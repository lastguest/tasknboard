import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const run = promisify(execFile);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-http-workflow-"));
  const database = join(directory, "workspace.sqlite");
  const cleanups = [];
  const child = spawn(process.execPath, ["server/http.mjs"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", TASKNBOARD_DB: database,
      TASKNBOARD_DESKTOP: "0", TASKNBOARD_SERVER_URL: "", TASKNBOARD_TOKENS: "{}" },
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`HTTP startup timeout: ${output}`)), 10000);
    child.stderr.on("data", chunk => {
      output += chunk;
      const match = output.match(/TasknBoard listening on (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`HTTP service exited: ${output}`)); });
  });
  const request = async (command, args = {}) => {
    const response = await fetch(`${origin}/api/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  return { directory, database, origin, request, cleanup: callback => cleanups.push(callback) };
}

test("HTTP reads current task files, real commit changes and inert uploaded evidence with task permalinks", async (t) => {
  const f = await fixture(t);
  const repository = join(f.directory, "repository");
  await mkdir(join(repository, "tasks"), { recursive: true });
  const git = async (...args) => (await run("git", ["-C", repository, ...args], { windowsHide: true })).stdout.trim();
  await git("init"); await git("config", "user.email", "test@example.invalid"); await git("config", "user.name", "Test");
  await writeFile(join(repository, "tasks", "T406.md"), "# Current brief\n");
  await writeFile(join(repository, "tasks", "T406.result.md"), "# Current result\n");
  await git("add", "."); await git("commit", "-m", "Add task documents");
  const sha = await git("rev-parse", "HEAD");
  let board = (await f.request("list_boards")).boards[0];
  board = await f.request("update_board", { id: board.id, expectedVersion: board.version, patch: { repository } });
  let task = await f.request("create_task", { boardId: board.id, title: "Traceable work", briefPath: "tasks/T406.md", resultPath: "tasks/T406.result.md" });
  assert.equal(new URL(task.url).origin, f.origin);
  assert.equal(new URL(task.url).searchParams.get("task"), task.id);
  const files = await f.request("task-files", { id: task.id });
  assert.equal(files.brief.content, "# Current brief\n");
  assert.equal(files.result.content, "# Current result\n");
  await writeFile(join(repository, "tasks", "T406.md"), "# Updated brief\n");
  assert.equal((await f.request("task-files", { id: task.id })).brief.content, "# Updated brief\n");
  task = await f.request("link_commits", { id: task.id, expectedVersion: task.version, commits: [sha], via: "codex#session-1" });
  const commits = await f.request("task-commits", { id: task.id });
  assert.equal(commits.commits[0].sha, sha);
  assert.deepEqual(commits.filesChanged.map(file => file.path), ["tasks/T406.md", "tasks/T406.result.md"]);
  const text = "<script>throw new Error('must stay text')</script>\n";
  const evidence = await f.request("upload_artifact", { title: "Check log", dataUrl: `data:text/plain;base64,${Buffer.from(text).toString("base64")}` });
  const served = await fetch(new URL(evidence.url, f.origin));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "text/plain");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.match(served.headers.get("content-security-policy"), /sandbox/);
  assert.equal(await served.text(), text);
  const jsonEvidence = await f.request("upload_artifact", { title: "Bench result", dataUrl: `data:application/json;base64,${Buffer.from('{"passed":true}').toString("base64")}` });
  const jsonServed = await fetch(new URL(jsonEvidence.url, f.origin));
  assert.equal(jsonServed.headers.get("content-type"), "application/json");
  assert.deepEqual(await jsonServed.json(), { passed: true });
});

test("HTTP manual dispatch notifies an existing MCP session and assignment follows the board autoDispatch policy", async (t) => {
  const f = await fixture(t);
  const client = new Client({ name: "watched-session", version: "1" });
  f.cleanup(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("server/mcp.mjs")],
    env: { ...process.env, TASKNBOARD_DB: f.database, TASKNBOARD_AGENT_ID: "watched-agent", TASKNBOARD_SERVER_URL: "", TASKNBOARD_TOKEN: "" }, stderr: "pipe" }));
  await client.subscribeResource({ uri: "tasknboard://notifications" });
  const board = (await f.request("list_boards")).boards[0];
  assert.equal(board.policy.autoDispatch, false);
  const task = await f.request("create_task", { boardId: board.id, title: "Explicit run", assignee: "watched-agent" });
  const before = await f.request("get_task", { id: task.id });
  assert.ok(!before.events.some(event => ["dispatch_requested", "agent_started", "agent_not_started"].includes(event.kind)));
  let timer;
  const notification = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The watched session received no dispatch notification")), 5000);
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => { clearTimeout(timer); resolve(); });
  });
  t.after(() => clearTimeout(timer));
  const dispatched = await f.request("agent-event", { event: "task_assigned", taskId: task.id });
  assert.deepEqual(dispatched, { started: ["watched-agent"], notified: true });
  await notification;
  const after = await f.request("get_task", { id: task.id });
  assert.equal(after.events.filter(event => event.kind === "dispatch_requested").length, 1);
  assert.ok(!after.events.some(event => ["agent_started", "agent_not_started"].includes(event.kind)));
  const resource = await client.readResource({ uri: "tasknboard://notifications" });
  assert.ok(JSON.parse(resource.contents[0].text).items.some(event => event.kind === "dispatch_requested" && event.taskId === task.id));
  await f.request("update_board", { id: board.id, expectedVersion: board.version, patch: { policy: { autoDispatch: true } } });
  const automatic = await f.request("create_task", { boardId: board.id, title: "Board dispatch", assignee: "watched-agent" });
  const automaticDetails = await f.request("get_task", { id: automatic.id });
  assert.equal(automaticDetails.events.filter(event => event.kind === "dispatch_requested").length, 1);
  assert.ok(!automaticDetails.events.some(event => ["agent_started", "agent_not_started"].includes(event.kind)));
});
