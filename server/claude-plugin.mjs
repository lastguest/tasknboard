import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { userEnvironment } from "./agent-launcher.mjs";
import { agentPluginConnection } from "./agent-plugin-connection.mjs";
import { identityPattern } from "./agent-config.mjs";

const exec = promisify(execFile);
const failure = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export function createClaudePlugin({
  desktop = process.env.TASKNBOARD_DESKTOP === "1",
  home = process.env.TASKNBOARD_USER_HOME,
  resources = process.env.TASKNBOARD_RESOURCES,
  runtimeFile = process.env.TASKNBOARD_RUNTIME_FILE,
  credentialHelper = process.env.TASKNBOARD_CREDENTIAL_HELPER,
  identity: defaultIdentity,
  platform = process.platform,
  searchPath,
  environment = () => userEnvironment({ platform, home }),
  run = exec,
} = {}) {
  let installing = false;
  async function install(identity = defaultIdentity) {
    const connection = agentPluginConnection({
      runtimeFile,
      credentialHelper,
      resources,
      identity,
    });
    if (!desktop || !home || !connection)
      throw failure(
        "PLUGIN_UNSUPPORTED",
        "Install the Claude Code plugin from the TasknBoard desktop app.",
      );
    if (typeof identity !== "string" || !identityPattern.test(identity))
      throw failure("PLUGIN_IDENTITY", "Enter a valid agent identity.");
    if (installing)
      throw failure(
        "PLUGIN_BUSY",
        "A Claude Code plugin install is already in progress.",
        409,
      );
    installing = true;
    try {
      const windows = platform === "win32";
      const userEnv = searchPath === undefined ? await environment() : {};
      const cliPath = searchPath ?? userEnv.PATH ?? userEnv.Path ?? "";
      let executable;
      for (const directory of cliPath
        .split(windows ? ";" : delimiter)
        .filter(Boolean)) {
        for (const name of windows
          ? ["claude.exe", "claude.cmd"]
          : ["claude"]) {
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
          "CLAUDE_MISSING",
          "Install the Claude Code CLI and add it to PATH, then restart TasknBoard.",
        );
      const mcp = {
        mcpServers: {
          tasknboard: { type: "stdio", ...connection },
        },
      };
      const fingerprint = hash(JSON.stringify(mcp));
      const marketplace = `tasknboard-${fingerprint}`;
      const directory = join(home, ".tasknboard", "claude", fingerprint);
      const files = {
        ".claude-plugin/marketplace.json": {
          name: marketplace,
          owner: { name: "TasknBoard" },
          plugins: [{ name: "tasknboard", source: "./plugin" }],
        },
        "plugin/.claude-plugin/plugin.json": {
          name: "tasknboard",
          version: `0.1.0-${fingerprint}`,
          description:
            "Read, claim, and update tasks in your TasknBoard workspace.",
          author: { name: "TasknBoard" },
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
              Object.entries(userEnv).filter(
                ([key]) =>
                  !key.startsWith("TASKNBOARD_") &&
                  key.toUpperCase() !== "PATH",
              ),
            ),
            HOME: home,
            USERPROFILE: home,
            PATH: cliPath,
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
      await invoke(["plugin", "validate", join(directory, "plugin")]);
      await invoke(["plugin", "marketplace", "add", directory]);
      await invoke([
        "plugin",
        "install",
        `tasknboard@${marketplace}`,
        "--scope",
        "user",
      ]);
      const { stdout } = await invoke(["plugin", "list", "--json"]);
      const installed = JSON.parse(stdout);
      if (
        !Array.isArray(installed) ||
        !installed.some(
          (plugin) =>
            plugin.id === `tasknboard@${marketplace}` &&
            plugin.enabled &&
            plugin.scope === "user",
        )
      )
        throw failure(
          "PLUGIN_VERIFY",
          "Claude Code did not confirm an enabled TasknBoard plugin.",
        );
      return { installed: true, marketplace, identity };
    } catch (error) {
      if (error.status) throw error;
      throw failure(
        "PLUGIN_INSTALL",
        "Claude Code could not install the plugin. Check that the Claude Code CLI supports plugins and can write its configuration, then retry.",
      );
    } finally {
      installing = false;
    }
  }
  return { install };
}
