import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const owner = { id: "claude", kind: "agent" };
const other = { id: "codex", kind: "agent" };

function fixture(t) {
  let now = 1000000;
  const store = createStore(":memory:", { clock: () => now });
  t.after(() => store.close());
  const task = store.execute("create_task", { boardId: "BOARD-1", title: "Lease work" }, human);
  return { ...store, task, now: () => now, advance: (ms) => { now += ms; } };
}

test("an owned active claim returns current data without renewal or events, including stale retries", (t) => {
  const s = fixture(t);
  const claimed = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, owner);
  s.advance(1000);
  const updated = s.execute("add_comment", { id: claimed.id, body: "A concurrent comment" }, other);
  for (const expectedVersion of [s.task.version, claimed.version, updated.version]) {
    const retried = s.execute("claim_task", { id: claimed.id, expectedVersion }, owner);
    assert.deepEqual(retried, updated);
    assert.equal(retried.lease.expiresAt, claimed.lease.expiresAt);
  }
  assert.throws(() => s.execute("heartbeat", { id: claimed.id, expectedVersion: claimed.version }, owner), { code: "VERSION_CONFLICT" });
});

test("a different actor receives the active holder and time remaining from the store clock", (t) => {
  const s = fixture(t);
  const claimed = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, owner);
  s.advance(1234);
  for (const [command, extra] of [["claim_task", {}], ["update_task", { patch: { title: "Other work" } }]]) {
    assert.throws(() => s.execute(command, { id: claimed.id, expectedVersion: claimed.version, ...extra }, other), (error) => {
      assert.equal(error.code, "LEASE_CONFLICT");
      assert.deepEqual(error.details.lease, { actor: owner.id, expiresAt: claimed.lease.expiresAt, now: s.now(), remainingMs: 898766, expiresInSeconds: 899, active: true });
      assert.match(error.message, /holder=claude/);
      assert.match(error.message, /remainingMs=898766/);
      return true;
    });
  }
  assert.deepEqual(s.execute("get_task", { id: claimed.id }, human), {...claimed,lease:{...claimed.lease,expiresInSeconds:899}});
});

test("expired claims retain their holder and expiration in errors and require a versioned new claim", (t) => {
  const s = fixture(t);
  const claimed = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, owner);
  s.advance(900000);
  for (const [command, extra] of [["heartbeat", {}], ["release_task", {}], ["update_task", { patch: { title: "Expired work" } }]]) {
    assert.throws(() => s.execute(command, { id: claimed.id, expectedVersion: claimed.version, ...extra }, owner), (error) => {
      assert.equal(error.code, "LEASE_REQUIRED");
      assert.deepEqual(error.details.lease, { actor: owner.id, expiresAt: claimed.lease.expiresAt, now: s.now(), remainingMs: 0, expiresInSeconds: 0, active: false });
      assert.match(error.message, /expiresAt=1900000/);
      return true;
    });
  }
  s.advance(1);
  assert.throws(() => s.execute("heartbeat", { id: claimed.id, expectedVersion: claimed.version }, owner), (error) => error.details.lease.remainingMs === -1);
  assert.throws(() => s.execute("claim_task", { id: claimed.id, expectedVersion: s.task.version }, owner), { code: "VERSION_CONFLICT" });
  const reclaimed = s.execute("claim_task", { id: claimed.id, expectedVersion: claimed.version }, other);
  assert.equal(reclaimed.lease.actor, other.id);
  assert.equal(reclaimed.lease.expiresAt, s.now() + 900000);
  assert.equal(reclaimed.version, claimed.version + 1);
  assert.equal(reclaimed.events.length, claimed.events.length + 1);
});

test("missing claims report a distinct state", (t) => {
  const s = fixture(t);
  assert.throws(() => s.execute("heartbeat", { id: s.task.id, expectedVersion: s.task.version }, owner), (error) => {
    assert.equal(error.code, "LEASE_REQUIRED");
    assert.deepEqual(error.details.lease, { actor: null, expiresAt: null, remainingMs: 0, expiresInSeconds: 0, now: s.now(), active: false });
    assert.match(error.message, /No lease exists/);
    return true;
  });
});
