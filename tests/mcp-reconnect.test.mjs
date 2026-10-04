import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { startSupervisor } from "../server/mcp-supervisor.mjs";
import { createStore } from "../server/store.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listMcpConnections, restartMcpConnection } from "../server/mcp-control.mjs";

function host(t, worker, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  diagnostics.resume();
  const messages = [], waiters = [];
  const lines = createInterface({ input: output });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const index = waiters.findIndex((waiter) => waiter.matches(message));
    if (index < 0) messages.push(message);
    else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  const supervisor = startSupervisor({ worker, input, output, diagnostics, ...options });
  t.after(() => { supervisor.stop(); lines.close(); input.destroy(); output.destroy(); });
  function receive(matches) {
    const index = messages.findIndex(matches);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, timer: setTimeout(() => reject(new Error("No MCP response")), 5000) };
      waiters.push(waiter);
    });
  }
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (id, method, params) => { const reply = receive((message) => message.id === id); send({ id, method, params }); return reply; };
  return { supervisor, receive, send, request, input };
}

const initialization = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "recovery-test", version: "1" } };

test("a real SDK client connects when the first worker dies during initialization", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-handshake-"));
  const worker = join(dir, "worker.mjs"), runner = join(dir, "runner.mjs"), marker = join(dir, "failed.txt");
  writeFileSync(worker, `import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (existsSync(${JSON.stringify(marker)})) {
  await import(${JSON.stringify(new URL("../server/mcp-worker.mjs", import.meta.url).href)});
} else {
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (JSON.parse(line).method === 'initialize') {
      writeFileSync(${JSON.stringify(marker)}, 'failed');
      process.exit(1);
    }
  });
}`);
  writeFileSync(runner, `import { startSupervisor } from ${JSON.stringify(new URL("../server/mcp-supervisor.mjs", import.meta.url).href)};
startSupervisor({ worker: new URL(${JSON.stringify(pathToFileURL(worker).href)}) });`);
  const client = new Client({ name: "handshake-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [runner],
    env: { ...process.env, TASKNBOARD_DB: join(dir, "test.sqlite") }, stderr: "pipe" });
  t.after(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 37);
  assert.equal(readFileSync(marker, "utf8"), "failed");
});

test("a real MCP worker recovers on the same host connection and restores its resource subscription", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-recovery-"));
  const previous = process.env.TASKNBOARD_DB;
  process.env.TASKNBOARD_DB = join(dir, "test.sqlite");
  const store = createStore(process.env.TASKNBOARD_DB);
  const connection = host(t, new URL("../server/mcp-worker.mjs", import.meta.url));
  t.after(() => {
    if (previous === undefined) delete process.env.TASKNBOARD_DB;
    else process.env.TASKNBOARD_DB = previous;
    store.close();
    // Windows releases the worker's file handles after process termination.
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  assert.ok((await connection.request(1, "initialize", initialization)).result);
  connection.send({ method: "notifications/initialized" });
  assert.ok((await connection.request(2, "resources/subscribe", { uri: "tasknboard://notifications" })).result);
  const originalPid = connection.supervisor.workerPid;
  const restored = connection.receive((message) => message.method === "notifications/resources/updated");
  process.kill(originalPid);
  await restored;
  assert.notEqual(connection.supervisor.workerPid, originalPid);
  assert.equal((await connection.request(3, "tools/list", {})).result.tools.length, 37);
  const board = store.execute("list_boards", {}, { id: "reviewer", kind: "human" }).boards[0];
  const task = store.execute("create_task", { title: "Restored subscription", boardId: board.id }, { id: "coding-agent", kind: "agent" });
  const feedback = connection.receive((message) => message.method === "notifications/resources/updated");
  store.execute("add_comment", { id: task.id, body: "A new request" }, { id: "reviewer", kind: "human" });
  await feedback;
  const result = await connection.request(4, "resources/read", { uri: "tasknboard://notifications" });
  assert.equal(JSON.parse(result.result.contents[0].text).items[0].body, "A new request");
  const workerPid = connection.supervisor.workerPid;
  connection.input.end();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(workerPid, 0));
});

test("a completed mutation with a lost response is never replayed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-ambiguous-"));
  const worker = join(dir, "worker.mjs"), calls = join(dir, "calls.txt");
  writeFileSync(worker, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'tools/call') {
    appendFileSync(${JSON.stringify(calls)}, 'committed\\n');
    process.exit(1);
  }
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
});`);
  const connection = host(t, pathToFileURL(worker));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  await connection.request(1, "initialize", initialization);
  connection.send({ method: "notifications/initialized" });
  await connection.request(2, "resources/subscribe", { uri: "tasknboard://notifications" });
  const restored = connection.receive((message) => message.method === "notifications/resources/updated");
  const result = await connection.request(3, "tools/call", { name: "create_task", arguments: {} });
  assert.equal(result.error.data.ambiguous, true);
  assert.match(result.error.message, /Read the task before any new write/);
  await restored;
  assert.ok((await connection.request(4, "tools/list", {})).result);
  assert.equal(readFileSync(calls, "utf8"), "committed\n");
});

test("startup failures use backoff and host EOF cancels the next restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-startup-"));
  const worker = join(dir, "worker.mjs"), launches = join(dir, "launches.txt");
  writeFileSync(worker, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(launches)}, Date.now() + '\\n');
process.exit(1);`);
  const connection = host(t, pathToFileURL(worker));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  connection.input.end();
  const starts = readFileSync(launches, "utf8").trim().split("\n").map(Number);
  assert.ok(starts.length >= 2 && starts.length <= 3);
  assert.ok(starts[1] - starts[0] >= 250);
  if (starts.length === 3) assert.ok(starts[2] - starts[1] >= 500);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(readFileSync(launches, "utf8").trim().split("\n").length, starts.length);
});

test("local MCP control restarts only its worker and preserves the host and subscriptions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-control-"));
  const database = join(dir, "test.sqlite"), worker = join(dir, "worker.mjs"), calls = join(dir, "calls.txt");
  writeFileSync(worker, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'tools/call') {
    appendFileSync(${JSON.stringify(calls)}, 'committed\\n');
    return;
  }
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
});`);
  const connection = host(t, pathToFileURL(worker), { database, identity: "control-agent" });
  const other = host(t, pathToFileURL(worker), { database, identity: "other-agent" });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  async function status(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await listMcpConnections(database);
      const found = result.connections.find((item) => item.identity === "control-agent");
      if (found && predicate(found)) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No MCP control status");
  }
  const starting = await status((item) => item.state === "starting");
  assert.equal(starting.identity, "control-agent");
  await connection.request(1, "initialize", initialization);
  connection.send({ method: "notifications/initialized" });
  await connection.request(2, "resources/subscribe", { uri: "tasknboard://notifications" });
  const connected = await status((item) => item.state === "connected");
  const originalPid = connected.workerPid, otherPid = other.supervisor.workerPid;
  assert.equal((await listMcpConnections(database)).connections.length, 2);
  assert.deepEqual(Object.keys(connected).sort(), ["id", "identity", "startedAt", "state", "workerPid"]);
  const pending = connection.request(3, "tools/call", { name: "create_task", arguments: {} });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (readFileSync(calls, "utf8")) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(readFileSync(calls, "utf8"), "committed\n");
  const restored = connection.receive((message) => message.method === "notifications/resources/updated");
  const restarted = await restartMcpConnection(database, connected.id);
  assert.equal(restarted.connection.state, "reconnecting");
  assert.equal((await pending).error.data.ambiguous, true);
  await restored;
  const recovered = await status((item) => item.state === "connected" && item.workerPid !== originalPid);
  assert.equal(recovered.id, connected.id);
  assert.equal(recovered.startedAt, connected.startedAt);
  assert.equal(other.supervisor.workerPid, otherPid);
  assert.equal(readFileSync(calls, "utf8"), "committed\n");
  assert.ok((await connection.request(4, "tools/list", {})).result);
  connection.supervisor.stop();
  other.supervisor.stop();
  assert.deepEqual(await listMcpConnections(database), { supported: true, connections: [] });
});
