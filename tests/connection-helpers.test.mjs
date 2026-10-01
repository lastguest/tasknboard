import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionHelper, isMcpStatus } from "../src/connection-helpers.ts";

const entry = {
  command: "/Apps/Stefano's $(false)/node",
  args: ["/Apps/Task Board/mcp.mjs"],
  env: { TASKNBOARD_DB: "/Data/Stefano's `db`/workspace.sqlite" },
};
const runtime = {
  mode: "local",
  platform: "darwin",
  config: { mcpServers: { tasknboard: entry } },
  cli: { ...entry, args: ["/Apps/Task Board/cli.mjs"] },
};

test("Codex uses a direct plugin install instead of a standalone MCP command", () => {
  const helper = connectionHelper("codex", runtime, "codex");
  assert.equal(helper.label, "Install Codex plugin");
  assert.equal(helper.text, "");
  assert.match(helper.steps.join(" "), /desktop app/);
});

test("OpenCode gets its native configuration and Pi gets an agent CLI skill", () => {
  const openCode = JSON.parse(
    connectionHelper("opencode", runtime, "opencode-2").text,
  );
  assert.deepEqual(openCode.mcp.tasknboard.command, [
    entry.command,
    ...entry.args,
  ]);
  assert.equal(openCode.mcp.tasknboard.type, "local");
  assert.equal(
    openCode.mcp.tasknboard.environment.TASKNBOARD_AGENT_ID,
    "opencode-2",
  );
  const pi = connectionHelper("pi", runtime, "pi-2");
  assert.match(pi.text, /^---\nname: tasknboard\n/);
  assert.ok(pi.text.includes("/Apps/Task Board/cli.mjs"));
  assert.ok(!pi.text.includes("/mcp.mjs"));
  assert.match(pi.text, /TASKNBOARD_AGENT_ID=pi-2/);
  assert.match(pi.text, /expectedVersion/);
  assert.match(pi.text, /submit_review/);
});

test("Windows commands use PowerShell literal strings and invocation", () => {
  const windows = { ...runtime, platform: "win32" };
  const pi = connectionHelper("pi", windows, "pi");
  assert.ok(pi.text.includes("$env:TASKNBOARD_AGENT_ID = 'pi';"));
  assert.ok(pi.text.includes("& '/Apps/Stefano''s $(false)/node'"));
  assert.match(pi.steps.join(" "), /PowerShell 7\.3 or later/);
  assert.match(pi.text, /PowerShell 7\.3 or later/);
});

test("incomplete runtime configuration is rejected instead of crashing the helper", () => {
  assert.equal(isMcpStatus(runtime), true);
  assert.equal(isMcpStatus({ mode: "shared" }), true);
  assert.equal(isMcpStatus({ ...runtime, cli: undefined }), false);
  assert.equal(isMcpStatus({ ...runtime, config: {} }), false);
});

test("Claude uses the desktop install button instead of a setup script", () => {
  const helper = connectionHelper("claude", runtime, "claude-2");
  assert.equal(helper.label, "Install Claude plugin");
  assert.equal(helper.text, "");
});
