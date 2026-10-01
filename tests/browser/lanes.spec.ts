import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const key = () => randomUUID().slice(0, 8);

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
const editBoard = async (page: Page) => {
  await page.getByRole("group", { name: "Board actions" }).getByRole("button", { name: "Edit board" }).click();
  return page.getByRole("dialog", { name: "Edit board" });
};
const column = (page: Page, name: string) =>
  page.locator("section.column", { has: page.getByRole("heading", { level: 2, name, exact: true }) });

test("a person adds a lane, moves a task through it, and deletes it into another lane", async ({ page }) => {
  const task = await command("create_task", { boardId: "BOARD-1", title: `Lane ${key()}` });
  await connect(page);
  await page.getByRole("searchbox").fill(task.id);

  // A task in a todo lane cannot go to a done lane before review.
  const status = page.getByLabel(`Status of ${task.id}`);
  await expect(status.locator("option", { hasText: "Done (after review)" })).toHaveJSProperty("disabled", true);

  let dialog = await editBoard(page);
  // The only lane of a role cannot be deleted.
  await expect(dialog.getByRole("button", { name: "Delete Backlog" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "New lane name" }).fill("Testing");
  await dialog.getByRole("combobox", { name: "New lane role" }).selectOption({ label: "In progress" });
  await dialog.getByRole("button", { name: "Add lane" }).click();
  await expect(dialog.getByRole("textbox", { name: "Name of Testing" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await expect(column(page, "Testing")).toBeVisible();
  await status.selectOption({ label: "Testing" });
  await expect(page.getByRole("status").filter({ hasText: `Moved ${task.id}` })).toBeVisible();
  await expect(column(page, "Testing").locator(".task-card")).toHaveCount(1);
  const testing = (await command("get_task", { id: task.id })).lane;
  expect(testing).not.toBe("LANE-2");

  dialog = await editBoard(page);
  await dialog.getByRole("button", { name: "Delete Testing" }).click();
  const confirm = dialog.getByRole("alertdialog", { name: "Delete Testing" });
  await expect(confirm).toContainText("Delete Testing and move its 1 task to");
  await confirm.getByRole("combobox", { name: "Move tasks to" }).selectOption({ label: "In progress" });
  await confirm.getByRole("button", { name: "Delete lane" }).click();
  await expect(dialog.getByRole("textbox", { name: "Name of Testing" })).toBeHidden();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(column(page, "Testing")).toHaveCount(0);
  await expect(page.locator('section[aria-labelledby="column-LANE-2"] .task-card')).toHaveCount(1);
  const moved = await command("get_task", { id: task.id });
  expect([moved.lane, moved.role]).toEqual(["LANE-2", "in_progress"]);
  // The activity names the lane that received the task.
  await page.getByRole("button", { name: new RegExp(`^${task.id}: `) }).click();
  await expect(page.getByRole("region", { name: /Task details/ })).toContainText(
    "Moved from a deleted lane to In progress",
  );
});
