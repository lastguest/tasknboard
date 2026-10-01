import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const alice = { id: "alice", kind: "human" };
const bob = { id: "bob", kind: "human" };
const agent = { id: "agent-a", kind: "agent" };

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const [board] = store.execute("list_boards", {}, alice).boards;
  store.registerActors([bob, agent]);
  return { store, board };
}

const comment = (store, actor, id, body) => {
  const { version } = store.execute("get_task", { id }, actor);
  return store.execute("add_comment", { id, expectedVersion: version, body }, actor);
};
const submit = (store, id) => {
  let task = store.execute("get_task", { id }, agent);
  task = store.execute("claim_task", { id, expectedVersion: task.version }, agent);
  return store.execute(
    "submit_review",
    { id, expectedVersion: task.version, summary: "Ready to check" },
    agent,
  );
};
const reasons = (store, actor) =>
  store.execute("list_inbox", {}, actor).items.map((item) => [item.taskId, item.reason]);

test("comments, mentions and reviews reach the people they concern, never their author", (t) => {
  const { store, board } = fixture(t);
  const mine = store.execute("create_task", { boardId: board.id, title: "Mine" }, alice);
  const other = store.execute("create_task", { boardId: board.id, title: "Other" }, bob);
  comment(store, bob, mine.id, "Looks good");
  comment(store, bob, other.id, "Can @alice check this?");
  comment(store, alice, mine.id, "My own note");
  submit(store, mine.id);

  const inbox = store.execute("list_inbox", {}, alice);
  assert.deepEqual(
    inbox.items.map((item) => [item.taskId, item.reason, item.kind, item.actor]),
    [
      [mine.id, "review", "submit_review", agent.id],
      [other.id, "mention", "add_comment", bob.id],
      [mine.id, "comment", "add_comment", bob.id],
    ],
  );
  assert.equal(inbox.items[0].excerpt, "Ready to check");
  assert.equal(inbox.items[0].taskTitle, "Mine");
  assert.equal(inbox.unread, 3);
  // Bob created "Other"; Alice's note on her own task does not concern him.
  assert.deepEqual(reasons(store, bob), []);
});

test("an assignee receives comments and reviews; agent-only tasks reach every human", (t) => {
  const { store, board } = fixture(t);
  const assigned = store.execute(
    "create_task",
    { boardId: board.id, title: "Assigned", assignee: bob.id },
    alice,
  );
  comment(store, alice, assigned.id, "Please start");
  assert.deepEqual(reasons(store, bob), [[assigned.id, "comment"]]);

  // An agent creates and claims the task, so no human owns it.
  const orphan = store.execute("create_task", { boardId: board.id, title: "Agent work" }, agent);
  submit(store, orphan.id);
  assert.deepEqual(reasons(store, alice)[0], [orphan.id, "review"]);
  assert.deepEqual(reasons(store, bob)[0], [orphan.id, "review"]);
});

test("the read cursor only moves forward and counts unread items", (t) => {
  const { store, board } = fixture(t);
  const task = store.execute("create_task", { boardId: board.id, title: "Mine" }, alice);
  comment(store, bob, task.id, "First");
  comment(store, bob, task.id, "Second");
  const [newest, oldest] = store.execute("list_inbox", {}, alice).items;
  // The count covers items beyond the limit.
  assert.equal(store.execute("list_inbox", { limit: 1 }, alice).unread, 2);

  assert.deepEqual(
    store.execute("mark_inbox_read", { upTo: oldest.sequence }, alice),
    { sequence: oldest.sequence, unread: 1 },
  );
  assert.deepEqual(
    store.execute("mark_inbox_read", { upTo: newest.sequence }, alice),
    { sequence: newest.sequence, unread: 0 },
  );
  // An older position never moves the cursor back.
  assert.deepEqual(
    store.execute("mark_inbox_read", { upTo: oldest.sequence }, alice),
    { sequence: newest.sequence, unread: 0 },
  );
  assert.throws(
    () => store.execute("mark_inbox_read", { upTo: newest.sequence + 100 }, alice),
    { code: "VALIDATION" },
  );
  // Reading is personal: the task keeps its version and gains no event.
  const after = store.execute("get_task", { id: task.id }, alice);
  assert.equal(after.version, task.version + 2);
  assert.equal(after.events.length, 3);

  comment(store, bob, task.id, "Third");
  assert.equal(store.execute("list_inbox", {}, alice).unread, 1);
  assert.equal(store.execute("list_inbox", { limit: 1 }, alice).items.length, 1);
});

test("archived tasks leave the inbox and its unread count", (t) => {
  const { store, board } = fixture(t);
  const task = store.execute("create_task", { boardId: board.id, title: "Mine" }, alice);
  const commented = comment(store, bob, task.id, "Note");
  assert.equal(store.execute("list_inbox", {}, alice).unread, 1);
  store.execute("archive_task", { id: task.id, expectedVersion: commented.version }, alice);
  assert.deepEqual(store.execute("list_inbox", {}, alice), { items: [], unread: 0 });
});
