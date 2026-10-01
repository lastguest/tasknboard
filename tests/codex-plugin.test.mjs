import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexPlugin } from "../server/codex-plugin.mjs";

async function fixture(t, run) {
  const home = await mkdtemp(join(tmpdir(), "tnb-codex-'"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, process.platform === "win32" ? "codex.exe" : "codex"),
    "",
    { mode: 0o755 },
  );
  return {
    home,
    options: {
      desktop: true,
      home,
      database: join(home, "tasks.sqlite"),
      mcpEntry: "/App's folder/mcp.mjs",
      searchPath: bin,
      run,
    },
  };
}

test("plugin installs active runtime and identity, retries safely, and preserves changed files", async (t) => {
  const calls = [];
  const { home, options } = await fixture(t, async (...args) => {
    calls.push(args);
    return { stdout: "{}" };
  });
  const plugin = createCodexPlugin(options);
  const result = await plugin.install("codex-2");
  assert.equal(result.installed, true);
  const directory = calls[0][1][3];
  const config = JSON.parse(
    await readFile(join(directory, "plugin/.mcp.json")),
  );
  assert.deepEqual(config.mcpServers.tasknboard, {
    command: process.execPath,
    args: [options.mcpEntry],
    env: {
      TASKNBOARD_DB: options.database,
      TASKNBOARD_AGENT_ID: "codex-2",
      TASKNBOARD_SERVER_URL: "",
      TASKNBOARD_TOKEN: "",
    },
  });
  assert.deepEqual(calls[1][1], [
    "plugin",
    "add",
    `tasknboard@${result.marketplace}`,
    "--json",
  ]);
  assert.equal(calls[0][2].env.HOME, home);
  assert.deepEqual(await plugin.install("codex-2"), result);
  await writeFile(join(directory, "plugin/.mcp.json"), "user edit");
  await assert.rejects(plugin.install("codex-2"), { code: "PLUGIN_CONFLICT" });
  assert.equal(calls.length, 4);
});

test("plugin rejects unsupported hosts, invalid identities, missing CLI, and failed installs", async (t) => {
  await assert.rejects(createCodexPlugin({ desktop: false }).install("codex"), {
    code: "PLUGIN_UNSUPPORTED",
  });
  const { options } = await fixture(t, async () => {
    throw new Error("CLI exited 1");
  });
  const plugin = createCodexPlugin(options);
  await assert.rejects(plugin.install("../codex"), { code: "PLUGIN_IDENTITY" });
  await assert.rejects(
    createCodexPlugin({ ...options, searchPath: "" }).install("codex"),
    { code: "CODEX_MISSING" },
  );
  await assert.rejects(plugin.install("codex"), { code: "PLUGIN_INSTALL" });
});

test("concurrent installs cannot race Codex configuration writes", async (t) => {
  let complete;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const { options } = await fixture(t, async () => {
    if (++calls > 1) return;
    entered();
    await new Promise((resolve) => {
      complete = resolve;
    });
  });
  const plugin = createCodexPlugin(options);
  const pending = plugin.install("codex");
  await ready;
  await assert.rejects(plugin.install("codex-2"), { code: "PLUGIN_BUSY" });
  complete();
  await pending;
});
