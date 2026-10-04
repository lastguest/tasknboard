import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../server/store.mjs";
const human = { id: "you", kind: "human" },
  agent = { id: "bot", kind: "agent" };
function fixture(t) {
  let now = 1000000;
  const store = createStore(":memory:", { clock: () => now });
  t.after(() => store.close());
  const board = () => store.execute("list_boards", {}, human).boards[0];
  return {
    ...store,
    advance: () => {
      now += 900001;
    },
    board,
    lane: (name) => board().lanes.find((l) => l.name === name).id,
    addLane: (name, role, position) =>
      store.execute(
        "create_lane",
        { boardId: "BOARD-1", expectedVersion: board().version, name, role, position },
        human,
      ),
    make: (title = "Work") =>
      store.execute("create_task", { boardId: "BOARD-1", title }, human),
  };
}

test("a new board gets one lane per role and humans manage its lanes", (t) => {
  const s = fixture(t);
  assert.deepEqual(
    s.board().lanes.map((l) => [l.name, l.role]),
    [
      ["Backlog", "todo"],
      ["In progress", "in_progress"],
      ["In review", "in_review"],
      ["Done", "done"],
    ],
  );
  const other = s.execute("create_board", { name: "Ops", prefix: "OPS" }, human);
  assert.deepEqual(other.lanes.map((l) => l.role), ["todo", "in_progress", "in_review", "done"]);
  assert.notDeepEqual(other.lanes.map((l) => l.id), s.board().lanes.map((l) => l.id));

  const version = s.board().version;
  let board = s.addLane("Testing", "in_progress", 2);
  assert.equal(board.version, version + 1);
  assert.deepEqual(board.lanes.map((l) => l.name), ["Backlog", "In progress", "Testing", "In review", "Done"]);
  board = s.execute(
    "update_lane",
    { id: s.lane("Testing"), expectedVersion: board.version, patch: { name: "QA", position: 0 } },
    human,
  );
  assert.deepEqual(board.lanes.map((l) => l.name), ["QA", "Backlog", "In progress", "In review", "Done"]);

  for (const [command, input] of [
    ["create_lane", { boardId: "BOARD-1", expectedVersion: board.version, name: "X", role: "todo" }],
    ["update_lane", { id: s.lane("QA"), expectedVersion: board.version, patch: { name: "Y" } }],
    ["delete_lane", { id: s.lane("QA"), expectedVersion: board.version, moveTo: s.lane("In progress") }],
  ])
    assert.throws(() => s.execute(command, input, agent), { code: "FORBIDDEN" });
  assert.throws(
    () => s.execute("update_lane", { id: s.lane("QA"), expectedVersion: version, patch: { name: "Y" } }, human),
    { code: "VERSION_CONFLICT" },
  );
  assert.throws(() => s.addLane("backlog", "todo"), { code: "VALIDATION", message: /already has a lane named/ });
  while (s.board().lanes.length < 12) s.addLane(`Lane ${s.board().lanes.length}`, "todo");
  assert.throws(() => s.addLane("Too many", "todo"), { code: "VALIDATION", message: /at most 12 lanes/ });
});

test("deleting a lane moves every task and view to a lane of the same role", (t) => {
  const s = fixture(t);
  s.addLane("Testing", "in_progress");
  const testing = s.lane("Testing");
  let claimed = s.make("Claimed");
  claimed = s.execute("claim_task", { id: claimed.id, expectedVersion: claimed.version }, agent);
  claimed = s.execute(
    "update_task",
    { id: claimed.id, expectedVersion: claimed.version, patch: { lane: testing } },
    agent,
  );
  let archived = s.make("Archived");
  archived = s.execute("update_task", { id: archived.id, expectedVersion: archived.version, patch: { lane: testing } }, human);
  s.execute("archive_task", { id: archived.id, expectedVersion: archived.version }, human);
  const view = s.execute(
    "create_view",
    {
      name: "Testing",
      filters: { conditions: [{ field: "lane", op: "is", values: [testing, s.lane("In progress")] }] },
    },
    human,
  );

  const counts = () =>
    Object.fromEntries(s.board().lanes.map((l) => [l.name, [l.tasks, l.archivedTasks]]));
  assert.deepEqual(counts(), {
    Backlog: [0, 0],
    "In progress": [0, 0],
    "In review": [0, 0],
    Done: [0, 0],
    Testing: [1, 1],
  });
  assert.throws(
    () =>
      s.execute("delete_lane", { id: testing, expectedVersion: s.board().version, moveTo: s.lane("Backlog") }, human),
    { code: "VALIDATION", message: /another in_progress lane/ },
  );
  const otherBoard = s.execute("create_board", { name: "Ops", prefix: "OPS" }, human);
  assert.throws(
    () =>
      s.execute(
        "delete_lane",
        { id: testing, expectedVersion: s.board().version, moveTo: otherBoard.lanes[1].id },
        human,
      ),
    { code: "VALIDATION" },
  );
  const board = s.execute(
    "delete_lane",
    { id: testing, expectedVersion: s.board().version, moveTo: s.lane("In progress") },
    human,
  );
  assert.equal(board.lanes.some((l) => l.id === testing), false);
  assert.deepEqual(board.lanes.map((l) => l.name), ["Backlog", "In progress", "In review", "Done"]);
  assert.deepEqual(counts()["In progress"], [1, 1]);

  const moved = s.execute("get_task", { id: claimed.id }, agent);
  assert.equal(moved.lane, s.lane("In progress"));
  assert.equal(moved.version, claimed.version + 1);
  assert.equal(moved.lease.actor, "bot");
  assert.deepEqual(JSON.parse(moved.events.at(-1).body), { from: testing, to: s.lane("In progress") });
  // The agent holding the claim reads the task again and continues.
  assert.throws(
    () => s.execute("heartbeat", { id: claimed.id, expectedVersion: claimed.version }, agent),
    { code: "VERSION_CONFLICT" },
  );
  s.execute("heartbeat", { id: claimed.id, expectedVersion: moved.version }, agent);
  assert.equal(s.execute("get_task", { id: archived.id }, human).lane, s.lane("In progress"));
  const [updatedView] = s.execute("list_views", {}, human).views;
  assert.deepEqual(updatedView.filters.conditions[0].values, [s.lane("In progress")]);
  assert.equal(updatedView.version, view.version + 1);

  for (const name of ["Backlog", "In progress", "In review", "Done"])
    assert.throws(
      () =>
        s.execute(
          "delete_lane",
          { id: s.lane(name), expectedVersion: s.board().version, moveTo: s.lane(name === "Done" ? "Backlog" : "Done") },
          human,
        ),
      { code: "LANE_REQUIRED" },
    );
});

test("lane roles keep the claim flow and the human review gate", (t) => {
  const s = fixture(t);
  s.addLane("Coding", "in_progress", 1);
  s.addLane("Testing", "in_progress");
  s.addLane("Ready", "todo");
  const ready = s.lane("Ready");
  let task = s.execute("create_task", { boardId: "BOARD-1", title: "Ready work", lane: ready }, human);
  assert.equal(task.lane, ready);
  assert.equal(task.role, "todo");
  const imported = s.execute("create_task", { boardId: "BOARD-1", title: "Late", lane: s.lane("Done") }, human);
  assert.equal(imported.role, "done");

  // A claim moves todo work to the leftmost in_progress lane.
  task = s.execute("claim_task", { id: task.id, expectedVersion: task.version }, agent);
  assert.equal(task.lane, s.lane("Coding"));
  assert.equal(task.role, "in_progress");
  task = s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: s.lane("Testing") } }, agent);
  assert.equal(task.lease.actor, "bot");
  for (const name of ["Backlog", "In review"])
    assert.throws(
      () => s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: s.lane(name) } }, agent),
      { code: "FORBIDDEN" },
    );
  const otherBoard = s.execute("create_board", { name: "Ops", prefix: "OPS" }, human);
  assert.throws(
    () =>
      s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: otherBoard.lanes[1].id } }, agent),
    { code: "VALIDATION" },
  );
  task = s.execute("submit_review", { id: task.id, expectedVersion: task.version, summary: "Tests pass" }, agent);
  assert.equal(task.lane, s.lane("In review"));
  assert.equal(task.lease, null);
  assert.throws(
    () => s.execute("claim_task", { id: task.id, expectedVersion: task.version }, agent),
    { code: "INVALID_TRANSITION" },
  );

  // Humans must send a task to review before they move it to a done lane.
  let fresh = s.make("Unreviewed");
  assert.throws(
    () => s.execute("update_task", { id: fresh.id, expectedVersion: fresh.version, patch: { lane: s.lane("Done") } }, human),
    { code: "INVALID_TRANSITION" },
  );
  task = s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: s.lane("Done") } }, human);
  assert.equal(task.role, "done");
  s.addLane("Released", "done");
  task = s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: s.lane("Released") } }, human);
  assert.equal(task.role, "done");

  // Filters and counts read roles.
  const ids = (args) => s.execute("list_tasks", args, human).tasks.map((x) => x.id);
  assert.deepEqual(ids({ role: "done" }), [imported.id, task.id]);
  assert.deepEqual(ids({ lane: s.lane("Backlog") }), [fresh.id]);
  assert.equal(s.board().inProgress, 0);
  fresh = s.execute("claim_task", { id: fresh.id, expectedVersion: fresh.version }, agent);
  assert.equal(s.board().inProgress, 1);
  const linked = s.execute("link_task", { id: fresh.id, expectedVersion: fresh.version, type: "relates", target: task.id }, agent);
  assert.deepEqual(
    linked.links.map(({ lane, role }) => ({ lane, role })),
    [{ lane: s.lane("Released"), role: "done" }],
  );
});

test("agents complete claimed work in any done lane on the same board", (t) => {
  const s = fixture(t);
  s.addLane("Released", "done");
  const otherBoard = s.execute("create_board", { name: "Ops", prefix: "OPS" }, human);
  let task = s.make();
  task = s.execute("claim_task", { id: task.id, expectedVersion: task.version }, agent);
  assert.throws(
    () => s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: otherBoard.lanes.find((lane) => lane.role === "done").id } }, agent),
    { code: "VALIDATION" },
  );
  task = s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: s.lane("Released") } }, agent);
  assert.equal(task.lane, s.lane("Released"));
  assert.equal(task.role, "done");
  assert.equal(task.lease, null);
  assert.equal(s.board().inProgress, 0);
  assert.equal(s.board().lanes.find((lane) => lane.name === "Released").tasks, 1);
  assert.deepEqual(s.execute("list_tasks", { role: "done" }, human).tasks.map((entry) => entry.id), [task.id]);
});

test("the lane upgrade moves tasks, history and views from statuses to lanes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-lanes-"));
  const path = join(dir, "legacy.sqlite");
  let store = createStore(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.execute("create_board", { name: "Ops", prefix: "OPS" }, human);
  const make = (boardId, title) => store.execute("create_task", { boardId, title }, human);
  const tasks = [make("BOARD-1", "One"), make("BOARD-1", "Two"), make("BOARD-2", "Three")];
  store.execute(
    "create_view",
    {
      name: "Open",
      filters: { conditions: [{ field: "role", op: "is_not", values: ["done"] }] },
      display: { layout: "list", groupBy: "lane" },
    },
    human,
  );
  store.close();

  // Rebuild the version 16 shape: statuses on tasks, history and views.
  const db = new DatabaseSync(path);
  const statuses = ["done", "backlog", "in_review"];
  tasks.forEach((task, i) => {
    const { lane, ...stored } = JSON.parse(
      db.prepare("SELECT data FROM tasks WHERE json_extract(data, '$.id')=?").get(task.id).data,
    );
    db.prepare("UPDATE tasks SET data=? WHERE json_extract(data, '$.id')=?").run(
      JSON.stringify({ ...stored, status: statuses[i] }),
      task.id,
    );
  });
  db.prepare(
    "INSERT INTO events(task_id,actor,kind,body,created_at) VALUES(?,?,?,?,?)",
  ).run(tasks[2].id, "you", "update_task", JSON.stringify({ status: "in_review", title: "Three" }), "2026-01-01T00:00:00.000Z");
  const view = JSON.parse(db.prepare("SELECT data FROM views").get().data);
  view.filters.conditions = [{ field: "status", op: "is", values: ["backlog", "in_review"] }];
  view.display.groupBy = "status";
  db.prepare("UPDATE views SET data=?").run(JSON.stringify(view));
  db.exec("DROP TABLE lanes; DELETE FROM migrations WHERE version=18");
  db.close();

  store = createStore(path);
  const boards = store.execute("list_boards", {}, human).boards;
  const laneOf = (boardId, role) =>
    boards.find((b) => b.id === boardId).lanes.find((l) => l.role === role).id;
  const upgraded = tasks.map((task) => store.execute("get_task", { id: task.id }, human));
  assert.deepEqual(
    upgraded.map((task) => [task.lane, task.role, task.version, Object.hasOwn(task, "status")]),
    [
      [laneOf("BOARD-1", "done"), "done", 1, false],
      [laneOf("BOARD-1", "todo"), "todo", 1, false],
      [laneOf("BOARD-2", "in_review"), "in_review", 1, false],
    ],
  );
  assert.deepEqual(JSON.parse(upgraded[2].events.at(-1).body), {
    title: "Three",
    lane: laneOf("BOARD-2", "in_review"),
  });
  const [migratedView] = store.execute("list_views", {}, human).views;
  assert.deepEqual(migratedView.filters.conditions, [
    { field: "role", op: "is", values: ["todo", "in_review"] },
  ]);
  assert.equal(migratedView.display.groupBy, "lane");
  assert.equal(migratedView.version, view.version);
  assert.equal(store.execute("workspace_info", {}, human).schemaVersion, 18);
  const backup = store.execute("export_workspace", {}, human);
  assert.deepEqual(
    backup.boards[1].lanes,
    boards[1].lanes.map(({ id, name, role }) => ({ id, name, role })),
  );
});
