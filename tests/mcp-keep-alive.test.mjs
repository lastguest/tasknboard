import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createStore } from "../server/store.mjs";
import { taskCallIds, createTaskKeepAlive } from "../server/mcp-keep-alive.mjs";

const turn = () => new Promise(resolve => setImmediate(resolve));
test("keep-alive derives bounded task IDs only from task operations", () => {
  assert.deepEqual(taskCallIds("get_task", { id: "TNB-1", boardId: "BOARD-1", target: "TNB-2" }), ["TNB-1"]);
  assert.deepEqual(taskCallIds("update_board", { id: "BOARD-1", tasks: [{ id: "TNB-1" }] }), []);
  assert.deepEqual(taskCallIds("update_epic", { id: "TNB-1" }), []);
  assert.deepEqual(taskCallIds("get_tasks", { ids: ["TNB-1", "TNB-1", "BOARD-1", "EPIC-2", null] }), ["TNB-1"]);
  assert.deepEqual(taskCallIds("submit_reviews", { reviews: [{ id: "TNB-2" }, { id: "TNB-3" }] }), ["TNB-2", "TNB-3"]);
  assert.equal(taskCallIds("get_tasks", { ids: Array.from({ length: 120 }, (_, index) => `TNB-${index + 1}`) }).length, 100);
});

test("keep-alive runs before calls, shares active scope and stops without idle renewal", async () => {
  const requests = [], cancelled = [];
  let tick, closed = 0;
  const manager = createTaskKeepAlive({ execute: async (name, args) => requests.push({ name, args }),
    schedule: callback => { tick = callback; return 7; }, cancel: timer => cancelled.push(timer), close: () => closed++ });
  await manager.start(1, "get_task", { id: "TNB-1" });
  await manager.start(2, "submit_reviews", { reviews: [{ id: "TNB-1" }, { id: "TNB-2" }] });
  assert.equal(requests.length, 2);
  tick(); await turn();
  assert.deepEqual(requests.at(-1), { name: "keep_alive", args: { ids: ["TNB-1", "TNB-2"] } });
  manager.finish(2);
  tick(); await turn();
  assert.deepEqual(requests.at(-1).args.ids, ["TNB-1"]);
  manager.finish(1);
  assert.deepEqual(cancelled, [7]);
  const count = requests.length;
  tick(); await turn();
  assert.equal(requests.length, count);
  await manager.stop();
  assert.equal(closed, 1);
});

test("maintenance errors do not reject the call and stop waits for in-flight renewal", async () => {
  let resolve, closed = false, count = 0;
  const errors = [];
  const manager = createTaskKeepAlive({ execute: async () => {
    count++;
    if (count === 1) throw Object.assign(new Error("Offline"), { code: "NETWORK" });
    await new Promise(done => { resolve = done; });
  }, onError: error => errors.push(error.code), schedule: () => 1, cancel: () => {}, close: () => { closed = true; } });
  await manager.start(1, "get_task", { id: "TNB-1" });
  assert.deepEqual(errors, ["NETWORK"]);
  const renewal = manager.start(2, "get_task", { id: "TNB-2" });
  await turn();
  const stopping = manager.stop();
  assert.equal(closed, false);
  resolve();
  await renewal; await stopping;
  assert.equal(closed, true);
  await manager.start(3, "get_task", { id: "TNB-3" });
  assert.equal(count, 2);
});

test("periodic renewal never queues overlapping requests and worker loss removes its scope", async () => {
  let tick, resolve, count = 0;
  const manager = createTaskKeepAlive({ execute: async () => {
    if (++count > 1) await new Promise(done => { resolve = done; });
  }, schedule: callback => { tick = callback; return 1; }, cancel: () => {} });
  await manager.start(1, "get_task", { id: "TNB-1" });
  tick(); await turn();
  for (let index = 0; index < 100; index++) tick();
  manager.cancelAll();
  const stopping = manager.stop();
  resolve(); await stopping;
  assert.equal(count, 2);
});

test("a real SDK call retains its lease while the adapter worker blocks and keeps its version", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tasknboard-blocked-mcp-"));
  const database = join(directory, "workspace.sqlite");
  const workerPath = join(directory, "worker.mjs"), runnerPath = join(directory, "runner.mjs");
  const actor = { id: "keep-alive-worker", kind: "agent" };
  const store = createStore(database);
  const board = store.execute("list_boards", {}, actor).boards[0];
  let task = store.execute("create_task", { boardId: board.id, title: "Slow request" }, actor);
  task = store.execute("claim_task", { id: task.id, expectedVersion: task.version }, actor);
  writeFileSync(workerPath, `import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.TASKNBOARD_DB);
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line); let result;
 if(message.method==='initialize') result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'slow-worker',version:'1'}};
 else if(message.method==='tools/call') {
  db.prepare("UPDATE tasks SET data=json_set(data,'$.lease.expiresAt',?) WHERE json_extract(data,'$.id')=?").run(Date.now()+150,message.params.arguments.id);
  const end=Date.now()+650; while(Date.now()<end) {}
  const task=JSON.parse(db.prepare("SELECT data FROM tasks WHERE json_extract(data,'$.id')=?").get(message.params.arguments.id).data);
  result={content:[{type:'text',text:JSON.stringify(task)}],structuredContent:task};
 }
 if(message.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:result||{}})+'\\n');
});`);
  writeFileSync(runnerPath, `import { startSupervisor } from ${JSON.stringify(new URL("../server/mcp-supervisor.mjs", import.meta.url).href)};
startSupervisor({worker:new URL(${JSON.stringify(pathToFileURL(workerPath).href)}),heartbeatIntervalMs:25});`);
  const client = new Client({ name: "blocked-worker-test", version: "1" });
  t.after(async () => { await client.close(); store.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [runnerPath],
    env: { ...process.env, TASKNBOARD_DB: database, TASKNBOARD_AGENT_ID: actor.id, TASKNBOARD_SERVER_URL: "", TASKNBOARD_TOKEN: "" }, stderr: "pipe" }));
  const response = await client.callTool({ name: "get_task", arguments: { id: task.id } });
  assert.notEqual(response.isError, true);
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.version, task.version);
  assert.equal(result.updatedAt, task.updatedAt);
  assert.ok(result.lease.expiresAt > Date.now() + 800000);
  const events = store.execute("get_task", { id: task.id }, actor).events;
  assert.equal(events.filter(event => event.kind === "auto_heartbeat").length, 1);
  const raw = new DatabaseSync(database);
  const idleExpiry = Date.now() + 5000;
  raw.prepare("UPDATE tasks SET data=json_set(data,'$.lease.expiresAt',?) WHERE json_extract(data,'$.id')=?").run(idleExpiry, task.id);
  await new Promise(resolve => setTimeout(resolve, 150));
  const idleTask = store.execute("get_task", { id: task.id }, actor);
  assert.equal(idleTask.lease.expiresAt, idleExpiry);
  assert.equal(idleTask.events.filter(event => event.kind === "auto_heartbeat").length, 1);
  raw.close();
});
