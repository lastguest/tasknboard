import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createApplication, commandSchemas } from "./application.mjs";
import { createMcpEndpoint } from "./mcp-endpoint.mjs";
import { authenticateLocal } from "./local-auth.mjs";
import { runtimeFile as defaultRuntimeFile } from "./runtime.mjs";
import { createStore } from "./store.mjs";
import { createCliHelper } from "./cli-helper.mjs";
import { createClaudePlugin } from "./claude-plugin.mjs";
import { createCodexPlugin } from "./codex-plugin.mjs";
import { createCodexAppPlugin } from "./codex-app-plugin.mjs";
import { createAgentLauncher } from "./agent-launcher.mjs";
import { createAgentLogs } from "./agent-logs.mjs";
import { createGitHub } from "./github.mjs";
import { createCommitLinks } from "./commit-links.mjs";
import { responseUrls } from "./task-files.mjs";
import { createChangeFeed } from "./changes.mjs";
import { imageDataUrlLimit } from "./domain.mjs";
import { dbPath, localActor, tokensFromEnvironment } from "./config.mjs";
const host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 4310);
const resident = process.env.TASKNBOARD_RESIDENT === "1";
const desktop = resident || process.env.TASKNBOARD_DESKTOP === "1";
const secret = process.env.TASKNBOARD_LOCAL_SECRET || "";
if (resident && secret.length < 24)
  throw new Error("The resident service requires its native credential.");
const instanceId = randomUUID();
const runtimeFile = desktop
  ? defaultRuntimeFile(process.env)
  : process.env.TASKNBOARD_RUNTIME_FILE;
const credentialHelper = process.env.TASKNBOARD_CREDENTIAL_HELPER;
let serviceUrl;
const connection = () => ({ url: serviceUrl, secret });
const tokens = tokensFromEnvironment();
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !Object.keys(tokens).length
)
  throw new Error("Remote binding requires TASKNBOARD_TOKENS");
const store = createStore(dbPath),
  root = resolve(process.env.TASKNBOARD_STATIC_DIR || "dist");
const cliEntry =
  desktop && process.env.TASKNBOARD_RESOURCES
    ? resolve(process.env.TASKNBOARD_RESOURCES, "cli.mjs")
    : fileURLToPath(new URL("../dist-cli/tasknboard.mjs", import.meta.url));
const github = createGitHub(store);
const changes = createChangeFeed(store);
const cliHelper = createCliHelper({ desktop, runtimeFile, credentialHelper });
const codexPlugin = createCodexPlugin({
  desktop,
  runtimeFile,
  credentialHelper,
});
const codexAppPlugin = createCodexAppPlugin();
const claudePlugin = createClaudePlugin({
  desktop,
  runtimeFile,
  credentialHelper,
});
// Agents run on this machine only for a local workspace, as plugins do.
const launcher = createAgentLauncher({
  store,
  desktop: desktop && !Object.keys(tokens).length,
  connection,
  runtimeFile,
  credentialHelper,
});

const agentLogs = createAgentLogs({
  home: launcher.enabled ? process.env.TASKNBOARD_USER_HOME : "",
  running: launcher.runningLogs,
});
store.registerActors(
  Object.keys(tokens).length ? Object.values(tokens) : [localActor],
);
const commitLinks = createCommitLinks(store, {
  onError: (error, repository) =>
    console.error(`Commit scan failed for ${repository}: ${error.message}`),
});
commitLinks.start();
const application = createApplication({
  database: dbPath,
  store,
  github,
  launcher,
  changes,
  agentLogs,
  cliHelper,
  codexPlugin,
  codexAppPlugin,
  claudePlugin,
  shared: Object.keys(tokens).length > 0,
  instanceId,
  connection,
  runtimeFile,
  credentialHelper,
  cliEntry,
  appRoot: resolve(
    process.env.TASKNBOARD_APP_DIR ||
      (process.env.TASKNBOARD_RESOURCES
        ? resolve(process.env.TASKNBOARD_RESOURCES, "app")
        : "dist-app"),
  ),
});
const authenticate = (value) => authenticateLocal(value, secret, tokens);
const mcp = createMcpEndpoint({
  application,
  schemas: commandSchemas,
  authenticate,
});
async function body(req, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit)
      throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(bytes ? Buffer.concat(chunks, bytes).toString("utf8") : "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
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
    const url = new URL(req.url, `http://${requestHost}`);
    if (url.pathname === "/healthz") {
      json(res, 200, {
        instanceId,
        pid: process.pid,
        url: serviceUrl,
        mcpUrl: serviceUrl + "/mcp",
      });
      return;
    }
    if (url.pathname === "/mcp") {
      await mcp.handle(
        req,
        res,
        req.method === "POST" ? await body(req, 30_000_000) : undefined,
      );
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const actor =
        secret || Object.keys(tokens).length
          ? authenticate(
              req.headers.authorization?.replace(/^Bearer /, "") || "",
            )
          : localActor;
      if (!actor) {
        json(res, 401, {
          code: "UNAUTHORIZED",
          message: "Enter your workspace access token in Settings.",
        });
        return;
      }
      if (actor.kind === "app") {
        json(res, 403, {
          code: "FORBIDDEN",
          message: "Use the MCP app interface.",
        });
        return;
      }
      if (url.pathname === "/api/cli-helper") {
        if (!["GET", "POST"].includes(req.method)) {
          json(res, 405, { message: "Use GET or POST" });
          return;
        }
        json(
          res,
          200,
          await application.execute(
            req.method === "GET" ? "cli-helper-status" : "cli-helper-install",
            {},
            actor,
          ),
        );
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
      if (["/api/mcp-config", "/api/mcp-status"].includes(url.pathname)) {
        if (req.method !== "GET") {
          json(res, 405, { message: "Use GET" });
          return;
        }
        json(res, 200, await application.execute(url.pathname.slice(5), {}, actor));
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
      const name = url.pathname.slice(5);
      const args = await body(
        req,
        name === "upload_artifact" ? 12 * 1024 * 1024
          : name === "upload_image" ? imageDataUrlLimit + 1024
          : name === "export-file" ? 30_000_000
          : 2 * 1024 * 1024,
      );
      json(res, 200, responseUrls(await application.execute(name, args, actor), url.origin));
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
server.listen(port, host, async () => {
  serviceUrl = `http://${host.includes(":") ? `[${host}]` : host}:${server.address().port}`;
  if (["127.0.0.1", "localhost", "::1"].includes(host))
    store.setSettings({ workspace_url: `${serviceUrl}/` });
  if (runtimeFile) {
    await mkdir(dirname(runtimeFile), { recursive: true });
    const temp = runtimeFile + `.${process.pid}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({
        url: serviceUrl,
        mcpUrl: serviceUrl + "/mcp",
        instanceId,
        pid: process.pid,
        credentialHelper,
      }),
      { mode: 0o600 },
    );
    await rename(temp, runtimeFile);
  }
  launcher.resume();
  console.error(`TasknBoard listening on ${serviceUrl}`);
  if (desktop) console.log(JSON.stringify({ url: serviceUrl }));
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  launcher.stop();
  changes.stop();
  await mcp.close();
  server.close(async () => {
    await commitLinks.stop();
    if (runtimeFile) {
      try {
        if (
          JSON.parse(await readFile(runtimeFile, "utf8")).instanceId ===
          instanceId
        )
          await unlink(runtimeFile);
      } catch {}
    }
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, stop);
const watchdog = resident
  ? setInterval(async () => {
      if (process.env.TASKNBOARD_SUPERVISOR_PID) {
        try {
          process.kill(Number(process.env.TASKNBOARD_SUPERVISOR_PID), 0);
        } catch {
          void stop();
        }
      }
      if (process.env.TASKNBOARD_STOP_FILE) {
        try {
          await readFile(process.env.TASKNBOARD_STOP_FILE);
          await unlink(process.env.TASKNBOARD_STOP_FILE);
          void stop();
        } catch {}
      }
    }, 500)
  : undefined;
if (desktop && (!resident || process.env.TASKNBOARD_SUPERVISOR_PID)) {
  process.stdin.resume();
  process.stdin.once("end", stop);
}
