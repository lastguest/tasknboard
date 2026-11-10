import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAppPlugin } from "../server/codex-app-plugin.mjs";

async function fixture(t, run) {
  const home = await mkdtemp(join(tmpdir(), "tnb-codex-app-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, process.platform === "win32" ? "codex.exe" : "codex"), "", { mode: 0o755 });
  return { home, searchPath: bin, run, runtimeFile: join(home, "runtime.json"), credentialHelper: join(bin, "TasknBoard"), bridgeEntry: join(home, "mcp-bridge.mjs") };
}

test("local app plugin discovers the resident at connection time and contains no credentials", async (t) => {
  const calls = [];
  let installed;
  const options = await fixture(t, async (...args) => {
    calls.push(args);
    if (args[1][1] === "add") installed = args[1][2];
    return { stdout: JSON.stringify({ installed: installed ? [{ pluginId: installed, installed: true, enabled: true }] : [] }) };
  });
  const plugin = createCodexAppPlugin(options);
  const result = await plugin.install();
  assert.equal(result.installed, true);
  const mcp = JSON.parse(await readFile(join(result.path, "plugin/.mcp.json"), "utf8"));
  const server = mcp.mcpServers.tasknboard_app;
  assert.equal(server.command, process.execPath);
  assert.equal(server.args.at(-1), options.bridgeEntry);
  assert.deepEqual(server.env, { TASKNBOARD_RUNTIME_FILE: options.runtimeFile, TASKNBOARD_CREDENTIAL_HELPER: options.credentialHelper });
  const manifest = JSON.parse(await readFile(join(result.path, "plugin/.codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "tasknboard-app");
  assert.equal(manifest.interface.displayName, "TasknBoard");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  for (const field of ["composerIcon", "logo", "logoDark"]) {
    const svg = await readFile(join(result.path, "plugin", manifest.interface[field]), "utf8");
    assert.match(svg, /^<svg [^>]*viewBox="0 0 512 512"/);
  }
  await assert.rejects(access(join(result.path, "plugin/.app.json")), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify({ manifest, mcp }), /127\.0\.0\.1|localhost|bearer_token|TASKNBOARD_TOKEN|tunnel_|asdk_app_|runtimeKey/);
  assert.deepEqual(calls[2][1], ["plugin", "add", result.pluginId, "--json"]);
  assert.equal(calls[0][2].env.CODEX_HOME, join(options.home, ".codex"));
  assert.equal(calls[0][2].env.TASKNBOARD_TOKEN, undefined);
  assert.deepEqual(await plugin.install(), result);
  assert.equal(calls.filter(call => call[1][1] === "add").length, 1);
  assert.deepEqual(await plugin.status(result.pluginId), { installed: true, enabled: true, pluginId: result.pluginId });
  await writeFile(join(result.path, "plugin/.mcp.json"), "user edit");
  await assert.rejects(plugin.install(), { code: "PLUGIN_CONFLICT" });
});

test("local app install reports unsupported setup, missing CLI and failed CLI without secrets", async (t) => {
  const options = await fixture(t, async () => { throw new Error("private diagnostic"); });
  await assert.rejects(createCodexAppPlugin({ ...options, credentialHelper: undefined }).install(), { code: "PLUGIN_UNSUPPORTED" });
  await assert.rejects(createCodexAppPlugin({ ...options, searchPath: "" }).install(), { code: "CODEX_MISSING" });
  const plugin = createCodexAppPlugin(options);
  await assert.rejects(plugin.install(), { code: "PLUGIN_INSTALL" });
  assert.deepEqual(await plugin.status("tasknboard-app@test"), { installed: false, enabled: false, error: "Codex plugin status is unavailable." });
});

test("desktop app installation uses the user's shell PATH without copying shell credentials", async (t) => {
  const calls = [];
  const options = await fixture(t, async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ installed: [] }) };
  });
  let reads = 0;
  const plugin = createCodexAppPlugin({
    ...options,
    searchPath: undefined,
    environment: async () => {
      reads++;
      return { PATH: options.searchPath, TASKNBOARD_TOKEN: "shell-private-token" };
    },
  });
  const result = await plugin.install();
  await plugin.status(result.pluginId);
  assert.equal(reads, 1);
  assert.equal(calls.length, 4);
  for (const [executable, , config] of calls) {
    assert.equal(executable, join(options.searchPath, process.platform === "win32" ? "codex.exe" : "codex"));
    assert.equal(config.env.PATH, options.searchPath);
    assert.equal(config.env.TASKNBOARD_TOKEN, undefined);
  }
});
