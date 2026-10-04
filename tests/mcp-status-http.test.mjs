import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function service(t, tokens = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tasknboard-mcp-http-"));
  const dbPath = join(dir, "db.sqlite");
  const cleanups = [];
  const child = spawn(process.execPath, ["server/http.mjs"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      TASKNBOARD_DB: dbPath,
      TASKNBOARD_TOKENS: JSON.stringify(tokens),
      TASKNBOARD_DESKTOP: "0",
      TASKNBOARD_SERVER_URL: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    child.kill();
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve) => child.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 10000);
    child.stderr.on("data", (data) => {
      output += data;
      const match = output.match(/TasknBoard listening on (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Server exited: ${output}`));
    });
  });
  const request = async (path, { method = "GET", token, args, headers = {} } = {}) => {
    if (headers.Host) return new Promise((resolve, reject) => {
      const req = httpRequest(`${url}/api/${path}`, { method, headers }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.end();
    });
    const response = await fetch(`${url}/api/${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(args !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(args !== undefined ? { body: JSON.stringify(args) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  request.dbPath = dbPath;
  request.cleanup = (cleanup) => cleanups.push(cleanup);
  return request;
}

test("HTTP restart keeps the MCP client connected to its new worker", async (t) => {
  const request = await service(t);
  const client = new Client({ name: "mcp-http-test", version: "1" });
  request.cleanup(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/mcp.mjs")],
    env: {
      ...process.env,
      TASKNBOARD_DB: request.dbPath,
      TASKNBOARD_AGENT_ID: "http-worker",
      TASKNBOARD_SERVER_URL: "",
    },
    stderr: "pipe",
  }));
  const connected = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const response = await request("mcp-status");
      assert.equal(response.status, 200);
      const connection = response.body.connections.find(predicate);
      if (connection) return connection;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("MCP connection did not reach the expected state");
  };
  const before = await connected((connection) => connection.identity === "http-worker" && connection.state === "connected");
  assert.ok(Number.isInteger(before.workerPid));
  const restarted = await request("mcp-restart", { method: "POST", args: { id: before.id } });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.connection.id, before.id);
  const after = await connected((connection) => connection.id === before.id && connection.state === "connected" && connection.workerPid !== before.workerPid);
  assert.equal(after.identity, before.identity);
  assert.equal(after.startedAt, before.startedAt);
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "workspace_info"));
});

test("local MCP control requires the correct method and a connection id", async (t) => {
  const request = await service(t);
  assert.deepEqual(await request("mcp-status"), {
    status: 200,
    body: { supported: true, connections: [] },
  });
  assert.equal((await request("mcp-status", { method: "POST", args: {} })).status, 405);
  assert.equal((await request("mcp-restart")).status, 405);
  assert.equal((await request("mcp-restart", { method: "POST" })).status, 415);
  for (const args of [{}, [], null, { id: 123 }, { id: "../other" }, { id: "00000000-0000-0000-0000-000000000000", extra: true }]) {
    const response = await request("mcp-restart", { method: "POST", args });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "VALIDATION");
  }
  const missing = await request("mcp-restart", {
    method: "POST", args: { id: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "MCP_CONNECTION_NOT_FOUND");
  assert.equal((await request("mcp-status", { headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await request("mcp-status", { headers: { Origin: "https://evil.example" } })).status, 403);
});

test("shared MCP control requires a person and disables local control", async (t) => {
  const human = "test-human-mcp-token-123456789";
  const agent = "test-agent-mcp-token-123456789";
  const request = await service(t, {
    [human]: { id: "you", kind: "human" },
    [agent]: { id: "worker", kind: "agent" },
  });
  assert.equal((await request("mcp-status")).status, 401);
  assert.equal((await request("mcp-status", { token: agent })).status, 403);
  assert.deepEqual(await request("mcp-status", { token: human }), {
    status: 200, body: { supported: false, connections: [] },
  });
  const args = { id: "00000000-0000-0000-0000-000000000000" };
  assert.equal((await request("mcp-restart", { method: "POST", args })).status, 401);
  assert.equal((await request("mcp-restart", { method: "POST", token: agent, args })).status, 403);
  const unsupported = await request("mcp-restart", { method: "POST", token: human, args });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.code, "MCP_CONTROL_UNSUPPORTED");
});
