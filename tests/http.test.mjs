import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
test("authenticated HTTP and remote MCP bridge share one authority", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-http-"));
  const dbPath = join(dir, "db.sqlite");
  const token = "test-only-human-token-123456789",
    agentToken = "test-only-agent-token-123456789";
  const service = spawn(process.execPath, ["server/http.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      TASKNBOARD_RUNTIME_FILE: join(dir,"runtime.json"),
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
  const base = JSON.parse(readFileSync(join(dir,"runtime.json"),"utf8")).url;
  assert.equal(
    (
      await fetch(`${base}/api/mcp-config`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${base}/api/mcp-config`)).status,
    401,
  );
  const sharedMcpResponse = await fetch(
    `${base}/api/mcp-config`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(sharedMcpResponse.status, 200);
  const sharedMcpStatus = await sharedMcpResponse.json();
  assert.deepEqual(sharedMcpStatus, { mode: "shared" });
  assert.ok(!JSON.stringify(sharedMcpStatus).includes(dbPath));
  assert.ok(!JSON.stringify(sharedMcpStatus).includes(process.execPath));
  const post = (cmd, args = {}, bearer = token, extra = {}) =>
    fetch(`${base}/api/${cmd}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        ...extra,
      },
      body: JSON.stringify(args),
    });
  assert.equal((await post("list_tasks", {}, "bad")).status, 401);
  // Agent settings stay on the local desktop app, and only people see them.
  assert.equal((await post("agent-configs", {}, agentToken)).status, 403);
  assert.equal(
    (await post("agent-logs", { taskId: "TNB-1" }, agentToken)).status,
    403,
  );
  const sharedAgents = await (await post("agent-configs")).json();
  assert.equal(sharedAgents.mode, "shared");
  assert.deepEqual(sharedAgents.agents, {});
  const sharedSave = await post("agent-config-save", {
    identity: "remote-agent",
    config: sharedAgents.defaults,
  });
  assert.equal(sharedSave.status, 400);
  assert.equal((await sharedSave.json()).code, "AGENTS_UNSUPPORTED");
  assert.equal(
    (await post("claude-plugin", { identity: "claude" }, agentToken)).status,
    403,
  );
  assert.equal(
    (await post("claude-plugin", { identity: "claude" })).status,
    400,
  );
  assert.equal(
    (await post("codex-plugin", { identity: "codex" }, agentToken)).status,
    403,
  );
  assert.equal((await post("codex-plugin", { identity: "codex" })).status, 400);
  assert.equal(
    (await post("list_tasks", {}, token, { Origin: "https://evil.example" }))
      .status,
    403,
  );
  const infoResponse = await post("workspace_info");
  assert.equal(infoResponse.status, 200);
  const info = await infoResponse.json();
  assert.equal(info.schemaVersion, 21);
  assert.equal(info.boards[0].id, "BOARD-1");
  assert.equal(Object.hasOwn(info, "settings"), false);
  assert.match(
    infoResponse.headers.get("content-security-policy") ?? "",
    /img-src[^;]*https:/,
  );
  assert.deepEqual(info.actors, [
    {
      id: "remote-agent",
      kind: "agent",
      name: "",
      avatar: "",
      useGravatar: false,
      gravatarUrl: "",
    },
    {
      id: "reviewer",
      kind: "human",
      name: "",
      avatar: "",
      useGravatar: false,
      gravatarUrl: "",
    },
  ]);
  assert.ok(!JSON.stringify(info).includes(token));
  assert.ok(!JSON.stringify(info).includes(agentToken));
  async function splitRequest(path, args, headers = {}) {
    const bytes = Buffer.from(JSON.stringify(args));
    const accented = bytes.indexOf(Buffer.from("é")) + 1;
    const emoji = bytes.indexOf(Buffer.from("🌱")) + 2;
    return new Promise((resolveResponse, reject) => {
      const req = request(base + path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolveResponse({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(bytes.subarray(0, accented));
      void delay(30).then(() => {
        req.write(bytes.subarray(accented, emoji));
        return delay(30);
      }).then(() => req.end(bytes.subarray(emoji)));
    });
  }
  const title = "Café 🌱";
  const created = await splitRequest("/api/create_task", {
    boardId: info.boards[0].id, title, labels: ["Product", "UX"],
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.title, title);
  let task = created.body;
  const oversized = await post("create_task", { title, description: "é".repeat(1_100_000) });
  assert.equal(oversized.status, 413);
  const client = new Client({ name: "remote-test", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base+"/mcp"), {
      requestInit:{headers:{Authorization:`Bearer ${agentToken}`}},
    }),
  );
  const remoteInfo = await client.callTool({
    name: "workspace_info",
    arguments: {},
  });
  assert.notEqual(remoteInfo.isError, true);
  assert.equal(JSON.parse(remoteInfo.content[0].text).actor.id, "remote-agent");
  const { transport: agentTransport } = client;
  const rpcTitle = "MCP café 🌱";
  const rpc = await splitRequest("/mcp", {
    jsonrpc: "2.0", id: 500, method: "tools/call",
    params: { name: "create_task", arguments: { boardId: "BOARD-1", title: rpcTitle } },
  }, {
    Authorization: `Bearer ${agentToken}`,
    Accept: "application/json, text/event-stream",
    "mcp-session-id": agentTransport.sessionId,
  });
  assert.equal(rpc.status, 200);
  assert.equal(rpc.body.result.structuredContent.title, rpcTitle);
  const claimed = await client.callTool({
    name: "claim_task",
    arguments: { id: task.id, expectedVersion: 1, verbose: true },
  });
  assert.notEqual(claimed.isError, true);
  task = JSON.parse(claimed.content[0].text);
  assert.equal(task.assignee, "");
  assert.equal(task.lease.actor, "remote-agent");
  const leaseConflict = await post("claim_task", {
    id: task.id,
    expectedVersion: task.version,
  });
  assert.equal(leaseConflict.status, 409);
  const leaseError = await leaseConflict.json();
  assert.equal(leaseError.code, "LEASE_CONFLICT");
  assert.equal(leaseError.details.lease.actor, "remote-agent");
  assert.equal(leaseError.details.lease.expiresAt, task.lease.expiresAt);
  assert.ok(leaseError.details.lease.remainingMs > 0);
  assert.deepEqual(task.labels, ["Product", "UX"]);
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
    patch: { lane: "LANE-4" },
  });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).role, "done");
  const board = (await (await post("list_boards")).json()).boards.find(
    (item) => item.id === info.boards[0].id,
  );
  assert.equal(
    (
      await post("update_board", {
        id: board.id,
        expectedVersion: board.version,
        patch: { policy: { humanCompletionOnly: false } },
      })
    ).status,
    200,
  );
  let direct = await (
    await post("create_task", {
      boardId: info.boards[0].id,
      title: "Direct remote completion",
    })
  ).json();
  const directClaim = await client.callTool({
    name: "claim_task",
    arguments: {
      id: direct.id,
      expectedVersion: direct.version,
      verbose: true,
    },
  });
  assert.notEqual(directClaim.isError, true);
  direct = JSON.parse(directClaim.content[0].text);
  const directVersion = direct.version;
  const claimedAssignee = direct.assignee;
  const directCompletion = await client.callTool({
    name: "update_task",
    arguments: {
      id: direct.id,
      expectedVersion: direct.version,
      patch: { lane: "LANE-4" },
      verbose: true,
    },
  });
  assert.notEqual(directCompletion.isError, true);
  direct = JSON.parse(directCompletion.content[0].text);
  assert.equal(direct.role, "done");
  assert.equal(direct.lease, null);
  assert.equal(direct.assignee, claimedAssignee);
  assert.equal(direct.version, directVersion + 1);
  const savedDirect = await (await post("get_task", { id: direct.id })).json();
  assert.deepEqual(savedDirect, direct);
  // Images exceed the ordinary command size and are served as inert files.
  const bigPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(200000),
  ]);
  const uploaded = await post("upload_image", {
    data: `data:image/png;base64,${bigPng.toString("base64")}`,
  });
  assert.equal(uploaded.status, 200);
  const { url: imageUrl } = await uploaded.json();
  const file = await fetch(`${base}${imageUrl}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.match(file.headers.get("content-security-policy"), /sandbox/);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(bigPng));
  assert.equal(
    (await fetch(`${base}/files/${"0".repeat(32)}`)).status,
    404,
  );
  assert.equal(
    (
      await post("add_comment", {
        id: task.id,
        expectedVersion: task.version,
        body: "x".repeat(2 * 1024 * 1024 + 1),
      })
    ).status,
    413,
  );
  const backup = await (await post("export_workspace")).json();
  assert.equal(backup.schemaVersion, 21);
  assert.equal(backup.boards[0].id, "BOARD-1");
  assert.ok(backup.actors.some((actor) => actor.id === "remote-agent"));
  const databaseBytes = Buffer.concat([
    readFileSync(dbPath),
    ...(existsSync(`${dbPath}-wal`) ? [readFileSync(`${dbPath}-wal`)] : []),
  ]);
  assert.ok(!databaseBytes.includes(token));
  assert.ok(!databaseBytes.includes(agentToken));
});

test("a local workspace saves agent settings and rejects invalid ones", async (t) => {
  const secret = "test-resident-launch-secret-32-characters";
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-agents-"));
  const service = spawn(process.execPath, ["server/http.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      TASKNBOARD_RUNTIME_FILE: join(dir, "runtime.json"),
      TASKNBOARD_DB: join(dir, "db.sqlite"),
      TASKNBOARD_DESKTOP: "1",
      TASKNBOARD_LOCAL_SECRET: secret,
      TASKNBOARD_USER_HOME: dir,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  t.after(async () => {
    service.kill();
    await new Promise((r) =>
      service.exitCode !== null ? r() : service.once("exit", r),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    service.stderr.on("data", (c) => {
      if (c.toString().includes("listening")) resolve();
    });
    service.once("exit", () => reject(new Error("Server exited")));
  });
  const base = JSON.parse(readFileSync(join(dir,"runtime.json"),"utf8")).url;
  const configResponse = await fetch(base+"/api/mcp-config", { headers: { Authorization: `Bearer ${secret}` } });
  const mcpConfig = await configResponse.json();
  assert.deepEqual(mcpConfig.config.mcpServers.tasknboard,{url:base+"/mcp",bearer_token_env_var:"TASKNBOARD_TOKEN"});
  assert.ok(!JSON.stringify(mcpConfig).includes(join(dir,"db.sqlite")));
  const post = async (cmd, args) => {
    const response = await fetch(`${base}/api/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(args),
    });
    return { status: response.status, body: await response.json() };
  };
  const { body: info } = await post("agent-configs", {});
  assert.equal(info.mode, "local");
  assert.equal(info.autoStart, true);
  assert.deepEqual(
    info.clients.map((c) => c.id),
    ["claude", "codex", "opencode", "pi"],
  );
  assert.deepEqual(
    info.events.map((e) => e.id),
    [
      "task_assigned",
      "task_unassigned",
      "changes_requested",
      "mention",
      "standup",
    ],
  );
  const config = {
    ...info.defaults,
    client: "opencode",
    command: process.execPath,
    model: "anthropic/x",
    env: { KEY: "v" },
  };
  const saved = await post("agent-config-save", {
    identity: "builder",
    config,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.client, "opencode");
  const { body: after } = await post("agent-configs", {});
  assert.deepEqual(after.agents.builder.config, saved.body.config);
  assert.deepEqual(after.agents.builder.queued, []);
  const { body: workspace } = await post("workspace_info", {});
  const board = workspace.boards[0];
  await post("update_board", {
    id: board.id,
    expectedVersion: board.version,
    patch: { repository: dir },
  });
  const { body: created } = await post("create_task", {
    boardId: board.id,
    title: "Manual run",
    assignee: "builder",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (await post("get_task", { id: created.id })).body.events.some(
      (event) => event.kind === "agent_started",
    ),
    false,
  );
  const { body: removed } = await post("update_task", {
    id: created.id,
    expectedVersion: created.version,
    patch: { assignee: "" },
  });
  const { body: assigned } = await post("update_task", {
    id: created.id,
    expectedVersion: removed.version,
    patch: { assignee: "builder" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (await post("get_task", { id: assigned.id })).body.events.some(
      (event) => event.kind === "agent_started",
    ),
    false,
  );
  assert.deepEqual(
    (await post("agent-event", { event: "task_assigned", taskId: assigned.id }))
      .body,
    { started: ["builder"] },
  );
  let dispatched;
  for (let attempt = 0; attempt < 60; attempt++) {
    dispatched = (await post("get_task", { id: assigned.id })).body;
    if (dispatched.events.some((event) => event.kind === "agent_started"))
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(dispatched.events.some((event) => event.kind === "agent_started"));
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = (await post("agent-configs", {})).body.agents.builder;
    if (!state.running) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const bad = await post("agent-config-save", {
    identity: "builder",
    config: { ...config, command: "relative/opencode" },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /^command: /);
  assert.equal(
    (await post("agent-config-save", { identity: "-bad", config })).status,
    400,
  );
  assert.equal((await post("agent-event", { event: "deploy" })).status, 400);
  assert.deepEqual((await post("agent-event", { event: "standup" })).body, {
    started: [],
  });
  // Logs belong to the desktop app that runs agents; elsewhere there are none.
  assert.equal(
    (await post("agent-logs", { taskId: "TNB-1" })).body.available,
    true,
  );
  assert.equal(
    (await post("agent-logs", { taskId: "TNB-1", path: "/etc/passwd" })).status,
    400,
  );
});
