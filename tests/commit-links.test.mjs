import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import { createCommitLinks } from "../server/commit-links.mjs";

const run = promisify(execFile);
const human = { id: "you", kind: "human" };
const worker = { id: "codex/worker", kind: "agent" };

async function fixture(t, options = {}) {
  const repository = await mkdtemp(join(tmpdir(), "tnb-commits-"));
  const git = async (...args) => (await run("git", ["-C", repository, ...args], { windowsHide: true })).stdout.trim();
  await git("init");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Test");
  const store = createStore(":memory:", options);
  const errors = [];
  const scanner = createCommitLinks(store, { ...options, onError: (error) => errors.push(error) });
  t.after(async () => { await scanner.stop(); store.close(); await rm(repository, { recursive: true, force: true }); });
  const board = store.execute("list_boards", {}, human).boards[0];
  store.execute("update_board", { id: board.id, expectedVersion: board.version, patch: { repository } }, human);
  return {
    store, scanner, git, errors,
    make: (boardId = board.id) => store.execute("create_task", { boardId, title: "Work" }, human),
    get: (id) => store.execute("get_task", { id }, human),
    commit: async (message) => { await git("commit", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); },
  };
}

test("local commits link exact task keys and old prefixes without duplicates or cross-board links", async (t) => {
  const f = await fixture(t);
  const task = f.make();
  const otherBoard = f.store.execute("create_board", { name: "Other", prefix: "OTHER" }, human);
  const other = f.make(otherBoard.id);
  const board = f.store.execute("list_boards", {}, human).boards.find((board) => board.id === task.boardId);
  f.store.execute("update_board", { id: board.id, expectedVersion: board.version, patch: { prefix: "NEW" } }, human);
  const sha = await f.commit(`Fix ${task.id}; also ${other.id}\n\n${task.id} appears twice.`);
  await f.scanner.check();
  const linked = f.get(task.id);
  assert.deepEqual(linked.commits, [sha]);
  assert.deepEqual(f.get(other.id).commits ?? [], []);
  await f.scanner.check();
  assert.equal(f.get(task.id).version, linked.version);
  const falseSha = await f.commit(`Ignore X${linked.id}, ${linked.id}0, ${linked.id}-suffix and _${linked.id}`);
  await f.scanner.check();
  assert.ok(!f.get(task.id).commits.includes(falseSha));
  const next = await f.commit(`Fix (${linked.id})`);
  await f.scanner.check();
  assert.deepEqual(f.get(task.id).commits, [sha, next]);
  assert.deepEqual(f.errors, []);
});

test("deferred commits survive a scanner restart and preserve a live worker lease", async (t) => {
  const f = await fixture(t);
  let task = f.make();
  task = f.store.execute("claim_task", { id: task.id, expectedVersion: task.version }, worker);
  const sha = await f.commit(`Finish ${task.id}`);
  await f.scanner.check();
  assert.equal(f.get(task.id).version, task.version);
  assert.deepEqual(f.get(task.id).lease, task.lease);
  const restarted = createCommitLinks(f.store);
  t.after(() => restarted.stop());
  f.store.execute("release_task", { id: task.id, expectedVersion: task.version }, worker);
  await restarted.check();
  assert.deepEqual(f.get(task.id).commits, [sha]);
});

test("a rewritten branch safely rescans recent commits and recovers from an empty repository", async (t) => {
  const f = await fixture(t);
  const task = f.make();
  await f.scanner.check();
  assert.equal(f.errors.length, 1);
  const first = await f.commit(`First ${task.id}`);
  await f.scanner.check();
  await f.git("checkout", "--orphan", "replacement");
  const replacement = await f.commit(`Replacement ${task.id}`);
  await f.scanner.check();
  assert.deepEqual(f.get(task.id).commits, [first, replacement]);
});

test("a deferred link resumes after the worker lease expires", async (t) => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now });
  let task = f.make();
  task = f.store.execute("claim_task", { id: task.id, expectedVersion: task.version }, worker);
  const sha = await f.commit(`Finish ${task.id}`);
  await f.scanner.check();
  assert.deepEqual(f.get(task.id).commits ?? [], []);
  now += 900001;
  await f.scanner.check();
  assert.deepEqual(f.get(task.id).commits, [sha]);
});

test("a version conflict retains its pending link for the next scan", async (t) => {
  const f = await fixture(t);
  const task = f.make();
  const sha = await f.commit(`Finish ${task.id}`);
  let conflict = true;
  const scanner = createCommitLinks({ ...f.store, execute(command, ...args) {
    if (command === "link_commits" && conflict) {
      conflict = false;
      throw Object.assign(new Error("Task changed"), { code: "VERSION_CONFLICT" });
    }
    return f.store.execute(command, ...args);
  } });
  t.after(() => scanner.stop());
  await scanner.check();
  assert.deepEqual(f.get(task.id).commits ?? [], []);
  await scanner.check();
  assert.deepEqual(f.get(task.id).commits, [sha]);
});

test("an empty workspace scan does not register an internal actor", async (t) => {
  const store = createStore(":memory:");
  const scanner = createCommitLinks(store);
  t.after(async () => { await scanner.stop(); store.close(); });
  const before = store.execute("workspace_info", {}, human).actors;
  await scanner.check();
  assert.deepEqual(store.execute("workspace_info", {}, human).actors, before);
});

test("new commit batches keep their oldest cursor until every new commit is scanned", async (t) => {
  const f = await fixture(t);
  const task = f.make();
  await f.commit("Initial commit");
  await f.scanner.check();
  const first = await f.commit(`Oldest new ${task.id}`);
  for (let i = 0; i < 200; i++) await f.commit(`Unrelated ${i}`);
  const last = await f.commit(`Newest new ${task.id}`);
  await f.scanner.check();
  assert.deepEqual(f.get(task.id).commits, [first]);
  await f.scanner.check();
  assert.deepEqual(f.get(task.id).commits, [first, last]);
});
