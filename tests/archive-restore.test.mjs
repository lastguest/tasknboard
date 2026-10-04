import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const creator = { id: "creator", kind: "agent" };
const worker = { id: "worker", kind: "agent" };
const architect = { id: "planner", kind: "agent", role: "architect" };

function fixture(t, path = ":memory:") {
  const store = createStore(path);
  t.after(() => store.close());
  const task = store.execute("create_task", { boardId: "BOARD-1", title: "Restore this card", assignee: "owner" }, creator);
  return { ...store, task };
}

const archive = (s, task) => s.execute("archive_task", { id: task.id, expectedVersion: task.version }, architect);
const restore = (s, task, actor = creator) => s.execute("restore_task", { id: task.id, expectedVersion: task.version }, actor);

test("new tasks remain visible after an earlier task is archived", (t) => {
  const s = fixture(t);
  assert.equal(s.task.archived, false);
  archive(s, s.task);
  const next = s.execute("create_task", { boardId: "BOARD-1", title: "Next card" }, creator);
  assert.equal(next.archived, false);
  assert.equal(next.version, 1);
  assert.deepEqual(next.events.map((event) => event.kind), ["created"]);
  assert.equal(s.execute("list_tasks", {}, human).tasks.some((task) => task.id === next.id), true);
  assert.throws(() => s.execute("create_task", { boardId: "BOARD-1", title: "Archived injection", archived: true }, creator), { code: "VALIDATION" });
});

test("the creator restores a delegated card with its lane and evidence intact", (t) => {
  const s = fixture(t);
  let task = s.execute("delegate_task", { id: s.task.id, expectedVersion: 1, delegatedTo: worker.id }, creator);
  task = s.execute("link_commits", { id: task.id, expectedVersion: task.version, commits: ["a".repeat(40)] }, creator);
  task = s.execute("add_comment", { id: task.id, body: "Keep this evidence" }, worker);
  const archived = archive(s, task);
  const restored = restore(s, archived);
  assert.equal(restored.archived, false);
  assert.equal(restored.lane, task.lane);
  assert.equal(restored.assignee, task.assignee);
  assert.deepEqual(restored.commits, task.commits);
  assert.equal(restored.lease, null);
  assert.equal(restored.delegatedTo, "");
  assert.equal(restored.delegatedBy, "");
  assert.equal(restored.version, archived.version + 1);
  assert.deepEqual(restored.events.slice(0, -1), archived.events);
  assert.equal(restored.events.at(-1).kind, "restore_task");
  assert.equal(restored.events.at(-1).actor, creator.id);
  assert.equal(s.execute("list_tasks", {}, human).tasks.some((task) => task.id === restored.id), true);
});

for (const actor of [human, architect]) {
  test(`${actor.kind} ${actor.id} restores another actor's task`, (t) => {
    const s = fixture(t);
    assert.equal(restore(s, archive(s, s.task), actor).archived, false);
  });
}

test("an unrelated worker cannot restore a task and failure changes no task history", (t) => {
  const s = fixture(t);
  const archived = archive(s, s.task);
  assert.throws(() => restore(s, archived, worker), { code: "FORBIDDEN" });
  assert.deepEqual(s.execute("get_task", { id: archived.id }, human), archived);
});

test("restore requires the current version and an archived task", (t) => {
  const s = fixture(t);
  assert.throws(() => restore(s, s.task), { code: "INVALID_TRANSITION" });
  const archived = archive(s, s.task);
  assert.throws(() => restore(s, s.task), { code: "VERSION_CONFLICT" });
  assert.throws(() => s.execute("restore_task", { id: archived.id }, creator), { code: "VALIDATION" });
  assert.throws(() => s.execute("update_task", { id: archived.id, expectedVersion: archived.version, patch: { archived: false } }, creator), { code: "VALIDATION" });
  assert.deepEqual(s.execute("get_task", { id: archived.id }, human), archived);
  const restored = restore(s, archived);
  assert.throws(() => restore(s, restored), { code: "INVALID_TRANSITION" });
});

test("restored state and archive attribution survive a database reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tasknboard-restore-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "workspace.sqlite");
  const first = createStore(path);
  let restored;
  try {
    const created = first.execute("create_task", { boardId: "BOARD-1", title: "Persistent card" }, creator);
    const archived = first.execute("archive_task", { id: created.id, expectedVersion: 1 }, human);
    restored = restore(first, archived);
  } finally {
    first.close();
  }
  const reopened = createStore(path);
  try {
    assert.deepEqual(reopened.execute("get_task", { id: restored.id }, creator), restored);
    assert.deepEqual(restored.events.map(({ kind, actor }) => [kind, actor]), [["created", "creator"], ["archive_task", "you"], ["restore_task", "creator"]]);
    assert.equal(reopened.execute("list_tasks", {}, creator).tasks.some((task) => task.id === restored.id), true);
  } finally {
    reopened.close();
  }
});
