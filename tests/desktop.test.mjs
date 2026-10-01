import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { request } from "node:http";

test("desktop service uses its assigned port, persists tasks, and exits with its parent pipe", { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-desktop-"));
  const assets = join(directory, "assets");
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Desktop fixture</title>");
  await writeFile(join(assets, "mcp.mjs"), "// MCP fixture");
  const database = join(directory, "workspace.sqlite");
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

  // The bundled runtime when testing a packaged app; the service reports it as the MCP command.
  const node = resolve(process.env.TASKNBOARD_TEST_NODE || process.execPath);
  async function start() {
    const child = spawn(node, [
      resolve(process.env.TASKNBOARD_TEST_SERVICE || "server/http.mjs"),
    ], {
      cwd: directory,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        TASKNBOARD_DESKTOP: "1",
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
    const lines = createInterface({ input: child.stdout });
    const ready = await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Desktop startup timed out: ${diagnostics}`)), 5000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Desktop exited before readiness: ${diagnostics}`)); });
      lines.once("line", (line) => {
        clearTimeout(timeout);
        try { resolveReady(JSON.parse(line)); } catch (error) { reject(error); }
      });
    });
    const origin = ready.url;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/?$/);
    return {
      origin,
      post: (command, args = {}, headers = {}) => fetch(`${origin}/api/${command}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(args),
      }),
      stop: async () => {
        const exited = once(child, "exit");
        child.stdin.end();
        const [code, signal] = await exited;
        lines.close();
        assert.equal(code, 0);
        assert.equal(signal, null);
      },
    };
  }

  const first = await start();
  assert.match(await (await fetch(first.origin)).text(), /Desktop fixture/);
  const mcpResponse = await fetch(`${first.origin}/api/mcp-config`);
  assert.equal(mcpResponse.status, 200);
  const mcpStatus = await mcpResponse.json();
  assert.equal(mcpStatus.mode, "local");
  assert.deepEqual(mcpStatus.config.mcpServers.tasknboard, {
    command: node,
    args: [join(assets, "mcp.mjs")],
    env: {
      TASKNBOARD_DB: database,
      TASKNBOARD_AGENT_ID: "codex",
    },
  });
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
  const task = await created.json();
  const boardResponse = await first.post("create_board", { name: "Operations", prefix: "OPS" }, { Origin: first.origin });
  assert.equal(boardResponse.status, 200);
  const board = await boardResponse.json();
  const otherResponse = await first.post("create_task", { title: "Other board", boardId: board.id }, { Origin: first.origin });
  assert.equal(otherResponse.status, 200);
  const other = await otherResponse.json();
  assert.equal(other.id, "OPS-1");
  await first.stop();
  await assert.rejects(fetch(first.origin));

  const second = await start();
  const restored = await second.post("get_task", { id: task.id });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).title, "Desktop persistence");
  const boardTasks = await (await second.post("list_tasks", { boardId: board.id })).json();
  assert.deepEqual(boardTasks.tasks.map((item) => item.id), [other.id]);
  await second.stop();
});
