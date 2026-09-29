import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const agent = { id: "agent-a", kind: "agent" };

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  return store;
}

test("boards give tasks independent numbers and scope task lists and epic counts", (t) => {
  const store = fixture(t);
  const [defaultBoard] = store.execute("list_boards", {}, human).boards;
  const operations = store.execute(
    "create_board",
    { name: "Operations", prefix: "ops" },
    human,
  );
  const epic = store.execute("create_epic", { title: "Launch" }, human);
  const productTask = store.execute(
    "create_task",
    { boardId: defaultBoard.id, title: "Product work", epic: epic.id },
    human,
  );
  const operationsTask = store.execute(
    "create_task",
    { boardId: operations.id, title: "Operations work", epic: epic.id },
    human,
  );

  assert.equal(productTask.id, "TNB-001");
  assert.equal(operationsTask.id, "OPS-001");
  assert.equal(productTask.boardId, defaultBoard.id);
  assert.equal(operationsTask.boardId, operations.id);
  assert.equal(store.execute("list_tasks", {}, human).total, 2);
  assert.deepEqual(
    store.execute("list_tasks", { boardId: operations.id }, human).tasks.map((task) => task.id),
    [operationsTask.id],
  );
  assert.equal(
    store.execute("list_epics", { boardId: defaultBoard.id }, human).epics[0].counts.backlog,
    1,
  );
  assert.equal(
    store.execute("list_epics", { boardId: operations.id }, human).epics[0].counts.backlog,
    1,
  );
});

test("renaming a board prefix changes only its tasks and event references", (t) => {
  const store = fixture(t);
  const [defaultBoard] = store.execute("list_boards", {}, human).boards;
  const operations = store.execute(
    "create_board",
    { name: "Operations", prefix: "OPS" },
    human,
  );
  const first = store.execute(
    "create_task",
    { boardId: defaultBoard.id, title: "Rename me" },
    human,
  );
  const second = store.execute(
    "create_task",
    { boardId: operations.id, title: "Keep this key" },
    human,
  );
  store.execute(
    "add_comment",
    { id: first.id, expectedVersion: first.version, body: "Task history" },
    human,
  );

  const renamedBoard = store.execute(
    "update_board",
    {
      id: defaultBoard.id,
      expectedVersion: defaultBoard.version,
      patch: { prefix: "app" },
    },
    human,
  );
  assert.equal(renamedBoard.prefix, "APP");
  assert.equal(renamedBoard.version, 2);
  assert.deepEqual(renamedBoard.formerPrefixes, ["TNB"]);
  assert.equal(store.execute("get_task", { id: first.id }, human).id, "APP-001");
  assert.throws(() => store.execute("get_task", { id: "NEVER-001" }, human), {
    code: "NOT_FOUND",
  });
  const moved = store.execute("get_task", { id: "APP-001" }, human);
  assert.equal(moved.boardId, defaultBoard.id);
  assert.equal(moved.events.length, 2);
  assert.equal(store.execute("get_task", { id: second.id }, human).id, "OPS-001");
  assert.equal(
    store.execute("create_task", { boardId: defaultBoard.id, title: "Next" }, human).id,
    "APP-002",
  );

  const events = store.execute("export_workspace", {}, human).events;
  assert.equal(events.some((event) => event.task_id === "TNB-001"), false);
  assert.equal(events.filter((event) => event.task_id === "APP-001").length, 2);
  assert.ok(events.some((event) => event.task_id === defaultBoard.id && event.kind === "update_board"));
  assert.ok(events.some((event) => event.task_id === operations.id && event.kind === "created"));
});

test("former task keys redirect to their own board and never to another", (t) => {
  const store = fixture(t);
  const [originalBoard] = store.execute("list_boards", {}, human).boards;
  const originalTask = store.execute(
    "create_task",
    { boardId: originalBoard.id, title: "Original task" },
    human,
  );
  store.execute(
    "update_board",
    {
      id: originalBoard.id,
      expectedVersion: originalBoard.version,
      patch: { prefix: "APP" },
    },
    human,
  );

  assert.throws(
    () => store.execute("create_board", { name: "Reuse", prefix: "TNB" }, human),
    { code: "VALIDATION" },
  );
  const otherBoard = store.execute(
    "create_board",
    { name: "Other", prefix: "OPS" },
    human,
  );
  const otherTask = store.execute(
    "create_task",
    { boardId: otherBoard.id, title: "Other task" },
    human,
  );
  assert.equal(otherTask.id, "OPS-001");
  const redirected = store.execute(
    "update_task",
    {
      id: originalTask.id,
      expectedVersion: originalTask.version,
      patch: { title: "Write through a former key" },
    },
    human,
  );
  assert.equal(redirected.id, "APP-001");
  assert.equal(redirected.boardId, originalBoard.id);
  assert.equal(store.execute("get_task", { id: otherTask.id }, human).title, "Other task");
  assert.throws(() => store.execute("get_task", { id: "OPS-002" }, human), {
    code: "NOT_FOUND",
  });

  const reclaimed = store.execute(
    "update_board",
    { id: originalBoard.id, expectedVersion: 2, patch: { prefix: "TNB" } },
    human,
  );
  assert.equal(reclaimed.prefix, "TNB");
  assert.deepEqual(reclaimed.formerPrefixes, ["APP"]);
  assert.throws(
    () => store.execute("create_board", { name: "Reuse former", prefix: "APP" }, human),
    { code: "VALIDATION" },
  );
  const reclaimedTask = store.execute("get_task", { id: "APP-001" }, human);
  assert.equal(reclaimedTask.id, "TNB-001");
  assert.equal(reclaimedTask.title, "Write through a former key");
  const reboard = store.execute(
    "update_board",
    { id: originalBoard.id, expectedVersion: 3, patch: { prefix: "WEB" } },
    human,
  );
  assert.deepEqual(reboard.formerPrefixes, ["APP", "TNB"]);
  for (const key of ["APP-001", "TNB-001", "WEB-001"])
    assert.equal(store.execute("get_task", { id: key }, human).id, "WEB-001");
  assert.deepEqual(
    store
      .execute("list_boards", {}, human)
      .boards.map((board) => [board.prefix, board.formerPrefixes]),
    [
      ["WEB", ["APP", "TNB"]],
      ["OPS", []],
    ],
  );
  const reservations = store.execute("export_workspace", {}, human).boardPrefixReservations;
  assert.deepEqual(reservations, [
    { prefix: "APP", boardId: originalBoard.id },
    { prefix: "OPS", boardId: otherBoard.id },
    { prefix: "TNB", boardId: originalBoard.id },
    { prefix: "WEB", boardId: originalBoard.id },
  ]);
  assert.equal(
    Object.hasOwn(store.execute("export_workspace", {}, human).boards[0], "formerPrefixes"),
    false,
  );
});

test("board prefixes are unique, reserved and checked on create and update", (t) => {
  const store = fixture(t);
  const [defaultBoard] = store.execute("list_boards", {}, human).boards;
  const operations = store.execute(
    "create_board",
    { name: "Operations", prefix: "OPS" },
    human,
  );

  assert.throws(
    () => store.execute("create_board", { name: "Duplicate", prefix: "tnb" }, human),
    { code: "VALIDATION" },
  );
  assert.throws(
    () =>
      store.execute(
        "update_board",
        { id: operations.id, expectedVersion: 1, patch: { prefix: defaultBoard.prefix } },
        human,
      ),
    { code: "VALIDATION" },
  );
  for (const prefix of ["EPIC", "VIEW", "BOARD", "A", "1AB"])
    assert.throws(
      () => store.execute("create_board", { name: "Invalid", prefix }, human),
      { code: "VALIDATION" },
    );
  assert.equal(store.execute("list_boards", {}, human).boards.length, 2);
});

test("task creation requires an existing, well-formed board ID", (t) => {
  const store = fixture(t);
  assert.throws(
    () => store.execute("create_task", { title: "Missing board" }, human),
    { code: "VALIDATION" },
  );
  for (const boardId of ["board-1", "BOARD-x"])
    assert.throws(
      () => store.execute("create_task", { boardId, title: "Invalid board" }, human),
      { code: "VALIDATION" },
    );
  assert.throws(
    () => store.execute("create_task", { boardId: "BOARD-99", title: "Unknown board" }, human),
    { code: "NOT_FOUND" },
  );
  assert.throws(() => store.execute("list_tasks", { boardId: "BOARD-99" }, human), {
    code: "NOT_FOUND",
  });
  assert.throws(() => store.execute("update_workspace", {}, human), {
    code: "UNKNOWN_COMMAND",
  });
});

test("board writes are human-only and updates reject stale versions", (t) => {
  const store = fixture(t);
  assert.throws(
    () => store.execute("create_board", { name: "Agent board", prefix: "AGENT" }, agent),
    { code: "FORBIDDEN" },
  );
  const board = store.execute(
    "create_board",
    { name: "Research", prefix: "RSH" },
    human,
  );
  const updated = store.execute(
    "update_board",
    { id: board.id, expectedVersion: board.version, patch: { name: "Research 2" } },
    human,
  );
  assert.equal(updated.version, 2);
  assert.throws(
    () =>
      store.execute(
        "update_board",
        { id: board.id, expectedVersion: 1, patch: { name: "Stale" } },
        human,
      ),
    { code: "VERSION_CONFLICT" },
  );
  assert.throws(
    () =>
      store.execute(
        "update_board",
        { id: board.id, expectedVersion: updated.version, patch: { name: "Agent edit" } },
        agent,
      ),
    { code: "FORBIDDEN" },
  );
  const boardEvents = store
    .execute("export_workspace", {}, human)
    .events.filter((event) => event.task_id === board.id);
  assert.deepEqual(boardEvents.map((event) => event.kind), ["created", "update_board"]);
});

test("the board migration preserves legacy keys and epic references", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-boards-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "legacy.sqlite");
  let store = createStore(path);
  const epic = store.execute("create_epic", { title: "Legacy launch" }, human);
  const task = store.execute(
    "create_task",
    { boardId: "BOARD-1", title: "Legacy task", epic: epic.id },
    human,
  );
  store.execute(
    "add_comment",
    { id: task.id, expectedVersion: task.version, body: "Keep this event" },
    human,
  );
  store.close();

  const db = new DatabaseSync(path);
  const storedTask = JSON.parse(db.prepare("SELECT data FROM tasks WHERE number=1").get().data);
  storedTask.id = "APP-001";
  storedTask.epic = "GOAL-1";
  delete storedTask.boardId;
  db.prepare("UPDATE tasks SET data=? WHERE number=1").run(JSON.stringify(storedTask));
  const storedEpic = JSON.parse(db.prepare("SELECT data FROM epics WHERE number=1").get().data);
  storedEpic.id = "GOAL-1";
  db.prepare("UPDATE epics SET data=? WHERE number=1").run(JSON.stringify(storedEpic));
  db.prepare("UPDATE events SET task_id='APP-001' WHERE task_id=?").run(task.id);
  db.prepare("UPDATE events SET task_id='GOAL-1' WHERE task_id=?").run(epic.id);
  db.exec("CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
  db.prepare("INSERT INTO workspace VALUES(1, ?)").run(
    JSON.stringify({
      taskPrefix: "APP",
      epicPrefix: "GOAL",
      formerTaskPrefixes: ["TNB"],
      formerEpicPrefixes: ["EPIC"],
      version: 2,
    }),
  );
  db.exec("DROP TABLE boards; DROP TABLE board_prefixes; DELETE FROM migrations WHERE version=11");
  db.close();

  store = createStore(path);
  const [defaultBoard] = store.execute("list_boards", {}, human).boards;
  assert.equal(defaultBoard.id, "BOARD-1");
  assert.equal(defaultBoard.prefix, "APP");
  assert.deepEqual(Object.keys(defaultBoard).sort(), [
    "createdAt",
    "formerPrefixes",
    "id",
    "inSidebar",
    "name",
    "prefix",
    "updatedAt",
    "version",
  ]);
  const upgraded = store.execute("get_task", { id: "APP-001" }, human);
  assert.equal(upgraded.boardId, defaultBoard.id);
  assert.equal(upgraded.epic, "GOAL-1");
  assert.equal(upgraded.events.length, 2);
  assert.equal(store.execute("list_epics", {}, human).epics[0].id, "GOAL-1");
  assert.deepEqual(defaultBoard.formerPrefixes, ["TNB"]);
  assert.equal(store.execute("get_task", { id: "TNB-001" }, human).id, "APP-001");
  assert.throws(
    () => store.execute("create_board", { name: "Collision", prefix: "GOAL" }, human),
    { code: "VALIDATION" },
  );
  assert.throws(
    () => store.execute("create_board", { name: "Former", prefix: "TNB" }, human),
    { code: "VALIDATION" },
  );
  assert.throws(
    () => store.execute("archive_epic", { id: "GOAL-1", expectedVersion: 1 }, human),
    { code: "EPIC_NOT_EMPTY", message: /Legacy launch.*1 open task/ },
  );
  store.execute("archive_task", { id: "APP-001", expectedVersion: upgraded.version }, human);
  store.execute("archive_epic", { id: "GOAL-1", expectedVersion: 1 }, human);
  assert.throws(
    () =>
      store.execute(
        "create_task",
        { boardId: defaultBoard.id, title: "Archived epic", epic: "GOAL-1" },
        human,
      ),
    { code: "EPIC_ARCHIVED", message: /Legacy launch is archived/ },
  );
  assert.equal(
    store.execute("create_task", { boardId: defaultBoard.id, title: "Next" }, human).id,
    "APP-002",
  );
  const backup = store.execute("export_workspace", {}, human);
  assert.equal(backup.schemaVersion, 12);
  assert.equal(Object.hasOwn(backup, "workspace"), false);
  assert.equal(backup.tasks[0].boardId, defaultBoard.id);
  // Exports hold stored records; formerPrefixes and inSidebar are derived.
  const { formerPrefixes, inSidebar, ...storedBoard } = defaultBoard;
  assert.deepEqual(backup.boards, [storedBoard]);
  assert.deepEqual(backup.boardPrefixReservations, [
    { prefix: "APP", boardId: defaultBoard.id },
    { prefix: "TNB", boardId: defaultBoard.id },
  ]);
  // Close before the directory is removed: Windows cannot delete an open file.
  store.close();
});

test("each person hides boards from their own sidebar without changing the board", (t) => {
  const store = fixture(t);
  const other = { id: "sam", kind: "human" };
  const [defaultBoard] = store.execute("list_boards", {}, human).boards;
  const operations = store.execute(
    "create_board",
    { name: "Operations", prefix: "OPS" },
    human,
  );
  assert.equal(operations.inSidebar, true);

  const hidden = store.execute(
    "set_board_sidebar",
    { id: operations.id, inSidebar: false },
    human,
  );
  assert.equal(hidden.inSidebar, false);
  assert.equal(hidden.version, operations.version);
  const sidebar = (actor) =>
    store
      .execute("list_boards", {}, actor)
      .boards.map((board) => [board.id, board.inSidebar]);
  assert.deepEqual(sidebar(human), [
    [defaultBoard.id, true],
    [operations.id, false],
  ]);
  assert.deepEqual(sidebar(other), [
    [defaultBoard.id, true],
    [operations.id, true],
  ]);
  assert.equal(
    store
      .execute("workspace_info", {}, human)
      .boards.find((board) => board.id === operations.id).inSidebar,
    false,
  );
  // Hiding twice is a no-op, and a board edit keeps the preference.
  store.execute("set_board_sidebar", { id: operations.id, inSidebar: false }, human);
  const renamed = store.execute(
    "update_board",
    { id: operations.id, expectedVersion: operations.version, patch: { name: "Ops" } },
    human,
  );
  assert.equal(renamed.inSidebar, false);
  assert.deepEqual(store.execute("export_workspace", {}, human).boardSidebarHidden, [
    { actor: "you", boardId: operations.id },
  ]);

  assert.equal(
    store.execute("set_board_sidebar", { id: operations.id, inSidebar: true }, human)
      .inSidebar,
    true,
  );
  assert.deepEqual(store.execute("export_workspace", {}, human).boardSidebarHidden, []);
  assert.throws(
    () => store.execute("set_board_sidebar", { id: operations.id, inSidebar: false }, agent),
    { code: "FORBIDDEN" },
  );
  assert.throws(
    () => store.execute("set_board_sidebar", { id: "BOARD-99", inSidebar: false }, human),
    { code: "NOT_FOUND" },
  );
});
