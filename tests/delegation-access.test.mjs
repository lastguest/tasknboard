import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const worker = { id: "codex/delegator", kind: "agent" };
const holder = { id: "codex/holder", kind: "agent" };
const architect = { id: "claude/planner", kind: "agent", role: "architect" };
const delegate = "codex/delegate";

function fixture(t) {
  let now = 1000000;
  const store = createStore(":memory:", { clock: () => now });
  t.after(() => store.close());
  const task = store.execute("create_task", {
    boardId: "BOARD-1", title: "Delegate execution", assignee: "owner",
  }, human);
  return { ...store, task, advance: (ms) => { now += ms; } };
}

function assertDelegated(task, previous, actor) {
  assert.equal(task.delegatedTo, delegate);
  assert.equal(task.delegatedBy, actor.id);
  assert.equal(task.assignee, previous.assignee);
  assert.equal(task.role, "in_progress");
  assert.equal(task.lease, null);
  assert.equal(task.version, previous.version + 1);
  assert.equal(task.events.length, previous.events.length + 1);
  assert.equal(task.events.at(-1).kind, "delegate_task");
  assert.equal(task.events.at(-1).actor, actor.id);
}

test("a noncreator worker delegates an unclaimed task without a claim", (t) => {
  const s = fixture(t);
  assert.notEqual(s.task.creator, worker.id);
  const delegated = s.execute("delegate_task", {
    id: s.task.id, expectedVersion: s.task.version, delegatedTo: delegate,
  }, worker);
  assertDelegated(delegated, s.task, worker);
});

test("a worker delegates directly after another worker's claim expires", (t) => {
  const s = fixture(t);
  const claimed = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, holder);
  s.advance(900000);
  const delegated = s.execute("delegate_task", {
    id: claimed.id, expectedVersion: claimed.version, delegatedTo: delegate,
  }, worker);
  assertDelegated(delegated, claimed, worker);
});

test("an architect delegates directly despite another worker's active claim", (t) => {
  const s = fixture(t);
  const claimed = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, holder);
  const delegated = s.execute("delegate_task", {
    id: claimed.id, expectedVersion: claimed.version, delegatedTo: delegate,
  }, architect);
  assertDelegated(delegated, claimed, architect);
});

test("workers retain claim exclusion and can delegate their own active claim", (t) => {
  const s = fixture(t);
  const claimed = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, holder);
  assert.throws(() => s.execute("delegate_task", {
    id: claimed.id, expectedVersion: claimed.version, delegatedTo: delegate,
  }, worker), { code: "LEASE_CONFLICT" });
  assert.deepEqual(s.execute("get_task", { id: claimed.id }, human), claimed);
  const delegated = s.execute("delegate_task", {
    id: claimed.id, expectedVersion: claimed.version, delegatedTo: delegate,
  }, holder);
  assertDelegated(delegated, claimed, holder);
});

test("direct delegation retains version checks", (t) => {
  const s = fixture(t);
  const changed = s.execute("add_comment", { id: s.task.id, body: "New context" }, human);
  for (const actor of [worker, architect]) {
    assert.throws(() => s.execute("delegate_task", {
      id: changed.id, expectedVersion: s.task.version, delegatedTo: delegate,
    }, actor), { code: "VERSION_CONFLICT" });
  }
  assert.deepEqual(s.execute("get_task", { id: changed.id }, human), changed);
});

for (const lane of ["LANE-3", "LANE-4"]) {
  test(`direct delegation rejects tasks in ${lane}`, (t) => {
    const s = fixture(t);
    const closed = s.execute("create_task", {
      boardId: "BOARD-1", title: "Closed task", lane,
    }, human);
    for (const actor of [worker, architect]) {
      assert.throws(() => s.execute("delegate_task", {
        id: closed.id, expectedVersion: closed.version, delegatedTo: delegate,
      }, actor), { code: "INVALID_TRANSITION" });
    }
    assert.deepEqual(s.execute("get_task", { id: closed.id }, human), closed);
  });
}
