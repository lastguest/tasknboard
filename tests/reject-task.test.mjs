import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const worker = { id: "worker", kind: "agent" };
const architect = { id: "architect", kind: "agent", role: "architect" };
function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const lanes = store.execute("list_boards", {}, human).boards[0].lanes;
  return { ...store, lane: (role) => lanes.find((lane) => lane.role === role).id,
    make: (input = {}, actor = human) => store.execute("create_task", { boardId: "BOARD-1", title: "Work", ...input }, actor) };
}

test("rejection overrides claims, preserves assignment and records optional reasons", (t) => {
  const s = fixture(t);
  let task = s.make({ assignee: worker.id }, worker);
  task = s.execute("claim_task", { id: task.id, expectedVersion: task.version }, worker);
  assert.throws(() => s.execute("reject_task", { id: task.id, expectedVersion: task.version }, worker), { code: "FORBIDDEN" });
  assert.throws(() => s.execute("reject_task", { id: task.id, expectedVersion: 1 }, human), { code: "VERSION_CONFLICT" });
  task = s.execute("reject_task", { id: task.id, expectedVersion: task.version, reason: "  Scope removed  " }, human);
  assert.equal(task.role, "in_progress");
  assert.equal(task.archived, true);
  assert.equal(task.assignee, worker.id);
  assert.equal(task.lease, null);
  assert.equal(task.delegatedTo, "");
  assert.equal(task.delegatedBy, "");
  assert.equal(task.events.at(-1).kind, "reject_task");
  assert.equal(task.events.at(-1).body, "Scope removed");
  assert.equal(s.execute("list_notifications", {}, worker).items.at(-1).kind, "reject_task");
  assert.throws(() => s.execute("reject_task", { id: task.id, expectedVersion: task.version }, human), { code: "ARCHIVED" });
  let delegated = s.make();
  delegated = s.execute("delegate_task", { id: delegated.id, expectedVersion: delegated.version, delegatedTo: worker.id }, architect);
  delegated = s.execute("reject_task", { id: delegated.id, expectedVersion: delegated.version }, architect);
  assert.equal(delegated.delegatedBy, "");
  assert.equal(delegated.delegatedTo, "");
  assert.equal(delegated.events.at(-1).body, "");
});

test("rejection removes tasks from active lists and restore returns the original lane", (t) => {
  const s = fixture(t);
  let task = s.make({}, worker);
  task = s.execute("reject_task", { id: task.id, expectedVersion: task.version }, architect);
  for (const [command, input] of [
    ["claim_task", {}], ["delegate_task", { delegatedTo: "external" }],
    ["submit_review", { summary: "Done" }],
  ]) assert.throws(() => s.execute(command, { id: task.id, expectedVersion: task.version, ...input }, architect), { code: "ARCHIVED" });
  assert.equal(s.execute("list_tasks", {}, human).tasks.length, 0);
  task = s.execute("restore_task", { id: task.id, expectedVersion: task.version }, human);
  assert.equal(task.role, "todo");
  assert.equal(task.archived, false);
  task = s.execute("claim_task", { id: task.id, expectedVersion: task.version }, worker);
  assert.equal(task.role, "in_progress");
});

test("rejected tasks are terminal for epics and retain blocked links", (t) => {
  const s = fixture(t);
  const epic = s.execute("create_epic", { boardId: "BOARD-1", title: "Scope" }, human);
  let blocker = s.make({ epic: epic.id });
  const blocked = s.make({ blockedBy: [blocker.id] });
  blocker = s.execute("reject_task", { id: blocker.id, expectedVersion: blocker.version }, human);
  assert.equal(s.execute("get_task", { id: blocked.id }, human).links[0].archived, true);
  const counts = s.execute("list_epics", {}, human).epics.find((item) => item.id === epic.id).counts;
  assert.equal(counts.todo, 0);
  assert.equal("rejected" in counts, false);
  assert.equal(counts.done, 0);
  assert.equal(s.execute("archive_epic", { id: epic.id, expectedVersion: epic.version }, human).archived, true);
});

test("schema 20 archives rejected tasks, removes their lanes and preserves IDs and history", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tnb-rejected-"));
  const path = join(dir, "workspace.sqlite");
  let store = createStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let task = store.execute("create_task", { boardId: "BOARD-1", title: "Preserved", assignee: worker.id }, worker);
  task = store.execute("claim_task", { id: task.id, expectedVersion: task.version }, worker);
  const originalEvents = task.events;
  const before = store.execute("list_boards", {}, human).boards[0];
  const view = store.execute("create_view", { name: "Scope", filters: { conditions: [
    { field: "lane", op: "is", values: [before.lanes[0].id] },
    { field: "role", op: "is", values: ["todo"] },
    { field: "priority", op: "is", values: ["high"] },
  ] } }, human);
  store.close();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE old_lanes(number INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('todo','in_progress','in_review','done','rejected')));
    INSERT INTO old_lanes SELECT * FROM lanes; DROP TABLE lanes; ALTER TABLE old_lanes RENAME TO lanes;
    CREATE INDEX lanes_by_board ON lanes(board_id,position); DELETE FROM migrations WHERE version=20;
    INSERT INTO lanes(number,board_id,position,name,role) VALUES(100,'BOARD-1',4,'Rejected','rejected');`);
  const stored = JSON.parse(db.prepare("SELECT data FROM tasks WHERE json_extract(data, '$.id')=?").get(task.id).data);
  stored.lane = "LANE-100";
  stored.delegatedTo = worker.id;
  stored.delegatedBy = architect.id;
  db.prepare("UPDATE tasks SET data=? WHERE json_extract(data, '$.id')=?").run(JSON.stringify(stored), task.id);
  const savedView = JSON.parse(db.prepare("SELECT data FROM views WHERE json_extract(data, '$.id')=?").get(view.id).data);
  savedView.filters.conditions[0].values.push("LANE-100");
  savedView.filters.conditions[1].values.push("rejected");
  db.prepare("UPDATE views SET data=? WHERE json_extract(data, '$.id')=?").run(JSON.stringify(savedView), view.id);
  db.close();
  store = createStore(path);
  const board = store.execute("list_boards", {}, human).boards[0];
  assert.deepEqual(board.lanes.map((lane) => lane.id), before.lanes.map((lane) => lane.id));
  assert.equal(board.version, before.version + 1);
  const converted = store.execute("get_task", { id: task.id }, human);
  assert.equal(converted.archived, true);
  assert.equal(converted.role, "todo");
  assert.equal(converted.assignee, worker.id);
  assert.equal(converted.version, task.version + 1);
  assert.equal(converted.lease, null);
  assert.equal(converted.delegatedTo, "");
  assert.equal(converted.delegatedBy, "");
  assert.deepEqual(converted.events, originalEvents);
  const convertedView = store.execute("list_views", {}, human).views.find((item) => item.id === view.id);
  assert.deepEqual(convertedView.filters, view.filters);
  assert.equal(convertedView.version, view.version + 1);
  assert.equal(store.execute("workspace_info", {}, human).schemaVersion, 20);
  const added = store.execute("create_lane", { boardId: board.id, expectedVersion: board.version, name: "Next", role: "todo" }, human);
  assert.equal(added.lanes.at(-1).id, "LANE-101");
  store.close(); store = createStore(path);
  assert.equal(store.execute("get_task", { id: task.id }, human).version, converted.version);
});
