import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import { createAgentLauncher } from "../server/agent-launcher.mjs";

const human = { id: "you", kind: "human" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

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
  await settle();
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
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "exec");
  assert.ok(calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  calls[0].child.emit("exit", 0);
  await settle();
  assert.equal(calls.length, 2);
  assert.match(calls[1].args.at(-1), /TNB-2/);
  const started = store
    .execute("get_task", { id: second.id }, human)
    .events.findLast((e) => e.kind === "agent_started");
  await writeFile(started.body.split("Log: ")[1].replace(/\.$/, ""), "booting\nNot logged in\n");
  calls[1].child.emit("exit", 1);
  await settle();
  const stopped = store
    .execute("get_task", { id: second.id }, human)
    .events.find((e) => e.kind === "agent_stopped");
  assert.match(stopped.body, /exited with code 1: Not logged in\. Log:/);
  assert.ok(!events(store, first.id).includes("agent_stopped"));
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
