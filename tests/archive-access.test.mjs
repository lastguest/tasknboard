import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const creator = { id: "codex/creator", kind: "agent" };
const worker = { id: "codex/worker", kind: "agent" };
const architect = { id: "codex/planner", kind: "agent", role: "architect" };

function fixture(t) {
  let now = 1000000;
  const store = createStore(":memory:", { clock: () => now });
  t.after(() => store.close());
  const task = store.execute("create_task", {
    boardId: "BOARD-1", title: "Duplicate card", assignee: "owner",
  }, creator);
  return { ...store, task, advance: () => { now += 900001; } };
}

function archive(s, task, actor) {
  return s.execute("archive_task", { id: task.id, expectedVersion: task.version }, actor);
}

function assertArchived(task, previous, actor) {
  assert.equal(task.archived, true);
  assert.equal(task.lease, null);
  assert.equal(task.delegatedTo, "");
  assert.equal(task.delegatedBy, "");
  assert.equal(task.assignee, previous.assignee);
  assert.equal(task.version, previous.version + 1);
  assert.equal(task.events.length, previous.events.length + 1);
  assert.equal(task.events.at(-1).kind, "archive_task");
  assert.equal(task.events.at(-1).actor, actor.id);
}

test("a creator worker archives an unclaimed duplicate with history and links preserved", (t) => {
  const s = fixture(t);
  const other = s.execute("create_task", { boardId: "BOARD-1", title: "Related card" }, human);
  let task = s.execute("link_task", {
    id: s.task.id, expectedVersion: s.task.version, target: other.id, type: "relates",
  }, human);
  task = s.execute("add_comment", { id: task.id, body: "Keep this history" }, creator);
  task = s.execute("link_commits", { id: task.id, expectedVersion: task.version, commits: ["a".repeat(40)] }, creator);
  const archived = archive(s, task, creator);
  assertArchived(archived, task, creator);
  assert.deepEqual(archived.links, task.links);
  assert.deepEqual(archived.commits, task.commits);
  assert.deepEqual(archived.events.slice(0, -1), task.events);
  assert.equal(s.execute("list_tasks", {}, human).tasks.some((item) => item.id === task.id), false);
  assert.equal(s.execute("export_workspace", {}, human).tasks.some((item) => item.id === task.id), true);
});

test("a creator worker archives its own claim and clears delegation", (t) => {
  const s = fixture(t);
  let task = s.execute("delegate_task", {
    id: s.task.id, expectedVersion: s.task.version, delegatedTo: worker.id,
  }, creator);
  task = s.execute("claim_task", { id: task.id, expectedVersion: task.version }, creator);
  assertArchived(archive(s, task, creator), task, creator);
});

test("a creator worker cannot archive another worker's active claim", (t) => {
  const s = fixture(t);
  const task = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, worker);
  assert.throws(() => archive(s, task, creator), { code: "LEASE_CONFLICT" });
  assert.deepEqual(s.execute("get_task", { id: task.id }, human), task);
  s.advance();
  assertArchived(archive(s, task, creator), task, creator);
});

test("a noncreator worker receives FORBIDDEN with or without its own claim", (t) => {
  const s = fixture(t);
  assert.throws(() => archive(s, s.task, worker), { code: "FORBIDDEN" });
  const task = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, worker);
  assert.throws(() => archive(s, task, worker), { code: "FORBIDDEN" });
  assert.deepEqual(s.execute("get_task", { id: task.id }, human), task);
});

test("an architect archives any task and overrides an active claim", (t) => {
  const s = fixture(t);
  const task = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, worker);
  assertArchived(archive(s, task, architect), task, architect);
});

test("a human archives any unclaimed task but respects active claims", (t) => {
  const s = fixture(t);
  const task = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, worker);
  assert.throws(() => archive(s, task, human), { code: "LEASE_CONFLICT" });
  s.advance();
  assertArchived(archive(s, task, human), task, human);
});

test("archive retains version checks and rejects repeat archive", (t) => {
  const s = fixture(t);
  const task = s.execute("add_comment", { id: s.task.id, body: "New context" }, human);
  assert.throws(() => archive(s, s.task, creator), { code: "VERSION_CONFLICT" });
  const archived = archive(s, task, creator);
  assert.throws(() => archive(s, archived, creator), { code: "ARCHIVED" });
  assert.deepEqual(s.execute("get_task", { id: task.id }, human), archived);
});
