import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import {
  createAgentLauncher,
  failureReason,
  userEnvironment,
} from "../server/agent-launcher.mjs";
import {
  defaultConfig,
  listConfigs,
  mentionedIdentities,
  parseConfig,
  readConfig,
  writeConfig,
} from "../server/agent-config.mjs";

const human = { id: "you", kind: "human" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
// Settles at least once, then keeps waiting while a run that starts asynchronously
// has not started yet; slow CI runners can need more than one settle.
const waitFor = async (condition, message) => {
  await settle();
  for (let attempt = 0; attempt < 60 && !condition(); attempt++) await settle();
  assert.ok(condition(), message);
};

async function fixture(t, { client = "claude" } = {}) {
  const home = await mkdtemp(join(tmpdir(), "tnb-launch-"));
  const store = createStore(":memory:");
  t.after(async () => {
    launcher.stop();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  const bin = join(home, "bin");
  const repository = join(home, "repo");
  await mkdir(bin);
  await mkdir(repository);
  for (const name of ["claude", "codex"])
    await writeFile(
      join(bin, process.platform === "win32" ? `${name}.exe` : name),
      "",
      { mode: 0o755 },
    );
  const calls = [];
  const spawn = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill() {
        this.killed = true;
      },
    });
    calls.push({ command, args, options, child });
    return child;
  };
  const launcher = createAgentLauncher({
    store,
    desktop: true,
    home,
    searchPath: bin,
    spawn,
    // The user's environment, as the desktop host and login shell provide it.
    environment: async () => ({ USER: "someone", PATH: bin, FROM_PROFILE: "yes" }),
  });
  const [board] = store.execute("list_boards", {}, human).boards;
  const withFolder = store.execute(
    "update_board",
    { id: board.id, expectedVersion: board.version, patch: { repository } },
    human,
  );
  launcher.register("bot", client);
  return { store, launcher, calls, repository, home, board: withFolder };
}

const events = (store, id) =>
  store.execute("get_task", { id }, human).events.map((e) => e.kind);

test("assigning a task to an installed agent starts its CLI in the board folder", async (t) => {
  const { store, launcher, calls, repository, board } = await fixture(t);
  assert.equal(board.repository, repository);
  const task = store.execute(
    "create_task",
    { boardId: board.id, title: "Fix it", assignee: "bot" },
    human,
  );
  launcher.assigned(task);
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.match(call.command, /claude(\.exe)?$/);
  assert.equal(call.args[0], "-p");
  assert.match(call.args[1], /TNB-1/);
  assert.match(call.args[1], /"bot"/);
  assert.ok(call.args.includes("--dangerously-skip-permissions"));
  assert.equal(call.options.cwd, repository);
  // Overriding it would make Claude Code read another keychain login.
  assert.equal(call.options.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.ok(events(store, task.id).includes("agent_started"));
});

test("a busy agent queues the next assignment and starts it when the run ends", async (t) => {
  const { store, launcher, calls, board } = await fixture(t, { client: "codex" });
  const first = store.execute(
    "create_task",
    { boardId: board.id, title: "One", assignee: "bot" },
    human,
  );
  const second = store.execute(
    "create_task",
    { boardId: board.id, title: "Two", assignee: "bot" },
    human,
  );
  launcher.assigned(first);
  launcher.assigned(second);
  launcher.assigned(second);
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "exec");
  assert.ok(!calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--sandbox") + 1], "workspace-write");
  calls[0].child.emit("exit", 0);
  await waitFor(() => calls.length >= 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1].args.at(-1), /TNB-2/);
  const started = store
    .execute("get_task", { id: second.id }, human)
    .events.findLast((e) => e.kind === "agent_started");
  await writeFile(started.body.split("Log: ")[1].replace(/\.$/, ""), "booting\nNot logged in\n");
  calls[1].child.emit("exit", 1);
  await waitFor(() => events(store, second.id).includes("agent_stopped"), "the second run records its exit");
  const stopped = store
    .execute("get_task", { id: second.id }, human)
    .events.find((e) => e.kind === "agent_stopped");
  assert.match(stopped.body, /exited with code 1: Not logged in\. Log:/);
  assert.ok(!events(store, first.id).includes("agent_stopped"));
});

test("custom prompts always include the task description and acceptance criteria", async (t) => {
  const { store, launcher, calls, board } = await fixture(t, { client: "codex" });
  const config = readConfig(store, "bot");
  config.events.task_assigned.prompt = "Do the assigned work.";
  writeConfig(store, "bot", config);
  const task = store.execute("create_task", {
    boardId: board.id, title: "Fix the export", assignee: "bot",
    description: "Preserve the authored layout.", acceptance: "The export opens the saved board.",
  }, human);
  launcher.assigned(task);
  await waitFor(() => calls.length === 1);
  const prompt = calls[0].args.at(-1);
  assert.match(prompt, /Fix the export/);
  assert.match(prompt, /Preserve the authored layout/);
  assert.match(prompt, /The export opens the saved board/);
});

test("external dispatch prevents a second assignment run", async (t) => {
  const { store, launcher, calls, board } = await fixture(t);
  const task = store.execute("create_task", {
    boardId: board.id, title: "Delegated work", assignee: "bot",
  }, human);
  store.execute("delegate_task", { id: task.id, expectedVersion: task.version, delegatedTo: "codex/cli" }, human);
  launcher.assigned(task);
  await settle();
  assert.equal(calls.length, 0);
});

test("Codex uses the reasoning and sandbox settings of its task's board", async (t) => {
  const { store, launcher, calls, board } = await fixture(t, { client: "codex" });
  store.execute("update_board", {
    id: board.id, expectedVersion: board.version,
    patch: { agentReasoning: "high", agentSandbox: "read-only" },
  }, human);
  const task = store.execute("create_task", { boardId: board.id, title: "Plan", assignee: "bot" }, human);
  launcher.assigned(task);
  await waitFor(() => calls.length === 1);
  assert.ok(calls[0].args.includes('model_reasoning_effort="high"'));
  assert.equal(calls[0].args[calls[0].args.indexOf("--sandbox") + 1], "read-only");
});

test("no run starts without a folder, for unknown agents, or for claimed tasks", async (t) => {
  const { store, launcher, calls, board } = await fixture(t);
  const other = store.execute(
    "create_task",
    { boardId: board.id, title: "Human work", assignee: "somebody" },
    human,
  );
  launcher.assigned(other);
  const claimed = store.execute(
    "create_task",
    { boardId: board.id, title: "Taken", assignee: "bot" },
    human,
  );
  store.execute(
    "claim_task",
    { id: claimed.id, expectedVersion: claimed.version },
    { id: "bot", kind: "agent" },
  );
  launcher.assigned(claimed);
  await settle();
  assert.equal(calls.length, 0);

  const current = store.execute("list_boards", {}, human).boards[0];
  store.execute(
    "update_board",
    { id: current.id, expectedVersion: current.version, patch: { repository: "" } },
    human,
  );
  const task = store.execute(
    "create_task",
    { boardId: board.id, title: "No folder", assignee: "bot" },
    human,
  );
  launcher.assigned(task);
  await settle();
  assert.equal(calls.length, 0);
  assert.ok(events(store, task.id).includes("agent_not_started"));
});

test("the launcher stays off outside the local desktop app", async (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const calls = [];
  const launcher = createAgentLauncher({
    store,
    desktop: false,
    home: tmpdir(),
    spawn: (...args) => calls.push(args),
  });
  launcher.register("bot", "claude");
  const [board] = store.execute("list_boards", {}, human).boards;
  launcher.assigned(
    store.execute(
      "create_task",
      { boardId: board.id, title: "Web", assignee: "bot" },
      human,
    ),
  );
  await settle();
  assert.equal(calls.length, 0);
});

test("board repository folders must be absolute paths", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  assert.throws(
    () =>
      store.execute(
        "create_board",
        { name: "Ops", prefix: "OPS", repository: "relative/path" },
        human,
      ),
    /absolute folder path/,
  );
  const board = store.execute(
    "create_board",
    { name: "Ops", prefix: "OPS", repository: "C:\\work\\ops" },
    human,
  );
  assert.equal(board.repository, "C:\\work\\ops");
});

test("a failed run reports the CLI's error line, not trailing noise", () => {
  assert.equal(
    failureReason(
      [
        "warning: something",
        'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}',
        "2026-10-01T08:39:34Z ERROR rmcp::transport::worker: worker quit",
      ].join("\n"),
    ),
    "The model is not supported.",
  );
  assert.equal(failureReason("booting\nNot logged in · Please run /login\n"), "Not logged in · Please run /login");
  assert.equal(failureReason(""), "");
});

const configure = (store, patch, identity = "bot") => {
  const config = readConfig(store, identity);
  return writeConfig(store, identity, {
    ...config,
    ...patch,
    events: { ...config.events, ...patch.events },
  });
};

test("a plugin install implies a default configuration, and saving replaces it", async (t) => {
  const { store } = await fixture(t, { client: "codex" });
  store.setSettings({ "agent_launcher.old": "claude" });
  assert.equal(readConfig(store, "old").client, "claude");
  assert.deepEqual(Object.keys(listConfigs(store)), ["bot", "old"]);
  writeConfig(store, "old", defaultConfig("pi"));
  assert.equal(store.setting("agent_launcher.old"), "");
  assert.equal(readConfig(store, "old").client, "pi");
  assert.equal(readConfig(store, "bot").client, "codex");
  assert.equal(readConfig(store, "nobody"), null);
});

test("configurations reject unsafe or malformed values", () => {
  const base = defaultConfig("claude");
  assert.throws(() => parseConfig({ ...base, client: "vim" }), /client/);
  assert.throws(() => parseConfig({ ...base, command: "bin/claude" }), /absolute path/);
  assert.throws(() => parseConfig({ ...base, env: { HOME: "/tmp" } }), /set by the app/);
  assert.throws(
    () => parseConfig({ ...base, env: { TASKNBOARD_AGENT_ID: "you" } }),
    /set by the app/,
  );
  assert.throws(() => parseConfig({ ...base, env: { "BAD-NAME": "x" } }), /env/);
  assert.throws(() => parseConfig({ ...base, model: "two words" }), /spaces/);
  assert.throws(() => parseConfig({ ...base, extra: true }), /config|Unrecognized/);
  const { mention, ...events } = base.events;
  assert.throws(() => parseConfig({ ...base, events }), /events\.mention/);
  assert.equal(parseConfig({ ...base, model: " opus " }).model, "opus");
});

test("each CLI gets its model, profile, extra arguments, and environment", async (t) => {
  const expected = {
    claude: (prompt) => [
      "-p", prompt, "--dangerously-skip-permissions",
      "--verbose", "--output-format", "stream-json",
      "--model", "m1", "--agent", "p1", "--verbose",
    ],
    codex: (prompt, folder) => [
      "exec", "--sandbox", "workspace-write", "-c", 'approval_policy="never"',
      "-c", 'model_reasoning_effort="medium"', "--skip-git-repo-check",
      "-C", folder, "--model", "m1", "--profile", "p1", "--verbose", prompt,
    ],
    opencode: (prompt, folder) => [
      "run", "--auto", "--dir", folder, "--model", "m1", "--agent", "p1", "--verbose", prompt,
    ],
    pi: (prompt) => [
      "--print", "--approve", "--model", "m1", "--provider", "p1", "--verbose", prompt,
    ],
  };
  for (const [client, args] of Object.entries(expected)) {
    const { store, launcher, calls, repository, board, home } = await fixture(t, { client });
    const executable = process.platform === "win32" ? `${client}.exe` : client;
    await writeFile(join(home, "bin", executable), "", { mode: 0o755 });
    configure(store, { model: "m1", profile: "p1", args: ["--verbose"], env: { API_KEY: "k" } });
    const task = store.execute(
      "create_task",
      { boardId: board.id, title: "Go", assignee: "bot" },
      human,
    );
    launcher.assigned(task);
    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1, client);
    const prompt = client === "claude" ? calls[0].args[1] : calls[0].args.at(-1);
    assert.match(prompt, /TNB-1/);
    assert.match(prompt, client === "pi" ? /tasknboard skill/ : /MCP tools/);
    assert.deepEqual(calls[0].args, args(prompt, repository), client);
    assert.match(calls[0].command, new RegExp(`${client}(\\.exe)?$`));
    assert.equal(calls[0].options.env.API_KEY, "k");
    assert.equal(calls[0].options.env.HOME, home);
  }
});

test("a custom command path and prompt are used, and disabled agents or events never start", async (t) => {
  const { store, launcher, calls, board, home } = await fixture(t);
  const custom = join(home, "custom-claude");
  await writeFile(custom, "", { mode: 0o755 });
  configure(store, {
    command: custom,
    events: { task_assigned: { enabled: true, prompt: "Work on {{task}} ({{title}}) for {{agent}} on {{board}}." } },
  });
  const make = (title) =>
    store.execute("create_task", { boardId: board.id, title, assignee: "bot" }, human);
  const first = make("Custom");
  launcher.assigned(first);
  await waitFor(() => calls.length >= 1);
  assert.equal(calls[0].command, custom);
  assert.match(calls[0].args[1], /Work on TNB-1 \(Custom\) for bot on /);
  assert.match(calls[0].args[1], /project data/);
  calls[0].child.emit("exit", 0);
  await settle();

  configure(store, { events: { task_assigned: { enabled: false } } });
  launcher.assigned(make("Off event"));
  configure(store, { enabled: false, events: { task_assigned: { enabled: true } } });
  launcher.assigned(make("Off agent"));
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);

  configure(store, { enabled: true, command: join(home, "missing") });
  const missing = make("Missing");
  launcher.assigned(missing);
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  const note = store
    .execute("get_task", { id: missing.id }, human)
    .events.find((e) => e.kind === "agent_not_started");
  assert.match(note.body, /is not an executable file/);
});

test("unassigning stops the run on that task and drops it from the queue", async (t) => {
  const { store, launcher, calls, board } = await fixture(t);
  const make = (title) =>
    store.execute("create_task", { boardId: board.id, title, assignee: "bot" }, human);
  const first = make("One");
  const second = make("Two");
  const third = make("Three");
  for (const task of [first, second, third]) launcher.assigned(task);
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  const reassign = (task) => {
    const after = store.execute(
      "update_task",
      { id: task.id, expectedVersion: task.version, patch: { assignee: "you" } },
      human,
    );
    launcher.changed(task, after);
  };
  reassign(second);
  reassign(first);
  assert.ok(calls[0].child.killed);
  calls[0].child.emit("exit", null);
  await waitFor(() => calls.length >= 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1].args[1], /TNB-3/);
  const stopped = store
    .execute("get_task", { id: first.id }, human)
    .events.filter((e) => e.kind === "agent_stopped");
  assert.equal(stopped.length, 1);
  assert.match(stopped[0].body, /assigned to someone else/);
});

test("Needs changes starts the agent with the changes prompt", async (t) => {
  const { store, launcher, calls, board } = await fixture(t);
  const bot = { id: "bot", kind: "agent" };
  let task = store.execute(
    "create_task",
    { boardId: board.id, title: "Review me", assignee: "bot" },
    human,
  );
  task = store.execute("claim_task", { id: task.id, expectedVersion: task.version }, bot);
  task = store.execute(
    "submit_review",
    { id: task.id, expectedVersion: task.version, summary: "Done" },
    bot,
  );
  const after = store.execute(
    "update_task",
    { id: task.id, expectedVersion: task.version, patch: { lane: "LANE-2" } },
    human,
  );
  launcher.changed(task, after);
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[1], /asked for changes/);
  const started = store
    .execute("get_task", { id: task.id }, human)
    .events.findLast((e) => e.kind === "agent_started");
  assert.match(started.body, /\(changes requested\)/);
});

test("a mention starts a bound agent with the comment, once per comment", async (t) => {
  const { store, launcher, calls, board } = await fixture(t);
  const task = store.execute(
    "create_task",
    { boardId: board.id, title: "Question", assignee: "you" },
    human,
  );
  launcher.commented(task, human, "@bot what do you think?");
  await settle();
  assert.equal(calls.length, 0, "mentions are off by default");
  configure(store, { events: { mention: { enabled: true } } });
  launcher.commented(task, human, "Hey @bot, what do you think? cc @someone.");
  launcher.commented(task, human, "@bot also this");
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[1], /you mentioned you in a comment on task TNB-1/);
  assert.match(calls[0].args[1], /what do you think\?/);
  calls[0].child.emit("exit", 0);
  await waitFor(() => calls.length >= 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1].args[1], /also this/);
  assert.deepEqual(mentionedIdentities("a@b.c @x.y. (@z) @@w"), ["x.y", "z"]);
  assert.deepEqual(mentionedIdentities("@claude/architect, @codex/cli. @claude/architect"), ["claude/architect", "codex/cli"]);
  assert.deepEqual(mentionedIdentities("@claude//architect @claude/../escape @claude/ @" + "a".repeat(81)), []);
});

test("the stand-up starts bound agents that have open tasks", async (t) => {
  const { store, launcher, calls, board } = await fixture(t);
  const bot = { id: "bot", kind: "agent" };
  let task = store.execute(
    "create_task",
    { boardId: board.id, title: "Ongoing", assignee: "bot" },
    human,
  );
  task = store.execute("claim_task", { id: task.id, expectedVersion: task.version }, bot);
  store.execute(
    "create_task",
    { boardId: board.id, title: "Later", assignee: "bot" },
    human,
  );
  assert.deepEqual(launcher.standup(["bot"]), [], "stand-up is off by default");
  configure(store, { events: { standup: { enabled: true } } });
  assert.deepEqual(launcher.standup(["bot", "idle"]), ["bot"]);
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[1], /stand-up just started\. Your open tasks: TNB-1 \(In progress\)\./);
  assert.deepEqual(launcher.status("bot").running, { event: "standup", taskId: "TNB-1" });
});

test("runs get a copy of the user's environment, not the service's", async (t) => {
  const { store, launcher, calls, board } = await fixture(t);
  launcher.assigned(
    store.execute("create_task", { boardId: board.id, title: "Env", assignee: "bot" }, human),
  );
  await waitFor(() => calls.length === 1, "the agent starts with the user environment");
  const { env } = calls[0].options;
  assert.equal(env.USER, "someone");
  assert.equal(env.FROM_PROFILE, "yes");
  // The service's own variables, such as its port, stay out of the agent's shell.
  assert.equal(env.TASKNBOARD_DB, undefined);
  assert.equal(env.PORT, undefined);
});

test("the user's environment combines the host copy, the account, and the login shell", async () => {
  const hostEnv = {
    PORT: "0",
    TASKNBOARD_DB: "/data/db.sqlite",
    TASKNBOARD_USER_ENV: JSON.stringify({
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
      TASKNBOARD_DB: "/leak",
      HOST_ONLY: "1",
    }),
  };
  let shellCall;
  const run = (file, args, options, done) => {
    shellCall = { file, args, options };
    done(null, "banner\n__TASKNBOARD_ENV__PATH=/opt/bin:/usr/bin\0API_KEY=a=b\0PWD=/x\0__TASKNBOARD_ENV__");
  };
  const env = await userEnvironment({ hostEnv, platform: "darwin", home: "/Users/me", run });
  assert.equal(shellCall.file, "/bin/zsh");
  assert.deepEqual(shellCall.args.slice(0, 1), ["-ilc"]);
  assert.equal(shellCall.options.env.HOME, "/Users/me");
  assert.equal(env.PATH, "/opt/bin:/usr/bin");
  assert.equal(env.API_KEY, "a=b");
  assert.equal(env.HOST_ONLY, "1");
  assert.equal(env.USER, userInfo().username);
  for (const name of ["PORT", "TASKNBOARD_DB", "TASKNBOARD_USER_ENV", "PWD"])
    assert.equal(env[name], undefined, name);

  // A failing shell keeps the host copy; Windows never starts one.
  const failed = await userEnvironment({
    hostEnv,
    platform: "darwin",
    run: (file, args, options, done) => done(new Error("timeout"), ""),
  });
  assert.equal(failed.PATH, "/usr/bin");
  const windows = await userEnvironment({
    hostEnv,
    platform: "win32",
    run: () => assert.fail("no shell on Windows"),
  });
  assert.equal(windows.HOST_ONLY, "1");
});

test("the login shell supplies the account and profile variables", { skip: process.platform === "win32" }, async () => {
  const env = await userEnvironment({
    hostEnv: { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
    home: tmpdir(),
  });
  assert.equal(env.USER, userInfo().username);
  assert.match(env.PATH, /\/bin/);
});

test("a failed stream-json run reports Claude Code's result message", () => {
  const output = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
  ].join("\n");
  assert.equal(failureReason(output), "Not logged in · Please run /login");
});

test("quitting records the stopped run, releases its claim, and starts it again on open", async (t) => {
  const { store, launcher, calls, board, home } = await fixture(t);
  const bot = { id: "bot", kind: "agent" };
  const make = (title) =>
    store.execute("create_task", { boardId: board.id, title, assignee: "bot" }, human);
  const first = make("Working");
  const second = make("Waiting");
  launcher.assigned(first);
  launcher.assigned(second);
  await waitFor(() => calls.length === 1, "the first run starts before shutdown");
  const claimed = store.execute("claim_task", { id: first.id, expectedVersion: 1 }, bot);
  assert.equal(claimed.lease.actor, "bot");
  launcher.stop();
  assert.ok(calls[0].child.killed);
  const after = store.execute("get_task", { id: first.id }, human);
  assert.equal(after.lease, null, "the claim is released so the next run can claim it");
  assert.match(after.events.at(-1).body, /TasknBoard quit while Claude Code was working/);
  assert.equal(JSON.parse(store.setting("agent_runs.interrupted")).length, 2);

  // The service opens again with the same database.
  const reopened = [];
  const next = createAgentLauncher({
    store,
    desktop: true,
    home,
    searchPath: join(home, "bin"),
    environment: async () => ({ PATH: join(home, "bin") }),
    spawn: (command, args, options) => {
      const child = Object.assign(new EventEmitter(), { kill() {} });
      reopened.push({ args, child });
      return child;
    },
  });
  next.resume();
  await waitFor(() => reopened.length === 1, "the interrupted run starts again");
  assert.equal(store.setting("agent_runs.interrupted"), "");
  assert.match(reopened[0].args[1], /TasknBoard quit while an earlier run worked on this/);
  assert.match(reopened[0].args[1], new RegExp(first.id));
  const started = store
    .execute("get_task", { id: first.id }, human)
    .events.findLast((e) => e.kind === "agent_started");
  assert.match(started.body, /again after TasknBoard restarted/);
  reopened[0].child.emit("exit", 0);
  await waitFor(() => reopened.length === 2, "the waiting task starts after the first run");
  assert.match(reopened[1].args[1], new RegExp(second.id));
  next.stop();
});

test("a task reassigned while another run starts still waits its turn", async (t) => {
  const { store, launcher, calls, board } = await fixture(t);
  const make = (title) =>
    store.execute("create_task", { boardId: board.id, title, assignee: "bot" }, human);
  const first = make("Starting");
  const second = make("Reassigned");
  // The first run is still starting when the second task is unassigned and assigned again.
  launcher.assigned(first);
  const away = store.execute(
    "update_task",
    { id: second.id, expectedVersion: second.version, patch: { assignee: "" } },
    human,
  );
  launcher.changed(second, away);
  const back = store.execute(
    "update_task",
    { id: second.id, expectedVersion: away.version, patch: { assignee: "bot" } },
    human,
  );
  launcher.changed(away, back);
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(launcher.status("bot").queued, [{ event: "task_assigned", taskId: second.id }]);
  calls[0].child.emit("exit", 0);
  await waitFor(() => calls.length >= 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1].args[1], new RegExp(second.id));
});
