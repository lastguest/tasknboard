import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const make = (title, fields = {}) => store.execute("create_task", {
    boardId: "BOARD-1", title, ...fields,
  }, human);
  const archive = (task) => store.execute("archive_task", {
    id: task.id, expectedVersion: task.version,
  }, human);
  const list = (fields = {}) => store.execute("list_tasks", fields, human);
  return { store, make, archive, list };
}

test("list_tasks selects active tasks by default and archived tasks on request", (t) => {
  const { make, archive, list, store } = fixture(t);
  const active = make("Active");
  const archived = archive(make("Archived"));
  assert.deepEqual(list().tasks.map((task) => task.id), [active.id]);
  assert.deepEqual(list({ archived: false }).tasks.map((task) => task.id), [active.id]);
  assert.deepEqual(list({ archived: true }).tasks.map((task) => task.id), [archived.id]);
  assert.equal(list({ archived: true }).tasks[0].archived, true);
  assert.throws(() => list({ archived: "true" }), { code: "VALIDATION" });
  store.execute("restore_task", { id: archived.id, expectedVersion: archived.version }, human);
  assert.equal(list({ archived: true }).total, 0);
  assert.equal(list().total, 2);
});

test("archived task lists retain filters, pagination, and comment counts", (t) => {
  const { store, make, archive, list } = fixture(t);
  const epic = store.execute("create_epic", { title: "Release", boardId: "BOARD-1" }, human);
  const board = store.execute("create_board", { name: "Other", prefix: "OTH" }, human);
  const fields = { assignee: human.id, labels: ["Bug"], epic: epic.id };
  const first = archive(make("Archived bug one", fields));
  let second = make("Archived bug two", fields);
  second = store.execute("add_comment", { id: second.id, body: "Keep the history" }, human);
  second = archive(second);
  archive(make("Other archived task"));
  archive(make("Archived bug on another board", { boardId: board.id, assignee: human.id, labels: ["Bug"] }));
  make("Archived bug active", fields);
  const view = store.execute("create_view", {
    name: "My bugs", filters: { conditions: [{ field: "assignee", op: "is", values: ["@me"] }] },
  }, human);
  const filters = {
    archived: true, boardId: "BOARD-1", query: "archived bug", role: "todo", lane: first.lane,
    assignee: human.id, owner: human.id, label: "Bug", epic: epic.id, view: view.id,
  };
  const all = list(filters);
  assert.equal(all.total, 2);
  assert.deepEqual(new Set(all.tasks.map((task) => task.id)), new Set([first.id, second.id]));
  assert.equal(all.tasks.find((task) => task.id === second.id).commentCount, 1);
  const page = list({ ...filters, offset: 1, limit: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.tasks.map((task) => task.id), [all.tasks[1].id]);
  assert.equal(list({ ...filters, offset: 2 }).tasks.length, 0);
  assert.equal(list({ ...filters, role: "done" }).total, 0);
  assert.equal(list({ ...filters, epic: "none" }).total, 0);
  assert.deepEqual(list({ ...filters, compact: true }).tasks.map((task) => task.id), all.tasks.map((task) => task.id));
});
