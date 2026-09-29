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
const menu = (page: Page) => page.getByRole("menu");

test("Task context menu changes status, priority and assignee, and filters", async ({ page }) => {
  const task = await command("create_task", { boardId: "BOARD-1", title: `Menu ${key()}`, assignee: "Helpful bot" });
  await connect(page);
  await page.getByRole("searchbox").fill(task.id);
  const card = page.locator(".task-card");

  await card.click({ button: "right" });
  await expect(menu(page)).toHaveAccessibleName(`Actions for ${task.id}`);
  await expect(menu(page).getByRole("menuitemradio", { name: "Backlog" })).toHaveAttribute("aria-checked", "true");
  await expect(menu(page).getByRole("menuitemradio", { name: "Done (after review)" })).toBeDisabled();
  await menu(page).getByRole("menuitemradio", { name: "In progress" }).click();
  await expect(menu(page)).toBeHidden();
  await expect(page.locator("#column-in_progress + .count")).toHaveText("1");

  await card.click({ button: "right" });
  await menu(page).getByRole("menuitemradio", { name: "High" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Priority is now High." })).toBeVisible();
  await card.click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Assign to me" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Assigned to reviewer." })).toBeVisible();
  const saved = await command("get_task", { id: task.id });
  expect([saved.status, saved.priority, saved.assignee]).toEqual(["in_progress", "high", "reviewer"]);

  await card.click({ button: "right" });
  await menu(page).getByRole("menuitemradio", { name: "Show only reviewer" }).click();
  await expect(page.getByRole("button", { name: "reviewer", pressed: true })).toBeVisible();

  // Pointer presses outside the menu close it; text fields keep the browser menu.
  await card.click({ button: "right" });
  await page.locator(".page-title h1").click();
  await expect(menu(page)).toBeHidden();
  await page.getByRole("searchbox").click({ button: "right" });
  await expect(menu(page)).toBeHidden();
});

test("Keyboard opens the menu, archive asks first, and the page menu switches layout", async ({ page }) => {
  const task = await command("create_task", { boardId: "BOARD-1", title: `Menu keys ${key()}` });
  await connect(page);
  await page.getByRole("searchbox").fill(task.id);
  const open = page.getByRole("button", { name: new RegExp(`^${task.id}:`) });

  await open.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page).getByRole("menuitem", { name: "Open details" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu(page).getByRole("menuitem", { name: "Archive" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(open).toBeFocused();

  await page.keyboard.press("Shift+F10");
  await menu(page).getByRole("menuitem", { name: "Archive" }).click();
  await expect(menu(page).getByRole("menuitem", { name: `Confirm archive of ${task.id}` })).toBeVisible();
  await menu(page).getByRole("menuitem", { name: `Confirm archive of ${task.id}` }).click();
  await expect(page.getByRole("status").filter({ hasText: `Archived ${task.id}` })).toBeVisible();
  await expect(page.locator(".task-card")).toHaveCount(0);

  await page.locator(".empty-state").click({ button: "right" });
  await menu(page).getByRole("menuitemradio", { name: "List" }).click();
  await expect(page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".empty-state").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Clear filters" }).click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
});

test("Epic context menu starts a task inside the epic", async ({ page }) => {
  const epic = await command("create_epic", { title: `Menu epic ${key()}` });
  await connect(page);
  const item = page.locator(".nav-epics").getByRole("button", { name: new RegExp(`^${epic.title}`) });
  // Menus close on scroll, so the sidebar must finish scrolling to the epic first.
  await item.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await item.click({ button: "right" });
  await expect(menu(page)).toHaveAccessibleName(`Actions for ${epic.id}`);
  await menu(page).getByRole("menuitem", { name: "New task in this epic" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog.getByRole("button", { name: `Epic: ${epic.title}. Choose epic` })).toBeVisible();
});
