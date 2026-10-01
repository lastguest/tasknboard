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
// Board N owns lanes LANE-<10N+1>…, named after the four default lanes.
const lanes = (n) =>
  [["Backlog", "todo"], ["In progress", "in_progress"], ["In review", "in_review"], ["Done", "done"]]
    .map(([name, role], i) => ({ id: `LANE-${n * 10 + i + 1}`, name, role }));
const task = (patch = {}) => ({
  id: "TNB-1", title: "Ship it", description: "", acceptance: "", lane: "LANE-13", role: "in_review",
  priority: "medium", assignee: "", labels: [], version: 4, commentCount: 0, lease: null,
  boardId: "BOARD-1", updatedAt: "2026-09-29T00:00:00.000Z", ...patch,
});
const board = (patch = {}) => ({
  id: "BOARD-2", name: "Engineering", prefix: "ENG", version: 1, lanes: lanes(2),
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
  const boards = [board({ id: "BOARD-1", lanes: lanes(1) })];
  assert.deepEqual(planInput("/move in progress", task(), { boards }).request, {
    name: "update_task",
    args: { id: "TNB-1", expectedVersion: 4, patch: { lane: "LANE-12" } },
  });
  const review = planInput("/review Done and tested https://ci.example/run/7", task());
  assert.deepEqual(review.request.args, {
    id: "TNB-1", expectedVersion: 4, summary: "Done and tested", artifactUrl: "https://ci.example/run/7",
  });
  assert.deepEqual(
    planInput("/new  Write docs ", undefined, { boardId: "BOARD-2" }).request.args,
    { boardId: "BOARD-2", title: "Write docs" },
  );
  assert.throws(() => planInput("/new Write docs", undefined), /Select a board first/);
  assert.deepEqual(planInput("/link blocked_by tnb-2", task()).request, {
    name: "link_task",
    args: { id: "TNB-1", expectedVersion: 4, type: "blocked_by", target: "TNB-2" },
  });
  assert.deepEqual(planInput("/unlink tnb-2", task()).request, {
    name: "unlink_task",
    args: { id: "TNB-1", expectedVersion: 4, target: "TNB-2" },
  });
  assert.deepEqual(
    planInput("/pr https://github.com/acme/web/pull/7 acme/api#3", task()).request,
    {
      name: "link_pull_requests",
      args: {
        id: "TNB-1",
        expectedVersion: 4,
        pullRequests: ["https://github.com/acme/web/pull/7", "acme/api#3"],
      },
    },
  );
  assert.deepEqual(planInput("/unpr acme/api#3", task()).request, {
    name: "unlink_pull_request",
    args: { id: "TNB-1", expectedVersion: 4, pullRequest: "acme/api#3" },
  });
  assert.throws(() => planInput("/link follows TNB-2", task()), /Choose a link type/);
  assert.throws(() => planInput("/link blocks", task()), /Usage: \/link/);
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
  for (const [input, t] of [["/archive", task()], ["/move", task()], ["/move Done", task()], ["/comment hi", undefined], ["/nope", task()]])
    assert.throws(() => planInput(input, t), UsageError, input);
});

test("/move takes a lane name or a unique start of one on the task's board", () => {
  const custom = [
    { id: "LANE-1", name: "Inbox", role: "todo" },
    { id: "LANE-2", name: "Ready", role: "todo" },
    { id: "LANE-3", name: "Doing", role: "in_progress" },
    { id: "LANE-4", name: "In review", role: "in_review" },
    { id: "LANE-5", name: "Shipped", role: "done" },
    { id: "LANE-6", name: "Archive", role: "done" },
  ];
  const boards = [board({ id: "BOARD-1", lanes: custom }), board()];
  const move = (input) => planInput(input, task({ lane: "LANE-4" }), { boards });
  assert.deepEqual(move("/move ready").request.args.patch, { lane: "LANE-2" });
  assert.deepEqual(move("/move IN REVIEW").request.args.patch, { lane: "LANE-4" });
  assert.deepEqual(move("/move do").request.args.patch, { lane: "LANE-3" });
  assert.equal(move("/move sh").message(), "TNB-1 moved to Shipped.");
  // "In" starts Inbox and In review; "Backlog" is a lane of another board.
  for (const input of ["/move in", "/move backlog"])
    assert.throws(
      () => move(input),
      (e) => e instanceof UsageError &&
        e.message === "Choose a lane: Inbox, Ready, Doing, In review, Shipped, Archive.",
      input,
    );
  // The leftmost done lane receives reviewed work.
  const done = planInput("/done", task({ lane: "LANE-4" }), { boards });
  assert.deepEqual(done.request.args, { id: "TNB-1", expectedVersion: 4, patch: { lane: "LANE-5" } });
  assert.equal(done.message(), "TNB-1 is in Shipped.");
  assert.throws(() => planInput("/done", task({ boardId: "BOARD-9" }), { boards }), /Board not loaded/);
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
  const boards = [board({ id: "BOARD-1", name: "Product", prefix: "TNB", lanes: lanes(1) }), board()];
  let conflict = true;
  const client = {
    mode: "local",
    target: "test.sqlite",
    close() {},
    async execute(name, args) {
      calls.push([name, args]);
      if (name === "workspace_info") return { name: "Studio", actor: { id: "you", kind: "human" }, actors: [], boards, schemaVersion: 18 };
      if (name === "list_boards") return { boards };
      if (name === "list_tasks") return { tasks: [task(), task({ id: "ENG-1", title: "Plan it", boardId: "BOARD-2", lane: "LANE-21", role: "todo" })], total: 2 };
      if (name === "update_task" && conflict) {
        conflict = false;
        throw Object.assign(new Error("Task changed. Read it again."), { code: "VERSION_CONFLICT" });
      }
      return task({ lane: "LANE-14", role: "done", version: 5 });
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
  assert.match(ui.lastFrame(), /● Product · In review 1\n❯ TNB-1\s+\[BOARD-1\]\s+● Ship it[^]*● Engineering · Backlog 1\n\s+ENG-1/);

  await type("/do");
  assert.match(ui.lastFrame(), /❯ \/done\s+Mark the reviewed task Done/);
  await type("\r");
  assert.match(ui.lastFrame(), /VERSION_CONFLICT: Task changed/);
  assert.match(ui.lastFrame(), /> \/done/);

  const lists = calls.filter(([name]) => name === "list_tasks").length;
  await type("\r");
  assert.match(ui.lastFrame(), /TNB-1 is in Done\./);
  assert.deepEqual(calls.filter(([name]) => name === "update_task").at(-1)[1], {
    id: "TNB-1", expectedVersion: 4, patch: { lane: "LANE-14" },
  });
  assert.ok(calls.filter(([name]) => name === "list_tasks").length > lists);
  ui.unmount();
});

test("task detail names the task's lane and each linked task's lane", async (t) => {
  const boards = [board({ id: "BOARD-1", name: "Product", prefix: "TNB", lanes: lanes(1) }), board()];
  const client = {
    mode: "local",
    target: "test.sqlite",
    close() {},
    async execute(name) {
      if (name === "workspace_info") return { name: "Studio", actor: { id: "you", kind: "human" }, actors: [], boards };
      if (name === "list_boards") return { boards };
      if (name === "list_tasks") return { tasks: [task()], total: 1 };
      return task({
        links: [{ type: "blocks", id: "ENG-4", title: "Deploy", lane: "LANE-22", role: "in_progress", archived: false }],
      });
    },
  };
  const ui = render(createElement(App, { client, pollMs: 60000 }));
  t.after(() => ui.unmount());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  await settle();
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame(), /In review · medium priority · unassigned · v4/);
  assert.match(ui.lastFrame(), /Blocks ENG-4 Deploy · In progress/);
});

test("interactive task creation requires and uses the selected board", async (t) => {
  const calls = [];
  const boards = [board({ id: "BOARD-1", name: "Product", prefix: "TNB", lanes: lanes(1) })];
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
        return task({ id: "ENG-1", title: args.title, boardId: args.boardId });
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
    board({ id: "BOARD-1", name: "Product", prefix: "TNB", lanes: lanes(1) }),
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
          tasks: [task({ id: "ENG-1", title: "Engineering task", boardId: "BOARD-2", lane: "LANE-23" })],
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
  // Windows has no shebang: the installed command there calls node.
  const cli = (...args) =>
    process.platform === "win32"
      ? run(process.execPath, ["dist-cli/tasknboard.mjs", ...args], { env })
      : run("dist-cli/tasknboard.mjs", args, { env });
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
