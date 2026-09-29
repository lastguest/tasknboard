import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const failure = (code, message) =>
  Object.assign(new Error(message), {
    code,
    status: code === "CLI_CONFLICT" ? 409 : 400,
  });
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const batchQuote = (value) => {
  if (/[\r\n"!]/.test(value))
    throw failure(
      "CLI_PATH",
      "The helper path contains unsupported Windows characters.",
    );
  return `"${value.replaceAll("%", "%%")}"`;
};

export function createCliHelper({
  desktop = process.env.TASKNBOARD_DESKTOP === "1",
  home = process.env.TASKNBOARD_USER_HOME,
  resources = process.env.TASKNBOARD_RESOURCES,
  database = process.env.TASKNBOARD_DB,
  searchPath = process.env.PATH || "",
  platform = process.platform,
} = {}) {
  const supported =
    desktop &&
    ["darwin", "win32"].includes(platform) &&
    Boolean(home && resources && database);
  const windows = platform === "win32";
  const directory = supported ? join(home, ".local", "bin") : null;
  const path = directory
    ? join(directory, windows ? "tasknboard.cmd" : "tasknboard")
    : null;
  const node = resources && join(resources, windows ? "node.exe" : "node");
  const cli = resources && join(resources, "cli.mjs");
  function launcher() {
    if (windows)
      return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%P in ('chcp') do set "tasknboardCodePage=%%P"\r\nchcp 65001 >nul\r\nif not defined TASKNBOARD_DB if not defined TASKNBOARD_SERVER_URL set ${batchQuote(`TASKNBOARD_DB=${database}`)}\r\n${batchQuote(node)} --disable-warning=ExperimentalWarning ${batchQuote(cli)} %*\r\nset "tasknboardExit=%errorlevel%"\r\nchcp %tasknboardCodePage% >nul\r\nexit /b %tasknboardExit%\r\n`;
    return `#!/bin/sh\n# TasknBoard CLI helper\nif [ -z "\${TASKNBOARD_DB:-}" ] && [ -z "\${TASKNBOARD_SERVER_URL:-}" ]; then\n  export TASKNBOARD_DB=${shellQuote(database)}\nfi\nexec ${shellQuote(node)} --disable-warning=ExperimentalWarning ${shellQuote(cli)} "$@"\n`;
  }
  async function exists(file) {
    try {
      return await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function onPath() {
    for (const entry of searchPath
      .split(windows ? ";" : delimiter)
      .filter(Boolean)) {
      const candidates = windows
        ? [
            "tasknboard.com",
            "tasknboard.exe",
            "tasknboard.bat",
            "tasknboard.cmd",
          ]
        : ["tasknboard"];
      for (const name of candidates) {
        const candidate = join(entry, name);
        try {
          await access(candidate, windows ? constants.F_OK : constants.X_OK);
          return windows
            ? resolve(candidate).toLowerCase() === resolve(path).toLowerCase()
            : resolve(candidate) === resolve(path);
        } catch (error) {
          if (!["ENOENT", "EACCES"].includes(error.code)) throw error;
        }
      }
    }
    return false;
  }
  async function status() {
    if (!supported)
      return {
        supported: false,
        installed: false,
        path: null,
        onPath: false,
        instruction: null,
      };
    const stat = await exists(path);
    const installed = Boolean(
      stat?.isFile() &&
      !stat.isSymbolicLink() &&
      (windows || stat.mode & 0o111) &&
      (await readFile(path, "utf8")) === launcher(),
    );
    const available = installed && (await onPath());
    return {
      supported: true,
      installed,
      path,
      onPath: available,
      instruction:
        stat && !installed
          ? `A different file exists at ${path}. Move it before installing the helper.`
          : !available
            ? windows
              ? `Add ${directory} to your user Path in Windows Environment Variables, then open a new terminal. This check uses the desktop app’s PATH; restart the app to refresh it. You can also run the full helper path.`
              : `Add ${shellQuote(directory)} to your shell PATH, then open a new terminal. This check uses the desktop app’s PATH, which can differ from your terminal. For this terminal, run: export PATH=${shellQuote(directory)}:"$PATH". You can also run the full helper path.`
            : null,
    };
  }
  async function install() {
    if (!supported)
      throw failure(
        "CLI_UNSUPPORTED",
        "Install the helper from the desktop app on macOS or Windows.",
      );
    await access(node, windows ? constants.F_OK : constants.X_OK);
    await access(cli, constants.R_OK);
    const current = await status();
    if (current.installed) return current;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(path, launcher(), { flag: "wx", mode: 0o755 });
    } catch (error) {
      if (error.code === "EEXIST")
        throw failure(
          "CLI_CONFLICT",
          `A file already exists at ${path}. Move it before installing the helper.`,
        );
      throw error;
    }
    return status();
  }
  const report = (action) => async () => {
    try {
      return await action();
    } catch (error) {
      if (error.status) throw error;
      throw failure(
        "CLI_IO",
        `Could not access the CLI helper files: ${error.message}`,
      );
    }
  };
  return { status: report(status), install: report(install) };
}
