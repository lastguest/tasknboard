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
      resources: join(home, "resources"),
      runtimeFile: join(home, "runtime.json"),
      credentialHelper: join(home, "native-helper"),
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
    type: "stdio",
    command: process.execPath,
    args: [
      "--disable-warning=ExperimentalWarning",
      join(options.resources, "mcp-bridge.mjs"),
      "--agent",
      "claude-2",
    ],
    env: {
      TASKNBOARD_RUNTIME_FILE: options.runtimeFile,
      TASKNBOARD_CREDENTIAL_HELPER: options.credentialHelper,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(config),
    /TASKNBOARD_DB|TASKNBOARD_TOKEN|http:\/\//,
  );
  assert.equal(calls[0][2].env.TASKNBOARD_TOKEN, undefined);
  assert.deepEqual(calls[2][1], [
    "plugin",
    "install",
    `tasknboard@${result.marketplace}`,
    "--scope",
    "user",
  ]);
  assert.equal(calls[0][2].env.HOME, home);
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

test("plugin requires absolute resident paths", async (t) => {
  const { options } = await fixture(t, async () => assert.fail("CLI called"));
  await assert.rejects(
    createClaudePlugin({ ...options, runtimeFile: "relative.json" }).install(
      "bot",
    ),
    { code: "PLUGIN_UNSUPPORTED" },
  );
});

test("Claude install uses the account's PATH and configuration", async (t) => {
  const calls = [];
  const { home, options } = await fixture(t, async (...args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify([
        { id: calls[2]?.[1][2], enabled: true, scope: "user" },
      ]),
    };
  });
  const config = join(home, "custom-claude-config");
  await createClaudePlugin({
    ...options,
    searchPath: undefined,
    environment: async () => ({
      PATH: options.searchPath,
      CLAUDE_CONFIG_DIR: config,
      TASKNBOARD_TOKEN: "service-secret",
    }),
  }).install("bot");
  assert.equal(calls[0][2].env.CLAUDE_CONFIG_DIR, config);
  assert.equal(calls[0][2].env.PATH, options.searchPath);
  assert.equal(calls[0][2].env.TASKNBOARD_TOKEN, undefined);
});
