import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudePlugin } from "../server/claude-plugin.mjs";

async function fixture(t, run) {
  const home = await mkdtemp(join(tmpdir(), "tnb-claude-'"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, process.platform === "win32" ? "claude.exe" : "claude"),
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
    return {
      stdout: JSON.stringify([
        { id: calls[2]?.[1][2], enabled: true, scope: "user" },
      ]),
    };
  });
  const plugin = createClaudePlugin(options);
  const result = await plugin.install("claude-2");
  assert.equal(result.installed, true);
  const directory = calls[1][1][3];
  const config = JSON.parse(
    await readFile(join(directory, "plugin/.mcp.json")),
  );
  assert.deepEqual(config.mcpServers.tasknboard, {
    command: process.execPath,
    args: [options.mcpEntry],
    env: {
      TASKNBOARD_DB: options.database,
      TASKNBOARD_AGENT_ID: "claude-2",
      TASKNBOARD_SERVER_URL: "",
      TASKNBOARD_TOKEN: "",
    },
  });
  assert.deepEqual(calls[2][1], [
    "plugin",
    "install",
    `tasknboard@${result.marketplace}`,
    "--scope",
    "user",
  ]);
  assert.equal(calls[0][2].env.CLAUDE_CONFIG_DIR, join(home, ".claude"));
  assert.deepEqual(await plugin.install("claude-2"), result);
  await writeFile(join(directory, "plugin/.mcp.json"), "user edit");
  await assert.rejects(plugin.install("claude-2"), { code: "PLUGIN_CONFLICT" });
  assert.equal(calls.length, 8);
});

test("plugin rejects unsupported hosts, invalid identities, missing CLI, and failed installs", async (t) => {
  await assert.rejects(
    createClaudePlugin({ desktop: false }).install("claude"),
    {
      code: "PLUGIN_UNSUPPORTED",
    },
  );
  const { options } = await fixture(t, async () => {
    throw new Error("CLI exited 1");
  });
  const plugin = createClaudePlugin(options);
  await assert.rejects(plugin.install("../claude"), {
    code: "PLUGIN_IDENTITY",
  });
  await assert.rejects(
    createClaudePlugin({ ...options, searchPath: "" }).install("claude"),
    { code: "CLAUDE_MISSING" },
  );
  await assert.rejects(plugin.install("claude"), { code: "PLUGIN_INSTALL" });
});

test("install rejects a missing enabled-plugin read-back", async (t) => {
  const { options } = await fixture(t, async () => ({ stdout: "[]" }));
  await assert.rejects(createClaudePlugin(options).install("claude"), {
    code: "PLUGIN_VERIFY",
  });
});
