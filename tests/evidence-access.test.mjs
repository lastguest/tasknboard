import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const creator = { id: "codex/creator", kind: "agent" };
const architect = { id: "claude/planner", kind: "agent", role: "architect" };
const delegate = { id: "codex/delegate", kind: "agent" };
const unrelated = { id: "codex/other", kind: "agent" };
const sha = "abcdef1234567";

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  let task = store.execute("create_task", { boardId: "BOARD-1", title: "Delegated work" }, creator);
  task = store.execute("delegate_task", { id: task.id, expectedVersion: task.version, delegatedTo: delegate.id }, architect);
  return { ...store, task };
}

for (const actor of [creator, architect]) {
  test(`${actor.id} attaches evidence to delegated work without a claim`, (t) => {
    const s = fixture(t);
    let task = s.execute("link_commits", { id: s.task.id, expectedVersion: s.task.version, commits: [sha] }, actor);
    assert.deepEqual(task.commits, [sha]);
    assert.equal(task.lease, null);
    assert.equal(task.delegatedTo, delegate.id);
    assert.equal(task.role, "in_progress");
    task = s.execute("add_comment", { id: task.id, expectedVersion: task.version, body: "Commit evidence is ready" }, actor);
    assert.equal(task.lease, null);
    assert.equal(task.delegatedTo, delegate.id);
    assert.equal(task.events.at(-1).actor, actor.id);
    task = s.execute("submit_review", { id: task.id, expectedVersion: task.version, summary: "Ready for review" }, actor);
    assert.equal(task.role, "in_review");
    assert.deepEqual(task.commits, [sha]);
  });

  test(`${actor.id} attaches evidence without changing another agent's active claim`, (t) => {
    const s = fixture(t);
    const claimed = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, delegate);
    let task = s.execute("link_commits", { id: claimed.id, expectedVersion: claimed.version, commits: [sha] }, actor);
    assert.deepEqual(task.lease, claimed.lease);
    assert.equal(task.delegatedTo, delegate.id);
    task = s.execute("add_comment", { id: task.id, body: "Evidence attached" }, actor);
    assert.deepEqual(task.lease, claimed.lease);
    assert.equal(task.delegatedTo, delegate.id);
  });
}

test("evidence retains version checks and does not grant creator access to execution changes", (t) => {
  const s = fixture(t);
  const commented = s.execute("add_comment", { id: s.task.id, body: "New context" }, delegate);
  for (const [command, fields] of [["link_commits", { commits: [sha] }], ["add_comment", { body: "Stale comment" }]]) {
    assert.throws(() => s.execute(command, { id: commented.id, expectedVersion: s.task.version, ...fields }, creator), { code: "VERSION_CONFLICT" });
  }
  assert.throws(() => s.execute("update_task", { id: commented.id, expectedVersion: commented.version, patch: { title: "Changed" } }, creator), { code: "LEASE_REQUIRED" });
  assert.throws(() => s.execute("heartbeat", { id: commented.id, expectedVersion: commented.version }, creator), { code: "LEASE_REQUIRED" });
  assert.deepEqual(s.execute("get_task", { id: commented.id }, human), commented);
});

test("other workers require their own claim for commit links while comments stay open", (t) => {
  const s = fixture(t);
  for (const actor of [delegate, unrelated]) {
    assert.throws(() => s.execute("link_commits", { id: s.task.id, expectedVersion: s.task.version, commits: [sha] }, actor), { code: "LEASE_REQUIRED" });
  }
  const claimed = s.execute("claim_task", { id: s.task.id, expectedVersion: s.task.version }, delegate);
  assert.throws(() => s.execute("link_commits", { id: claimed.id, expectedVersion: claimed.version, commits: [sha] }, unrelated), { code: "LEASE_CONFLICT" });
  const commented = s.execute("add_comment", { id: claimed.id, body: "A discussion reply" }, unrelated);
  assert.deepEqual(commented.lease, claimed.lease);
  assert.equal(commented.delegatedTo, delegate.id);
  const linked = s.execute("link_commits", { id: commented.id, expectedVersion: commented.version, commits: [sha] }, delegate);
  assert.deepEqual(linked.commits, [sha]);
  assert.deepEqual(linked.lease, claimed.lease);
});
