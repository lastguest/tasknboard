import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP exposes workflow tools, preserves selected fields and passes structured batch evidence", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tasknboard-mcp-workflow-"));
  const client = new Client({ name: "workflow-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("server/mcp.mjs")],
    env: { ...process.env, TASKNBOARD_DB: join(directory, "test.sqlite"), TASKNBOARD_AGENT_ID: "architect/test", TASKNBOARD_AGENT_ROLE: "architect", TASKNBOARD_SERVER_URL: "", TASKNBOARD_TOKEN: "" }, stderr: "pipe" });
  t.after(async () => { await client.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some(tool => tool.name === "keep_alive"));
  for (const name of ["get_tasks", "claim_tasks", "add_comments", "submit_reviews", "undo_task", "reorder_task", "critical_path", "list_activity", "list_milestones", "create_milestone", "update_milestone", "archive_milestone", "set_label_color", "upload_artifact"])
    assert.ok(tools.some(tool => tool.name === name), name);
  assert.match(tools.find(tool => tool.name === "update_task").description, /get_task.completionPolicy/);
  assert.match(tools.find(tool => tool.name === "submit_review").description, /configured origin\/HEAD/);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  const board = (await call("list_boards")).boards[0];
  const task = await call("create_task", { boardId: board.id, title: "Workflow evidence", description: "Full context" });
  const selected = (await call("list_tasks", { fields: ["id", "title", "version"] })).tasks[0];
  assert.equal(selected.id, task.id);
  assert.equal(selected.title, "Workflow evidence");
  assert.equal(selected.description, undefined);
  assert.equal(selected.lane, undefined);
  const selectedPolicy = (await call("list_tasks", { fields: ["id", "completionPolicy", "autoCompletion"] })).tasks[0];
  assert.equal(selectedPolicy.completionPolicy.mode, "human");
  assert.equal(selectedPolicy.completionPolicy.source, "board");
  const claimed = (await call("claim_tasks", { tasks: [{ id: task.id, expectedVersion: task.version }] })).tasks[0];
  assert.equal(claimed.lease.actor, "architect/test");
  assert.equal(typeof claimed.lease.expiresInSeconds, "number");
  await call("add_comments", { comments: [{ id: task.id, body: "The implementation passed its check", via: "sonnet#run-7" }] });
  const current = await call("get_task", { id: task.id });
  assert.ok(current.events.some(event => event.kind === "add_comment" && event.body.includes("sonnet#run-7")));
  const artifact = await call("upload_artifact", { title: "Check log", dataUrl: "data:text/plain;base64,cGFzcw==" });
  await call("submit_reviews", { reviews: [{ id: task.id, expectedVersion: current.version, summary: "Ready for review",
    artifacts: [{ title: artifact.title, url: artifact.url }], commitRange: "abcdef1..abcdef2",
    verifiedBy: [{ agent: "checker/session", checks: "The focused check passed" }], via: "sonnet#run-7" }] });
  const reviewed = await call("get_task", { id: task.id });
  assert.equal(reviewed.role, "in_review");
  assert.equal(reviewed.review.via, "sonnet#run-7");
  assert.equal(reviewed.review.artifacts[0].url, artifact.url);
  assert.equal(reviewed.review.verifiedBy[0].agent, "checker/session");
  const compact = (await call("list_tasks")).tasks[0];
  assert.equal(compact.description, undefined);
  assert.equal(compact.id, task.id);
});
