import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      store.execute("create_task", { board: "TNB", title: "Implement something" }, human),
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
    () => s.execute("create_task", { board: "TNB", title: "", actor: "fake" }, human),
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
  assert.equal(info.schemaVersion, 8);
  assert.deepEqual(info.actor, human);
  assert.deepEqual(info.actors, [
    { id: "Morgan", kind: "agent", name: "", avatar: "" },
    { id: "TasknBoard Agent", kind: "human", name: "", avatar: "" },
    { ...human, name: "", avatar: "" },
  ]);
  assert.ok(!JSON.stringify(info).includes("must-not-be-kept"));
  assert.throws(
    () =>
      s.execute(
        "create_task",
        { board: "TNB", title: "Should not be created" },
        {
          id: "Morgan",
          kind: "human",
        },
      ),
    { code: "ACTOR_KIND_CONFLICT", status: 409 },
  );
  assert.equal(s.execute("list_tasks", {}, human).total, 0);
  const backup = s.execute("export_workspace", {}, human);
  assert.equal(backup.schemaVersion, 8);
  assert.deepEqual(backup.actors, info.actors);
});
test("actors edit only their own display name and picture", (t) => {
  const s = fixture(t);
  s.registerActors([{ id: "Morgan", kind: "human" }]);
  const picture = "data:image/png;base64,iVBORw0KGgo=";
  const own = s.execute(
    "update_profile",
    { name: "  Ada Lovelace ", avatar: picture },
    human,
  );
  assert.deepEqual(own, { ...human, name: "Ada Lovelace", avatar: picture });
  assert.deepEqual(s.execute("update_profile", { avatar: "" }, human), {
    ...human,
    name: "Ada Lovelace",
    avatar: "",
  });
  const roster = s.execute("workspace_info", {}, human).actors;
  assert.deepEqual(
    roster.find((entry) => entry.id === "Morgan"),
    { id: "Morgan", kind: "human", name: "", avatar: "" },
  );
  for (const avatar of [
    "https://example.com/me.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    `data:image/png;base64,${"A".repeat(48000)}`,
  ])
    assert.throws(() => s.execute("update_profile", { avatar }, human), {
      code: "VALIDATION",
    });
  assert.throws(() => s.execute("update_profile", {}, human), {
    code: "VALIDATION",
  });
  assert.throws(
    () => s.execute("update_profile", { id: "Morgan", name: "X" }, human),
    { code: "VALIDATION" },
  );
});
test("comment counts include only persisted comments and agree across task reads", (t) => {
  const s = fixture(t);
  let task = s.make();
  assert.equal(task.commentCount, 0);
  task = s.execute(
    "claim_task",
    { id: task.id, expectedVersion: task.version },
    a,
  );
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
    {
      id: task.id,
      expectedVersion: task.version,
      patch: { title: "Still one" },
    },
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
  assert.equal(
    task.events.filter((event) => event.kind === "add_comment").length,
    1,
  );
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
  const task = first.execute("create_task", { board: "TNB", title: "Persist me" }, human);
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
  let task = s.execute(
    "create_task",
    { board: "TNB", title: "Tagged task", labels: [" UX ", "Product", "UX"] },
    human,
  );
  assert.deepEqual(task.labels, ["UX", "Product"]);
  assert.equal(Object.hasOwn(task, "label"), false);
  assert.deepEqual(
    s.execute("list_tasks", {}, human).tasks[0].labels,
    task.labels,
  );
  assert.deepEqual(
    s.execute("get_task", { id: task.id }, human).labels,
    task.labels,
  );
  for (const labels of [[" "], ["x".repeat(41)], "Product"]) {
    assert.throws(
      () =>
        s.execute(
          "update_task",
          {
            id: task.id,
            expectedVersion: task.version,
            patch: { labels },
          },
          human,
        ),
      { code: "VALIDATION" },
    );
  }
  assert.throws(
    () => s.execute("create_task", { board: "TNB", title: "Old field", label: "UX" }, human),
    { code: "VALIDATION" },
  );
  task = s.execute(
    "update_task",
    { id: task.id, expectedVersion: task.version, patch: { labels: [] } },
    human,
  );
  assert.deepEqual(task.labels, []);
  assert.deepEqual(
    s.execute("export_workspace", {}, human).tasks[0].labels,
    [],
  );
});

test("stored single labels upgrade once without changing task history", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-labels-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "workspace.sqlite");
  let store = createStore(path);
  const task = store.execute("create_task", { board: "TNB", title: "Existing task" }, human);
  store.close();
  const db = new DatabaseSync(path);
  const { labels, events, commentCount, ...legacy } = task;
  db.prepare("UPDATE tasks SET data=? WHERE number=1").run(
    JSON.stringify({ ...legacy, label: "Product" }),
  );
  db.exec("DELETE FROM migrations WHERE version=3");
  db.close();
  store = createStore(path);
  const upgraded = store.execute("get_task", { id: task.id }, human);
  assert.deepEqual(upgraded.labels, ["Product"]);
  assert.equal(Object.hasOwn(upgraded, "label"), false);
  assert.equal(upgraded.version, task.version);
  assert.deepEqual(upgraded.events, events);
  store.execute(
    "update_task",
    {
      id: task.id,
      expectedVersion: task.version,
      patch: { labels: ["UX", "Data"] },
    },
    human,
  );
  store.close();
  store = createStore(path);
  assert.deepEqual(store.execute("get_task", { id: task.id }, human).labels, [
    "UX",
    "Data",
  ]);
  store.close();
});
test("uploaded images are validated by content and exported", (t) => {
  const s = fixture(t);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const saved = s.execute(
    "upload_image",
    { data: `data:image/png;base64,${png.toString("base64")}` },
    a,
  );
  assert.match(saved.id, /^[0-9a-f]{32}$/);
  assert.equal(saved.url, `/files/${saved.id}`);
  assert.deepEqual(s.image(saved.id), { mime: "image/png", data: png });
  assert.equal(s.image("0".repeat(32)), null);
  assert.equal(s.image("../etc/passwd"), null);
  // A PNG prefix on non-PNG bytes, SVG, and remote URLs are all rejected.
  for (const data of [
    `data:image/png;base64,${Buffer.from("<script>").toString("base64")}`,
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "https://example.com/a.png",
  ])
    assert.throws(() => s.execute("upload_image", { data }, human), {
      code: "VALIDATION",
    });
  const backup = s.execute("export_workspace", {}, human);
  assert.deepEqual(
    backup.images.map(({ id, mime, actor, data }) => ({
      id,
      mime,
      actor,
      data,
    })),
    [
      {
        id: saved.id,
        mime: "image/png",
        actor: "agent-a",
        data: png.toString("base64"),
      },
    ],
  );
});
test("epics group tasks, derive counts, and filter lists", (t) => {
  const s = fixture(t);
  const epic = s.execute(
    "create_epic",
    { board: "TNB", title: "  Onboarding  ", description: "**Why** it matters" },
    human,
  );
  assert.equal(epic.id, "EPIC-1");
  assert.equal(epic.title, "Onboarding");
  assert.equal(epic.version, 1);
  assert.deepEqual(epic.counts, {
    backlog: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
  });
  const inside = s.execute(
    "create_task",
    { board: "TNB", title: "Welcome screen", epic: epic.id },
    human,
  );
  assert.equal(inside.epic, epic.id);
  const outside = s.make();
  assert.equal(outside.epic, "");
  s.execute(
    "claim_task",
    { id: inside.id, expectedVersion: inside.version },
    a,
  );
  let [listed] = s.execute("list_epics", {}, a).epics;
  assert.equal(listed.counts.in_progress, 1);
  assert.equal(listed.counts.backlog, 0);
  const ids = (epicFilter) =>
    s
      .execute("list_tasks", { epic: epicFilter }, human)
      .tasks.map((task) => task.id);
  assert.deepEqual(ids(epic.id), [inside.id]);
  assert.deepEqual(ids("none"), [outside.id]);
  // Moving a task between epics is a versioned task write.
  const moved = s.execute(
    "update_task",
    { id: outside.id, expectedVersion: outside.version, patch: { epic: epic.id } },
    human,
  );
  assert.equal(moved.version, outside.version + 1);
  assert.deepEqual(JSON.parse(moved.events.at(-1).body), { epic: epic.id });
  [listed] = s.execute("list_epics", {}, human).epics;
  assert.equal(listed.counts.backlog, 1);
  // Epic events are audited but never mixed into task activity.
  assert.ok(moved.events.every((event) => event.kind !== "create_epic"));
  const backup = s.execute("export_workspace", {}, human);
  assert.equal(backup.epics.length, 1);
  assert.equal(Object.hasOwn(backup.epics[0], "counts"), false);
  assert.ok(
    backup.events.some(
      (event) => event.task_id === epic.id && event.kind === "created",
    ),
  );
});
test("epic writes are human-only, versioned and validated", (t) => {
  const s = fixture(t);
  assert.throws(() => s.execute("create_epic", { board: "TNB", title: "Agent plan" }, a), {
    code: "FORBIDDEN",
  });
  for (const title of ["", "   ", "x".repeat(121)])
    assert.throws(() => s.execute("create_epic", { board: "TNB", title }, human), {
      code: "VALIDATION",
    });
  let epic = s.execute("create_epic", { board: "TNB", title: "Billing" }, human);
  assert.throws(
    () =>
      s.execute(
        "update_epic",
        { id: epic.id, expectedVersion: 1, patch: { title: "Nope" } },
        a,
      ),
    { code: "FORBIDDEN" },
  );
  epic = s.execute(
    "update_epic",
    { id: epic.id, expectedVersion: 1, patch: { description: "Invoices" } },
    human,
  );
  assert.equal(epic.version, 2);
  assert.equal(epic.description, "Invoices");
  assert.throws(
    () =>
      s.execute(
        "update_epic",
        { id: epic.id, expectedVersion: 1, patch: { title: "Stale" } },
        human,
      ),
    { code: "VERSION_CONFLICT" },
  );
  for (const patch of [{}, { status: "done" }])
    assert.throws(
      () =>
        s.execute(
          "update_epic",
          { id: epic.id, expectedVersion: 2, patch },
          human,
        ),
      { code: "VALIDATION" },
    );
  assert.throws(
    () => s.execute("create_task", { board: "TNB", title: "Lost", epic: "EPIC-99" }, human),
    { code: "NOT_FOUND" },
  );
  assert.throws(
    () => s.execute("create_task", { board: "TNB", title: "Bad", epic: "TNB-1" }, human),
    { code: "VALIDATION" },
  );
  assert.throws(() => s.execute("list_tasks", { epic: "" }, human), {
    code: "VALIDATION",
  });
});
test("agents file claimed tasks into epics under lease rules", (t) => {
  const s = fixture(t);
  const epic = s.execute("create_epic", { board: "TNB", title: "Search" }, human);
  const created = s.execute(
    "create_task",
    { board: "TNB", title: "Agent-made", epic: epic.id },
    a,
  );
  assert.equal(created.epic, epic.id);
  let task = s.make();
  assert.throws(
    () =>
      s.execute(
        "update_task",
        { id: task.id, expectedVersion: task.version, patch: { epic: epic.id } },
        a,
      ),
    { code: "LEASE_REQUIRED" },
  );
  task = s.execute("claim_task", { id: task.id, expectedVersion: 1 }, a);
  assert.throws(
    () =>
      s.execute(
        "update_task",
        { id: task.id, expectedVersion: task.version, patch: { epic: "" } },
        human,
      ),
    { code: "LEASE_CONFLICT" },
  );
  task = s.execute(
    "update_task",
    { id: task.id, expectedVersion: task.version, patch: { epic: epic.id } },
    a,
  );
  assert.equal(task.epic, epic.id);
});
test("an epic archives only without open work and then rejects new tasks", (t) => {
  const s = fixture(t);
  let epic = s.execute("create_epic", { board: "TNB", title: "Launch" }, human);
  let open = s.execute("create_task", { board: "TNB", title: "Open", epic: epic.id }, human);
  let finished = s.execute(
    "create_task",
    { board: "TNB", title: "Finished", epic: epic.id },
    human,
  );
  for (const status of ["in_review", "done"])
    finished = s.execute(
      "update_task",
      { id: finished.id, expectedVersion: finished.version, patch: { status } },
      human,
    );
  assert.throws(
    () => s.execute("archive_epic", { id: epic.id, expectedVersion: 1 }, a),
    { code: "FORBIDDEN" },
  );
  assert.throws(
    () => s.execute("archive_epic", { id: epic.id, expectedVersion: 1 }, human),
    { code: "EPIC_NOT_EMPTY", message: /1 open task\./ },
  );
  open = s.execute(
    "archive_task",
    { id: open.id, expectedVersion: open.version },
    human,
  );
  epic = s.execute(
    "archive_epic",
    { id: epic.id, expectedVersion: 1 },
    human,
  );
  assert.equal(epic.archived, true);
  assert.equal(epic.counts.done, 1);
  assert.deepEqual(s.execute("list_epics", {}, human).epics, []);
  assert.deepEqual(
    s
      .execute("list_epics", { includeArchived: true }, human)
      .epics.map((e) => e.id),
    [epic.id],
  );
  assert.throws(
    () =>
      s.execute(
        "update_epic",
        { id: epic.id, expectedVersion: 2, patch: { title: "Again" } },
        human,
      ),
    { code: "ARCHIVED" },
  );
  assert.throws(
    () => s.execute("create_task", { board: "TNB", title: "Late", epic: epic.id }, human),
    { code: "EPIC_ARCHIVED" },
  );
  // Done work keeps its project through unrelated edits.
  finished = s.execute(
    "update_task",
    {
      id: finished.id,
      expectedVersion: finished.version,
      patch: { title: "Finished and renamed" },
    },
    human,
  );
  assert.equal(finished.epic, epic.id);
});
/**
 * Build a workspace file as an older store left it (schema 5 or 6), using raw
 * SQL that mirrors migrations 1–6, so upgrades are tested without old code.
 */
function legacyWorkspace(path, schema, { tasks = [], epics = [], events = [] }) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY);
 CREATE TABLE tasks(number INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
 CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE actors(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','agent')), name TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '');
 CREATE INDEX events_by_task ON events(task_id, sequence);
 CREATE TABLE images(id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);`);
  if (schema >= 6)
    db.exec(
      "CREATE TABLE epics(number INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)",
    );
  for (let v = 1; v <= schema; v++)
    db.prepare("INSERT INTO migrations VALUES(?)").run(v);
  db.prepare("INSERT INTO actors(id,kind) VALUES(?,?)").run(human.id, human.kind);
  for (const task of tasks)
    db.prepare("INSERT INTO tasks(data) VALUES(?)").run(JSON.stringify(task));
  for (const epic of epics)
    db.prepare("INSERT INTO epics(data) VALUES(?)").run(JSON.stringify(epic));
  for (const e of events)
    db.prepare(
      "INSERT INTO events(task_id,actor,kind,body,created_at) VALUES(?,?,?,?,?)",
    ).run(e.taskId, e.actor, e.kind, e.body, e.createdAt);
  db.close();
}
const stamp = "2026-01-01T00:00:00.000Z";
const legacyTask = (id, extra = {}) => ({
  title: `Legacy ${id}`,
  description: "",
  acceptance: "",
  priority: "medium",
  assignee: "",
  labels: ["Product"],
  id,
  status: "backlog",
  version: 1,
  createdAt: stamp,
  updatedAt: stamp,
  lease: null,
  archived: false,
  ...extra,
});
test("existing tasks join no epic once, without a version change", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-epics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "workspace.sqlite");
  legacyWorkspace(path, 5, {
    tasks: [legacyTask("TNB-001", { version: 2 })],
    events: [
      { taskId: "TNB-001", actor: "you", kind: "created", body: "", createdAt: stamp },
    ],
  });
  const store = createStore(path);
  t.after(() => store.close());
  const upgraded = store.execute("get_task", { id: "TNB-001" }, human);
  assert.equal(upgraded.epic, "");
  assert.equal(upgraded.board, "TNB");
  assert.equal(upgraded.version, 2);
  assert.deepEqual(
    upgraded.events.map(({ actor, kind, body, createdAt }) => ({ actor, kind, body, createdAt })),
    [{ actor: "you", kind: "created", body: "", createdAt: stamp }],
  );
  assert.equal(
    store.execute("create_epic", { board: "TNB", title: "First" }, human).id,
    "EPIC-1",
  );
});
test("migration 7 moves a schema-6 workspace onto board TNB", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-boards-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "workspace.sqlite");
  const epic = {
    id: "EPIC-1",
    title: "Legacy project",
    description: "",
    color: "aurora",
    version: 2,
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  legacyWorkspace(path, 6, {
    tasks: [
      legacyTask("TNB-001", { epic: "EPIC-1", version: 3, status: "in_progress" }),
      legacyTask("TNB-002", { epic: "" }),
    ],
    epics: [epic],
    events: [
      { taskId: "TNB-001", actor: "you", kind: "created", body: "", createdAt: stamp },
      { taskId: "EPIC-1", actor: "you", kind: "created", body: "", createdAt: stamp },
      { taskId: "TNB-002", actor: "you", kind: "created", body: "", createdAt: stamp },
      { taskId: "TNB-001", actor: "you", kind: "add_comment", body: "Kept", createdAt: stamp },
    ],
  });
  let store = createStore(path, { clock: () => Date.parse(stamp) });
  const first = store.execute("get_task", { id: "TNB-001" }, human);
  assert.equal(first.board, "TNB");
  assert.equal(first.version, 3);
  assert.equal(first.epic, "EPIC-1");
  assert.equal(first.commentCount, 1);
  assert.deepEqual(
    first.events.map((e) => e.kind),
    ["created", "add_comment"],
  );
  const listed = store.execute("list_tasks", {}, human).tasks;
  assert.deepEqual(
    listed.map(({ id, board, version }) => ({ id, board, version })),
    [
      { id: "TNB-002", board: "TNB", version: 1 },
      { id: "TNB-001", board: "TNB", version: 3 },
    ],
  );
  const [migratedEpic] = store.execute("list_epics", {}, human).epics;
  assert.deepEqual(
    { ...migratedEpic, counts: undefined },
    { ...epic, board: "TNB", counts: undefined },
  );
  assert.equal(migratedEpic.counts.in_progress, 1);
  const { boards } = store.execute("list_boards", {}, human);
  assert.deepEqual(boards, [
    {
      id: "TNB",
      title: "Studio",
      showInSidebar: true,
      formerIds: [],
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
      counts: { backlog: 1, in_progress: 1, in_review: 0, done: 0 },
    },
  ]);
  // Numbering continues after the migrated tasks; epic numbers too.
  assert.equal(
    store.execute("create_task", { board: "TNB", title: "After" }, human).id,
    "TNB-003",
  );
  assert.equal(
    store.execute("create_epic", { board: "TNB", title: "Next" }, human).id,
    "EPIC-2",
  );
  const backup = store.execute("export_workspace", {}, human);
  assert.equal(backup.schemaVersion, 8);
  assert.deepEqual(backup.boards.map((b) => b.id), ["TNB"]);
  assert.ok(backup.epics.every((e) => e.board === "TNB"));
  store.close();
  // Reopening does not migrate again.
  store = createStore(path);
  t.after(() => store.close());
  assert.equal(store.execute("list_boards", {}, human).boards.length, 1);
  assert.equal(store.execute("get_task", { id: "TNB-001" }, human).version, 3);
  assert.equal(
    store.execute("create_task", { board: "TNB", title: "Again" }, human).id,
    "TNB-004",
  );
});
test("epic colours rotate through the palette and accept custom hex", (t) => {
  const s = fixture(t);
  const first = s.execute("create_epic", { board: "TNB", title: "One" }, human);
  const second = s.execute("create_epic", { board: "TNB", title: "Two" }, human);
  assert.equal(first.color, "aurora");
  assert.equal(second.color, "lagoon");
  const chosen = s.execute(
    "create_epic",
    { board: "TNB", title: "Three", color: "flamingo" },
    human,
  );
  assert.equal(chosen.color, "flamingo");
  const custom = s.execute(
    "update_epic",
    { id: first.id, expectedVersion: 1, patch: { color: "#FF00AA" } },
    human,
  );
  assert.equal(custom.color, "#ff00aa");
  for (const color of ["red", "#fff", "url(x)", "#12345g"])
    assert.throws(
      () => s.execute("create_epic", { board: "TNB", title: "Bad", color }, human),
      { code: "VALIDATION" },
    );
});
test("a new workspace starts with board TNB and requires a board for tasks", (t) => {
  const s = fixture(t);
  const [board] = s.execute("list_boards", {}, a).boards;
  assert.equal(board.id, "TNB");
  assert.equal(board.title, "Studio");
  assert.equal(board.showInSidebar, true);
  assert.throws(() => s.execute("create_task", { title: "Nowhere" }, human), {
    code: "VALIDATION",
  });
  assert.throws(
    () => s.execute("create_task", { board: "NOPE", title: "Lost" }, human),
    { code: "NOT_FOUND" },
  );
  assert.equal(s.execute("list_tasks", {}, human).total, 0);
});
test("each board numbers its own tasks and prefixes their IDs", (t) => {
  const s = fixture(t);
  const web = s.execute("create_board", { id: "WEB2", title: " Website " }, human);
  assert.equal(web.title, "Website");
  assert.equal(web.showInSidebar, true);
  assert.equal(web.version, 1);
  const create = (board) =>
    s.execute("create_task", { board, title: `On ${board}` }, a);
  const ids = [create("TNB"), create("WEB2"), create("WEB2"), create("TNB")];
  assert.deepEqual(
    ids.map((task) => [task.id, task.board]),
    [
      ["TNB-001", "TNB"],
      ["WEB2-001", "WEB2"],
      ["WEB2-002", "WEB2"],
      ["TNB-002", "TNB"],
    ],
  );
  assert.equal(s.execute("get_task", { id: "WEB2-002" }, a).title, "On WEB2");
  // Numbers are never reused, even after archiving.
  s.execute("archive_task", { id: "WEB2-002", expectedVersion: 1 }, human);
  assert.equal(create("WEB2").id, "WEB2-003");
  assert.deepEqual(
    s.execute("list_tasks", { board: "WEB2" }, a).tasks.map((task) => task.id),
    ["WEB2-003", "WEB2-001"],
  );
  s.execute("claim_task", { id: "TNB-001", expectedVersion: 1 }, a);
  const { boards } = s.execute("list_boards", {}, a);
  assert.deepEqual(
    boards.map((b) => [b.id, b.counts]),
    [
      ["TNB", { backlog: 1, in_progress: 1, in_review: 0, done: 0 }],
      ["WEB2", { backlog: 2, in_progress: 0, in_review: 0, done: 0 }],
    ],
  );
  const backup = s.execute("export_workspace", {}, human);
  assert.deepEqual(backup.boards.map((b) => b.id), ["TNB", "WEB2"]);
  assert.equal(Object.hasOwn(backup.boards[0], "counts"), false);
  assert.ok(
    backup.events.some(
      (e) => e.task_id === "WEB2" && e.kind === "create_board",
    ),
  );
});
test("board writes are human-only, unique, validated and versioned", (t) => {
  const s = fixture(t);
  assert.throws(
    () => s.execute("create_board", { id: "AGT", title: "Agent board" }, a),
    { code: "FORBIDDEN" },
  );
  assert.throws(
    () => s.execute("create_board", { id: "TNB", title: "Again" }, human),
    { code: "BOARD_EXISTS" },
  );
  for (const id of ["T", "tnb", "1AB", "TOOLONGBOARD", "WE-B", "EPIC"])
    assert.throws(
      () => s.execute("create_board", { id, title: "Bad" }, human),
      { code: "VALIDATION" },
    );
  const hidden = s.execute(
    "create_board",
    { id: "OPS", title: "Ops", showInSidebar: false },
    human,
  );
  assert.equal(hidden.showInSidebar, false);
  assert.throws(
    () =>
      s.execute(
        "update_board",
        { id: "OPS", expectedVersion: 1, patch: { showInSidebar: true } },
        a,
      ),
    { code: "FORBIDDEN" },
  );
  const shown = s.execute(
    "update_board",
    { id: "OPS", expectedVersion: 1, patch: { showInSidebar: true } },
    human,
  );
  assert.equal(shown.showInSidebar, true);
  assert.equal(shown.version, 2);
  assert.throws(
    () =>
      s.execute(
        "update_board",
        { id: "OPS", expectedVersion: 1, patch: { showInSidebar: false } },
        human,
      ),
    { code: "VERSION_CONFLICT" },
  );
  for (const patch of [{}, { id: "NEW" }, { title: " " }])
    assert.throws(
      () =>
        s.execute(
          "update_board",
          { id: "OPS", expectedVersion: 2, patch },
          human,
        ),
      { code: "VALIDATION" },
    );
  assert.throws(
    () =>
      s.execute(
        "update_board",
        { id: "NONE", expectedVersion: 1, patch: { title: "X" } },
        human,
      ),
    { code: "NOT_FOUND" },
  );
  const ops = s
    .execute("list_boards", {}, human)
    .boards.find((b) => b.id === "OPS");
  assert.equal(ops.showInSidebar, true);
  assert.equal(ops.version, 2);
});
test("epics take custom codenames and stay on their board", (t) => {
  const s = fixture(t);
  s.execute("create_board", { id: "WEB", title: "Website" }, human);
  const launch = s.execute(
    "create_epic",
    { board: "WEB", id: "Q3-LAUNCH", title: "Launch" },
    human,
  );
  assert.equal(launch.id, "Q3-LAUNCH");
  assert.equal(launch.board, "WEB");
  // Server-allocated IDs are unaffected by codenames.
  const plain = s.execute("create_epic", { board: "TNB", title: "Plain" }, human);
  assert.match(plain.id, /^EPIC-\d+$/);
  assert.equal(plain.board, "TNB");
  assert.throws(
    () =>
      s.execute(
        "create_epic",
        { board: "TNB", id: "Q3-LAUNCH", title: "Twice" },
        human,
      ),
    { code: "EPIC_EXISTS" },
  );
  for (const id of ["WEB-12", "TNB-001", "EPIC-7", "q3", "Q3--X", "-Q3", "X".repeat(33)])
    assert.throws(
      () => s.execute("create_epic", { board: "TNB", id, title: "Bad" }, human),
      { code: "VALIDATION" },
      id,
    );
  assert.throws(
    () => s.execute("create_epic", { board: "NOPE", title: "Lost" }, human),
    { code: "NOT_FOUND" },
  );
  assert.throws(
    () =>
      s.execute(
        "create_task",
        { board: "TNB", title: "Wrong board", epic: "Q3-LAUNCH" },
        human,
      ),
    { code: "EPIC_BOARD_MISMATCH" },
  );
  const webTask = s.execute(
    "create_task",
    { board: "WEB", title: "Right board", epic: "Q3-LAUNCH" },
    a,
  );
  assert.equal(webTask.epic, "Q3-LAUNCH");
  const tnbTask = s.make();
  assert.throws(
    () =>
      s.execute(
        "update_task",
        { id: tnbTask.id, expectedVersion: 1, patch: { epic: "Q3-LAUNCH" } },
        human,
      ),
    { code: "EPIC_BOARD_MISMATCH" },
  );
  assert.throws(
    () =>
      s.execute(
        "update_task",
        { id: webTask.id, expectedVersion: 1, patch: { epic: plain.id } },
        human,
      ),
    { code: "EPIC_BOARD_MISMATCH" },
  );
  assert.equal(s.execute("get_task", { id: tnbTask.id }, human).version, 1);
  assert.deepEqual(
    s.execute("list_epics", { board: "WEB" }, a).epics.map((e) => e.id),
    ["Q3-LAUNCH"],
  );
  assert.deepEqual(
    s.execute("list_epics", { board: "TNB" }, a).epics.map((e) => e.id),
    [plain.id],
  );
  assert.equal(
    s.execute("list_epics", {}, a).epics.length,
    2,
  );
  assert.throws(() => s.execute("list_epics", { board: "web" }, a), {
    code: "VALIDATION",
  });
  assert.deepEqual(
    s
      .execute("list_tasks", { board: "WEB", epic: "Q3-LAUNCH" }, a)
      .tasks.map((task) => task.id),
    [webTask.id],
  );
});

test("rename_board moves every task, its history and epics to the new prefix", (t) => {
  const s = fixture(t);
  s.execute("create_board", { id: "WEB", title: "Website" }, human);
  s.execute("create_epic", { board: "WEB", id: "HOME", title: "Home" }, human);
  const first = s.execute("create_task", { board: "WEB", title: "One", epic: "HOME" }, human);
  s.execute("add_comment", { id: first.id, expectedVersion: 1, body: "Note" }, human);
  let second = s.execute("create_task", { board: "WEB", title: "Two" }, human);
  second = s.execute("archive_task", { id: second.id, expectedVersion: 1 }, human);
  const other = s.execute("create_task", { board: "TNB", title: "Stays" }, human);

  assert.throws(
    () => s.execute("rename_board", { id: "WEB", expectedVersion: 1, newId: "SITE" }, a),
    { code: "FORBIDDEN" },
  );
  assert.throws(
    () => s.execute("rename_board", { id: "WEB", expectedVersion: 1, newId: "TNB" }, human),
    { code: "BOARD_EXISTS" },
  );
  assert.throws(
    () => s.execute("rename_board", { id: "WEB", expectedVersion: 1, newId: "WEB" }, human),
    { code: "VALIDATION" },
  );
  // A claim names the old ID, so the rename waits for it.
  const claimed = s.execute("claim_task", { id: first.id, expectedVersion: 2 }, a);
  assert.throws(
    () => s.execute("rename_board", { id: "WEB", expectedVersion: 1, newId: "SITE" }, human),
    { code: "LEASE_CONFLICT" },
  );
  s.execute("release_task", { id: first.id, expectedVersion: claimed.version }, a);

  const board = s.execute("rename_board", { id: "WEB", expectedVersion: 1, newId: "SITE" }, human);
  assert.equal(board.id, "SITE");
  assert.equal(board.version, 2);
  const moved = s.execute("get_task", { id: "SITE-001" }, human);
  assert.equal(moved.board, "SITE");
  assert.equal(moved.epic, "HOME");
  assert.equal(moved.commentCount, 1);
  const renamedEvent = moved.events.at(-1);
  assert.equal(renamedEvent.kind, "rename_board");
  assert.equal(renamedEvent.body, JSON.stringify({ from: "WEB-001", to: "SITE-001" }));
  assert.equal(s.execute("get_task", { id: "SITE-002" }, human).title, "Two");
  assert.equal(s.execute("get_task", { id: other.id }, human).board, "TNB");
  assert.deepEqual(
    s.execute("list_epics", { board: "SITE" }, human).epics.map((e) => e.id),
    ["HOME"],
  );
  assert.deepEqual(s.execute("list_boards", {}, human).boards.map((b) => b.id), ["TNB", "SITE"]);
  // Numbering continues.
  assert.equal(s.execute("create_task", { board: "SITE", title: "Three" }, human).id, "SITE-003");

  // The old prefix redirects: reads, writes, board filters and new tasks.
  assert.equal(s.execute("get_task", { id: "WEB-001" }, human).id, "SITE-001");
  const edited = s.execute(
    "update_task",
    { id: "WEB-001", expectedVersion: moved.version, patch: { title: "One!" } },
    human,
  );
  assert.equal(edited.id, "SITE-001");
  assert.equal(s.execute("list_tasks", { board: "WEB" }, human).total, 2);
  assert.equal(s.execute("create_task", { board: "WEB", title: "Four" }, human).id, "SITE-004");
  assert.deepEqual(s.execute("list_boards", {}, human).boards[1].formerIds, ["WEB"]);

  // A second rename keeps the chain one hop: WEB and SITE both reach HOME1.
  s.execute("rename_board", { id: "WEB", expectedVersion: 2, newId: "HOME1" }, human);
  assert.equal(s.execute("get_task", { id: "WEB-002" }, human).id, "HOME1-002");
  assert.equal(s.execute("get_task", { id: "SITE-002" }, human).id, "HOME1-002");
  assert.deepEqual(s.execute("list_boards", {}, human).boards[1].formerIds, ["SITE", "WEB"]);

  // Registering an old prefix again drops its redirect only.
  assert.equal(s.execute("create_board", { id: "WEB", title: "New web" }, human).id, "WEB");
  assert.equal(s.execute("create_task", { board: "WEB", title: "Fresh" }, human).id, "WEB-001");
  assert.equal(s.execute("get_task", { id: "WEB-001" }, human).title, "Fresh");
  assert.equal(s.execute("get_task", { id: "SITE-001" }, human).id, "HOME1-001");
  assert.deepEqual(s.execute("list_boards", {}, human).boards[1].formerIds, ["SITE"]);

  // Renaming back onto a former ID takes it over as well.
  s.execute("rename_board", { id: "HOME1", expectedVersion: 3, newId: "SITE" }, human);
  assert.equal(s.execute("get_task", { id: "HOME1-001" }, human).id, "SITE-001");
  assert.deepEqual(s.execute("list_boards", {}, human).boards[1].formerIds, ["HOME1"]);
  const backup = s.execute("export_workspace", {}, human);
  assert.deepEqual(
    backup.boardRedirects.map((r) => [r.fromId, r.toId]),
    [["HOME1", "SITE"]],
  );
  const events = backup.events;
  assert.ok(events.some((e) => e.task_id === "SITE" && e.kind === "create_board"));
  assert.throws(() => s.execute("get_task", { id: "HOME1-099" }, human), { code: "NOT_FOUND" });
});
