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
  updatedAt: "2026-09-29T00:00:00.000Z", ...patch,
});
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
  assert.equal(planInput("/new  Write docs ", undefined).request.args.title, "Write docs");
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
      if (name === "workspace_info") return { name: "Studio", actor: { id: "you", kind: "human" }, actors: [], schemaVersion: 3 };
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
  assert.match(ui.lastFrame(), /Studio · you \(human\)/);
  assert.match(ui.lastFrame(), /❯ TNB-001\s+● Ship it/);

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

test("one-shot commands print JSON and fail with a JSON error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, TASKNBOARD_DB: join(directory, "cli.sqlite") };
  delete env.TASKNBOARD_SERVER_URL;
  // Run the executable itself, as the installed `tasknboard` command does.
  const cli = (...args) => run("dist-cli/tasknboard.mjs", args, { env });
  const created = JSON.parse((await cli("create_task", '{"title":"From the shell"}')).stdout);
  assert.equal(created.id, "TNB-001");
  const listed = JSON.parse((await cli("list_tasks")).stdout);
  assert.deepEqual(listed.tasks.map((t) => t.title), ["From the shell"]);
  await assert.rejects(cli("get_task", "{not json"), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).code, "USAGE");
    return true;
  });
});
