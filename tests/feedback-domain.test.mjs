import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
const human = { id: "you", kind: "human" };
const architect = { id: "claude/architect", kind: "agent", role: "architect" };
const worker = { id: "codex/cli", kind: "agent" };
function fixture(t) {
  let now = 1000000;
  const store = createStore(":memory:", { clock: () => now });
  t.after(() => store.close());
  return { ...store, advance: () => { now += 900001; }, make: (input = {}, actor = human) => store.execute("create_task", { boardId: "BOARD-1", title: "Work", ...input }, actor) };
}
test("lease ownership preserves assignment and delegation persists without a lease", (t) => {
  const s = fixture(t);
  let task = s.make({ assignee: "owner" });
  task = s.execute("claim_task", { id: task.id, expectedVersion: task.version }, worker);
  assert.equal(task.assignee, "owner");
  assert.equal(task.lease.actor, worker.id);
  task = s.execute("delegate_task", { id: task.id, expectedVersion: task.version, delegatedTo: "codex/external" }, architect);
  s.advance();
  task = s.execute("get_task", { id: task.id }, human);
  assert.equal(task.delegatedTo, "codex/external");
  assert.equal(task.role, "in_progress");
  assert.equal(task.lease, null);
});
test("architect plans without claims; creator submits review directly; human requests changes", (t) => {
  const s = fixture(t);
  const board = s.execute("create_board", { name: "Engine", prefix: "ENG" }, architect);
  assert.equal(board.agentSandbox, "workspace-write");
  const epic = s.execute("create_epic", { boardId: board.id, title: "Engine work" }, architect);
  let task = s.make({ boardId: board.id, epic: epic.id }, worker);
  task = s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { labels: ["M1"] } }, architect);
  task = s.execute("submit_review", { id: task.id, expectedVersion: task.version, summary: "Done", artifactUrl: "tasks/T005.result.md" }, worker);
  assert.equal(task.role, "in_review");
  task = s.execute("request_changes", { id: task.id, expectedVersion: task.version, reason: "Fix the output" }, human);
  assert.equal(task.role, "in_progress");
  assert.equal(task.changeRequest.reason, "Fix the output");
  assert.equal(s.execute("list_notifications", {}, architect).items.at(-1).kind, "request_changes");
  assert.deepEqual(s.execute("list_epics", { boardId: "BOARD-1" }, human).epics, []);
  assert.equal(s.execute("list_epics", { boardId: board.id }, human).epics[0].id, epic.id);
  assert.throws(() => s.make({ epic: epic.id }), { code: "VALIDATION" });
});
test("bulk commands are atomic and initial lanes, dependencies, comments and filters work", (t) => {
  const s = fixture(t);
  const blocker = s.make();
  const { tasks } = s.execute("bulk_create_tasks", { tasks: [
    { boardId: "BOARD-1", title: "Done", lane: "LANE-4", labels: ["M0"], assignee: "owner" },
    { boardId: "BOARD-1", title: "Blocked", blockedBy: [blocker.id] },
  ] }, architect);
  assert.equal(tasks[0].role, "done");
  assert.equal(tasks[1].links[0].type, "blocked_by");
  s.execute("add_comment", { id: tasks[1].id, body: "First" }, worker);
  s.execute("add_comment", { id: tasks[1].id, body: "Second" }, architect);
  assert.equal(s.execute("get_task", { id: tasks[1].id }, human).commentCount, 2);
  const filtered = s.execute("list_tasks", { label: "M0", owner: "owner", lane: "LANE-4", compact: true }, human);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.tasks[0].description, undefined);
  const before = s.execute("list_tasks", {}, human).total;
  assert.throws(() => s.execute("bulk_create_tasks", { tasks: [
    { boardId: "BOARD-1", title: "Rollback" }, { boardId: "BOARD-999", title: "Fail" },
  ] }, architect), { code: "NOT_FOUND" });
  assert.equal(s.execute("list_tasks", {}, human).total, before);
  const moved = s.execute("bulk_move_tasks", { tasks: [{ id: blocker.id, expectedVersion: blocker.version }], lane: "LANE-2" }, architect);
  assert.equal(moved.tasks[0].role, "in_progress");
});
test("repository artifacts and commit SHAs reject traversal and unsafe schemes", (t) => {
  const s = fixture(t);
  let task = s.make();
  task = s.execute("link_commits", { id: task.id, expectedVersion: task.version, commits: ["abcdef1234567"] }, architect);
  assert.deepEqual(task.commits, ["abcdef1234567"]);
  for (const artifactUrl of ["../secret", "javascript:alert(1)", "C:\\secret", "/secret"]) {
    assert.throws(() => s.execute("submit_review", { id: task.id, expectedVersion: task.version, summary: "Done", artifactUrl }, architect), { code: "VALIDATION" });
  }
  task = s.execute("submit_review", { id: task.id, expectedVersion: task.version, summary: "Done", artifactUrl: "commit:abcdef1234567" }, architect);
  assert.equal(task.review.artifactUrl, "commit:abcdef1234567");
});
