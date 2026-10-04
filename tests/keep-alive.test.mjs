import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";

const human={id:"you",kind:"human"};
const worker={id:"worker",kind:"agent"};
const other={id:"other",kind:"agent"};
const planner={id:"planner",kind:"agent",role:"architect"};

function fixture(t){
  let now=1000000;
  const store=createStore(":memory:",{clock:()=>now});
  t.after(()=>store.close());
  const create=(actor=worker)=>store.execute("create_task",{boardId:"BOARD-1",title:"Long call"},actor);
  const claim=(actor=worker)=>{const task=create();return store.execute("claim_task",{id:task.id,expectedVersion:task.version},actor);};
  return {...store,create,claim,advance:milliseconds=>now+=milliseconds,now:()=>now};
}

test("automatic maintenance renews only a near-expiry owned claim without a version change",t=>{
  const s=fixture(t),task=s.claim();
  assert.deepEqual(s.execute("keep_alive",{ids:[task.id]},worker),{renewed:[]});
  s.advance(600000);
  const renewed=s.execute("keep_alive",{ids:[task.id,task.id]},worker);
  assert.deepEqual(renewed,{renewed:[{id:task.id,lease:{actor:worker.id,expiresAt:s.now()+900000,expiresInSeconds:900}}]});
  const current=s.execute("get_task",{id:task.id},worker);
  assert.equal(current.version,task.version);
  assert.equal(current.updatedAt,task.updatedAt);
  assert.equal(current.events.filter(event=>event.kind==="auto_heartbeat").length,1);
  const changed=s.execute("update_task",{id:task.id,expectedVersion:task.version,patch:{title:"Call completed"}},worker);
  assert.equal(changed.title,"Call completed");
  assert.equal(changed.lease.expiresAt,renewed.renewed[0].lease.expiresAt);
});

test("automatic maintenance never reclaims expired, foreign, idle, delegated or archived tasks",t=>{
  const s=fixture(t),owned=s.claim(),foreign=s.claim(other),idle=s.create();
  let delegated=s.create();
  delegated=s.execute("delegate_task",{id:delegated.id,expectedVersion:delegated.version,delegatedTo:worker.id},planner);
  delegated=s.execute("claim_task",{id:delegated.id,expectedVersion:delegated.version},worker);
  let archived=s.claim();
  archived=s.execute("archive_task",{id:archived.id,expectedVersion:archived.version},worker);
  s.advance(600000);
  assert.deepEqual(s.execute("keep_alive",{ids:[foreign.id,idle.id,delegated.id,archived.id,"TNB-999"]},worker),{renewed:[]});
  assert.deepEqual(s.execute("keep_alive",{ids:[foreign.id]},planner),{renewed:[]});
  s.advance(300000);
  assert.deepEqual(s.execute("keep_alive",{ids:[owned.id]},worker),{renewed:[]});
  assert.equal(s.execute("get_task",{id:owned.id},worker).lease.expiresAt,owned.lease.expiresAt);
  assert.equal(s.execute("get_task",{id:owned.id},worker).version,owned.version);
});

test("maintenance reads fresh task data and keeps comments, versions and timestamps",t=>{
  const s=fixture(t),task=s.claim();
  s.advance(600000);
  const edited=s.execute("update_task",{id:task.id,expectedVersion:task.version,patch:{description:"Concurrent note",labels:["Keep"]}},planner);
  const commented=s.execute("add_comment",{id:task.id,body:"Progress recorded"},other);
  s.execute("keep_alive",{ids:[task.id]},worker);
  const current=s.execute("get_task",{id:task.id},worker);
  assert.equal(current.description,edited.description);
  assert.deepEqual(current.labels,edited.labels);
  assert.equal(current.commentCount,1);
  assert.equal(current.version,commented.version);
  assert.equal(current.updatedAt,commented.updatedAt);
});

test("humans cannot request automatic agent claim maintenance",t=>{
  const s=fixture(t),task=s.claim();
  s.advance(600000);
  assert.throws(()=>s.execute("keep_alive",{ids:[task.id]},human),{code:"FORBIDDEN"});
  assert.equal(s.execute("get_task",{id:task.id},human).lease.expiresAt,task.lease.expiresAt);
  assert.equal(s.execute("get_task",{id:task.id},human).events.some(event=>event.kind==="auto_heartbeat"),false);
});
