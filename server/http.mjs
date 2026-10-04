import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { createStore } from "./store.mjs";
import { createCliHelper } from "./cli-helper.mjs";
import { createClaudePlugin } from "./claude-plugin.mjs";
import { createCodexPlugin } from "./codex-plugin.mjs";
import { createAgentLauncher } from "./agent-launcher.mjs";
import { createAgentLogs } from "./agent-logs.mjs";
import { listMcpConnections, restartMcpConnection } from "./mcp-control.mjs";
import {
  agentClients,
  agentEvents,
  defaultConfig,
  listConfigs,
  writeConfig,
} from "./agent-config.mjs";
import { createGitHub } from "./github.mjs";
import { createChangeFeed } from "./changes.mjs";
import { createCommitLinks } from "./commit-links.mjs";
import { imageDataUrlLimit } from "./domain.mjs";
import { dbPath, localActor, tokensFromEnvironment } from "./config.mjs";
const host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 4310);
const desktop = process.env.TASKNBOARD_DESKTOP === "1";
const tokens = tokensFromEnvironment();
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !Object.keys(tokens).length
)
  throw new Error("Remote binding requires TASKNBOARD_TOKENS");
const store = createStore(dbPath),
  root = resolve(process.env.TASKNBOARD_STATIC_DIR || "dist");
const mcpEntry =
  desktop && process.env.TASKNBOARD_RESOURCES
    ? resolve(process.env.TASKNBOARD_RESOURCES, "mcp.mjs")
    : fileURLToPath(new URL("./mcp.mjs", import.meta.url));
const cliEntry =
  desktop && process.env.TASKNBOARD_RESOURCES
    ? resolve(process.env.TASKNBOARD_RESOURCES, "cli.mjs")
    : fileURLToPath(new URL("../dist-cli/tasknboard.mjs", import.meta.url));
const github = createGitHub(store);
const changes = createChangeFeed(store);
const cliHelper = createCliHelper();
const codexPlugin = createCodexPlugin({ mcpEntry });
const claudePlugin = createClaudePlugin({ mcpEntry, database: dbPath });
// Agents run on this machine only for a local workspace, as plugins do.
const launcher = createAgentLauncher({
  store,
  desktop: desktop && !Object.keys(tokens).length,
});
// Runs that the last quit stopped start again.
launcher.resume();
const agentLogs = createAgentLogs({
  home: launcher.enabled ? process.env.TASKNBOARD_USER_HOME : "",
  running: launcher.runningLogs,
});
store.registerActors(
  Object.keys(tokens).length ? Object.values(tokens) : [localActor],
);
const commitLinks = createCommitLinks(store, {
  onError: (error, repository) => console.error(`Commit scan failed for ${repository}: ${error.message}`),
});
commitLinks.start();
const httpError = (code, message, status) =>
  Object.assign(new Error(message), { code, status });
/** Agent settings live on this machine, like the plugins that use them. */
function agentCommand(name, args, actor) {
  if (actor.kind !== "human")
    throw httpError("FORBIDDEN", "Only a person can manage agent settings.", 403);
  const shared = Object.keys(tokens).length > 0;
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw httpError("VALIDATION", "Send a JSON object.", 400);
  const roster = () =>
    store
      .execute("workspace_info", {}, actor)
      .actors.filter((a) => a.kind === "agent")
      .map((a) => a.id);
  if (name === "agent-configs") {
    const agents = shared ? {} : listConfigs(store);
    return {
      mode: shared ? "shared" : "local",
      autoStart: launcher.enabled,
      clients: Object.entries(agentClients).map(([id, c]) => ({
        id,
        name: c.name,
        executable: c.executable,
        model: c.model,
        profile: { label: c.profile.label, flag: c.profile.flag, hint: c.profile.hint },
      })),
      events: agentEvents.map(({ id, label, description, placeholders, prompt }) => ({
        id,
        label,
        description,
        placeholders,
        hasPrompt: prompt !== null,
      })),
      defaults: defaultConfig(),
      agents: Object.fromEntries(
        Object.entries(agents).map(([id, config]) => [
          id,
          { config, ...launcher.status(id) },
        ]),
      ),
    };
  }
  if (shared)
    throw httpError(
      "AGENTS_UNSUPPORTED",
      "Configure agents from the local TasknBoard desktop app.",
      400,
    );
  if (name === "agent-config-save") {
    if (Object.keys(args).some((key) => !["identity", "config"].includes(key)))
      throw httpError("VALIDATION", "Provide only identity and config.", 400);
    return { identity: args.identity, config: writeConfig(store, args.identity, args.config) };
  }
  if (args.event !== "standup" || Object.keys(args).length !== 1)
    throw httpError("VALIDATION", "event: Only standup can be sent.", 400);
  const identities = new Set([...roster(), ...Object.keys(listConfigs(store))]);
  return { started: launcher.standup([...identities]) };
}
/** A task's agent runs, and one run's log: `{ taskId, identity?, file? }`. */
async function agentLogsCommand(args, actor) {
  if (actor.kind !== "human")
    throw httpError("FORBIDDEN", "Only a person can read agent logs.", 403);
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    typeof args.taskId !== "string" ||
    Object.keys(args).some((key) => !["taskId", "identity", "file"].includes(key))
  )
    throw httpError("VALIDATION", "Provide taskId, and identity and file to read one log.", 400);
  if (!agentLogs.root) return { available: false, runs: [] };
  const runs = await agentLogs.list(args.taskId);
  const chosen =
    args.identity !== undefined || args.file !== undefined
      ? { identity: String(args.identity), file: String(args.file) }
      : runs[0];
  return {
    available: true,
    runs,
    log: chosen ? await agentLogs.read(args.taskId, chosen.identity, chosen.file) : null,
  };
}
const json = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const server = createServer(async (req, res) => {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com https://gravatar.com; frame-ancestors 'none'",
    );
    const requestHost = req.headers.host || "";
    const allowedHosts = (
      process.env.TASKNBOARD_ALLOWED_HOSTS ||
      `${host}:${server.address().port},localhost:${server.address().port},127.0.0.1:${server.address().port}${desktop ? "" : ",localhost:5173,127.0.0.1:5173"}`
    ).split(",");
    if (!allowedHosts.includes(requestHost)) {
      json(res, 403, { code: "HOST_REJECTED", message: "Host not allowed" });
      return;
    }
    if (
      req.headers.origin &&
      !["http://", "https://"].some((s) =>
        allowedHosts.some((h) => req.headers.origin === s + h),
      )
    ) {
      json(res, 403, { message: "Origin not allowed" });
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      let actor = localActor;
      if (Object.keys(tokens).length) {
        const presented =
          req.headers.authorization?.replace(/^Bearer /, "") || "";
        const key = Object.keys(tokens).find(
          (k) =>
            Buffer.byteLength(k) === Buffer.byteLength(presented) &&
            timingSafeEqual(Buffer.from(k), Buffer.from(presented)),
        );
        if (!key) {
          json(res, 401, {
            code: "UNAUTHORIZED",
            message: "Enter your workspace access token in Settings.",
          });
          return;
        }
        actor = tokens[key];
      }
      if (url.pathname === "/api/cli-helper") {
        if (actor.kind !== "human") {
          json(res, 403, {
            code: "FORBIDDEN",
            message: "Only a person can manage the CLI helper.",
          });
        } else if (req.method === "GET") {
          json(res, 200, await cliHelper.status());
        } else if (req.method === "POST") {
          json(res, 200, await cliHelper.install());
        } else {
          json(res, 405, { message: "Use GET or POST" });
        }
        return;
      }
      if (url.pathname === "/api/stream") {
        if (req.method !== "GET") {
          json(res, 405, { message: "Use GET" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        });
        // The first bytes let clients and proxies treat the stream as open.
        res.write(": connected\n\n");
        const unsubscribe = changes.subscribe(() =>
          res.write("event: change\ndata: {}\n\n"),
        );
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        res.once("close", () => {
          clearInterval(ping);
          unsubscribe();
        });
        return;
      }
      if (url.pathname === "/api/mcp-config") {
        if (req.method !== "GET") {
          json(res, 405, { message: "Use GET" });
        } else if (actor.kind !== "human") {
          json(res, 403, {
            code: "FORBIDDEN",
            message: "Only a person can view MCP configuration.",
          });
        } else if (Object.keys(tokens).length) {
          json(res, 200, { mode: "shared" });
        } else {
          json(res, 200, {
            mode: "local",
            platform: process.platform,
            config: {
              mcpServers: {
                tasknboard: {
                  command: process.execPath,
                  args: [mcpEntry],
                  env: {
                    TASKNBOARD_DB: dbPath,
                    TASKNBOARD_AGENT_ID: "codex",
                  },
                },
              },
            },
            cli: {
              command: process.execPath,
              // Agents parse stderr as JSON, so Node's SQLite warning must stay off it.
              args: ["--disable-warning=ExperimentalWarning", cliEntry],
              env: {
                TASKNBOARD_DB: dbPath,
                TASKNBOARD_AGENT_ID: "pi",
              },
            },
          });
        }
        return;
      }
      if (url.pathname === "/api/mcp-status") {
        if (req.method !== "GET") {
          json(res, 405, { message: "Use GET" });
        } else if (actor.kind !== "human") {
          json(res, 403, {
            code: "FORBIDDEN",
            message: "Only a person can view MCP status.",
          });
        } else {
          json(res, 200, Object.keys(tokens).length
            ? { supported: false, connections: [] }
            : await listMcpConnections(dbPath));
        }
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { message: "Use POST" });
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        json(res, 415, { message: "JSON required" });
        return;
      }
      // Image uploads carry a base64 data URL; every other command stays small.
      const limit =
        url.pathname === "/api/upload_image" ? imageDataUrlLimit + 1024 : 65536;
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > limit) {
          json(res, 413, { message: "Request too large" });
          return;
        }
      }
      let args;
      try {
        args = JSON.parse(body || "{}");
      } catch {
        json(res, 400, { message: "Invalid JSON" });
        return;
      }
      const name = url.pathname.slice(5);
      if (name === "mcp-restart") {
        if (actor.kind !== "human")
          throw httpError("FORBIDDEN", "Only a person can restart MCP connections.", 403);
        if (Object.keys(tokens).length)
          throw httpError("MCP_CONTROL_UNSUPPORTED", "Restart MCP connections from the local TasknBoard app.", 400);
        if (
          !args || typeof args !== "object" || Array.isArray(args) ||
          Object.keys(args).length !== 1 ||
          typeof args.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.id)
        )
          throw httpError("VALIDATION", "Provide only a valid MCP connection id.", 400);
        json(res, 200, await restartMcpConnection(dbPath, args.id));
        return;
      }
      if (name === "codex-plugin") {
        if (actor.kind !== "human") {
          json(res, 403, {
            code: "FORBIDDEN",
            message: "Only a person can install the Codex plugin.",
          });
        } else if (Object.keys(tokens).length) {
          json(res, 400, {
            code: "PLUGIN_UNSUPPORTED",
            message:
              "Install the Codex plugin from the local TasknBoard desktop app.",
          });
        } else if (
          !args ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          Object.keys(args).some((key) => key !== "identity")
        ) {
          json(res, 400, { message: "Provide only the agent identity." });
        } else {
          const installed = await codexPlugin.install(args.identity);
          launcher.register(installed.identity, "codex");
          json(res, 200, { ...installed, autoStart: true });
        }
        return;
      }
      if (name === "claude-plugin") {
        if (actor.kind !== "human") {
          json(res, 403, {
            code: "FORBIDDEN",
            message: "Only a person can install the Claude Code plugin.",
          });
        } else if (Object.keys(tokens).length) {
          json(res, 400, {
            code: "PLUGIN_UNSUPPORTED",
            message:
              "Install the Claude Code plugin from the local TasknBoard desktop app.",
          });
        } else if (
          !args ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          Object.keys(args).some((key) => key !== "identity")
        ) {
          json(res, 400, { message: "Provide only the agent identity." });
        } else {
          const installed = await claudePlugin.install(args.identity);
          launcher.register(installed.identity, "claude");
          json(res, 200, { ...installed, autoStart: true });
        }
        return;
      }
      if (name === "agent-logs") {
        json(res, 200, await agentLogsCommand(args, actor));
        return;
      }
      if (["agent-configs", "agent-config-save", "agent-event"].includes(name)) {
        json(res, 200, agentCommand(name, args, actor));
        return;
      }
      // GitHub commands call out to GitHub, so they run outside the store.
      const result = await github.execute(name, args, actor);
      // Agent events compare the task with how it was before a person's edit.
      const before =
        actor.kind === "human" && ["update_task", "request_changes", "reject_task"].includes(name) && !result
          ? store.execute("get_task", { id: args.id }, actor)
          : null;
      const output = result ?? store.execute(name, args, actor);
      // A person's edits start agents; agents cannot reassign tasks.
      if (actor.kind === "human") {
        if (name === "create_task") launcher.assigned(output);
        if (name === "bulk_create_tasks") for (const task of output.tasks) launcher.assigned(task);
        if (["update_task", "request_changes", "reject_task"].includes(name)) launcher.changed(before, output);
        if (name === "add_comment") launcher.commented(output, actor, args.body);
      }
      json(res, 200, output);
      // data_version does not change for this connection's own writes.
      changes.check();
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      json(res, 405, { message: "Method not allowed" });
      return;
    }
    // Uploaded images are capability URLs: 128-bit random IDs, served as inert files
    // so <img> tags work without a bearer header.
    const upload = url.pathname.match(/^\/files\/([0-9a-f]{32})$/);
    if (upload) {
      const image = store.image(upload[1]);
      if (!image) {
        json(res, 404, { message: "Not found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": image.mime,
        "Content-Length": image.data.length,
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline",
      });
      res.end(req.method === "HEAD" ? undefined : image.data);
      return;
    }
    const file = resolve(
      root,
      "." +
        decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!file.startsWith(root + sep)) {
      json(res, 403, { message: "Forbidden" });
      return;
    }
    try {
      const data = await readFile(file);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[extname(file)] || "application/octet-stream",
      );
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      json(res, 404, {
        message: "Not found. Run npm run build before npm start.",
      });
    }
  } catch (e) {
    json(res, e.status || 500, {
      code: e.code || "INTERNAL",
      message: e.status ? e.message : "Unexpected server error",
      ...(e.status && e.details ? { details: e.details } : {}),
    });
    if (!e.status) console.error(e);
  }
});
server.listen(port, host, () => {
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${server.address().port}`;
  console.error(`TasknBoard listening on ${url}`);
  if (desktop) console.log(JSON.stringify({ url }));
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  launcher.stop();
  changes.stop();
  server.close(async () => {
    await commitLinks.stop();
    store.close();
    process.exit(0);
  });
  // A renderer or local client must not keep an orphan service alive.
  server.closeAllConnections();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, stop);
if (desktop) {
  process.stdin.resume();
  process.stdin.once("end", stop);
}
