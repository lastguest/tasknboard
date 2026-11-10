import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { credentialFor } from "../server/local-auth.mjs";
import { connect } from "../server/client.mjs";
import { request } from "node:http";

test("resident service survives client exit, publishes discovery, authenticates, and persists tasks", { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-desktop-"));
  const assets = join(directory, "assets");
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Desktop fixture</title>");
  const database = join(directory, "workspace.sqlite");
  const runtimeFile = join(directory, "runtime.json");
  const stopFile = join(directory, "node-stop");
  const secret = randomBytes(32).toString("hex");
  const authorization = { Authorization: `Bearer ${secret}` };
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  // CI also runs this test against the bundled Node and resident service.
  const node = resolve(process.env.TASKNBOARD_TEST_NODE || process.execPath);
  async function start({ supervised = false } = {}) {
    const child = spawn(node, [
      resolve(process.env.TASKNBOARD_TEST_SERVICE || "server/http.mjs"),
    ], {
      cwd: directory,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        TASKNBOARD_DESKTOP: "1",
        TASKNBOARD_RESIDENT: "1",
        TASKNBOARD_RUNTIME_FILE: runtimeFile,
        TASKNBOARD_STOP_FILE: stopFile,
        TASKNBOARD_LOCAL_SECRET: secret,
        ...(supervised ? { TASKNBOARD_SUPERVISOR_PID: String(process.pid) } : {}),
        TASKNBOARD_DB: database,
        TASKNBOARD_RESOURCES: assets,
        TASKNBOARD_STATIC_DIR: assets,
        TASKNBOARD_ALLOWED_HOSTS: "",
        TASKNBOARD_TOKENS: "{}",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    const deadline = Date.now() + 5000;
    let ready;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Resident exited before readiness: ${diagnostics}`);
      try { ready = JSON.parse(await readFile(runtimeFile, "utf8")); } catch {}
      if (ready?.pid === child.pid) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready?.pid === child.pid, `Resident startup timed out: ${diagnostics}`);
    assert.ok(ready.instanceId);
    assert.equal(ready.mcpUrl, `${ready.url.replace(/\/$/, "")}/mcp`);
    assert.ok(!(await readFile(runtimeFile, "utf8")).includes(secret));
    if (process.platform !== "win32") assert.equal((await stat(runtimeFile)).mode & 0o777, 0o600);
    // Closing the desktop client pipe must not stop the independent resident.
    if (!supervised) child.stdin.end();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null);
    const origin = ready.url;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/?$/);
    return {
      origin,
      post: (command, args = {}, headers = {}) => fetch(`${origin}/api/${command}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorization, ...headers },
        body: JSON.stringify(args),
      }),
      endSupervisor: async () => {
        const exited = once(child, "exit");
        child.stdin.end();
        const [code, signal] = await exited;
        assert.equal(code, 0);
        assert.equal(signal, null);
      },
      stop: async () => {
        const exited = once(child, "exit");
        await writeFile(stopFile, "stop");
        const [code, signal] = await exited;
        assert.equal(code, 0);
        assert.equal(signal, null);
      },
    };
  }

  const cli = connect({ env: { TASKNBOARD_RUNTIME_FILE: runtimeFile, TASKNBOARD_TOKEN: secret } });
  t.after(() => cli.close());
  await assert.rejects(cli.execute("workspace_info"));
  const first = await start();
  await Promise.all([cli.execute("workspace_info"), cli.execute("list_boards")]);
  assert.match(await (await fetch(first.origin)).text(), /Desktop fixture/);
  const rejected = await fetch(`${first.origin}/api/list_tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(rejected.status, 401);
  assert.equal((await first.post("list_tasks", {}, { Origin: "https://untrusted.example" })).status, 403);
  const rejectedHost = await new Promise((resolveResponse, reject) => {
    const req = request(first.origin, { headers: { Host: "untrusted.example" } }, (res) => {
      res.resume();
      resolveResponse(res.statusCode);
    });
    req.once("error", reject);
    req.end();
  });
  assert.equal(rejectedHost, 403);
  const created = await first.post("create_task", { title: "Desktop persistence", boardId: "BOARD-1" }, { Origin: first.origin });
  assert.equal(created.status, 200);
  let task = await created.json();
  const agent = connect({
    env: {
      TASKNBOARD_RUNTIME_FILE: runtimeFile,
      TASKNBOARD_TOKEN: credentialFor(secret, { id: "desktop-agent", kind: "agent" }),
    },
  });
  t.after(() => agent.close());
  const assigned = await first.post("update_task", {
    id: task.id, expectedVersion: task.version, patch: { assignee: "desktop-agent" },
  });
  assert.equal(assigned.status, 200);
  task = await assigned.json();
  const args = () => ({ id: task.id, expectedVersion: task.version });
  task = await agent.execute("claim_task", args());
  task = await agent.execute("add_comment", { ...args(), body: "Packaged service check" });
  task = await agent.execute("link_pull_requests", { ...args(), pullRequests: ["owner/repo#1"] });
  task = await agent.execute("submit_review", { ...args(), summary: "Ready for review" });
  assert.equal(task.role, "in_review");
  await agent.close();
  const boardResponse = await first.post("create_board", { name: "Operations", prefix: "OPS" }, { Origin: first.origin });
  assert.equal(boardResponse.status, 200);
  const board = await boardResponse.json();
  const otherResponse = await first.post("create_task", { title: "Other board", boardId: board.id }, { Origin: first.origin });
  assert.equal(otherResponse.status, 200);
  const other = await otherResponse.json();
  assert.equal(other.id, "OPS-1");
  await first.stop();
  await assert.rejects(cli.execute("create_task", { title: "Do not replay", boardId: "BOARD-1" }), { code: "NETWORK" });
  await assert.rejects(fetch(first.origin));
  await assert.rejects(readFile(runtimeFile), { code: "ENOENT" });

  const second = await start();
  assert.equal((await cli.execute("get_task", { id: task.id })).title, "Desktop persistence");
  assert.equal((await cli.execute("list_tasks", { query: "Do not replay" })).total, 0);
  await cli.close();
  const restored = await second.post("get_task", { id: task.id });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).title, "Desktop persistence");
  const completed = await second.post("update_task", {
    ...args(), patch: { lane: "LANE-4" },
  });
  assert.equal(completed.status, 200);
  const done = await completed.json();
  assert.equal(done.role, "done");
  assert.equal(done.pullRequests[0].number, 1);
  assert.ok(done.events.some(event => event.kind === "add_comment"));
  const boardTasks = await (await second.post("list_tasks", { boardId: board.id })).json();
  assert.deepEqual(boardTasks.tasks.map((item) => item.id), [other.id]);
  await second.stop();
  const supervised = await start({ supervised: true });
  assert.equal((await supervised.post("get_task", { id: task.id })).status, 200);
  await supervised.endSupervisor();
  await assert.rejects(readFile(runtimeFile), { code: "ENOENT" });
});
