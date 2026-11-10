import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { spawn } from "node:child_process";
import { credentialFor } from "../server/local-auth.mjs";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createStore } from "../server/store.mjs";
test("real MCP client initializes, discovers tools, claims and submits review", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-mcp-"));
  const setup = createStore(join(dir, "test.sqlite"));
  const setupActor = { id: "reviewer", kind: "human" };
  const setupBoard = setup.execute("list_boards", {}, setupActor).boards[0];
  setup.execute("update_board", { id: setupBoard.id, expectedVersion: setupBoard.version,
    patch: { policy: { humanCompletionOnly: false } } }, setupActor);
  setup.close();
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/mcp.mjs")],
    env: {
      ...process.env,
      TASKNBOARD_DB: join(dir, "test.sqlite"),
      TASKNBOARD_AGENT_ID: "test-agent",
    },
    stderr: "pipe",
  });
  t.after(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "restore_task"));
  assert.equal(tools.tools.find((tool) => tool.name === "archive_task").annotations.destructiveHint, true);
  const similarTool = tools.tools.find((tool) => tool.name === "find_similar_tasks");
  assert.equal(similarTool.annotations.readOnlyHint, true);
  assert.ok(similarTool.inputSchema.properties.excludeId);
  assert.match(
    tools.tools.find((tool) => tool.name === "create_task").description,
    /find_similar_tasks first.*duplicates/,
  );
  const profileTool = tools.tools.find((tool) => tool.name === "update_profile");
  assert.ok(profileTool);
  assert.match(profileTool.description, /useGravatar.*gravatarEmail/);
  assert.ok(profileTool.inputSchema.properties.useGravatar);
  assert.ok(profileTool.inputSchema.properties.gravatarEmail);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: { ...args, verbose: true } });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  const info = await call("workspace_info", {});
  assert.equal(info.schemaVersion, 21);
  assert.ok(
    info.actors.some((entry) => entry.id === "test-agent" && entry.kind === "agent"),
  );
  const email = "agent@example.com";
  const profile = await call("update_profile", {
    useGravatar: true,
    gravatarEmail: " Agent@Example.com ",
  });
  const hash = createHash("sha256").update(email).digest("hex");
  assert.equal(profile.gravatarEmail, email);
  assert.equal(
    profile.gravatarUrl,
    `https://gravatar.com/avatar/${hash}?s=128&d=404`,
  );
  const afterProfile = await call("workspace_info", {});
  assert.equal(afterProfile.actor.gravatarEmail, email);
  assert.equal(
    Object.hasOwn(
      afterProfile.actors.find((actor) => actor.id === "test-agent"),
      "gravatarEmail",
    ),
    false,
  );
  await call("update_profile", { useGravatar: false, gravatarEmail: "" });
  assert.deepEqual(await call("list_epics", {}), { epics: [] });
  const epicDenied = await client.callTool({
    name: "create_epic",
    arguments: { title: "Not an MCP tool" },
  });
  assert.equal(epicDenied.isError, true);
  const { boards } = await call("list_boards", {});
  let task = await call("create_task", { title: "Real protocol test", boardId: boards[0].id });
  assert.equal(task.commentCount, 0);
  const compact = await client.callTool({ name: "add_comment", arguments: { id: task.id, body: "No version read needed" } });
  const compactTask = JSON.parse(compact.content[0].text);
  assert.deepEqual(Object.keys(compactTask).sort(), ["completionPolicy", "id", "lane", "url", "version"]);
  task = await call("get_task", { id: task.id });
  assert.deepEqual(
    (await call("find_similar_tasks", { title: "Real protocol tests" })).tasks.map(
      (similar) => similar.id,
    ),
    [task.id],
  );
  task = await call("claim_task", {
    id: task.id,
    expectedVersion: task.version,
  });
  assert.equal(task.lease.actor, "test-agent");
  task = await call("set_standup_notes", {
    id: task.id,
    expectedVersion: task.version,
    highlight: "Ready to demo",
    blocker: "Waiting for review",
  });
  assert.equal(task.standup.blocker, "Waiting for review");

  task = await call("add_comment", {
    id: task.id,
    expectedVersion: task.version,
    body: "Implementation ready",
  });
  assert.equal(task.commentCount, 2);
  assert.equal((await call("get_task", { id: task.id })).commentCount, 2);
  assert.equal((await call("list_tasks", {})).tasks[0].commentCount, 2);
  task = await call("submit_review", {
    id: task.id,
    expectedVersion: task.version,
    summary: "Verified through SDK client",
  });
  assert.equal(task.role, "in_review");
  assert.equal(task.lease, null);
  const denied = await client.callTool({
    name: "update_task",
    arguments: {
      id: task.id,
      expectedVersion: task.version,
      patch: { lane: "LANE-4" },
    },
  });
  assert.equal(denied.isError, true);
  let direct = await call("create_task", { title: "Complete without review", boardId: boards[0].id });
  direct = await call("claim_task", { id: direct.id, expectedVersion: direct.version });
  const claimedVersion = direct.version;
  const claimedAssignee = direct.assignee;
  const doneLane = boards[0].lanes.find((lane) => lane.role === "done").id;
  direct = await call("update_task", {
    id: direct.id,
    expectedVersion: direct.version,
    patch: { lane: doneLane },
  });
  assert.equal(direct.role, "done");
  assert.equal(direct.lease, null);
  assert.equal(direct.assignee, claimedAssignee);
  assert.equal(direct.version, claimedVersion + 1);
  assert.equal((await call("get_task", { id: direct.id })).lane, doneLane);
  const archived = await client.callTool({ name: "archive_task", arguments: { id: direct.id, expectedVersion: direct.version } });
  assert.notEqual(archived.isError, true);
  assert.deepEqual(JSON.parse(archived.content[0].text), { id: direct.id, version: direct.version + 1, lane: doneLane, url: direct.url, archived: true,
    completionPolicy: direct.completionPolicy, completion: direct.completion });
  assert.equal((await call("get_task", { id: direct.id })).archived, true);
  assert.ok(!(await call("list_tasks", {})).tasks.some((entry) => entry.id === direct.id));
  const restored = await client.callTool({ name: "restore_task", arguments: { id: direct.id, expectedVersion: direct.version + 1 } });
  assert.notEqual(restored.isError, true);
  assert.equal(JSON.parse(restored.content[0].text).archived, false);
  assert.equal((await call("get_task", { id: direct.id })).archived, false);
});

test("architect MCP receives human feedback through a subscribed resource", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-notifications-"));
  const database = join(dir, "test.sqlite");
  const client = new Client({ name: "notification-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("server/mcp.mjs")],
    env: { ...process.env, TASKNBOARD_DB: database, TASKNBOARD_AGENT_ID: "claude/architect", TASKNBOARD_AGENT_ROLE: "architect" }, stderr: "pipe" });
  const store = createStore(database);
  t.after(async () => { await client.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await call("workspace_info", {})).actor.role, "architect");
  const board = await call("create_board", { name: "Planning", prefix: "PL" });
  const task = await call("create_task", { boardId: board.id, title: "Review the result" });
  let timer;
  const updated = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("No feedback notification")), 5000);
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, ({ params }) => { clearTimeout(timer); resolve(params); });
  });
  t.after(() => clearTimeout(timer));
  await client.subscribeResource({ uri: "tasknboard://notifications" });
  store.execute("add_comment", { id: task.id, body: "Please update the result" }, { id: "reviewer", kind: "human" });
  assert.equal((await updated).uri, "tasknboard://notifications");
  const resource = await client.readResource({ uri: "tasknboard://notifications" });
  assert.equal(JSON.parse(resource.contents[0].text).items[0].body, "Please update the result");
  await client.unsubscribeResource({ uri: "tasknboard://notifications" });
});

test("resident app resource, session authentication and chat work use one authority", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-app-mcp-"));
  const secret = "resident-app-secret-1234567890";
  const runtime = join(dir,"runtime.json");
  writeFileSync(join(dir,"index.html"),"<!doctype html><html><body>TasknBoard app</body></html>");
  const service = spawn(process.execPath,[resolve("server/http.mjs")],{
    env:{...process.env,PORT:"0",HOST:"127.0.0.1",TASKNBOARD_RESIDENT:"1",TASKNBOARD_LOCAL_SECRET:secret,TASKNBOARD_TOKENS:"",TASKNBOARD_DB:join(dir,"db.sqlite"),TASKNBOARD_RUNTIME_FILE:runtime,TASKNBOARD_APP_DIR:dir,TASKNBOARD_USER_HOME:dir},
    stdio:["pipe","ignore","pipe"],
  });
  const client = new Client({name:"app-test",version:"1"});
  t.after(async()=>{
    await client.close(); service.kill();
    await new Promise(r=>service.exitCode!==null?r():service.once("exit",r));
    rmSync(dir,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{
    let output="";const timer=setTimeout(()=>reject(new Error("Startup timeout: "+output)),10000);
    service.stderr.on("data",chunk=>{output+=chunk;if(output.includes("listening")){clearTimeout(timer);resolve();}});
    service.once("exit",()=>{clearTimeout(timer);reject(new Error("Service exited: "+output));});
  });
  const descriptor=JSON.parse(readFileSync(runtime,"utf8"));
  assert.equal(descriptor.pid,service.pid);
  assert.ok(!JSON.stringify(descriptor).includes(secret));
  const token=credentialFor(secret,{id:"codex-app",kind:"app"});
  const transport=new StreamableHTTPClientTransport(new URL(descriptor.mcpUrl),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  const opener=tools.find(tool=>tool.name==="open_tasknboard");
  assert.equal(opener._meta.ui.resourceUri,"ui://tasknboard/app-v1.html");
  assert.deepEqual(tools.find(tool=>tool.name==="ui_create_task")._meta.ui.visibility,["app"]);
  assert.deepEqual(tools.find(tool=>tool.name==="update_task")._meta.ui.visibility,["model"]);
  const resources=await client.listResources();
  assert.ok(resources.resources.some(resource=>resource.uri===opener._meta.ui.resourceUri));
  const resource=await client.readResource({uri:opener._meta.ui.resourceUri});
  assert.equal(resource.contents[0].mimeType,"text/html;profile=mcp-app");
  assert.match(resource.contents[0].text,/TasknBoard app/);
  assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains,[]);
  const call=async(name,args={})=>{
    const result=await client.callTool({name,arguments:args});
    assert.notEqual(result.isError,true,JSON.stringify(result));
    return name.startsWith("ui_")?result._meta.result:JSON.parse(result.content[0].text);
  };
  const fail=async(name,args,code)=>{
    const result=await client.callTool({name,arguments:args});
    assert.equal(result.isError,true,JSON.stringify(result));
    assert.equal(JSON.parse(result.content[0].text).code,code);
  };
  assert.deepEqual(await call("open_tasknboard",{boardId:"BOARD-1"}),{opened:true,boardId:"BOARD-1"});
  assert.equal((await call("ui_workspace_info")).actor.kind,"human");
  assert.equal((await call("workspace_info")).actor.kind,"agent");
  assert.equal((await fetch(descriptor.url+"/api/workspace_info",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:"{}"})).status,403);
  const rpc={jsonrpc:"2.0",id:42,method:"tools/list",params:{}};
  const request=async bearer=>fetch(descriptor.mcpUrl,{method:"POST",headers:{Authorization:`Bearer ${bearer}`,"mcp-session-id":transport.sessionId,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify(rpc)});
  assert.equal((await request("invalid")).status,401);
  assert.equal((await request(secret)).status,404);
  let task=await call("ui_create_task",{title:"Chat ownership",boardId:"BOARD-1"});
  const other=await call("ui_create_task",{title:"Other task",boardId:"BOARD-1"});
  await fail("claim_task",{id:task.id,expectedVersion:task.version},"WORK_SESSION_REQUIRED");
  await fail("ui_start_chat_work",{id:task.id,expectedVersion:task.version+1},"VERSION_CONFLICT");
  await fail("claim_task",{id:task.id,expectedVersion:task.version,workSessionId:"00000000-0000-4000-8000-000000000000"},"WORK_SESSION_INVALID");
  const work=await call("ui_start_chat_work",{id:task.id,expectedVersion:task.version});
  await fail("update_task",{id:other.id,expectedVersion:other.version,workSessionId:work.workSessionId,patch:{title:"Denied"}},"FORBIDDEN");
  const { boards: [originalBoard] } = await call("ui_list_boards");
  const oldId = task.id;
  await call("ui_update_board", {
    id: originalBoard.id, expectedVersion: originalBoard.version, patch: { prefix: "REN" },
  });
  task = await call("get_task", { id: oldId, workSessionId: work.workSessionId });
  assert.equal(task.id, oldId.replace(/^TNB-/, "REN-"));
  const reused = await call("ui_create_board", { name: "Reused prefix", prefix: "TNB" });
  const replacement = await call("ui_create_task", { title: "Unrelated task", boardId: reused.id });
  assert.equal(replacement.id, oldId);
  await fail("claim_task", {
    id: replacement.id, expectedVersion: replacement.version, workSessionId: work.workSessionId,
  }, "FORBIDDEN");
  const args=()=>({id:task.id,expectedVersion:task.version,workSessionId:work.workSessionId});
  task=await call("claim_task",args());
  assert.equal(task.lease.actor,work.actorId);
  assert.equal(task.assignee, "");
  await fail("ui_start_chat_work",{id:task.id,expectedVersion:task.version},"CLAIM_CONFLICT");
  await fail("heartbeat",{...args(),expectedVersion:1},"VERSION_CONFLICT");
  const previous=task.version;
  task=await call("heartbeat",args());
  assert.ok(task.version>previous);
  task=await call("update_task",{...args(),patch:{title:"Owned chat work"}});
  task = await call("link_pull_requests", { ...args(), pullRequests: ["owner/repo#123", "https://github.com/OWNER/REPO/pull/123"] });
  assert.equal(task.pullRequests.length, 1);
  task = await call("unlink_pull_request", { ...args(), pullRequest: "OWNER/repo#123" });
  assert.deepEqual(task.pullRequests, []);
  task=await call("submit_review",{...args(),summary:"Verified app MCP lease"});
  assert.equal(task.role,"in_review");assert.equal(task.lease,null);
  await fail("update_task",{...args(),patch:{title:"After review"}},"LEASE_REQUIRED");
});
