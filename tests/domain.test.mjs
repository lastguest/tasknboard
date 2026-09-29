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
  assert.equal(info.schemaVersion, 6);
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
        { title: "Should not be created" },
        {
          id: "Morgan",
          kind: "human",
        },
      ),
    { code: "ACTOR_KIND_CONFLICT", status: 409 },
  );
  assert.equal(s.execute("list_tasks", {}, human).total, 0);
  const backup = s.execute("export_workspace", {}, human);
  assert.equal(backup.schemaVersion, 6);
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
  let task = s.execute(
    "create_task",
    { title: "Tagged task", labels: [" UX ", "Product", "UX"] },
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
    () => s.execute("create_task", { title: "Old field", label: "UX" }, human),
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
  const task = store.execute("create_task", { title: "Existing task" }, human);
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
    { title: "  Onboarding  ", description: "**Why** it matters" },
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
    { title: "Welcome screen", epic: epic.id },
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
  assert.throws(() => s.execute("create_epic", { title: "Agent plan" }, a), {
    code: "FORBIDDEN",
  });
  for (const title of ["", "   ", "x".repeat(121)])
    assert.throws(() => s.execute("create_epic", { title }, human), {
      code: "VALIDATION",
    });
  let epic = s.execute("create_epic", { title: "Billing" }, human);
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
    () => s.execute("create_task", { title: "Lost", epic: "EPIC-99" }, human),
    { code: "NOT_FOUND" },
  );
  assert.throws(
    () => s.execute("create_task", { title: "Bad", epic: "TNB-1" }, human),
    { code: "VALIDATION" },
  );
  assert.throws(() => s.execute("list_tasks", { epic: "" }, human), {
    code: "VALIDATION",
  });
});
test("agents file claimed tasks into epics under lease rules", (t) => {
  const s = fixture(t);
  const epic = s.execute("create_epic", { title: "Search" }, human);
  const created = s.execute(
    "create_task",
    { title: "Agent-made", epic: epic.id },
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
  let epic = s.execute("create_epic", { title: "Launch" }, human);
  let open = s.execute("create_task", { title: "Open", epic: epic.id }, human);
  let finished = s.execute(
    "create_task",
    { title: "Finished", epic: epic.id },
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
    () => s.execute("create_task", { title: "Late", epic: epic.id }, human),
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
test("existing tasks join no epic once, without a version change", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-epics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "workspace.sqlite");
  let store = createStore(path);
  const task = store.execute("create_task", { title: "Before epics" }, human);
  store.close();
  const db = new DatabaseSync(path);
  const { epic, events, commentCount, ...legacy } = task;
  db.prepare("UPDATE tasks SET data=? WHERE number=1").run(
    JSON.stringify(legacy),
  );
  db.exec("DROP TABLE epics; DELETE FROM migrations WHERE version=6");
  db.close();
  store = createStore(path);
  const upgraded = store.execute("get_task", { id: task.id }, human);
  assert.equal(upgraded.epic, "");
  assert.equal(upgraded.version, task.version);
  assert.deepEqual(upgraded.events, events);
  assert.equal(
    store.execute("create_epic", { title: "First" }, human).id,
    "EPIC-1",
  );
  store.close();
});
test("epic colours rotate through the palette and accept custom hex", (t) => {
  const s = fixture(t);
  const first = s.execute("create_epic", { title: "One" }, human);
  const second = s.execute("create_epic", { title: "Two" }, human);
  assert.equal(first.color, "aurora");
  assert.equal(second.color, "lagoon");
  const chosen = s.execute(
    "create_epic",
    { title: "Three", color: "flamingo" },
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
      () => s.execute("create_epic", { title: "Bad", color }, human),
      { code: "VALIDATION" },
    );
});
