import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
const human = { id: "you", kind: "human" },
  a = { id: "agent-a", kind: "agent" },
  b = { id: "agent-b", kind: "agent" };
function fixture(t) {
  let now = 1000000;
  const store = createStore(":memory:", { clock: () => now });
  t.after(() => store.close());
  return {
    ...store,
    advance: () => {
      now += 900001;
    },
    make: () =>
      store.execute("create_task", { title: "Implement something" }, human),
  };
}
test("claim exclusion, agent ownership, heartbeat and review lifecycle", (t) => {
  const s = fixture(t);
  let task = s.make();
  task = s.execute("claim_task", { id: task.id, expectedVersion: 1 }, a);
  assert.equal(task.status, "in_progress");
  assert.throws(
    () =>
      s.execute(
        "claim_task",
        { id: task.id, expectedVersion: task.version },
        b,
      ),
    { code: "LEASE_CONFLICT" },
  );
  assert.throws(
    () =>
      s.execute(
        "update_task",
        {
          id: task.id,
          expectedVersion: task.version,
          patch: { title: "collision" },
        },
        human,
      ),
    { code: "LEASE_CONFLICT" },
  );
  task = s.execute(
    "heartbeat",
    { id: task.id, expectedVersion: task.version },
    a,
  );
  assert.throws(
    () =>
      s.execute(
        "update_task",
        {
          id: task.id,
          expectedVersion: task.version,
          patch: { status: "done" },
        },
        a,
      ),
    { code: "FORBIDDEN" },
  );
  task = s.execute(
    "submit_review",
    {
      id: task.id,
      expectedVersion: task.version,
      summary: "Tests passed",
      artifactUrl: "https://example.com/pr/1",
    },
    a,
  );
  assert.equal(task.status, "in_review");
  assert.equal(task.lease, null);
  task = s.execute(
    "update_task",
    { id: task.id, expectedVersion: task.version, patch: { status: "done" } },
    human,
  );
  assert.equal(task.status, "done");
  assert.equal(task.events.length, 5);
});
test("expired leases deny old agent writes and allow takeover", (t) => {
  const s = fixture(t);
  let task = s.make();
  task = s.execute("claim_task", { id: task.id, expectedVersion: 1 }, a);
  s.advance();
  assert.throws(
    () =>
      s.execute("heartbeat", { id: task.id, expectedVersion: task.version }, a),
    { code: "LEASE_REQUIRED" },
  );
  task = s.execute(
    "claim_task",
    { id: task.id, expectedVersion: task.version },
    b,
  );
  assert.equal(task.lease.actor, b.id);
  assert.throws(
    () =>
      s.execute(
        "release_task",
        { id: task.id, expectedVersion: task.version },
        a,
      ),
    { code: "LEASE_CONFLICT" },
  );
});
test("stale writes rejected without changing data or appending events", (t) => {
  const s = fixture(t);
  let task = s.make();
  s.execute(
    "update_task",
    { id: task.id, expectedVersion: 1, patch: { title: "new title" } },
    human,
  );
  assert.throws(
    () =>
      s.execute(
        "update_task",
        { id: task.id, expectedVersion: 1, patch: { title: "stale title" } },
        human,
      ),
    { code: "VERSION_CONFLICT" },
  );
  task = s.execute("get_task", { id: task.id }, human);
  assert.equal(task.title, "new title");
  assert.equal(task.version, 2);
  assert.equal(task.events.length, 2);
});
test("strict validation blocks unrecognized fields and unsafe artifact URLs", (t) => {
  const s = fixture(t);
  const task = s.make();
  assert.throws(
    () => s.execute("create_task", { title: "", actor: "fake" }, human),
    { code: "VALIDATION" },
  );
  assert.throws(
    () =>
      s.execute(
        "submit_review",
        {
          id: task.id,
          expectedVersion: 1,
          summary: "test",
          artifactUrl: "javascript:alert(1)",
        },
        a,
      ),
    { code: "VALIDATION" },
  );
  assert.throws(
    () =>
      s.execute(
        "update_task",
        { id: task.id, expectedVersion: 1, patch: { version: 42 } },
        human,
      ),
    { code: "VALIDATION" },
  );
  assert.throws(
    () => s.execute("archive_task", { id: task.id, expectedVersion: 1 }, a),
    { code: "LEASE_REQUIRED" },
  );
});
test("archive hides from queries, preserves export and activity", (t) => {
  const s = fixture(t);
  const task = s.make();
  s.execute("archive_task", { id: task.id, expectedVersion: 1 }, human);
  assert.equal(s.execute("list_tasks", {}, human).total, 0);
  const backup = s.execute("export_workspace", {}, human);
  assert.equal(backup.tasks.length, 1);
  assert.equal(backup.events.length, 2);
  assert.throws(() => s.execute("export_workspace", {}, a), {
    code: "FORBIDDEN",
  });
});
test("actor roster uses explicit kinds and rejects conflicting identities", (t) => {
  const s = fixture(t);
  s.registerActors([
    { id: "Morgan", kind: "agent" },
    { id: "TasknBoard Agent", kind: "human", token: "must-not-be-kept" },
  ]);
  const info = s.execute("workspace_info", {}, human);
  assert.equal(info.schemaVersion, 3);
  assert.deepEqual(info.actor, human);
  assert.deepEqual(info.actors, [
    { id: "Morgan", kind: "agent" },
    { id: "TasknBoard Agent", kind: "human" },
    human,
  ]);
  assert.ok(!JSON.stringify(info).includes("must-not-be-kept"));
  assert.throws(
    () =>
      s.execute("create_task", { title: "Should not be created" }, {
        id: "Morgan",
        kind: "human",
      }),
    { code: "ACTOR_KIND_CONFLICT", status: 409 },
  );
  assert.equal(s.execute("list_tasks", {}, human).total, 0);
  const backup = s.execute("export_workspace", {}, human);
  assert.equal(backup.schemaVersion, 3);
  assert.deepEqual(backup.actors, info.actors);
});
test("comment counts include only persisted comments and agree across task reads", (t) => {
  const s = fixture(t);
  let task = s.make();
  assert.equal(task.commentCount, 0);
  task = s.execute("claim_task", { id: task.id, expectedVersion: task.version }, a);
  assert.equal(task.commentCount, 0);
  task = s.execute(
    "update_task",
    {
      id: task.id,
      expectedVersion: task.version,
      patch: { description: "Changed without a comment" },
    },
    a,
  );
  assert.equal(task.commentCount, 0);
  task = s.execute(
    "add_comment",
    { id: task.id, expectedVersion: task.version, body: "First comment" },
    a,
  );
  assert.equal(task.commentCount, 1);
  task = s.execute(
    "update_task",
    { id: task.id, expectedVersion: task.version, patch: { title: "Still one" } },
    a,
  );
  assert.equal(task.commentCount, 1);
  assert.throws(
    () =>
      s.execute(
        "add_comment",
        { id: task.id, expectedVersion: task.version - 1, body: "Rejected" },
        a,
      ),
    { code: "VERSION_CONFLICT" },
  );
  assert.equal(s.execute("get_task", { id: task.id }, human).commentCount, 1);
  assert.equal(s.execute("list_tasks", {}, human).tasks[0].commentCount, 1);
  assert.equal(task.events.filter((event) => event.kind === "add_comment").length, 1);
});
test("database persistence and independent connections enforce version checks", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-"));
  const path = join(dir, "test.sqlite");
  const first = createStore(path),
    second = createStore(path);
  t.after(() => {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const task = first.execute("create_task", { title: "Persist me" }, human);
  first.execute("claim_task", { id: task.id, expectedVersion: 1 }, a);
  assert.throws(
    () => second.execute("claim_task", { id: task.id, expectedVersion: 1 }, b),
    { code: "VERSION_CONFLICT" },
  );
  assert.throws(
    () => second.execute("list_tasks", {}, { id: a.id, kind: "human" }),
    { code: "ACTOR_KIND_CONFLICT", status: 409 },
  );
  assert.ok(
    first
      .execute("workspace_info", {}, human)
      .actors.some((actor) => actor.id === b.id && actor.kind === b.kind),
  );
  assert.equal(
    second.execute("get_task", { id: task.id }, human).lease.actor,
    a.id,
  );
  const reopened = createStore(path);
  assert.equal(
    reopened.execute("get_task", { id: task.id }, human).title,
    "Persist me",
  );
  assert.ok(
    reopened
      .execute("workspace_info", {}, human)
      .actors.some((actor) => actor.id === a.id && actor.kind === a.kind),
  );
  reopened.close();
});

test("stand-up notes preserve claims, validate input and enforce versions/agent ownership", (t) => {
  const s = fixture(t);
  let task = s.make();
  assert.throws(
    () =>
      s.execute(
        "set_standup_notes",
        {
          id: task.id,
          expectedVersion: task.version,
          highlight: "Hello",
          blocker: "",
        },
        a,
      ),
    { code: "LEASE_REQUIRED" },
  );
  task = s.execute(
    "claim_task",
    { id: task.id, expectedVersion: task.version },
    a,
  );
  const ownedLease = { ...task.lease },
    oldVersion = task.version;
  task = s.execute(
    "set_standup_notes",
    {
      id: task.id,
      expectedVersion: task.version,
      highlight: "Demo ready",
      blocker: "Needs test credentials",
    },
    human,
  );
  assert.deepEqual(task.lease, ownedLease);
  assert.equal(task.status, "in_progress");
  assert.equal(task.assignee, a.id);
  assert.equal(task.standup.blocker, "Needs test credentials");
  assert.equal(task.events.at(-1).kind, "set_standup_notes");
  assert.throws(
    () =>
      s.execute(
        "set_standup_notes",
        {
          id: task.id,
          expectedVersion: oldVersion,
          highlight: "Stale",
          blocker: "",
        },
        human,
      ),
    { code: "VERSION_CONFLICT" },
  );
  assert.throws(
    () =>
      s.execute(
        "set_standup_notes",
        {
          id: task.id,
          expectedVersion: task.version,
          highlight: "x".repeat(501),
          blocker: "",
        },
        human,
      ),
    { code: "VALIDATION" },
  );
  assert.throws(
    () =>
      s.execute(
        "set_standup_notes",
        {
          id: task.id,
          expectedVersion: task.version,
          highlight: "Other agent",
          blocker: "",
        },
        b,
      ),
    { code: "LEASE_CONFLICT" },
  );
  task = s.execute(
    "set_standup_notes",
    { id: task.id, expectedVersion: task.version, highlight: "", blocker: "" },
    a,
  );
  assert.deepEqual(task.standup, { highlight: "", blocker: "" });
  assert.deepEqual(
    s.execute("get_task", { id: task.id }, human).standup,
    task.standup,
  );
});

test("labels support multiple tags, normalization, clearing and strict validation", (t) => {
  const s = fixture(t);
  let task = s.execute("create_task", { title: "Tagged task", labels: [" UX ", "Product", "UX"] }, human);
  assert.deepEqual(task.labels, ["UX", "Product"]);
  assert.equal(Object.hasOwn(task, "label"), false);
  assert.deepEqual(s.execute("list_tasks", {}, human).tasks[0].labels, task.labels);
  assert.deepEqual(s.execute("get_task", { id: task.id }, human).labels, task.labels);
  for (const labels of [[" "], ["x".repeat(41)], "Product"]) {
    assert.throws(() => s.execute("update_task", {
      id: task.id, expectedVersion: task.version, patch: { labels },
    }, human), { code: "VALIDATION" });
  }
  assert.throws(() => s.execute("create_task", { title: "Old field", label: "UX" }, human), { code: "VALIDATION" });
  task = s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { labels: [] } }, human);
  assert.deepEqual(task.labels, []);
  assert.deepEqual(s.execute("export_workspace", {}, human).tasks[0].labels, []);
});

test("stored single labels upgrade once without changing task history", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-labels-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "workspace.sqlite");
  let store = createStore(path);
  const task = store.execute("create_task", { title: "Existing task" }, human);
  store.close();
  const db = new DatabaseSync(path);
  const { labels, events, commentCount, ...legacy } = task;
  db.prepare("UPDATE tasks SET data=? WHERE number=1").run(JSON.stringify({ ...legacy, label: "Product" }));
  db.exec("DELETE FROM migrations WHERE version=3");
  db.close();
  store = createStore(path);
  const upgraded = store.execute("get_task", { id: task.id }, human);
  assert.deepEqual(upgraded.labels, ["Product"]);
  assert.equal(Object.hasOwn(upgraded, "label"), false);
  assert.equal(upgraded.version, task.version);
  assert.deepEqual(upgraded.events, events);
  store.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { labels: ["UX", "Data"] } }, human);
  store.close();
  store = createStore(path);
  assert.deepEqual(store.execute("get_task", { id: task.id }, human).labels, ["UX", "Data"]);
  store.close();
});
