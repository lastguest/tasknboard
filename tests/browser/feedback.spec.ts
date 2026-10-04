import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const baseURL = process.env.TASKNBOARD_BASE_URL!;

async function command(name: string, args: object) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${humanToken}` },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  expect(response.ok, `${name}: ${JSON.stringify(body)}`).toBeTruthy();
  return body;
}

test("review changes require a reason and delegation stays visible", async ({ page }) => {
  const title = `Feedback ${randomUUID().slice(0, 8)}`;
  const boards = await command("list_boards", {});
  const lane = boards.boards.find((board: any) => board.id === "BOARD-1").lanes.find((lane: any) => lane.role === "in_progress").id;
  const task = await command("create_task", { boardId: "BOARD-1", title, lane });
  const reviewed = await command("submit_review", { id: task.id, expectedVersion: task.version, summary: "Review evidence", artifactUrl: "tasks/T005.result.md" });
  await command("link_commits", { id: task.id, expectedVersion: reviewed.version, commits: ["a123456789abcdef"] });
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".workspace-status .identity")).toContainText("reviewer");
  await page.getByRole("button", { name: new RegExp(`^${task.id}: ${title}`) }).click();
  const details = page.getByRole("region", { name: /Task details/ });
  await expect(details).toContainText("tasks/T005.result.md");
  await expect(details.getByRole("region", { name: "Commits", exact: true })).toContainText("a123456789abcdef");
  await details.getByRole("button", { name: "Request changes", exact: true }).click();
  const send = details.getByRole("button", { name: "Send to In progress" });
  await expect(send).toBeDisabled();
  await details.getByLabel("Reason for changes").fill("Fix the missing acceptance evidence.");
  await send.click();
  await expect(details.getByLabel("Reason for changes")).toHaveCount(0);
  const changed = await command("get_task", { id: task.id });
  expect(changed.role).toBe("in_progress");
  expect(changed.events.some((event: any) => event.kind === "request_changes" && event.body.includes("Fix the missing acceptance evidence."))).toBe(true);
  await details.getByLabel("Delegate to", { exact: true }).fill("codex/cli");
  await details.getByRole("button", { name: "Delegate work" }).click();
  await expect(details).toContainText("No lease renewal is required.");
  await page.reload();
  await expect(page.locator(".claim-chip").filter({ hasText: "Delegated to codex/cli" })).toBeVisible();
});

test("board settings save the reasoning effort and sandbox", async ({ page }) => {
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), humanToken);
  await page.goto(baseURL);
  await page.getByRole("group", { name: "Board actions" }).getByRole("button", { name: "Edit board" }).click();
  const editor = page.getByRole("dialog", { name: "Edit board" });
  await expect(editor.getByLabel("Agent sandbox")).toHaveValue("workspace-write");
  await editor.getByLabel("Agent reasoning").selectOption("high");
  await editor.getByLabel("Agent sandbox").selectOption("read-only");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor).toBeHidden();
  const boards = await command("list_boards", {});
  const board = boards.boards.find((board: any) => board.id === "BOARD-1");
  expect(board.agentReasoning).toBe("high");
  expect(board.agentSandbox).toBe("read-only");
});
