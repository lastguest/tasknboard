import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const owner = { id: "codex/owner", kind: "agent" };
const worker = { id: "codex/worker", kind: "agent" };
const architect = { id: "codex/architect", kind: "agent", role: "architect" };

function fixture(t, holder = owner) {
  let now = 1000000;
  const store = createStore(":memory:", { clock: () => now });
  t.after(() => store.close());
  const created = store.execute("create_task", {
    boardId: "BOARD-1", title: "Release the claim", assignee: "assignee",
  }, human);
  const task = store.execute("claim_task", {
    id: created.id, expectedVersion: created.version,
  }, holder);
  return { ...store, task, advance: () => { now += 900001; } };
}

function release(store, task, actor) {
  return store.execute("release_task", { id: task.id, expectedVersion: task.version }, actor);
}

for (const [name, actor] of [["claim owner", owner], ["architect", architect]]) {
  test(`the ${name} releases an active claim and keeps the task fields`, (t) => {
    const s = fixture(t);
    const released = release(s, s.task, actor);
    assert.equal(released.lease, null);
    assert.equal(released.lane, s.task.lane);
    assert.equal(released.assignee, s.task.assignee);
    assert.equal(released.archived, false);
    assert.equal(released.version, s.task.version + 1);
    assert.deepEqual(released.events.slice(0, -1), s.task.events);
    assert.equal(released.events.at(-1).kind, "release_task");
    assert.equal(released.events.at(-1).actor, actor.id);
    const claimed = s.execute("claim_task", {
      id: released.id, expectedVersion: released.version,
    }, worker);
    assert.equal(claimed.lease.actor, worker.id);
  });
}

test("a human claim owner releases its own claim", (t) => {
  const s = fixture(t, human);
  assert.equal(release(s, s.task, human).lease, null);
});

for (const [name, actor] of [["worker", worker], ["human", human]]) {
  test(`another ${name} cannot release the active claim`, (t) => {
    const s = fixture(t);
    assert.throws(() => release(s, s.task, actor), { code: "LEASE_CONFLICT" });
    assert.deepEqual(s.execute("get_task", { id: s.task.id }, human), s.task);
  });
}

test("release requires the current version for owners and architects", (t) => {
  const s = fixture(t);
  const task = s.execute("add_comment", { id: s.task.id, body: "New context" }, human);
  for (const actor of [owner, architect])
    assert.throws(() => release(s, s.task, actor), { code: "VERSION_CONFLICT" });
  assert.deepEqual(s.execute("get_task", { id: task.id }, human), task);
});

test("an architect cannot renew another actor's claim", (t) => {
  const s = fixture(t);
  assert.throws(() => s.execute("heartbeat", {
    id: s.task.id, expectedVersion: s.task.version,
  }, architect), { code: "LEASE_REQUIRED" });
  assert.deepEqual(s.execute("get_task", { id: s.task.id }, human), s.task);
});

test("release requires an active claim, including for architects", (t) => {
  const s = fixture(t);
  s.advance();
  for (const actor of [owner, architect])
    assert.throws(() => release(s, s.task, actor), { code: "LEASE_REQUIRED" });
  const claimed = s.execute("claim_task", {
    id: s.task.id, expectedVersion: s.task.version,
  }, owner);
  const released = release(s, claimed, owner);
  assert.throws(() => release(s, released, architect), { code: "LEASE_REQUIRED" });
});

test("archive clears an active claim and prevents another claim", (t) => {
  const s = fixture(t);
  const archived = s.execute("archive_task", {
    id: s.task.id, expectedVersion: s.task.version,
  }, architect);
  assert.equal(archived.archived, true);
  assert.equal(archived.lease, null);
  assert.throws(() => s.execute("claim_task", {
    id: archived.id, expectedVersion: archived.version,
  }, worker), { code: "ARCHIVED" });
});
