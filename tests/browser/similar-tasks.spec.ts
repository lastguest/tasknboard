import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;

async function command(name: string, args: object = {}) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${humanToken}` },
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

test("A near-duplicate title in the New task dialog shows the existing task", async ({ page }) => {
  const word = randomUUID().replace(/[^a-z]/g, "").slice(0, 8);
  const existing = await command("create_task", {
    boardId: "BOARD-1",
    title: `Export ${word} reports as CSV`,
  });
  await connect(page);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  const duplicates = dialog.getByRole("region", { name: "Possible duplicates" });
  await dialog.getByLabel("Title").fill("Exp");
  await expect(duplicates).toBeHidden();
  await dialog.getByLabel("Title").fill(`Export ${word} report as csv`);
  const match = duplicates.getByRole("link", { name: new RegExp(existing.id) });
  await expect(match).toContainText(existing.title);
  await expect(duplicates).toContainText("Backlog");
  // A warning only: Create stays available. Opening the task asks before the draft goes.
  await expect(dialog.getByRole("button", { name: "Create task" })).toBeEnabled();
  await match.click();
  await dialog.getByRole("button", { name: "Discard" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: /Task details/ })).toContainText(existing.id);
});
