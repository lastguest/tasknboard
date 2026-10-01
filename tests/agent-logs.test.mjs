import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentLogs, logReadLimit, readableLog } from "../server/agent-logs.mjs";

test("Claude Code's stream-json log reads as steps; plain logs stay as written", () => {
  const lines = [
    { type: "system", subtype: "init", model: "claude-opus-5-5" },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading the task." }] } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "mcp__tasknboard__get_task", input: { id: "TNB-1" } },
          { type: "tool_use", name: "Bash", input: { command: "npm test", description: "Run the tests" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: "ok\n85 passed" },
          { type: "tool_result", is_error: true, content: [{ type: "text", text: "exit 1" }] },
        ],
      },
    },
    { type: "result", is_error: false, result: "Submitted for review." },
  ].map((line) => JSON.stringify(line));
  assert.equal(
    readableLog(lines.join("\n")),
    [
      "▸ Session started with claude-opus-5-5",
      "",
      "Reading the task.",
      "",
      '→ get_task: {"id":"TNB-1"}',
      "→ Bash: Run the tests",
      "  ← ok 85 passed",
      "  ✗ exit 1",
      "",
      "■ Finished: Submitted for review.",
    ].join("\n"),
  );
  assert.equal(readableLog("OpenAI Codex v1\n{not json\nERROR: boom\n"), "OpenAI Codex v1\n{not json\nERROR: boom");
});

test("logs are listed per task, newest first, and only listed files can be read", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "tnb-logs-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, ".tasknboard", "logs");
  await mkdir(join(root, "claude"), { recursive: true });
  await mkdir(join(root, "codex"));
  const older = "TNB-1-2026-10-01T09-00-00.000Z.log";
  const newer = "TNB-1-2026-10-01T10-00-00.000Z.log";
  await writeFile(join(root, "claude", older), "first run\n");
  await writeFile(join(root, "codex", newer), "second run\n");
  await writeFile(join(root, "claude", "TNB-12-2026-10-01T11-00-00.000Z.log"), "other task\n");
  await writeFile(join(root, "claude", "notes.txt"), "not a log\n");
  const logs = createAgentLogs({ home, running: () => new Set([join(root, "codex", newer)]) });

  const runs = await logs.list("TNB-1");
  assert.deepEqual(
    runs.map((r) => [r.identity, r.file, r.startedAt, r.running]),
    [
      ["codex", newer, "2026-10-01T10:00:00.000Z", true],
      ["claude", older, "2026-10-01T09:00:00.000Z", false],
    ],
  );
  assert.equal((await logs.read("TNB-1", "claude", older)).text, "first run");
  for (const [identity, file] of [
    ["claude", "TNB-12-2026-10-01T11-00-00.000Z.log"],
    ["claude", "notes.txt"],
    ["..", older],
    ["claude", `../codex/${newer}`],
  ])
    await assert.rejects(logs.read("TNB-1", identity, file), { code: "NOT_FOUND" });
  await assert.rejects(logs.list("../etc"), { code: "VALIDATION" });
  assert.deepEqual(await createAgentLogs({ home: "" }).list("TNB-1"), []);
});

test("a long log keeps its newest part, from a whole line", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "tnb-logs-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, ".tasknboard", "logs", "pi");
  await mkdir(dir, { recursive: true });
  const file = "TNB-2-2026-10-01T09-00-00.000Z.log";
  const line = "x".repeat(99) + "\n";
  await writeFile(join(dir, file), line.repeat(Math.ceil(logReadLimit / 100) + 50) + "last line\n");
  const log = await createAgentLogs({ home }).read("TNB-2", "pi", file);
  assert.equal(log.truncated, true);
  assert.ok(log.text.endsWith("last line"));
  assert.ok(log.text.split("\n").slice(0, -1).every((l) => l === "x".repeat(99)));
});
