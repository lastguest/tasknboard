import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const serverDirectory = fileURLToPath(new URL("../server/", import.meta.url));
const nodeExecutable = process.env.TASKNBOARD_TEST_NODE || process.execPath;
const serviceEntry =
  process.env.TASKNBOARD_TEST_SERVICE || join(serverDirectory, "http.mjs");
const bridgeEntry =
  process.env.TASKNBOARD_TEST_BRIDGE || join(serverDirectory, "mcp-bridge.mjs");

async function stop(child) {
  // Include the MCP bridge descendants if the host fails before closing them.
  const kill = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  if (!child.pid) return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  kill("SIGTERM");
  if (exited) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForResident(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const finish = (error) => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", finish);
      error ? reject(error) : resolve();
    };
    const onData = (chunk) => {
      output = (output + chunk).slice(-4096);
      if (output.includes("TasknBoard listening on ")) finish();
    };
    const onExit = (code, signal) =>
      finish(new Error(`Resident exited before startup (${code ?? signal})`));
    const timer = setTimeout(
      () => finish(new Error("Resident startup timed out")),
      10000,
    );
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

function appServer(child) {
  let nextId = 0;
  let failure;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  const fail = (error) => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.once("error", fail);
  child.once("exit", (code, signal) =>
    fail(new Error(`Codex app-server exited (${code ?? signal})`)),
  );
  child.stdin.on("error", fail);
  // Drain diagnostics without exposing host configuration or credentials.
  child.stderr.resume();
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error("Codex app-server emitted invalid JSON"));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) {
      request.reject(
        new Error(
          `${request.method}: ${message.error.code} ${message.error.message}`,
        ),
      );
    } else {
      request.resolve(message.result);
    }
  });
  return {
    close: () => lines.close(),
    notify: (method) => child.stdin.write(JSON.stringify({ method }) + "\n"),
    call: (method, params, timeout = 30000) =>
      new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex app-server request timed out: ${method}`));
        }, timeout);
        pending.set(id, { method, resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      }),
  };
}

test(
  "installed Codex discovers the local app and agent plugins and reconnects after restart",
  {
    skip:
      process.platform === "win32"
        ? "The credential fixture requires a POSIX shell"
        : false,
    timeout: 180000,
  },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "tnb-codex-discovery-"));
    const children = [];
    let rpc;
    t.after(async () => {
      try {
        for (const child of children.reverse()) await stop(child);
        rpc?.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("TASKNBOARD_") &&
            !/TOKEN|SECRET|PASSWORD|API_KEY/.test(key),
        ),
      ),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };
    try {
      const version = await exec("codex", ["--version"], {
        env,
        cwd: home,
        timeout: 10000,
      });
      t.diagnostic(version.stdout.trim());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      t.skip("Codex CLI is not installed on PATH");
      return;
    }
    const runtime = join(home, "runtime.json");
    const helper = join(home, "credential-helper");
    const secret = randomBytes(32).toString("hex");
    const html =
      "<!doctype html><html><body>Isolated Codex discovery fixture</body></html>";
    await writeFile(join(home, "index.html"), html);
    await writeFile(
      helper,
      `#!/bin/sh\ncase "$1" in\n--service-attach) exit 0 ;;\n--service-credential) printf '%s' '${secret}' ;;\n*) exit 1 ;;\nesac\n`,
      { mode: 0o700 },
    );
    const serviceOptions = {
      cwd: home,
      detached: true,
      env: {
        ...env,
        TASKNBOARD_USER_HOME: home,
        TASKNBOARD_DB: join(home, "db.sqlite"),
        TASKNBOARD_RUNTIME_FILE: runtime,
        TASKNBOARD_CREDENTIAL_HELPER: helper,
        TASKNBOARD_RESOURCES: dirname(resolve(bridgeEntry)),
        TASKNBOARD_APP_DIR: home,
        TASKNBOARD_RESIDENT: "1",
        TASKNBOARD_LOCAL_SECRET: secret,
        TASKNBOARD_TOKENS: "",
        TASKNBOARD_ALLOWED_HOSTS: "",
        PORT: "0",
        HOST: "127.0.0.1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    };
    const start = async () => {
      const resident = spawn(
        resolve(nodeExecutable),
        [resolve(serviceEntry)],
        serviceOptions,
      );
      children.push(resident);
      await waitForResident(resident);
      resident.stderr.resume();
      return {
        resident,
        descriptor: JSON.parse(await readFile(runtime, "utf8")),
      };
    };
    const { resident, descriptor } = await start();
    const response = await fetch(descriptor.url + "/api/service-connect", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(40000),
    });
    const installed = await response.json();
    assert.equal(
      response.status,
      200,
      "The resident must install the app plugin",
    );
    assert.equal(installed.appPlugin.installed, true);
    assert.equal(installed.appPlugin.enabled, true);
    const agentResponse = await fetch(descriptor.url + "/api/codex-plugin", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identity: "codex-installed" }),
      signal: AbortSignal.timeout(40000),
    });
    const agentPlugin = await agentResponse.json();
    assert.equal(agentResponse.status, 200, JSON.stringify(agentPlugin));
    await appendFile(
      join(env.CODEX_HOME, "config.toml"),
      `\n[projects.${JSON.stringify(home)}]\ntrust_level = "trusted"\n`,
    );
    const host = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: home,
      env: { ...env, TASKNBOARD_AGENT_ID: "codex-dispatched" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(host);
    rpc = appServer(host);
    await rpc.call("initialize", {
      clientInfo: { name: "tasknboard_discovery_test", version: "1" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        extensions: { "io.modelcontextprotocol/ui": {} },
      },
    });
    rpc.notify("initialized");
    const thread = await rpc.call("thread/start", {
      cwd: home,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const deadline = Date.now() + 20000;
    let server, agentServer;
    // MCP startup runs asynchronously after thread/start, especially in a bundle.
    while (Date.now() < deadline) {
      const status = await rpc.call(
        "mcpServerStatus/list",
        { threadId: thread.thread.id },
        Math.max(1, deadline - Date.now()),
      );
      server = status.data.find(
        (entry) => entry.pluginId === installed.appPlugin.pluginId,
      );
      agentServer = status.data.find(
        (entry) => entry.pluginId === `tasknboard@${agentPlugin.marketplace}`,
      );
      if (
        server?.runtimeStatus === "connected" &&
        agentServer?.runtimeStatus === "connected"
      )
        break;
      if (server) {
        assert.ok(["starting", "connected"].includes(server.runtimeStatus));
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    assert.ok(
      server,
      "Codex did not discover the app plugin within 20 seconds",
    );
    assert.equal(server.runtimeStatus, "connected");
    assert.equal(agentServer?.runtimeStatus, "connected");
    assert.ok(agentServer.tools.workspace_info);
    assert.equal(agentServer.tools.open_tasknboard, undefined);
    const callAgent = (tool, args = {}) =>
      rpc.call("mcpServer/tool/call", {
        threadId: thread.thread.id,
        server: agentServer.name,
        tool,
        arguments: args,
      });
    const workspace = await callAgent("workspace_info");
    assert.equal(workspace.structuredContent?.actor.id, "codex-dispatched");
    assert.equal(workspace.structuredContent?.actor.kind, "agent");
    const opener = server.tools.open_tasknboard;
    assert.ok(opener, "Codex must expose open_tasknboard");
    assert.deepEqual(opener._meta["openai/ui"].entrypoints, [
      { type: "global" },
      { type: "thread" },
    ]);
    const uri = opener._meta.ui.resourceUri;
    assert.equal(uri, "ui://tasknboard/app-v1.html");
    const resource = await rpc.call("mcpServer/resource/read", {
      threadId: thread.thread.id,
      server: server.name,
      uri,
    });
    assert.equal(resource.contents.length, 1);
    const content = resource.contents[0];
    assert.equal(content.uri, uri);
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.equal(content.text, html);
    assert.deepEqual(content._meta["openai/ui"], {
      preferredDisplayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen"],
    });
    assert.deepEqual(content._meta.ui.csp.connectDomains, []);
    assert.deepEqual(content._meta.ui.csp.resourceDomains, [
      "https://avatars.githubusercontent.com",
      "https://gravatar.com",
      "https://github.com",
      "https://user-images.githubusercontent.com",
    ]);
    assert.equal(content._meta.ui.prefersBorder, false);
    const created = await callAgent("create_task", {
      boardId: "BOARD-1",
      title: "Codex task before restart",
    });
    assert.notEqual(created.isError, true);
    assert.ok(created.structuredContent.id);
    await stop(resident);
    const restarted = await start();
    assert.notEqual(restarted.descriptor.mcpUrl, descriptor.mcpUrl);
    const existing = await callAgent("get_task", {
      id: created.structuredContent.id,
    });
    assert.equal(
      existing.structuredContent?.title,
      "Codex task before restart",
    );
  },
);
