import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("real MCP client initializes, discovers tools, claims and submits review", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-mcp-"));
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
  assert.equal(tools.tools.length, 16);
  const profileTool = tools.tools.find((tool) => tool.name === "update_profile");
  assert.ok(profileTool);
  assert.match(profileTool.description, /useGravatar.*gravatarEmail/);
  assert.ok(profileTool.inputSchema.properties.useGravatar);
  assert.ok(profileTool.inputSchema.properties.gravatarEmail);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  const info = await call("workspace_info", {});
  assert.equal(info.schemaVersion, 11);
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
  assert.equal(task.commentCount, 1);
  assert.equal((await call("get_task", { id: task.id })).commentCount, 1);
  assert.equal((await call("list_tasks", {})).tasks[0].commentCount, 1);
  task = await call("submit_review", {
    id: task.id,
    expectedVersion: task.version,
    summary: "Verified through SDK client",
  });
  assert.equal(task.status, "in_review");
  assert.equal(task.lease, null);
  const denied = await client.callTool({
    name: "update_task",
    arguments: {
      id: task.id,
      expectedVersion: task.version,
      patch: { status: "done" },
    },
  });
  assert.equal(denied.isError, true);
});
