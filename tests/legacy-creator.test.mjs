import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../server/store.mjs";

const creator={id:"creator",kind:"agent"};
const human={id:"you",kind:"human"};

for(const hasCreatedEvent of [true,false]) {
  test(`task lists handle a missing creator field ${hasCreatedEvent ? "with" : "without"} creation history`,t=>{
    const directory=mkdtempSync(join(tmpdir(),"tasknboard-legacy-creator-"));
    const path=join(directory,"workspace.sqlite");
    let store=createStore(path);
    t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
    const task=store.execute("create_task",{boardId:"BOARD-1",title:"Existing task"},creator);
    store.close();
    const db=new DatabaseSync(path);
    db.exec("UPDATE tasks SET data=json_remove(data,'$.creator')");
    if(!hasCreatedEvent)db.exec("DELETE FROM events WHERE kind='created'");
    db.close();
    store=createStore(path);
    const list=store.execute("list_tasks",{boardId:"BOARD-1"},human);
    assert.equal(list.tasks.length,1);
    assert.equal(list.tasks[0].id,task.id);
    assert.equal(store.execute("get_task",{id:task.id},creator).undo.eligible,hasCreatedEvent);
    assert.equal(store.execute("get_task",{id:task.id},human).undo.eligible,false);
    if(hasCreatedEvent){
      const undone=store.execute("undo_task",{id:task.id,expectedVersion:task.version},creator);
      assert.equal(undone.archived,true);
      assert.equal(undone.events.at(-1).kind,"undo_task");
    }else{
      assert.throws(()=>store.execute("undo_task",{id:task.id,expectedVersion:task.version},creator),{code:"FORBIDDEN"});
    }
  });
}
