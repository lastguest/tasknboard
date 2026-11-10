import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { credentialFor } from "./local-auth.mjs";

const run = promisify(execFile);
export function runtimeFile(env = process.env) {
  if (env.TASKNBOARD_RUNTIME_FILE) return env.TASKNBOARD_RUNTIME_FILE;
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? env.APPDATA || join(homedir(), "AppData", "Roaming")
        : env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "app.tasknboard.desktop", "runtime.json");
}

export async function resolveConnection({ actor, env = process.env } = {}) {
  let descriptor;
  if (!env.TASKNBOARD_SERVER_URL) {
    try {
      descriptor = JSON.parse(await readFile(runtimeFile(env), "utf8"));
    } catch {
      throw Object.assign(
        new Error(
          "The TasknBoard service is unavailable. Start or install the service from TasknBoard Settings.",
        ),
        { code: "SERVICE_UNAVAILABLE" },
      );
    }
  }
  const target = env.TASKNBOARD_SERVER_URL || descriptor?.mcpUrl;
  let url;
  try {
    url = new URL(target);
  } catch {
    throw Object.assign(new Error("The service URL is invalid."), {
      code: "SERVICE_UNAVAILABLE",
    });
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw Object.assign(
      new Error("MCP credentials require HTTPS except on loopback."),
      { code: "INSECURE_CONNECTION" },
    );
  if (!url.pathname.endsWith("/mcp"))
    url.pathname = url.pathname.replace(/\/$/, "") + "/mcp";
  if (descriptor && (!loopback || url.protocol !== "http:"))
    throw Object.assign(
      new Error("The resident descriptor must use loopback HTTP."),
      { code: "INSECURE_CONNECTION" },
    );
  let token = env.TASKNBOARD_TOKEN;
  if (!token && !loopback)
    throw Object.assign(
      new Error("An explicit remote service requires TASKNBOARD_TOKEN."),
      { code: "CREDENTIAL_UNAVAILABLE" },
    );
  if (!token) {
    const helper =
      env.TASKNBOARD_CREDENTIAL_HELPER || descriptor?.credentialHelper;
    if (!helper || !isAbsolute(helper))
      throw Object.assign(
        new Error(
          "The local credential helper is unavailable. Reinstall the TasknBoard service.",
        ),
        { code: "CREDENTIAL_UNAVAILABLE" },
      );
    const output = await run(helper, ["--service-credential"], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 8192,
    });
    const secret = output.stdout.trim();
    token = ["agent", "app"].includes(actor?.kind)
      ? credentialFor(secret, actor)
      : secret;
  }
  return { url, token };
}
