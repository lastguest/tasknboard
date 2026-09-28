import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("authenticated HTTP and remote MCP bridge share one authority", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-http-"));
  const dbPath = join(dir, "db.sqlite");
  const token = "test-only-human-token-123456789",
    agentToken = "test-only-agent-token-123456789";
  const service = spawn(process.execPath, ["server/http.mjs"], {
    env: {
      ...process.env,
      PORT: "14319",
      TASKNBOARD_DB: dbPath,
      TASKNBOARD_TOKENS: JSON.stringify({
        [token]: { id: "reviewer", kind: "human" },
        [agentToken]: { id: "remote-agent", kind: "agent" },
      }),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(async () => {
    service.kill();
    await new Promise((r) =>
      service.exitCode !== null ? r() : service.once("exit", r),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Server startup timeout")),
      10000,
    );
    service.stderr.on("data", (c) => {
      if (c.toString().includes("listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    service.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("Server exited"));
    });
  });
  const post = (cmd, args = {}, bearer = token, extra = {}) =>
    fetch(`http://127.0.0.1:14319/api/${cmd}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        ...extra,
      },
      body: JSON.stringify(args),
    });
  assert.equal((await post("list_tasks", {}, "bad")).status, 401);
  assert.equal(
    (await post("list_tasks", {}, token, { Origin: "https://evil.example" }))
      .status,
    403,
  );
  const infoResponse = await post("workspace_info");
  assert.equal(infoResponse.status, 200);
  const info = await infoResponse.json();
  assert.equal(info.schemaVersion, 2);
  assert.deepEqual(info.actors, [
    { id: "remote-agent", kind: "agent" },
    { id: "reviewer", kind: "human" },
  ]);
  assert.ok(!JSON.stringify(info).includes(token));
  assert.ok(!JSON.stringify(info).includes(agentToken));
  let task = await (await post("create_task", { title: "Shared task" })).json();
  const client = new Client({ name: "remote-test", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/mcp.mjs")],
      env: {
        ...process.env,
        TASKNBOARD_SERVER_URL: "http://127.0.0.1:14319",
        TASKNBOARD_TOKEN: agentToken,
      },
      stderr: "pipe",
    }),
  );
  const remoteInfo = await client.callTool({
    name: "workspace_info",
    arguments: {},
  });
  assert.notEqual(remoteInfo.isError, true);
  assert.equal(JSON.parse(remoteInfo.content[0].text).actor.id, "remote-agent");
  const claimed = await client.callTool({
    name: "claim_task",
    arguments: { id: task.id, expectedVersion: 1 },
  });
  assert.notEqual(claimed.isError, true);
  task = JSON.parse(claimed.content[0].text);
  assert.equal(task.assignee, "remote-agent");
  assert.equal(
    (
      await post("update_task", {
        id: task.id,
        expectedVersion: task.version,
        patch: { title: "blocked" },
      })
    ).status,
    409,
  );
  assert.equal((await post("export_workspace", {}, agentToken)).status, 403);
  const review = await client.callTool({
    name: "submit_review",
    arguments: {
      id: task.id,
      expectedVersion: task.version,
      summary: "Done remotely",
    },
  });
  assert.notEqual(review.isError, true);
  task = JSON.parse(review.content[0].text);
  const completed = await post("update_task", {
    id: task.id,
    expectedVersion: task.version,
    patch: { status: "done" },
  });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).status, "done");
  const backup = await (await post("export_workspace")).json();
  assert.equal(backup.schemaVersion, 2);
  assert.ok(backup.actors.some((actor) => actor.id === "remote-agent"));
  const databaseBytes = Buffer.concat([
    readFileSync(dbPath),
    ...(existsSync(`${dbPath}-wal`) ? [readFileSync(`${dbPath}-wal`)] : []),
  ]);
  assert.ok(!databaseBytes.includes(token));
  assert.ok(!databaseBytes.includes(agentToken));
});
