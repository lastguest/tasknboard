import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCliHelper } from "../server/cli-helper.mjs";
import { createStore } from "../server/store.mjs";

test("the Windows cmd helper preserves JSON file and stdin text", {
  skip: process.platform !== "win32",
  timeout: 30000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "tasknboard-json-"));
  let store;
  t.after(async () => {
    store?.close();
    await rm(home, { recursive: true, force: true });
  });
  const resources = join(home, "app resources");
  await mkdir(resources);
  await copyFile(process.execPath, join(resources, "node.exe"));
  await copyFile(resolve("dist-cli/tasknboard.mjs"), join(resources, "cli.mjs"));
  await symlink(resolve("node_modules"), join(resources, "node_modules"), "junction");
  const database = join(home, "workspace.sqlite");
  const human = { id: "you", kind: "human" };
  store = createStore(database);
  const task = store.execute("create_task", {
    boardId: "BOARD-1", title: "Windows JSON round trip",
  }, human);
  const helper = createCliHelper({
    desktop: true, platform: "win32", home, resources, database,
    searchPath: join(home, ".local", "bin"),
  });
  const installed = await helper.install();
  assert.equal(installed.installed, true);
  const env = {
    ...process.env,
    TASKNBOARD_AGENT_ID: "windows-json-agent",
    TASKNBOARD_JSON_SENTINEL: "expanded-text-must-not-appear",
  };
  for (const name of ["TASKNBOARD_DB", "TASKNBOARD_SERVER_URL", "TASKNBOARD_TOKEN", "TASKNBOARD_AGENT_ROLE"])
    delete env[name];

  // Only fixed flags and generated paths enter cmd.exe. JSON enters a file or a pipe.
  function run(flags, input = "") {
    return new Promise((resolveRun, reject) => {
      const command = `""${installed.path}" add_comment ${flags}"`;
      const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
        cwd: home, env, windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`CLI exited ${code}: ${stderr}\n${stdout}`));
        else resolveRun(JSON.parse(stdout));
      });
      child.stdin.end(input);
    });
  }

  const text = 'Comparison >16 & echo injected | more ^ %TASKNBOARD_JSON_SENTINEL%\nUnicode: åäö 漢字 🚀; quoted "value"; slash \\.';
  for (const mode of ["file", "stdin"]) {
    const current = store.execute("get_task", { id: task.id }, human);
    const body = `${mode}: ${text}`;
    const json = JSON.stringify({ taskId: task.id, expectedVersion: current.version, body });
    let result;
    if (mode === "file") {
      const path = join(home, "comment payload.json");
      await writeFile(path, `\uFEFF${json}`, "utf8");
      result = await run(`--file "${path}"`);
    } else result = await run("--stdin", json);
    assert.equal(result.id, task.id);
    assert.equal(result.version, current.version + 1);
    const saved = store.execute("get_task", { id: task.id }, human);
    const event = saved.events.findLast((item) => item.kind === "add_comment");
    assert.equal(event.body, body);
    assert.equal(event.actor, "windows-json-agent");
    assert.doesNotMatch(event.body, /expanded-text-must-not-appear/);
  }
  assert.deepEqual((await readdir(home)).sort(), [
    ".local", "app resources", "comment payload.json", "workspace.sqlite",
    "workspace.sqlite-shm", "workspace.sqlite-wal",
  ].sort());
});
