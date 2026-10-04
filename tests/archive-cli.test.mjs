import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-archive-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, TASKNBOARD_DB: join(directory, "workspace.sqlite") };
  delete env.TASKNBOARD_SERVER_URL;
  delete env.TASKNBOARD_TOKEN;
  const cli = async (name, args = {}, { actor = "creator", role = "worker", mode = "stdin" } = {}) => {
    const commandEnv = { ...env, TASKNBOARD_AGENT_ID: actor, TASKNBOARD_AGENT_ROLE: role };
    const payload = JSON.stringify(args);
    const file = join(directory, "archive arguments.json");
    if (mode === "file") await writeFile(file, payload, "utf8");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["dist-cli/tasknboard.mjs", name, ...(mode === "file" ? ["--file", file] : ["--stdin"])], {
        env: commandEnv, stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
      child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(mode === "stdin" ? payload : "");
    });
  };
  const success = async (...args) => {
    const result = await cli(...args);
    assert.equal(result.code, 0, result.stderr);
    assert.notEqual(result.stdout.trim(), "", "The CLI must print its result.");
    return JSON.parse(result.stdout);
  };
  const board = await success("create_board", { name: "Archive", prefix: "ARC" }, { actor: "architect", role: "architect" });
  const task = await success("create_task", { boardId: board.id, title: "Duplicate card" });
  return { cli, success, task, board };
}

for (const [mode, key] of [["file", "id"], ["stdin", "taskId"]]) {
  test(`CLI archives a claimed creator task through ${mode} with ${key}`, async (t) => {
    const { success, task, board } = await fixture(t);
    const commented = await success("add_comment", { id: task.id, body: "Keep this history." });
    const claimed = await success("claim_task", { id: task.id, expectedVersion: commented.version });
    assert.equal(claimed.lease.actor, "creator");
    const archived = await success("archive_task", { [key]: task.id, expectedVersion: claimed.version }, { mode });
    assert.equal(archived.archived, true);
    assert.equal(archived.version, claimed.version + 1);
    assert.equal(archived.lease, null);
    assert.equal(archived.delegatedTo, "");
    assert.equal(archived.delegatedBy, "");
    assert.equal(archived.events.at(-1).kind, "archive_task");
    assert.equal(archived.events.at(-1).actor, "creator");
    const listed = await success("list_tasks", { boardId: board.id });
    assert.deepEqual(listed.tasks, []);
    // Each CLI process opens the database again, so this read checks persistence.
    const reopened = await success("get_task", { taskId: task.id });
    assert.equal(reopened.archived, true);
    assert.equal(reopened.title, "Duplicate card");
    assert.equal(reopened.events.find((event) => event.kind === "add_comment").body, "Keep this history.");
    assert.deepEqual(reopened.events.map((event) => event.kind), ["created", "add_comment", "claim_task", "archive_task"]);
  });
}

test("CLI archive failures print JSON and leave the task unchanged", async (t) => {
  const { cli, success, task } = await fixture(t);
  const claimed = await success("claim_task", { id: task.id, expectedVersion: task.version });
  const cases = [
    [{ id: task.id, expectedVersion: claimed.version }, { actor: "other" }, "FORBIDDEN"],
    [{ taskId: task.id, expectedVersion: task.version }, { mode: "file" }, "VERSION_CONFLICT"],
  ];
  for (const [args, options, expectedCode] of cases) {
    const failed = await cli("archive_task", args, options);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "");
    assert.equal(JSON.parse(failed.stderr).code, expectedCode);
    const current = await success("get_task", { id: task.id });
    assert.equal(current.archived, false);
    assert.equal(current.version, claimed.version);
    assert.deepEqual(current.lease, claimed.lease);
    assert.equal(current.events.filter((event) => event.kind === "archive_task").length, 0);
  }
});
