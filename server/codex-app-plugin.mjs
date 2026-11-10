import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userEnvironment } from "./agent-launcher.mjs";

const exec = promisify(execFile);
const failure = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
// The board glyph from the app sidebar, on a square tile like Codex's bundled plugin icons.
const icon = (background, glyph) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 512 512">
  <mask id="cutout">
    <rect x="112" y="104" width="288" height="304" fill="#fff"/>
    <circle cx="176" cy="172" r="30" fill="#000"/>
    <rect x="148" y="244" width="216" height="28" rx="14" fill="#000"/>
    <rect x="148" y="300" width="144" height="28" rx="14" fill="#000"/>
  </mask>
  <rect width="512" height="512" fill="${background}"/>
  <rect x="112" y="104" width="288" height="304" rx="44" fill="${glyph}" mask="url(#cutout)"/>
</svg>
`;
const icons = {
  "plugin/assets/icon.svg": icon("white", "black"),
  "plugin/assets/icon-dark.svg": icon("black", "white"),
};

export function createCodexAppPlugin({
  home = process.env.TASKNBOARD_USER_HOME,
  runtimeFile = process.env.TASKNBOARD_RUNTIME_FILE,
  credentialHelper = process.env.TASKNBOARD_CREDENTIAL_HELPER,
  resources = process.env.TASKNBOARD_RESOURCES,
  nodeExecutable = process.execPath,
  bridgeEntry = resources ? join(resources, "mcp-bridge.mjs") : undefined,
  platform = process.platform,
  searchPath,
  environment = () => userEnvironment({ platform, home }),
  run = exec,
} = {}) {
  let installing = false;
  let resolvedPath;
  async function invoke(args) {
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
  }

  async function install() {
    if (
      !home ||
      ![runtimeFile, credentialHelper, nodeExecutable, bridgeEntry].every(
        (value) => typeof value === "string" && isAbsolute(value),
      )
    )
      throw failure(
        "PLUGIN_UNSUPPORTED",
        "Install the Codex app plugin from TasknBoard Settings.",
      );
    if (installing)
      throw failure(
        "PLUGIN_BUSY",
        "A Codex plugin install is already in progress.",
        409,
      );
    installing = true;
    try {
      const mcp = {
        mcpServers: {
          tasknboard_app: {
            command: nodeExecutable,
            args: ["--disable-warning=ExperimentalWarning", bridgeEntry],
            env: {
              TASKNBOARD_RUNTIME_FILE: runtimeFile,
              TASKNBOARD_CREDENTIAL_HELPER: credentialHelper,
            },
          },
        },
      };
      const fingerprint = hash(JSON.stringify({ mcp, icons }));
      const marketplace = `tasknboard-app-${fingerprint}`;
      const directory = join(home, ".tasknboard", "codex-app", fingerprint);
      const files = {
        ".agents/plugins/marketplace.json": {
          name: marketplace,
          interface: { displayName: "TasknBoard" },
          plugins: [
            {
              name: "tasknboard-app",
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
          name: "tasknboard-app",
          version: `0.1.0-${fingerprint}`,
          description: "Open your local TasknBoard workspace inside Codex.",
          author: { name: "TasknBoard" },
          mcpServers: "./.mcp.json",
          interface: {
            displayName: "TasknBoard",
            shortDescription: "Open your TasknBoard workspace.",
            developerName: "TasknBoard",
            category: "Productivity",
            brandColor: "#9DE3C1",
            composerIcon: "./assets/icon.svg",
            logo: "./assets/icon.svg",
            logoDark: "./assets/icon-dark.svg",
          },
        },
        "plugin/.mcp.json": mcp,
        ...icons,
      };
      // Immutable, content-addressed files make retries safe without overwriting user edits.
      for (const [name, value] of Object.entries(files)) {
        const file = join(directory, name);
        await mkdir(join(file, ".."), { recursive: true });
        const content =
          typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
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
      await mkdir(join(home, ".codex"), { recursive: true });
      await invoke(["plugin", "marketplace", "add", directory, "--json"]);
      const pluginId = `tasknboard-app@${marketplace}`;
      const listing = JSON.parse(
        (await invoke(["plugin", "list", "--json"])).stdout,
      );
      const existing = listing.installed?.find(
        (plugin) => plugin.pluginId === pluginId,
      );
      if (!existing?.installed || !existing.enabled)
        await invoke(["plugin", "add", pluginId, "--json"]);
      return { installed: true, marketplace, pluginId, path: directory };
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
  async function status(pluginId) {
    if (!pluginId) return { installed: false, enabled: false };
    try {
      const listing = JSON.parse(
        (await invoke(["plugin", "list", "--json"])).stdout,
      );
      const plugin = listing.installed?.find(
        (entry) => entry.pluginId === pluginId,
      );
      return {
        installed: Boolean(plugin?.installed),
        enabled: Boolean(plugin?.enabled),
        pluginId,
      };
    } catch {
      return {
        installed: false,
        enabled: false,
        error: "Codex plugin status is unavailable.",
      };
    }
  }
  return { install, status };
}
