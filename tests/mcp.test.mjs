import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
