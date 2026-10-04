import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import { createCommitLinks, readTaskCommitSummary, areTaskCommitsOnDefaultBranch } from "../server/commit-links.mjs";

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
    store, scanner, git, errors, repository,
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

test("commit summaries report real file changes, binary files and unavailable commits", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repository, "file with spaces.txt"), "one\ntwo\n");
  await writeFile(join(f.repository, "binary.bin"), Buffer.from([0, 1, 2]));
  await f.git("add", ".");
  const first = await f.commit("Add source files");
  await writeFile(join(f.repository, "file with spaces.txt"), "one\nthree\n");
  await f.git("add", ".");
  const second = await f.commit("Change source file");
  const summary = await readTaskCommitSummary(f.repository, [first, second, first, "abcdef1234567"]);
  assert.equal(summary.commits.length, 2);
  assert.equal(summary.commits[0].subject, "Add source files");
  assert.deepEqual(summary.filesChanged, [
    { path: "binary.bin", additions: 0, deletions: 0, binary: true },
    { path: "file with spaces.txt", additions: 3, deletions: 1, binary: false },
  ]);
  assert.deepEqual(summary.unavailable, ["abcdef1234567"]);
  await assert.rejects(readTaskCommitSummary(f.repository, ["--output=bad"]), { code: "VALIDATION" });
});

test("merge branch references map to the task branch and report merged files", async (t) => {
  const f = await fixture(t);
  let task = f.make();
  task = f.store.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { branch: "codex/T406" } }, human);
  await f.commit("Base");
  const baseBranch = await f.git("branch", "--show-current");
  await f.git("checkout", "-b", "codex/T406");
  await writeFile(join(f.repository, "feature.txt"), "implemented\n");
  await f.git("add", ".");
  await f.commit("Implement feature");
  await f.git("checkout", baseBranch);
  await f.git("merge", "--no-ff", "codex/T406", "-m", "Merge branch 'codex/T406'");
  const sha = await f.git("rev-parse", "HEAD");
  await f.scanner.check();
  assert.deepEqual(f.get(task.id).commits, [sha]);
  const summary = await readTaskCommitSummary(f.repository, [sha]);
  assert.deepEqual(summary.filesChanged, [{ path: "feature.txt", additions: 1, deletions: 0, binary: false }]);
  assert.deepEqual(f.errors, []);
});

test("completion evidence requires every linked commit on the configured default branch", async (t) => {
  const f = await fixture(t);
  const base = await f.commit("Base");
  const defaultBranch = await f.git("branch", "--show-current");
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, [base]), false);
  await f.git("update-ref", `refs/remotes/origin/${defaultBranch}`, base);
  await f.git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${defaultBranch}`);
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, [base]), true);
  await f.git("checkout", "-b", "feature-evidence");
  const feature = await f.commit("Feature work");
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, [feature]), false);
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, [base, feature]), false);
  await f.git("checkout", defaultBranch);
  await f.git("merge", "--no-ff", "feature-evidence", "-m", "Merge feature");
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, [base, feature]), true);
  assert.equal(await f.git("rev-parse", `refs/remotes/origin/${defaultBranch}`), base);
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, []), false);
  assert.equal(areTaskCommitsOnDefaultBranch("", [base]), false);
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, ["--not"]), false);
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, ["abcdef1234567"]), false);
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, Array(21).fill(base)), false);
  await writeFile(join(f.repository, "evidence.txt"), "Evidence is a file, not a commit.\n");
  const blob = await f.git("hash-object", "-w", "evidence.txt");
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, [blob]), false);
});

test("completion evidence uses the configured remote branch when no local branch exists", async (t) => {
  const f = await fixture(t);
  const base = await f.commit("Configured remote default");
  await f.git("update-ref", "refs/remotes/origin/release-default", base);
  await f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release-default");
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, [base]), true);
  await f.git("update-ref", "-d", "refs/remotes/origin/release-default");
  assert.equal(areTaskCommitsOnDefaultBranch(f.repository, [base]), false);
});

test("the scanner completes reviewed evidence after a merge without a task reference", async (t) => {
  const f = await fixture(t);
  const base = await f.commit("Base");
  const defaultBranch = await f.git("branch", "--show-current");
  await f.git("update-ref", `refs/remotes/origin/${defaultBranch}`, base);
  await f.git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${defaultBranch}`);
  let task = f.make();
  const board = f.store.execute("list_boards", {}, human).boards[0];
  f.store.execute("update_board", { id: board.id, expectedVersion: board.version,
    patch: { policy: { humanCompletionOnly: false, completionMode: "auto_on_evidence" } } }, human);
  task = f.store.execute("delegate_task", { id: task.id, expectedVersion: task.version, delegatedTo: worker.id }, human);
  await f.git("checkout", "-b", "feature-evidence");
  const feature = await f.commit("Implement the feature");
  task = f.store.execute("link_commits", { id: task.id, expectedVersion: task.version, commits: [feature] }, worker);
  task = f.store.execute("submit_review", { id: task.id, expectedVersion: task.version,
    summary: "Review the feature", artifacts: [{ title: "Check log", url: "https://ci.example/check/1" }] }, worker);
  assert.equal(task.role, "in_review");
  assert.equal(task.delegatedTo, worker.id);
  await f.scanner.check();
  assert.equal(f.get(task.id).role, "in_review");
  await f.git("checkout", defaultBranch);
  await f.git("merge", "--no-ff", "feature-evidence", "-m", "Merge the feature");
  await f.scanner.check();
  const completed = f.get(task.id);
  assert.equal(completed.role, "done");
  assert.equal(completed.lease, null);
  assert.equal(completed.delegatedTo, "");
  assert.equal(completed.delegatedBy, "");
  assert.equal(completed.completion.approvedBy, "evidence");
  assert.equal(completed.completion.automatic, true);
  assert.ok(completed.events.some(event => event.body.includes('"automatic":true')));
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
