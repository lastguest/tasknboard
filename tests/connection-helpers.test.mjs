import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("client commands preserve literal paths and separate agent identities", () => {
  for (const client of ["codex", "claude"]) {
    const helper = connectionHelper(client, runtime, client);
    // "sh" from PATH: Windows runners have it from Git for Windows.
    const output = execFileSync(
      "sh",
      ["-c", `${client}() { printf '%s\\0' "$@"; }; ${helper.text}`],
      { encoding: "utf8" },
    );
    const args = output.split("\0").slice(0, -1);
    assert.deepEqual(args.slice(0, 3), ["mcp", "add", "tasknboard"]);
    assert.deepEqual(args.slice(-3), ["--", entry.command, ...entry.args]);
    assert.ok(args.includes(`TASKNBOARD_DB=${entry.env.TASKNBOARD_DB}`));
    assert.ok(args.includes(`TASKNBOARD_AGENT_ID=${client}`));
    assert.ok(args.includes("TASKNBOARD_SERVER_URL="));
    assert.ok(args.includes("TASKNBOARD_TOKEN="));
  }
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
  assert.match(connectionHelper("codex", windows, "codex").text, /Stefano''s/);
  const pi = connectionHelper("pi", windows, "pi").text;
  assert.ok(pi.includes("$env:TASKNBOARD_AGENT_ID = 'pi';"));
  assert.ok(pi.includes("& '/Apps/Stefano''s $(false)/node'"));
});

test("incomplete runtime configuration is rejected instead of crashing the helper", () => {
  assert.equal(isMcpStatus(runtime), true);
  assert.equal(isMcpStatus({ mode: "shared" }), true);
  assert.equal(isMcpStatus({ ...runtime, cli: undefined }), false);
  assert.equal(isMcpStatus({ ...runtime, config: {} }), false);
});
