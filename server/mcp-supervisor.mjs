import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { startMcpControl } from "./mcp-control.mjs";
import { connect } from "./client.mjs";
import { createTaskKeepAlive } from "./mcp-keep-alive.mjs";

// The host owns this process. Only the adapter worker restarts.
export function startSupervisor({ worker, input = process.stdin, output = process.stdout, diagnostics = process.stderr,
  database = process.env.TASKNBOARD_SERVER_URL ? null : resolve(process.env.TASKNBOARD_DB || "data/tasknboard.sqlite"),
  identity = process.env.TASKNBOARD_AGENT_ID || "coding-agent", heartbeatIntervalMs = 30000 }) {
  const pending = new Map();
  const internal = new Map();
  const subscriptions = new Set();
  const forwarded = new Set();
  let maintenanceClient;
  const maintenance = createTaskKeepAlive({ intervalMs: heartbeatIntervalMs,
    execute(name, args) {
      if (!database && !process.env.TASKNBOARD_SERVER_URL) return;
      maintenanceClient ??= connect({ database, actor: { id: identity, kind: "agent",
        ...(["architect", "worker"].includes(process.env.TASKNBOARD_AGENT_ROLE) ? { role: process.env.TASKNBOARD_AGENT_ROLE } : {}) } });
      return maintenanceClient.execute(name, args);
    },
    close: () => maintenanceClient?.close(),
    onError: error => diagnostics.write(`TasknBoard MCP keep-alive: ${error?.code || "ERROR"}.\n`),
  });
  let child, timer, handshakeTimer, initialization, initialized, startupInitialization;
  let stopped = false, ready = false, failures = 0;
  let state = "starting", manualRestart = false;
  const control = database ? startMcpControl({ database, identity, diagnostics,
    status: () => ({ state, workerPid: child?.pid ?? null }), restart }) : null;
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const fail = (id, message, ambiguous = false) => write({ jsonrpc: "2.0", id,
    error: { code: -32001, message, data: { code: "MCP_WORKER_UNAVAILABLE", ambiguous } } });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  function request(method, params, callback) {
    const id = `tasknboard-supervisor-${randomUUID()}`;
    internal.set(id, callback);
    send({ jsonrpc: "2.0", id, method, params });
  }

  function restore() {
    handshakeTimer = setTimeout(() => child?.kill(), 10000);
    request("initialize", initialization.params, (message) => {
      if (message.error) { child?.kill(); return; }
      if (initialized) send(initialized);
      const uris = [...subscriptions];
      function next() {
        const uri = uris.shift();
        if (uri) request("resources/subscribe", { uri }, (reply) => {
          if (reply.error) { child?.kill(); return; }
          next();
        });
        else {
          clearTimeout(handshakeTimer);
          ready = true;
          state = "connected";
          failures = 0;
          // Changes during the restart require a fresh resource read.
          for (const uri of subscriptions) write({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
        }
      }
      next();
    });
  }

  function launch() {
    if (stopped) return;
    const current = spawn(process.execPath, [fileURLToPath(worker)], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, TASKNBOARD_AGENT_ID: identity, ...(database ? { TASKNBOARD_DB: database } : {}) },
    });
    child = current;
    // Node buffers stdin writes until spawn. Accept the host's first handshake.
    ready = !initialization;
    current.stderr.pipe(diagnostics, { end: false });
    current.stdin.on("error", () => current.kill());
    current.on("error", (error) => diagnostics.write(`TasknBoard MCP worker: ${error.message}\n`));
    const lines = createInterface({ input: current.stdout });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (internal.has(message.id)) {
        const callback = internal.get(message.id);
        internal.delete(message.id);
        callback(message);
        return;
      }
      if (Object.hasOwn(message, "id") && !message.method) {
        maintenance.finish(message.id);
        forwarded.delete(message.id);
        const original = pending.get(message.id);
        pending.delete(message.id);
        if (original && !message.error) {
          if (original.method === "initialize") {
            initialization = original; startupInitialization = undefined; state = "connected";
          }
          if (original.method === "resources/subscribe") subscriptions.add(original.params.uri);
          if (original.method === "resources/unsubscribe") subscriptions.delete(original.params.uri);
        }
      }
      write(message);
    });
    current.once("spawn", () => {
      if (initialization) restore();
      else if (startupInitialization && !pending.has(startupInitialization.id)) {
        pending.set(startupInitialization.id, startupInitialization);
        send(startupInitialization);
      }
    });
    current.once("close", () => {
      lines.close();
      clearTimeout(handshakeTimer);
      ready = false;
      state = "reconnecting";
      child = undefined;
      internal.clear();
      maintenance.cancelAll();
      for (const [id, message] of pending) {
        // Initialization is safe to replay and the host still awaits this ID.
        if (message.method === "initialize" && !initialization) continue;
        const ambiguous = message.method === "tools/call" && forwarded.has(id);
        fail(id, ambiguous
          ? "The MCP worker stopped and is reconnecting. The action can have completed. Read the task before any new write."
          : message.method === "tools/call" && !forwarded.has(id)
            ? "The MCP worker is reconnecting. This request was not sent."
            : "The MCP worker stopped and is reconnecting. Read the current state after reconnection.", ambiguous);
      }
      forwarded.clear();
      pending.clear();
      if (!stopped) {
        const delay = manualRestart ? 0 : Math.min(250 * 2 ** Math.min(failures++, 7), 30000);
        manualRestart = false;
        diagnostics.write(`TasknBoard MCP worker stopped. Restart in ${delay} ms.\n`);
        timer = setTimeout(launch, delay);
      }
    });
  }

  const host = createInterface({ input });
  host.on("line", async (line) => {
    let message;
    try { message = JSON.parse(line); } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
      return;
    }
    if (!message || message.jsonrpc !== "2.0" || Array.isArray(message)) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      return;
    }
    if (message.method === "notifications/initialized") initialized = message;
    if (message.method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      maintenance.finish(requestId);
      if (pending.has(requestId) && !forwarded.has(requestId)) {
        pending.delete(requestId);
        write({ jsonrpc: "2.0", id: requestId, error: { code: -32800, message: "The tool call was cancelled before it was sent." } });
      }
    }
    if (message.method === "initialize" && !initialization) startupInitialization = message;
    if (!ready) {
      if (message.method === "initialize" && !initialization) return;
      if (Object.hasOwn(message, "id") && message.method) fail(message.id,
        "The MCP worker is reconnecting. This request was not sent. Read the current state before a new write.");
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) pending.set(message.id, message);
    if (message.method === "tools/call" && Object.hasOwn(message, "id")) {
      const current = child;
      await maintenance.start(message.id, message.params?.name, message.params?.arguments);
      if (stopped || pending.get(message.id) !== message || current !== child || !ready) return;
    }
    if (Object.hasOwn(message, "id") && message.method) forwarded.add(message.id);
    send(message);
  });
  function restart() {
    if (stopped) return;
    ready = false;
    state = "reconnecting";
    failures = 0;
    clearTimeout(timer);
    if (child) { manualRestart = true; child.kill(); }
    else launch();
  }
  function stop() {
    if (stopped) return maintenance.stop();
    stopped = true;
    ready = false;
    pending.clear();
    forwarded.clear();
    control?.stop();
    clearTimeout(timer);
    clearTimeout(handshakeTimer);
    host.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    output.removeListener("error", stop);
    child?.kill();
    return maintenance.stop();
  }
  host.once("close", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  output.once("error", stop);
  launch();
  return { stop, get workerPid() { return child?.pid; } };
}
