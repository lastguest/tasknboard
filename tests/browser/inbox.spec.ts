import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;

async function command(name: string, args: object = {}, token = humanToken) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  expect(response.ok, `${name}: ${body.code || response.status}`).toBeTruthy();
  return body;
}
async function connect(page: Page) {
  await page.addInitScript((value) => sessionStorage.setItem("tasknboard-token", value), humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
}
const inboxNav = (page: Page) =>
  page.locator(".sidebar").getByRole("button", { name: /^Inbox(?:\s|$)/ });

test("Inbox shows unread work, opens its task, and Mark all read clears the badge", async ({ page }) => {
  const title = `Inbox ${randomUUID().slice(0, 8)}`;
  let task = await command("create_task", { boardId: "BOARD-1", title });
  // The agent mentions the reviewer, then hands the work over for review.
  task = await command("add_comment", { id: task.id, expectedVersion: task.version, body: "Question for @reviewer" }, agentToken);
  task = await command("claim_task", { id: task.id, expectedVersion: task.version }, agentToken);
  await command("submit_review", { id: task.id, expectedVersion: task.version, summary: "Done, please check" }, agentToken);

  await connect(page);
  const badge = inboxNav(page).locator(".nav-badge");
  await expect(badge).toBeVisible();
  await inboxNav(page).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  const rows = page.locator(".inbox-row").filter({ hasText: task.id });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("submitted for review");
  await expect(rows.first()).toContainText("Done, please check");
  await expect(rows.nth(1)).toContainText("mentioned you on");
  // Opening the page does not mark anything read.
  await expect(rows.first()).toHaveClass(/unread/);
  await expect(badge).toBeVisible();

  await rows.first().getByRole("button").click();
  await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveAttribute("aria-current", "page");
  await expect(badge).toBeVisible();

  await inboxNav(page).click();
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(badge).toHaveCount(0);
  await expect(page.locator(".inbox-row.unread")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark all read" })).toBeDisabled();
});
