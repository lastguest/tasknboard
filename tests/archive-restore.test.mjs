import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import { DatabaseSync } from "node:sqlite";

const human = { id: "you", kind: "human" };
const creator = { id: "creator", kind: "agent" };
const worker = { id: "worker", kind: "agent" };
const architect = { id: "planner", kind: "agent", role: "architect" };

function fixture(t, path = ":memory:",options) {
  const store = createStore(path,options);
  t.after(() => store.close());
  const task = store.execute("create_task", { boardId: "BOARD-1", title: "Restore this card", assignee: "owner" }, creator);
  return { ...store, task };
}

const archive = (s, task) => s.execute("archive_task", { id: task.id, expectedVersion: task.version }, creator);
const restore = (s, task, actor = creator) => s.execute("restore_task", { id: task.id, expectedVersion: task.version }, actor);

test("new tasks remain visible after an earlier task is archived", (t) => {
  const s = fixture(t);
  assert.equal(s.task.archived, false);
  archive(s, s.task);
  const next = s.execute("create_task", { boardId: "BOARD-1", title: "Next card" }, creator);
  assert.equal(next.archived, false);
  assert.equal(next.version, 1);
  assert.deepEqual(next.events.map((event) => event.kind), ["created"]);
  assert.equal(s.execute("list_tasks", {}, human).tasks.some((task) => task.id === next.id), true);
  assert.throws(() => s.execute("create_task", { boardId: "BOARD-1", title: "Archived injection", archived: true }, creator), { code: "VALIDATION" });
});

test("the creator restores a delegated card with its lane and evidence intact", (t) => {
  const s = fixture(t);
  let task = s.execute("delegate_task", { id: s.task.id, expectedVersion: 1, delegatedTo: worker.id }, creator);
  task = s.execute("link_commits", { id: task.id, expectedVersion: task.version, commits: ["a".repeat(40)] }, creator);
  task = s.execute("add_comment", { id: task.id, body: "Keep this evidence" }, worker);
  const archived = archive(s, task);
  const restored = restore(s, archived);
  assert.equal(restored.archived, false);
  assert.equal(restored.lane, task.lane);
  assert.equal(restored.assignee, task.assignee);
  assert.deepEqual(restored.commits, task.commits);
  assert.equal(restored.lease, null);
  assert.equal(restored.delegatedTo, "");
  assert.equal(restored.delegatedBy, "");
  assert.equal(restored.version, archived.version + 1);
  assert.deepEqual(restored.events.slice(0, -1), archived.events);
  assert.equal(restored.events.at(-1).kind, "restore_task");
  assert.equal(restored.events.at(-1).actor, creator.id);
  assert.equal(s.execute("list_tasks", {}, human).tasks.some((task) => task.id === restored.id), true);
});

for (const actor of [human, architect]) {
  test(`${actor.kind} ${actor.id} restores another actor's task`, (t) => {
    const s = fixture(t);
    assert.equal(restore(s, archive(s, s.task), actor).archived, false);
  });
}

test("an unrelated worker cannot restore a task and failure changes no task history", (t) => {
  const s = fixture(t);
  const archived = archive(s, s.task);
  assert.throws(() => restore(s, archived, worker), { code: "FORBIDDEN" });
  assert.deepEqual(s.execute("get_task", { id: archived.id }, creator), archived);
});

test("restore requires the current version and an archived task", (t) => {
  const s = fixture(t);
  assert.throws(() => restore(s, s.task), { code: "INVALID_TRANSITION" });
  const archived = archive(s, s.task);
  assert.throws(() => restore(s, s.task), { code: "VERSION_CONFLICT" });
  assert.throws(() => s.execute("restore_task", { id: archived.id }, creator), { code: "VALIDATION" });
  assert.throws(() => s.execute("update_task", { id: archived.id, expectedVersion: archived.version, patch: { archived: false } }, creator), { code: "VALIDATION" });
  assert.deepEqual(s.execute("get_task", { id: archived.id }, creator), archived);
  const restored = restore(s, archived);
  assert.throws(() => restore(s, restored), { code: "INVALID_TRANSITION" });
});

test("restored state and archive attribution survive a database reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tasknboard-restore-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "workspace.sqlite");
  const first = createStore(path);
  let restored;
  try {
    const created = first.execute("create_task", { boardId: "BOARD-1", title: "Persistent card" }, creator);
    const archived = first.execute("archive_task", { id: created.id, expectedVersion: 1 }, creator);
    restored = restore(first, archived);
  } finally {
    first.close();
  }
  const reopened = createStore(path);
  try {
    assert.deepEqual(reopened.execute("get_task", { id: restored.id }, creator), restored);
    assert.deepEqual(restored.events.map(({ kind, actor }) => [kind, actor]), [["created", "creator"], ["archive_task", "creator"], ["restore_task", "creator"]]);
    assert.equal(reopened.execute("list_tasks", {}, creator).tasks.some((task) => task.id === restored.id), true);
  } finally {
    reopened.close();
  }
});

test("a creator worker restores its recent archive even after another actor touched the task",t=>{
  let now=1000000;const s=fixture(t,":memory:",{clock:()=>now});
  const touched=s.execute("add_comment",{id:s.task.id,body:"Human context"},human);
  const archived=archive(s,touched);now+=599999;
  const restored=restore(s,archived);
  assert.equal(restored.archived,false);
  assert.equal(restored.events.at(-1).kind,"restore_task");
});

for(const command of ["archive_task","reject_task"]){
  test(`a creator worker cannot reverse a human ${command}`,t=>{
    const s=fixture(t);const archived=s.execute(command,{id:s.task.id,expectedVersion:s.task.version},human);
    assert.throws(()=>restore(s,archived),{code:"FORBIDDEN"});
    assert.equal(s.execute("get_task",{id:s.task.id},human).archived,true);
    assert.equal(restore(s,archived,architect).archived,false);
  });
}

test("a creator worker cannot restore an old archive after another actor touched the task",t=>{
  let now=1000000;const s=fixture(t,":memory:",{clock:()=>now});
  const touched=s.execute("add_comment",{id:s.task.id,body:"Human context"},human);
  const archived=archive(s,touched);now+=600001;
  assert.throws(()=>restore(s,archived),{code:"FORBIDDEN"});
  assert.equal(restore(s,archived,human).archived,false);
});

test("a creator worker restores an old archive on an untouched task",t=>{
  let now=1000000;const s=fixture(t,":memory:",{clock:()=>now});
  const archived=archive(s,s.task);now+=86400000;
  assert.equal(restore(s,archived).archived,false);
});

test("a creator worker restores a legacy archive with no task history snapshot",t=>{
  const directory=mkdtempSync(join(tmpdir(),"tasknboard-legacy-restore-"));
  const path=join(directory,"workspace.sqlite");let store=createStore(path);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const task=store.execute("create_task",{boardId:"BOARD-1",title:"Old archive"},creator);
  const archived=archive(store,task);store.close();
  const db=new DatabaseSync(path);db.exec("DELETE FROM task_history; DELETE FROM migrations WHERE version=21");db.close();
  store=createStore(path);
  assert.equal(restore(store,archived).archived,false);
});
