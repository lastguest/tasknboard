import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };

test("archive categories follow the latest archive action and preserve the saved lane", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  let task = store.execute("create_task", { boardId: "BOARD-1", title: "Archive category" }, human);
  const lane = task.lane;
  assert.equal(task.archiveCategory, null);
  task = store.execute("reject_task", { id: task.id, expectedVersion: task.version, reason: "No longer needed" }, human);
  assert.equal(task.archiveCategory, "rejected");
  assert.equal(task.lane, lane);
  assert.equal(store.execute("list_tasks", { archived: true }, human).tasks.find((row) => row.id === task.id).archiveCategory, "rejected");
  task = store.execute("restore_task", { id: task.id, expectedVersion: task.version }, human);
  assert.equal(task.archiveCategory, null);
  assert.equal(task.lane, lane);
  task = store.execute("archive_task", { id: task.id, expectedVersion: task.version }, human);
  assert.equal(task.archiveCategory, "archived");
  assert.equal(store.execute("get_task", { id: task.id }, human).archiveCategory, "archived");
  assert.equal(task.events.some((event) => event.kind === "reject_task"), true);
});

test("board prefix changes preserve the category in existing rejection history", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const created = store.execute("create_task", { boardId: "BOARD-1", title: "Existing rejected card" }, human);
  store.execute("reject_task", { id: created.id, expectedVersion: created.version }, human);
  const board = store.execute("list_boards", {}, human).boards.find((board) => board.id === "BOARD-1");
  store.execute("update_board", { id: board.id, expectedVersion: board.version, patch: { prefix: "NEW" } }, human);
  const renamed = store.execute("list_tasks", { archived: true, boardId: board.id }, human).tasks[0];
  assert.equal(renamed.id, "NEW-1");
  assert.equal(renamed.archiveCategory, "rejected");
  assert.equal(store.execute("get_task", { id: created.id }, human).archiveCategory, "rejected");
});
