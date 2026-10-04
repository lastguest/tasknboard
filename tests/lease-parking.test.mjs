import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const owner = { id: "worker", kind: "agent" };
const other = { id: "other", kind: "agent" };
const architect = { id: "planner", kind: "agent", role: "architect" };

function fixture(t) {
  let now = 1000000;
  const store = createStore(":memory:", { clock: () => now });
  t.after(() => store.close());
  const create = () => store.execute("create_task", { boardId: "BOARD-1", title: "Park work", assignee: owner.id }, human);
  const claim = () => {
    const task = create();
    return store.execute("claim_task", { id: task.id, expectedVersion: task.version }, owner);
  };
  return { ...store, create, claim, now: () => now, expire: () => { now += 900000; } };
}

test("workers park their active claims without changing the assignee", (t) => {
  const s = fixture(t);
  const task = s.claim();
  const parked = s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: "LANE-1" } }, owner);
  assert.equal(parked.lane, "LANE-1");
  assert.equal(parked.lease, null);
  assert.equal(parked.assignee, owner.id);
  assert.equal(parked.version, task.version + 1);
  assert.equal(parked.events.length, task.events.length + 1);
});

test("expired owners can park or resume with one versioned lane move", (t) => {
  const s = fixture(t);
  const parkedTask = s.claim();
  const resumedTask = s.claim();
  s.expire();
  const parked = s.execute("update_task", { id: parkedTask.id, expectedVersion: parkedTask.version, patch: { lane: "LANE-1" } }, owner);
  const resumed = s.execute("update_task", { id: resumedTask.id, expectedVersion: resumedTask.version, patch: { lane: "LANE-2" } }, owner);
  assert.equal(parked.lease, null);
  assert.equal(parked.assignee, owner.id);
  assert.deepEqual(resumed.lease, { actor: owner.id, expiresAt: s.now() + 900000,expiresInSeconds:900 });
  for (const [before, after] of [[parkedTask, parked], [resumedTask, resumed]]) {
    assert.equal(after.version, before.version + 1);
    assert.equal(after.events.length, before.events.length + 1);
  }
});

test("expired own lane moves retain version checks and cannot change other fields or bypass review", (t) => {
  const s = fixture(t);
  const task = s.claim();
  s.expire();
  for (const [patch, expectedVersion, code] of [
    [{ lane: "LANE-1" }, task.version - 1, "VERSION_CONFLICT"],
    [{ lane: "LANE-1", title: "Changed" }, task.version, "LEASE_REQUIRED"],
    [{ lane: "LANE-1", assignee: other.id }, task.version, "LEASE_REQUIRED"],
    [{ lane: "LANE-3" }, task.version, "FORBIDDEN"],
  ]) {
    assert.throws(() => s.execute("update_task", { id: task.id, expectedVersion, patch }, owner), { code });
    assert.deepEqual(s.execute("get_task", { id: task.id }, human), {...task,lease:{...task.lease,expiresInSeconds:0}});
  }
});

test("workers cannot park foreign claims or unclaimed tasks", (t) => {
  const s = fixture(t);
  const task = s.claim();
  const unclaimed = s.create();
  const move = (task, actor) => s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: "LANE-1" } }, actor);
  assert.throws(() => move(task, other), { code: "LEASE_CONFLICT" });
  s.expire();
  assert.throws(() => move(task, other), { code: "LEASE_REQUIRED" });
  assert.throws(() => move(unclaimed, owner), { code: "LEASE_REQUIRED" });
  assert.deepEqual(s.execute("get_task", { id: task.id }, human), {...task,lease:{...task.lease,expiresInSeconds:0}});
});

test("bulk parking handles expired own leases and rolls back when any task fails", (t) => {
  const s = fixture(t);
  const first = s.claim();
  const second = s.claim();
  const foreignCreated = s.create();
  const foreign = s.execute("claim_task", { id: foreignCreated.id, expectedVersion: foreignCreated.version }, other);
  s.expire();
  const input = (tasks) => ({ tasks: tasks.map(({ id, version }) => ({ id, expectedVersion: version })), lane: "LANE-1" });
  assert.throws(() => s.execute("bulk_move_tasks", input([first, foreign]), owner), { code: "LEASE_REQUIRED" });
  assert.deepEqual(s.execute("get_task", { id: first.id }, human), {...first,lease:{...first.lease,expiresInSeconds:0}});
  const moved = s.execute("bulk_move_tasks", input([first, second]), owner);
  for (const task of moved.tasks) {
    assert.equal(task.lane, "LANE-1");
    assert.equal(task.lease, null);
    assert.equal(task.assignee, owner.id);
  }
});

test("active workers cannot reassign while parking and architects keep their lane rights", (t) => {
  const s = fixture(t);
  const task = s.claim();
  assert.throws(() => s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: "LANE-1", assignee: other.id } }, owner), { code: "FORBIDDEN" });
  const parked = s.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { lane: "LANE-1" } }, architect);
  assert.equal(parked.lease, null);
  assert.equal(parked.assignee, owner.id);
});
