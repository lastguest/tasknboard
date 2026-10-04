import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWebMCP } from "../src/webmcp.ts";
import { createStore } from "../server/store.mjs";

function registry(failAt) {
  const tools = new Map();
  return {
    tools,
    async registerTool(tool, { signal }) {
      if (tools.size === failAt) throw new Error("Registration denied");
      tools.set(tool.name, tool);
      signal.addEventListener("abort", () => tools.delete(tool.name), {
        once: true,
      });
    },
  };
}
const execution = () => ({ signal: new AbortController().signal });

test("WebMCP validates and executes against the domain, refreshes writes, rejects stale versions", async (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const context = registry();
  const lifetime = new AbortController();
  let refreshes = 0;
  await registerWebMCP(
    context,
    async (name, args) =>
      store.execute(name, args, { id: "you", kind: "human" }),
    async () => {
      refreshes++;
    },
    lifetime.signal,
  );
  assert.ok(context.tools.has("critical_path"));
  assert.ok(context.tools.has("submit_review"));
  const call = async (name, args) =>
    JSON.parse(await context.tools.get(name).execute(args, execution()));
  const { boards } = await call("list_boards", {});
  await assert.rejects(call("create_task", { title: "Missing board" }));
  const created = await call("create_task", { title: "Browser task", boardId: boards[0].id });
  assert.equal(refreshes, 1);
  assert.equal((await call("list_tasks", {})).total, 1);
  assert.equal(refreshes, 1);
  const updated = await call("update_task", {
    id: created.id,
    expectedVersion: created.version,
    patch: { title: "Updated" },
  });
  await assert.rejects(
    call("update_task", {
      id: created.id,
      expectedVersion: created.version,
      patch: { title: "Stale" },
    }),
  );
  assert.equal((await call("get_task", { id: created.id })).title, "Updated");
  await assert.rejects(call("create_task", { title: "", actor: "admin" }));
  assert.equal((await call("list_tasks", {})).total, 1);
  const noted = await call("set_standup_notes", {
    id: updated.id,
    expectedVersion: updated.version,
    highlight: "Ready",
    blocker: "",
  });
  assert.equal(noted.standup.highlight, "Ready");
  const commented = await call("add_comment", {
    id: noted.id,
    expectedVersion: noted.version,
    body: "Verified",
  });
  assert.ok(commented.version > noted.version);
  const rejected = await call("reject_task", {
    id: commented.id,
    expectedVersion: commented.version,
    reason: "Work is no longer required",
  });
  assert.equal(rejected.archived, true);
  assert.equal(rejected.lane, commented.lane);
  assert.equal(rejected.events.at(-1).kind, "reject_task");
  lifetime.abort();
  assert.equal(context.tools.size, 0);
});

test("WebMCP handles unsupported browsers, registration failure and cancellation", async () => {
  const lifetime = new AbortController();
  assert.equal(
    await registerWebMCP(
      undefined,
      async () => {},
      async () => {},
      lifetime.signal,
    ),
    false,
  );
  const failed = registry(2);
  await assert.rejects(
    registerWebMCP(
      failed,
      async () => {},
      async () => {},
      lifetime.signal,
    ),
    /Registration denied/,
  );
  assert.equal(failed.tools.size, 0);
  const context = registry();
  let requests = 0;
  await registerWebMCP(
    context,
    async (_name, _args, signal) => {
      requests++;
      assert.ok(signal);
      return {};
    },
    async () => {},
    lifetime.signal,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    context.tools
      .get("create_task")
      .execute({ title: "Cancelled" }, { signal: cancelled.signal }),
    { name: "AbortError" },
  );
  assert.equal(requests, 0);
  await context.tools.get("list_tasks").execute({}, execution());
  assert.equal(requests, 1);
  lifetime.abort();
});
