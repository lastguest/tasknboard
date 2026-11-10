import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userEnvironment } from "./agent-launcher.mjs";

const exec = promisify(execFile);
const failure = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export function createCodexPlugin({
  desktop = process.env.TASKNBOARD_DESKTOP === "1",
  home = process.env.TASKNBOARD_USER_HOME,
  serverUrl = process.env.TASKNBOARD_SERVER_URL,
  mcpUrl,
  runtimeFile = process.env.TASKNBOARD_RUNTIME_FILE,
  credentialHelper = process.env.TASKNBOARD_CREDENTIAL_HELPER,
  identity: defaultIdentity,
  platform = process.platform,
  searchPath,
  environment = () => userEnvironment({ platform, home }),
  run = exec,
} = {}) {
  let installing = false;
  let resolvedPath;
  async function install(identity = defaultIdentity) {
    if (!desktop || !home || !(serverUrl || mcpUrl || runtimeFile))
      throw failure(
        "PLUGIN_UNSUPPORTED",
        "Install the Codex plugin from the TasknBoard desktop app.",
      );
    if (
      typeof identity !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(identity)
    )
      throw failure("PLUGIN_IDENTITY", "Enter a valid agent identity.");
    if (installing)
      throw failure(
        "PLUGIN_BUSY",
        "A Codex plugin install is already in progress.",
        409,
      );
    installing = true;
    try {
      const windows = platform === "win32";
      if (searchPath === undefined)
        resolvedPath ??= environment().then(env => env.PATH || env.Path || "");
      const cliPath = searchPath ?? await resolvedPath;
      let executable;
      for (const directory of cliPath
        .split(windows ? ";" : delimiter)
        .filter(Boolean)) {
        for (const name of windows ? ["codex.exe", "codex.cmd"] : ["codex"]) {
          const candidate = join(directory, name);
          try {
            await access(candidate, windows ? constants.F_OK : constants.X_OK);
            executable = candidate;
            break;
          } catch (error) {
            if (!["ENOENT", "EACCES"].includes(error.code)) throw error;
          }
        }
        if (executable) break;
      }
      if (!executable)
        throw failure(
          "CODEX_MISSING",
          "Install the Codex CLI and add it to PATH, then restart TasknBoard.",
        );
      const descriptor =
        runtimeFile && !serverUrl && !mcpUrl
          ? JSON.parse(await readFile(runtimeFile, "utf8"))
          : null;
      const endpoint = new URL(mcpUrl || serverUrl || descriptor?.mcpUrl);
      if (
        endpoint.protocol !== "https:" &&
        !(
          endpoint.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
        )
      )
        throw failure(
          "PLUGIN_URL",
          "MCP credentials require HTTPS except on loopback.",
        );
      if (!endpoint.pathname.endsWith("/mcp"))
        endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/mcp";
      const mcp = {
        mcpServers: {
          tasknboard: {
            url: endpoint.href,
            bearer_token_env_var: "TASKNBOARD_TOKEN",
          },
        },
      };
      const fingerprint = hash(JSON.stringify({ mcp, identity }));
      const marketplace = `tasknboard-${hash(endpoint.href + "\0" + identity)}`;
      const directory = join(home, ".tasknboard", "codex", fingerprint);
      const files = {
        ".agents/plugins/marketplace.json": {
          name: marketplace,
          interface: { displayName: "TasknBoard" },
          plugins: [
            {
              name: "tasknboard",
              source: { source: "local", path: "./plugin" },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
          ],
        },
        "plugin/.codex-plugin/plugin.json": {
          name: "tasknboard",
          version: `0.1.0-${fingerprint}`,
          description:
            "Read, claim, and update tasks in your TasknBoard workspace.",
          author: { name: "TasknBoard" },
          mcpServers: "./.mcp.json",
          interface: {
            displayName: "TasknBoard",
            shortDescription: "Read, claim, and update workspace tasks.",
            developerName: "TasknBoard",
            category: "Productivity",
          },
        },
        "plugin/.mcp.json": mcp,
      };
      // Immutable, content-addressed files make retries safe without overwriting user edits.
      for (const [name, value] of Object.entries(files)) {
        const file = join(directory, name);
        await mkdir(join(file, ".."), { recursive: true });
        const content = JSON.stringify(value, null, 2) + "\n";
        try {
          await writeFile(file, content, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if ((await readFile(file, "utf8")) !== content)
            throw failure(
              "PLUGIN_CONFLICT",
              `The plugin files changed at ${directory}. Move that directory before retrying.`,
              409,
            );
        }
      }
      const invoke = async (args) => {
        const options = {
          timeout: 10000,
          maxBuffer: 1024 * 1024,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.startsWith("TASKNBOARD_") && key.toUpperCase() !== "PATH",
              ),
            ),
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: join(home, ".codex"),
            PATH: cliPath,
            ...(runtimeFile ? { TASKNBOARD_RUNTIME_FILE: runtimeFile } : {}),
            ...(credentialHelper
              ? { TASKNBOARD_CREDENTIAL_HELPER: credentialHelper }
              : {}),
          },
          windowsHide: true,
        };
        if (windows && executable.endsWith(".cmd")) {
          const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
          return run(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `& ${[executable, ...args].map(quote).join(" ")}; exit $LASTEXITCODE`,
            ],
            options,
          );
        }
        return run(executable, args, options);
      };
      await mkdir(join(home, ".codex"), { recursive: true });
      await invoke(["plugin", "marketplace", "add", directory, "--json"]);
      await invoke(["plugin", "add", `tasknboard@${marketplace}`, "--json"]);
      // The plugin uses a direct SQLite connection and survives desktop restarts.
      // Remove the obsolete standalone registration only after the plugin installs.
      await invoke(["mcp", "remove", "tasknboard"]);
      return { installed: true, marketplace, identity };
    } catch (error) {
      if (error.status) throw error;
      throw failure(
        "PLUGIN_INSTALL",
        "Codex could not install the plugin. Check that the Codex CLI supports plugins and can write its configuration, then retry.",
      );
    } finally {
      installing = false;
    }
  }
  return { install };
}
