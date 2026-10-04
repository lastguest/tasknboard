import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { planInput, matchCommands, UsageError } from "../cli/commands.ts";
import { editLine, insert } from "../cli/editor.ts";
import { cliActor } from "../cli/identity.ts";
import { normalizeArguments, requireExpectedVersion } from "../cli/arguments.ts";
import { commandExamples, commandHelp } from "../cli/help.ts";
import { schemas } from "../server/domain.mjs";
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

test("CLI command help provides a valid example for every schema command", () => {
  assert.deepEqual(Object.keys(commandExamples).sort(), Object.keys(schemas).sort());
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schema.safeParse(commandExamples[name]).success, true, name);
    const help = commandHelp(name);
    assert.match(help, new RegExp(`Usage: tasknboard ${name}`));
    assert.ok(help.includes(JSON.stringify(commandExamples[name])), name);
    assert.ok(help.includes(`tasknboard ${name} --file <path>`), name);
    assert.ok(help.includes(`tasknboard ${name} --stdin`), name);
    assert.match(help, /On Windows, use --file or --stdin/);
    if (JSON.stringify(commandExamples[name]).includes("expectedVersion"))
      assert.match(help, /current version as expectedVersion/);
  }
  assert.match(commandHelp("claim_task"), /Read get_task/);
  assert.match(commandHelp("create_lane"), /board version/);
  assert.throws(() => commandHelp("not_a_command"), { code: "USAGE" });
});

test("CLI task aliases normalize once and reject conflicting keys", () => {
  for (const name of ["get_task", "update_task", "set_standup_notes", "claim_task", "heartbeat", "release_task", "delegate_task", "request_changes", "link_commits", "add_comment", "submit_review", "archive_task", "link_task", "unlink_task", "link_pull_requests", "unlink_pull_request"]) {
    assert.deepEqual(normalizeArguments(name, { taskId: "TNB-1", expectedVersion: 3 }), { id: "TNB-1", expectedVersion: 3 });
    assert.deepEqual(normalizeArguments(name, { id: "TNB-1", taskId: "TNB-1" }), { id: "TNB-1" });
    assert.throws(() => normalizeArguments(name, { id: "TNB-1", taskId: "TNB-2" }), { code: "USAGE" });
  }
  assert.deepEqual(normalizeArguments("bulk_move_tasks", { tasks: [{ taskId: "TNB-1", expectedVersion: 3 }], lane: "LANE-12" }), { tasks: [{ id: "TNB-1", expectedVersion: 3 }], lane: "LANE-12" });
  for (const name of ["update_board", "update_epic", "update_view", "update_lane"])
    assert.deepEqual(normalizeArguments(name, { taskId: "TNB-1" }), { taskId: "TNB-1" });
  assert.throws(() => requireExpectedVersion("claim_task", { id: "TNB-1" }), /tasknboard help claim_task/);
  assert.throws(() => requireExpectedVersion("bulk_move_tasks", { tasks: [{ id: "TNB-1" }], lane: "LANE-12" }), /tasks.0.expectedVersion is required/);
});

test("CLI identity keeps human terminal commands and requires script attribution", () => {
  assert.equal(cliActor("create_board", {}, true), undefined);
  assert.equal(cliActor("list_tasks", {}, false), undefined);
  assert.throws(() => cliActor("create_board", {}, false), { code: "ACTOR_REQUIRED" });
  assert.deepEqual(cliActor("create_board", { TASKNBOARD_AGENT_ID: "claude" }, false), { id: "claude", kind: "agent" });
  assert.throws(() => cliActor("workspace_info", { TASKNBOARD_AGENT_ID: "claude", TASKNBOARD_AGENT_ROLE: "admin" }, false), { code: "USAGE" });
});

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

test("one-shot JSON files and stdin preserve text and reject mixed input modes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-cli-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, TASKNBOARD_DB: join(directory, "cli.sqlite"), TASKNBOARD_AGENT_ID: "input-agent", TASKNBOARD_AGENT_ROLE: "architect" };
  delete env.TASKNBOARD_SERVER_URL;
  const cli = (args, input = "", environment = env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist-cli/tasknboard.mjs", ...args], { env: environment, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
  const file = join(directory, "args with spaces.json");
  await writeFile(file, '\uFEFF' + JSON.stringify({ name: "CLI safe input", prefix: "SAFE" }), "utf8");
  const result = await cli(["create_board", "--file", file]);
  assert.equal(result.code, 0, result.stderr);
  const boardId = JSON.parse(result.stdout).id;
  const text = 'more than >16 submeshes & pipes | caret ^ percent %PATH% "quotes" café 日本語\nsecond line';
  await writeFile(file, JSON.stringify({ boardId, title: text }), "utf8");
  const created = await cli(["create_task", "--file", file]);
  assert.equal(created.code, 0, created.stderr);
  const task = JSON.parse(created.stdout);
  assert.equal(task.title, text);
  const comment = await cli(["add_comment", "--stdin"], '\uFEFF' + JSON.stringify({ taskId: task.id, body: text }));
  assert.equal(comment.code, 0, comment.stderr);
  const detail = await cli(["get_task", "--stdin"], JSON.stringify({ id: task.id }));
  assert.equal(detail.code, 0, detail.stderr);
  assert.equal(JSON.parse(detail.stdout).events.filter((event) => event.kind === "add_comment").at(-1).body, text);
  for (const args of [
    ["create_task", "--file"],
    ["create_task", "--file", file, "--stdin"],
    ["create_task", "--stdin", "{}"],
    ["create_task", "{}", "--file", file],
    ["create_task", "--file", "--stdin"],
    ["create_task", "--file", join(directory, "missing.json")],
  ]) {
    const failed = await cli(args);
    assert.equal(failed.code, 1, args.join(" "));
    assert.equal(JSON.parse(failed.stderr).code, "USAGE");
    assert.equal(failed.stdout, "");
  }
  for (const input of ["", "[]", "{invalid", "{}\n{}"]) {
    const failed = await cli(["create_task", "--stdin"], input);
    assert.equal(JSON.parse(failed.stderr).code, "USAGE");
  }
  await writeFile(file, JSON.stringify({ boardId, title: "Must not write" }), "utf8");
  const noActor = { ...env };
  delete noActor.TASKNBOARD_AGENT_ID;
  delete noActor.TASKNBOARD_AGENT_ROLE;
  for (const args of [["create_task", "--file", file], ["create_task", "--stdin"]]) {
    const failed = await cli(args, JSON.stringify({ boardId, title: "Must not write" }), noActor);
    assert.equal(JSON.parse(failed.stderr).code, "ACTOR_REQUIRED");
  }
  const tasks = await cli(["list_tasks", "--stdin"], JSON.stringify({ boardId }));
  assert.deepEqual(JSON.parse(tasks.stdout).tasks.map((task) => task.id), [task.id]);
});

test("one-shot commands print JSON and fail with a JSON error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, TASKNBOARD_DB: join(directory, "cli.sqlite"), TASKNBOARD_AGENT_ID: "shell-agent", TASKNBOARD_AGENT_ROLE: "architect" };
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
  const detail = JSON.parse((await cli("get_task", JSON.stringify({ id: created.id }))).stdout);
  assert.equal(detail.events[0].actor, "shell-agent");
  const aliasDetail = JSON.parse((await cli("get_task", JSON.stringify({ taskId: created.id }))).stdout);
  assert.equal(aliasDetail.id, created.id);
  const comment = JSON.parse((await cli("add_comment", JSON.stringify({ taskId: created.id, body: "CLI alias works" }))).stdout);
  assert.equal(comment.id, created.id);
  await assert.rejects(cli("claim_task", JSON.stringify({ taskId: created.id })), (error) => {
    assert.equal(JSON.parse(error.stderr).code, "USAGE");
    assert.match(JSON.parse(error.stderr).message, /expectedVersion is required.*help claim_task/);
    return true;
  });
  await assert.rejects(cli("get_task", JSON.stringify({ id: created.id, taskId: "ENG-999" })), (error) => {
    assert.equal(JSON.parse(error.stderr).code, "USAGE");
    assert.match(JSON.parse(error.stderr).message, /must identify the same task/);
    return true;
  });
  assert.match((await cli("help", "claim_task")).stdout, /expectedVersion.*\n[^]*tasknboard claim_task/);
  await assert.rejects(cli("get_task", "{}"), (error) => {
    const failure = JSON.parse(error.stderr);
    assert.equal(failure.code, "VALIDATION");
    assert.match(failure.message, /tasknboard help get_task/);
    return true;
  });
  const storedRoleEnv = { ...env };
  delete storedRoleEnv.TASKNBOARD_AGENT_ROLE;
  const storedInfo = JSON.parse((await run(process.execPath, ["dist-cli/tasknboard.mjs", "workspace_info"], { env: storedRoleEnv })).stdout);
  assert.equal(storedInfo.actor.role, "architect");
  const epic = JSON.parse((await run(process.execPath, ["dist-cli/tasknboard.mjs", "create_epic", JSON.stringify({ boardId: createdBoard.id, title: "Architect plan" })], { env: storedRoleEnv })).stdout);
  assert.equal(epic.title, "Architect plan");
  const listed = JSON.parse((await cli("list_tasks", JSON.stringify({ boardId: createdBoard.id }))).stdout);
  assert.deepEqual(listed.tasks.map((t) => t.title), ["From the shell"]);
  assert.deepEqual(listed.tasks.map((t) => t.boardId), [createdBoard.id]);
  await assert.rejects(cli("get_task", "{not json"), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).code, "USAGE");
    return true;
  });
  const scriptEnv = { ...env };
  delete scriptEnv.TASKNBOARD_AGENT_ID;
  delete scriptEnv.TASKNBOARD_AGENT_ROLE;
  for (const command of ["create_task", "create_board", "add_comment", "update_profile"]) {
    await assert.rejects(run(process.execPath, ["dist-cli/tasknboard.mjs", command, "{}"], { env: scriptEnv }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(JSON.parse(error.stderr).code, "ACTOR_REQUIRED");
      return true;
    });
  }
  const humanInfo = JSON.parse((await run(process.execPath, ["dist-cli/tasknboard.mjs", "workspace_info"], { env: scriptEnv })).stdout);
  assert.equal(humanInfo.actor.kind, "human");
  assert.deepEqual(JSON.parse((await cli("list_tasks", JSON.stringify({ boardId: createdBoard.id }))).stdout).tasks.map((t) => t.id), [created.id]);
  await assert.rejects(run(process.execPath, ["dist-cli/tasknboard.mjs", "create_board", "{}"], { env: { ...env, TASKNBOARD_AGENT_ROLE: "admin" } }), (error) => {
    assert.equal(JSON.parse(error.stderr).code, "USAGE");
    return true;
  });
});
