import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConnection, runtimeFile } from "./runtime.mjs";
import { identityPattern } from "./agent-config.mjs";

const run = promisify(execFile);
const unavailable = () =>
  Object.assign(
    new Error(
      "The TasknBoard service helper is unavailable. Reinstall the TasknBoard service.",
    ),
    { code: "SERVICE_UNAVAILABLE" },
  );

export async function resolveBridgeConnection(
  env = process.env,
  actor = { id: "codex-app", kind: "app" },
) {
  if (env.TASKNBOARD_SERVER_URL) {
    let url;
    try {
      url = new URL(env.TASKNBOARD_SERVER_URL);
    } catch {
      throw unavailable();
    }
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw Object.assign(
        new Error("The TasknBoard MCP bridge requires loopback HTTP."),
        { code: "INSECURE_CONNECTION" },
      );
  } else {
    let helper = env.TASKNBOARD_CREDENTIAL_HELPER;
    if (!helper) {
      try {
        helper = JSON.parse(
          await readFile(runtimeFile(env), "utf8"),
        ).credentialHelper;
      } catch {
        throw unavailable();
      }
    }
    if (!helper || !isAbsolute(helper)) throw unavailable();
    try {
      await run(helper, ["--service-attach"], {
        timeout: 40000,
        windowsHide: true,
        maxBuffer: 8192,
      });
    } catch {
      throw unavailable();
    }
  }
  return resolveConnection({ env, actor });
}

/** Relay the original MCP messages. The resident service owns all protocol and domain behavior. */
export async function startBridge({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  agentIdentity,
} = {}) {
  let actor;
  if (agentIdentity !== undefined) {
    const id = env.TASKNBOARD_AGENT_ID || agentIdentity;
    if (!identityPattern.test(id))
      throw Object.assign(new Error("Invalid agent identity."), {
        code: "AGENT_IDENTITY",
      });
    actor = { id, kind: "agent" };
    // The plugin is local. Inherited URL and token values can point at another
    // service or carry more privileges than this agent.
    env = { ...env, TASKNBOARD_SERVER_URL: "", TASKNBOARD_TOKEN: "" };
  }
  const stdio = new StdioServerTransport(stdin, stdout);
  const pending = new Map();
  let http, closing, reconnecting, initializeParams, descriptorStamp;
  let available = true;
  const report = () =>
    stderr.write(
      "TasknBoard MCP bridge transport failed. No request was retried.\n",
    );
  const errorResponse = (id) =>
    stdio.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message:
          "The TasknBoard resident connection failed. The request was not retried.",
      },
    });
  const fail = async (id) => {
    if (pending.delete(id)) await errorResponse(id);
  };
  const currentDescriptor = async () => {
    if (env.TASKNBOARD_SERVER_URL) return null;
    try {
      const descriptor = JSON.parse(await readFile(runtimeFile(env), "utf8"));
      return JSON.stringify([descriptor.mcpUrl, descriptor.instanceId]);
    } catch {
      return null;
    }
  };
  const createTransport = ({ url, token }) => {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 0,
        initialReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1,
      },
    });
    let handshake;
    transport.onerror = (error) => {
      if (closing || http !== transport) return;
      available = false;
      report();
      handshake?.reject(unavailable());
      // A POST failure belongs to its send promise. SSE errors affect the session.
      if (/SSE|reconnect/i.test(error.message))
        for (const id of pending.keys()) void fail(id).catch(report);
    };
    transport.onmessage = (message) => {
      if (closing || http !== transport) return;
      if (handshake && message.id === handshake.id && !("method" in message)) {
        if (message.result?.protocolVersion) {
          transport.setProtocolVersion(message.result.protocolVersion);
          handshake.resolve();
        } else handshake.reject(unavailable());
        return;
      }
      if ("id" in message && !("method" in message)) {
        const method = pending.get(message.id);
        if (!pending.delete(message.id)) return;
        if (method === "initialize" && message.result?.protocolVersion)
          transport.setProtocolVersion(message.result.protocolVersion);
      }
      void stdio.send(message).catch(report);
    };
    const initialize = async () => {
      const id = `tasknboard-bridge-${randomUUID()}`;
      let timer;
      const response = new Promise((resolve, reject) => {
        handshake = { id, resolve, reject };
        timer = setTimeout(() => reject(unavailable()), 10000);
      });
      // Attach a rejection handler before sending because send also reports errors.
      const sending = transport.send({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: initializeParams,
      });
      try {
        await Promise.all([sending, response]);
        await transport.send({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
      } finally {
        clearTimeout(timer);
        handshake = undefined;
      }
    };
    return { transport, initialize };
  };
  http = createTransport(await resolveBridgeConnection(env, actor)).transport;
  descriptorStamp = await currentDescriptor();
  const ensureConnection = async () => {
    if (reconnecting) return reconnecting;
    const stamp = await currentDescriptor();
    if (reconnecting) return reconnecting;
    if (available && stamp === descriptorStamp) return http;
    reconnecting = (async () => {
      available = false;
      for (const id of pending.keys()) await fail(id);
      await http.close();
      const connection = await resolveBridgeConnection(env, actor);
      if (closing) throw unavailable();
      const next = createTransport(connection);
      http = next.transport;
      await http.start();
      try {
        if (!initializeParams) throw unavailable();
        await next.initialize();
        if (closing) throw unavailable();
        descriptorStamp = await currentDescriptor();
        available = true;
        return http;
      } catch (error) {
        await http.close();
        throw error;
      }
    })();
    try {
      return await reconnecting;
    } finally {
      reconnecting = undefined;
    }
  };
  stdio.onerror = report;
  stdio.onmessage = (message) => {
    if (closing) return;
    const request = "id" in message && "method" in message;
    if (message.method === "initialize") initializeParams = message.params;
    void (async () => {
      let transport;
      try {
        transport = request ? await ensureConnection() : http;
        if (closing || (!request && !available)) return;
        if (request) pending.set(message.id, message.method);
        await transport.send(message);
      } catch {
        if (!transport) report();
        if (transport === http) available = false;
        if (request) {
          if (transport) await fail(message.id);
          else await errorResponse(message.id);
        }
      }
    })().catch(report);
  };
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      stdin.off("end", close);
      // DELETE closes only this MCP session. It never stops the resident.
      const timer = setTimeout(() => {
        void http.close();
      }, 3000);
      try {
        await http.terminateSession();
      } catch {
        report();
      } finally {
        clearTimeout(timer);
        await http.close();
        await stdio.close();
      }
    })();
    return closing;
  };
  await http.start();
  await stdio.start();
  stdin.once("end", close);
  return { close };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [mode, identity, ...extra] = process.argv.slice(2);
    if (mode !== undefined && (mode !== "--agent" || !identity || extra.length))
      throw Object.assign(new Error("Invalid bridge arguments."), {
        code: "AGENT_IDENTITY",
      });
    const bridge = await startBridge({ agentIdentity: identity });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        void bridge.close();
      });
  } catch (error) {
    const message =
      error.code === "INSECURE_CONNECTION"
        ? "The TasknBoard MCP bridge requires loopback HTTP."
        : error.code === "AGENT_IDENTITY"
          ? "The TasknBoard MCP bridge requires a valid agent identity."
          : "The TasknBoard resident connection is unavailable. Check the installed service and credential helper.";
    process.stderr.write(message + "\n");
    process.exitCode = 1;
  }
}
