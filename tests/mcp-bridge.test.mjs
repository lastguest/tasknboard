import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { credentialFor } from "../server/local-auth.mjs";
import { resolveBridgeConnection } from "../server/mcp-bridge.mjs";

const bridgePath = resolve(process.env.TASKNBOARD_TEST_BRIDGE || "server/mcp-bridge.mjs");
const servicePath = resolve(process.env.TASKNBOARD_TEST_SERVICE || "server/http.mjs");
const nodeExecutable = resolve(process.env.TASKNBOARD_TEST_NODE || process.execPath);
const exec = promisify(execFile);
const secret = "bridge-resident-secret-1234567890";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "tnb-bridge-"));
  const runtime = join(dir, "runtime.json");
  const helper = join(dir, "native-helper");
  const trace = join(dir, "attach-trace");
  const clients = [],
    services = [];
  await writeFile(
    join(dir, "index.html"),
    "<!doctype html><html><body>Bridge app resource</body></html>",
  );
  await writeFile(
    helper,
    `#!/bin/sh\ncase "$1" in\n--service-attach) printf attached >> '${trace}' ;;\n--service-credential) printf '%s' '${secret}' ;;\n*) exit 1 ;;\nesac\n`,
    { mode: 0o700 },
  );
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const service of services) await stop(service);
    await rm(dir, { recursive: true, force: true });
  });
  const start = async (env = {}) => {
    const service = spawn(nodeExecutable, [servicePath], {
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        TASKNBOARD_RESIDENT: "1",
        TASKNBOARD_LOCAL_SECRET: secret,
        TASKNBOARD_TOKENS: "",
        TASKNBOARD_DB: join(dir, "db.sqlite"),
        TASKNBOARD_RUNTIME_FILE: runtime,
        TASKNBOARD_CREDENTIAL_HELPER: helper,
        TASKNBOARD_APP_DIR: dir,
        TASKNBOARD_USER_HOME: dir,
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    services.push(service);
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Resident startup timeout: " + output)),
        10000,
      );
      service.stderr.on("data", (chunk) => {
        output += chunk;
        if (output.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      service.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Resident exited: " + output));
      });
    });
    return { service, descriptor: JSON.parse(await readFile(runtime, "utf8")) };
  };
  const connect = async (extra = {}, args = []) => {
    const client = new Client(
      { name: "bridge-test", version: "1" },
      {
        capabilities: { experimental: { "bridge-test": { preserved: true } } },
      },
    );
    clients.push(client);
    const transport = new StdioClientTransport({
      command: nodeExecutable,
      args: [bridgePath, ...args],
      env: {
        ...process.env,
        TASKNBOARD_SERVER_URL: "",
        TASKNBOARD_TOKEN: "",
        TASKNBOARD_RUNTIME_FILE: runtime,
        TASKNBOARD_CREDENTIAL_HELPER: "",
        ...extra,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    return { client, transport };
  };
  return { dir, runtime, helper, trace, start, connect };
}

async function stop(service) {
  if (service.exitCode !== null || service.signalCode !== null) return;
  service.kill();
  await new Promise((resolve) => service.once("exit", resolve));
}
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return name.startsWith("ui_")
    ? result._meta.result
    : JSON.parse(result.content[0].text);
};

test("the bridge preserves initialize capabilities and never retries a failed write", async (t) => {
  let writes = 0;
  let initializations = 0;
  let capabilities;
  const serverCapabilities = {
    tools: {},
    experimental: { extension: { supported: true } },
  };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    assert.equal(req.headers.authorization, "Bearer explicit-fixture-token");
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "initialize") {
      initializations++;
      capabilities = message.params.capabilities;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "bridge-fixture",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: serverCapabilities,
            serverInfo: { name: "fixture", version: "1" },
          },
        }),
      );
    } else if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
    } else if (message.method === "tools/call") {
      writes++;
      req.socket.destroy();
    } else if (message.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [] },
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new Client(
    { name: "capabilities-test", version: "1" },
    {
      capabilities: {
        experimental: { "client-extension": { original: true } },
      },
    },
  );
  t.after(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.connect(
    new StdioClientTransport({
      command: nodeExecutable,
      args: [bridgePath],
      env: {
        ...process.env,
        TASKNBOARD_SERVER_URL: `http://127.0.0.1:${server.address().port}/mcp`,
        TASKNBOARD_TOKEN: "explicit-fixture-token",
      },
      stderr: "pipe",
    }),
  );
  assert.deepEqual(capabilities, {
    experimental: { "client-extension": { original: true } },
  });
  assert.deepEqual(client.getServerCapabilities(), serverCapabilities);
  await assert.rejects(
    client.callTool({ name: "create_task", arguments: { title: "No retry" } }),
    (error) => error.code === -32603,
  );
  assert.equal(writes, 1);
  assert.deepEqual(await client.listTools(), { tools: [] });
  assert.equal(initializations, 2);
  assert.equal(writes, 1);
  assert.deepEqual(capabilities, {
    experimental: { "client-extension": { original: true } },
  });
});

test(
  "stdio bridge relays the resident app, UI resource, role boundaries and concurrent requests",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const { service, descriptor } = await f.start();
    const { client } = await f.connect();
    assert.equal(await readFile(f.trace, "utf8"), "attached");
    assert.ok(client.getServerCapabilities().resources);
    const tools = (await client.listTools()).tools;
    const opener = tools.find((tool) => tool.name === "open_tasknboard");
    assert.equal(opener._meta.ui.resourceUri, "ui://tasknboard/app-v1.html");
    assert.deepEqual(
      tools.find((tool) => tool.name === "ui_create_task")._meta.ui.visibility,
      ["app"],
    );
    assert.ok(
      (await client.listResources()).resources.some(
        (resource) => resource.uri === opener._meta.ui.resourceUri,
      ),
    );
    const resource = (
      await client.readResource({ uri: opener._meta.ui.resourceUri })
    ).contents[0];
    assert.equal(resource.mimeType, "text/html;profile=mcp-app");
    assert.match(resource.text, /Bridge app resource/);
    assert.deepEqual(resource._meta.ui.csp.connectDomains, []);
    assert.deepEqual(
      await call(client, "open_tasknboard", { boardId: "BOARD-1" }),
      { opened: true, boardId: "BOARD-1" },
    );
    assert.equal((await call(client, "ui_workspace_info")).actor.kind, "human");
    assert.equal((await call(client, "workspace_info")).actor.kind, "agent");
    const first = await call(client, "ui_create_task", {
      title: "First bridge task",
      boardId: "BOARD-1",
    });
    const second = await call(client, "ui_create_task", {
      title: "Second bridge task",
      boardId: "BOARD-1",
    });
    const denied = await client.callTool({
      name: "claim_task",
      arguments: { id: first.id, expectedVersion: first.version },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse(denied.content[0].text).code,
      "WORK_SESSION_REQUIRED",
    );
    const tasks = await Promise.all(
      [second.id, first.id, second.id, first.id].map((id) =>
        call(client, "get_task", { id }),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      [second.id, first.id, second.id, first.id],
    );
    await client.close();
    assert.equal(service.exitCode, null);
    assert.equal((await fetch(descriptor.url + "/healthz")).status, 200);
  },
);

test(
  "the same agent bridge follows a restart without using inherited credentials",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const first = await f.start();
    const { client } = await f.connect(
      {
        TASKNBOARD_AGENT_ID: "",
        TASKNBOARD_TOKEN: secret,
        TASKNBOARD_SERVER_URL: "http://127.0.0.1:1/mcp",
      },
      ["--agent", "installed-agent"],
    );
    const { actor } = await call(client, "workspace_info");
    assert.equal(actor.id, "installed-agent");
    assert.equal(actor.kind, "agent");
    const { tools } = await client.listTools();
    assert.ok(!tools.some(({ name }) => name === "open_tasknboard" || name.startsWith("ui_")));
    const task = await call(client, "create_task", {
      title: "Agent task before restart",
      boardId: "BOARD-1",
    });
    await stop(first.service);
    const second = await f.start();
    assert.notEqual(second.descriptor.mcpUrl, first.descriptor.mcpUrl);
    assert.equal((await call(client, "get_task", { id: task.id })).title, task.title);
    assert.equal(
      (await call(client, "create_task", {
        title: "Agent task after restart",
        boardId: "BOARD-1",
      })).title,
      "Agent task after restart",
    );
  },
);

test(
  "installed Claude Code connects to the resident before and after a port change",
  { skip: process.platform === "win32", timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const env = {
      PATH: process.env.PATH,
      HOME: f.dir,
      USERPROFILE: f.dir,
      CLAUDE_CONFIG_DIR: join(f.dir, ".claude"),
      DISABLE_TELEMETRY: "1",
      DISABLE_NONESSENTIAL_MODEL_CALLS: "1",
    };
    const runClaude = (args) =>
      exec("claude", args, { cwd: f.dir, env, timeout: 20000 });
    try {
      const { stdout } = await runClaude(["--version"]);
      t.diagnostic(stdout.trim());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return t.skip("Claude Code is not installed on PATH");
    }
    const settings = {
      TASKNBOARD_RESOURCES: dirname(bridgePath),
      TASKNBOARD_USER_ENV: JSON.stringify(env),
    };
    const first = await f.start(settings);
    const response = await fetch(first.descriptor.url + "/api/claude-plugin", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identity: "claude-installed" }),
      signal: AbortSignal.timeout(40000),
    });
    assert.equal(response.status, 200, await response.text());
    const verify = async () => {
      const { stdout } = await runClaude(["mcp", "list"]);
      assert.match(stdout, /plugin:tasknboard:tasknboard[^\n]*Connected/i);
    };
    await verify();
    await stop(first.service);
    const second = await f.start(settings);
    assert.notEqual(second.descriptor.mcpUrl, first.descriptor.mcpUrl);
    await verify();
  },
);

test(
  "the same client and a fresh bridge discover a new resident and preserve data",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const first = await f.start();
    const { client } = await f.connect();
    const task = await call(client, "ui_create_task", {
      title: "Survives resident restart",
      boardId: "BOARD-1",
    });
    await stop(first.service);
    const second = await f.start();
    assert.notEqual(second.descriptor.instanceId, first.descriptor.instanceId);
    assert.notEqual(second.descriptor.mcpUrl, first.descriptor.mcpUrl);
    const [tools, existing, workspace] = await Promise.all([
      client.listTools(),
      call(client, "get_task", { id: task.id }),
      call(client, "ui_workspace_info"),
    ]);
    assert.ok(tools.tools.some((tool) => tool.name === "open_tasknboard"));
    assert.equal(existing.title, task.title);
    assert.equal(workspace.actor.kind, "human");
    assert.equal(await readFile(f.trace, "utf8"), "attachedattached");
    assert.equal(
      (
        await call(client, "ui_create_task", {
          title: "After restart",
          boardId: "BOARD-1",
        })
      ).title,
      "After restart",
    );
    await client.close();
    const fresh = await f.connect();
    assert.equal(
      (await call(fresh.client, "get_task", { id: task.id })).title,
      task.title,
    );
    await stop(second.service);
    await assert.rejects(
      fresh.client.listTools(),
      (error) => error.code === -32603,
    );
  },
);

test("explicit fixture tokens use loopback HTTP and skip native attach", async (t) => {
  const f = await fixture(t);
  const { descriptor } = await f.start();
  const { client } = await f.connect({
    TASKNBOARD_SERVER_URL: descriptor.mcpUrl,
    TASKNBOARD_TOKEN: credentialFor(secret, { id: "codex-app", kind: "app" }),
  });
  assert.equal((await call(client, "workspace_info")).actor.kind, "agent");
  await assert.rejects(access(f.trace), { code: "ENOENT" });
  for (const url of [
    "https://127.0.0.1/mcp",
    "https://remote.example/mcp",
    "http://remote.example/mcp",
  ])
    await assert.rejects(
      resolveBridgeConnection({
        TASKNBOARD_SERVER_URL: url,
        TASKNBOARD_TOKEN: "fixture",
      }),
      { code: "INSECURE_CONNECTION" },
    );
});

test("missing native helper fails on stderr with clean stdout and no database fallback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tnb-bridge-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, "must-not-exist.sqlite");
  const processBridge = spawn(nodeExecutable, [bridgePath], {
    env: {
      ...process.env,
      TASKNBOARD_SERVER_URL: "",
      TASKNBOARD_TOKEN: "secret-must-not-appear",
      TASKNBOARD_RUNTIME_FILE: join(dir, "missing-runtime"),
      TASKNBOARD_CREDENTIAL_HELPER: join(dir, "missing-helper"),
      TASKNBOARD_DB: database,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  processBridge.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  processBridge.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) =>
    processBridge.once("exit", resolve),
  );
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /credential helper/);
  assert.ok(!stderr.includes("secret-must-not-appear"));
  await assert.rejects(access(database), { code: "ENOENT" });
});
