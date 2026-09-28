import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createStore } from "./store.mjs";
import { dbPath, localActor, tokensFromEnvironment } from "./config.mjs";
const host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 4310);
const tokens = tokensFromEnvironment();
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !Object.keys(tokens).length
)
  throw new Error("Remote binding requires TASKNBOARD_TOKENS");
const store = createStore(dbPath),
  root = resolve("dist");
store.registerActors(
  Object.keys(tokens).length ? Object.values(tokens) : [localActor],
);
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
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    );
    const requestHost = req.headers.host || "";
    const allowedHosts = (
      process.env.TASKNBOARD_ALLOWED_HOSTS ||
      `${host}:${port},localhost:${port},127.0.0.1:${port},localhost:5173,127.0.0.1:5173`
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
      if (req.method !== "POST") {
        json(res, 405, { message: "Use POST" });
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        json(res, 415, { message: "JSON required" });
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) {
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
      json(res, 200, store.execute(url.pathname.slice(5), args, actor));
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      json(res, 405, { message: "Method not allowed" });
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
    });
    if (!e.status) console.error(e);
  }
});
server.listen(port, host, () =>
  console.error(`TasknBoard listening on http://${host}:${port}`),
);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
