import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { planInput, matchCommands, UsageError } from "../cli/commands.ts";
import { editLine, insert } from "../cli/editor.ts";
import { App, clean } from "../dist-cli/app.mjs";

const run = promisify(execFile);
const task = (patch = {}) => ({
  id: "TNB-001", title: "Ship it", description: "", acceptance: "", status: "in_review",
  priority: "medium", assignee: "", labels: [], version: 4, commentCount: 0, lease: null,
  boardId: "BOARD-1", updatedAt: "2026-09-29T00:00:00.000Z", ...patch,
});
const board = (patch = {}) => ({
  id: "BOARD-2", name: "Engineering", prefix: "ENG", version: 1,
  createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z", ...patch,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const key = (patch = {}) => ({ ctrl: false, meta: false, shift: false, ...patch });

test("slash commands map to versioned workspace requests", () => {
  assert.deepEqual(planInput("/move review", task()).request, {
    name: "update_task",
    args: { id: "TNB-001", expectedVersion: 4, patch: { status: "in_review" } },
  });
  const review = planInput("/review Done and tested https://ci.example/run/7", task());
  assert.deepEqual(review.request.args, {
    id: "TNB-001", expectedVersion: 4, summary: "Done and tested", artifactUrl: "https://ci.example/run/7",
  });
  assert.deepEqual(
    planInput("/new  Write docs ", undefined, { boardId: "BOARD-2" }).request.args,
    { boardId: "BOARD-2", title: "Write docs" },
  );
  assert.throws(() => planInput("/new Write docs", undefined), /Select a board first/);
  assert.deepEqual(planInput("/board", undefined), { kind: "boards" });
  assert.deepEqual(
    planInput("/board board-2", undefined),
    { kind: "select-board", boardId: "BOARD-2" },
  );
  const createBoard = planInput("/board create ENG Engineering", undefined);
  assert.deepEqual(createBoard.request, {
    name: "create_board",
    args: { name: "Engineering", prefix: "ENG" },
  });
  assert.deepEqual(planInput("/board UNKNOWN", undefined), {
    kind: "select-board",
    boardId: "UNKNOWN",
  });
  assert.equal(planInput("/exit", undefined).kind, "quit");
  assert.deepEqual(matchCommands("/re").map((c) => c.name), ["release", "review", "refresh"]);
  assert.deepEqual(matchCommands("/move x"), []);
  for (const [input, t] of [["/archive", task()], ["/move", task()], ["/comment hi", undefined], ["/nope", task()]])
    assert.throws(() => planInput(input, t), UsageError, input);
});

test("the prompt edits text and never keeps line breaks", () => {
  const line = { text: "fix the bug", cursor: 11 };
  assert.deepEqual(editLine(line, "", key({ delete: true })), { text: "fix the bu", cursor: 10 });
  assert.deepEqual(editLine(line, "w", key({ ctrl: true })), { text: "fix the ", cursor: 8 });
  assert.equal(editLine(line, "", key({ return: true })), null);
  assert.deepEqual(insert({ text: "", cursor: 0 }, "a\nb"), { text: "a b", cursor: 3 });
});

test("task text cannot send terminal control sequences", () => {
  assert.equal(clean("ok\u001b]0;pwned\u0007\tend"), "ok ]0;pwned   end");
});

test("the board runs commands, keeps the prompt on a conflict, and refreshes", async () => {
  const calls = [];
  let conflict = true;
  const client = {
    mode: "local",
    target: "test.sqlite",
    close() {},
    async execute(name, args) {
      calls.push([name, args]);
      if (name === "workspace_info") return { name: "Studio", actor: { id: "you", kind: "human" }, actors: [], boards: [board({ id: "BOARD-1", name: "Product", prefix: "TNB" }), board()], schemaVersion: 3 };
      if (name === "list_tasks") return { tasks: [task()], total: 1 };
      if (name === "update_task" && conflict) {
        conflict = false;
        throw Object.assign(new Error("Task changed. Read it again."), { code: "VERSION_CONFLICT" });
      }
      return task({ status: "done", version: 5 });
    },
  };
  const ui = render(createElement(App, { client, pollMs: 60000 }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const type = async (text) => {
    for (const ch of text) {
      ui.stdin.write(ch);
      await settle();
    }
  };
  await settle();
  assert.match(ui.lastFrame(), /Studio · you \(human\) · All boards/);
  assert.match(ui.lastFrame(), /❯ TNB-001\s+\[BOARD-1\]\s+● Ship it/);

  await type("/do");
  assert.match(ui.lastFrame(), /❯ \/done\s+Mark the reviewed task Done/);
  await type("\r");
  assert.match(ui.lastFrame(), /VERSION_CONFLICT: Task changed/);
  assert.match(ui.lastFrame(), /> \/done/);

  const lists = calls.filter(([name]) => name === "list_tasks").length;
  await type("\r");
  assert.match(ui.lastFrame(), /TNB-001 is Done\./);
  assert.deepEqual(calls.filter(([name]) => name === "update_task").at(-1)[1], {
    id: "TNB-001", expectedVersion: 4, patch: { status: "done" },
  });
  assert.ok(calls.filter(([name]) => name === "list_tasks").length > lists);
  ui.unmount();
});

test("interactive task creation requires and uses the selected board", async (t) => {
  const calls = [];
  const boards = [board({ id: "BOARD-1", name: "Product", prefix: "TNB" })];
  const liveBoards = [...boards, board()];
  const client = {
    mode: "local",
    target: "test.sqlite",
    close() {},
    async execute(name, args) {
      calls.push([name, args]);
      if (name === "workspace_info")
        return { name: "Studio", actor: { id: "you", kind: "human" }, boards };
      if (name === "list_boards") return { boards: liveBoards };
      if (name === "list_tasks") return { tasks: [], total: 0 };
      if (name === "create_task")
        return task({ id: "ENG-001", title: args.title, boardId: args.boardId });
      return task();
    },
  };
  const ui = render(createElement(App, { client, pollMs: 60000 }));
  t.after(() => ui.unmount());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const type = async (text) => {
    for (const ch of text) {
      ui.stdin.write(ch);
      await settle();
    }
  };
  await settle();

  await type("/new Must choose a board");
  await type("\r");
  assert.match(ui.lastFrame(), /Select a board first with \/board <id>/);
  assert.equal(calls.filter(([name]) => name === "create_task").length, 0);
  ui.stdin.write("\u001b");
  await settle();

  await type("/board");
  await type("\r");
  assert.match(ui.lastFrame(), /BOARD-2  Engineering/);
  await type("/board BOARD-2");
  await type("\r");
  assert.match(ui.lastFrame(), /Engineering · BOARD-2/);

  await type("/new Selected only");
  await type("\r");
  assert.deepEqual(
    calls.find(([name]) => name === "create_task")[1],
    { boardId: "BOARD-2", title: "Selected only" },
  );
  liveBoards[1] = board({ name: "Renamed by GUI" });
  await type("/refresh");
  await type("\r");
  assert.match(ui.lastFrame(), /Renamed by GUI · BOARD-2/);
  assert.ok(calls.filter(([name]) => name === "list_boards").length >= 3);
  ui.unmount();
});

test("late board refreshes cannot replace tasks or errors for the selected board", async (t) => {
  const oldBoardTasks = deferred();
  const oldBoardError = deferred();
  const calls = [];
  const boards = [
    board({ id: "BOARD-1", name: "Product", prefix: "TNB" }),
    board(),
  ];
  let boardOneRequests = 0;
  const client = {
    mode: "local",
    target: "test.sqlite",
    close() {},
    async execute(name, args) {
      calls.push([name, args]);
      if (name === "workspace_info")
        return { name: "Studio", actor: { id: "you", kind: "human" }, boards };
      if (name === "list_boards") return { boards };
      if (name === "list_tasks" && args.boardId === "BOARD-1") {
        boardOneRequests++;
        return boardOneRequests === 1
          ? oldBoardTasks.promise
          : oldBoardError.promise;
      }
      if (name === "list_tasks" && args.boardId === "BOARD-2")
        return {
          tasks: [task({ id: "ENG-001", title: "Engineering task", boardId: "BOARD-2" })],
          total: 1,
        };
      if (name === "list_tasks") return { tasks: [], total: 0 };
      return task();
    },
  };
  const ui = render(createElement(App, { client, pollMs: 60000 }));
  t.after(() => ui.unmount());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const type = async (text) => {
    for (const ch of text) {
      ui.stdin.write(ch);
      await settle();
    }
  };
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (condition()) return;
      await settle();
    }
    assert.fail("Timed out waiting for the board request.");
  };

  await settle();
  await type("/board BOARD-1");
  await type("\r");
  await waitFor(() => boardOneRequests === 1);

  await type("/refresh");
  await type("\r");
  await waitFor(() => boardOneRequests === 2);

  await type("/board BOARD-2");
  await type("\r");
  await waitFor(() => /Engineering task/.test(ui.lastFrame()));
  assert.match(ui.lastFrame(), /Engineering · BOARD-2/);

  oldBoardTasks.resolve({
    tasks: [task({ id: "TNB-OLD", title: "Old Product task", boardId: "BOARD-1" })],
    total: 1,
  });
  oldBoardError.reject(
    Object.assign(new Error("Stale Product request"), { code: "NETWORK" }),
  );
  await settle();
  await settle();

  assert.match(ui.lastFrame(), /Engineering task/);
  assert.match(ui.lastFrame(), /● live/);
  assert.doesNotMatch(ui.lastFrame(), /Old Product task|Stale Product request/);
});

test("one-shot commands print JSON and fail with a JSON error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, TASKNBOARD_DB: join(directory, "cli.sqlite") };
  delete env.TASKNBOARD_SERVER_URL;
  // Run the executable itself, as the installed `tasknboard` command does.
  const cli = (...args) => run("dist-cli/tasknboard.mjs", args, { env });
  const createdBoard = JSON.parse((await cli("create_board", '{"name":"Engineering","prefix":"ENG"}')).stdout);
  assert.match(createdBoard.id, /^BOARD-\d+$/);
  const boards = JSON.parse((await cli("list_boards")).stdout);
  assert.ok(boards.boards.some((b) => b.id === createdBoard.id));
  const created = JSON.parse((await cli("create_task", JSON.stringify({ boardId: createdBoard.id, title: "From the shell" }))).stdout);
  assert.equal(created.boardId, createdBoard.id);
  const listed = JSON.parse((await cli("list_tasks", JSON.stringify({ boardId: createdBoard.id }))).stdout);
  assert.deepEqual(listed.tasks.map((t) => t.title), ["From the shell"]);
  assert.deepEqual(listed.tasks.map((t) => t.boardId), [createdBoard.id]);
  await assert.rejects(cli("get_task", "{not json"), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).code, "USAGE");
    return true;
  });
});
