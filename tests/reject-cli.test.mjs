import { test } from "node:test";
import assert from "node:assert/strict";
import { planInput, matchCommands } from "../cli/commands.ts";
import { normalizeArguments, requireExpectedVersion } from "../cli/arguments.ts";
import { commandExamples, commandHelp } from "../cli/help.ts";
import { schemas } from "../server/domain.mjs";

const task = { id: "TNB-1", version: 4 };

test("CLI reject action sends the task version and optional reason", () => {
  assert.deepEqual(planInput("/reject No longer needed", task).request, {
    name: "reject_task",
    args: { id: "TNB-1", expectedVersion: 4, reason: "No longer needed" },
  });
  assert.deepEqual(planInput("/reject", task).request, {
    name: "reject_task",
    args: { id: "TNB-1", expectedVersion: 4 },
  });
  assert.throws(() => planInput("/reject"), /Select a task first/);
  assert.ok(matchCommands("/rej").some((command) => command.name === "reject"));
});

test("CLI reject command accepts taskId and explains versioned input", () => {
  assert.deepEqual(normalizeArguments("reject_task", { taskId: "TNB-1", expectedVersion: 4 }), {
    id: "TNB-1", expectedVersion: 4,
  });
  assert.throws(() => normalizeArguments("reject_task", { id: "TNB-1", taskId: "TNB-2" }), { code: "USAGE" });
  assert.throws(() => requireExpectedVersion("reject_task", { id: "TNB-1" }), /expectedVersion is required/);
  assert.equal(schemas.reject_task.safeParse(commandExamples.reject_task).success, true);
  const help = commandHelp("reject_task", "win32");
  assert.match(help, /Optional fields: reason/);
  assert.match(help, /Use id or taskId/);
  assert.match(help, /Read get_task before the mutation/);
});
