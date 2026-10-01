import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;
const key = () => randomUUID().slice(0, 8);

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
async function addFilter(page: Page, field: string, values: string[]) {
  await page.getByRole("group", { name: "Filters" }).getByRole("button", { name: /Filter|Add filter/ }).click();
  await page.getByRole("dialog", { name: "Add filter" }).getByText(field, { exact: true }).click();
  const picker = page.getByRole("dialog", { name: `${field} filter` });
  for (const value of values) await picker.getByText(value, { exact: true }).click();
  await picker.getByRole("button", { name: "Done" }).click();
  await expect(picker).toBeHidden();
}

test("Views save filters and display, favourite into the sidebar, and delete", async ({ page }) => {
  const label = `View-${key()}`;
  const name = `Mine in ${label}`;
  const mine = await command("create_task", { boardId: "BOARD-1", title: `${label} mine`, assignee: "reviewer", labels: [label] });
  await command("create_task", { boardId: "BOARD-1", title: `${label} theirs`, assignee: "Helpful bot", labels: [label] });
  await connect(page);

  // Filter chips narrow the board; all conditions must hold.
  await addFilter(page, "Label", [label]);
  await expect(page.locator(".task-card")).toHaveCount(2);
  await addFilter(page, "Assignee", ["Me"]);
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Assignee filter" })).toContainText("Me");

  // Flip the operator: "is not" me.
  await page.getByRole("button", { name: /^Assignee is\. Switch to is not/ }).click();
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.locator(".task-card")).toContainText(`${label} theirs`);
  await page.getByRole("button", { name: /^Assignee is not\. Switch to is/ }).click();

  // Save the filtered board as a workspace view.
  await page.getByRole("button", { name: "Save as view" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as view" });
  await expect(dialog.locator(".view-filter-summary")).toContainText(`Label is ${label}`);
  await expect(dialog.locator(".view-filter-summary")).toContainText("Assignee is Me");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByText("Workspace", { exact: true }).click();
  await dialog.getByRole("button", { name: "Create view" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.locator(".breadcrumb")).toContainText("Views");
  await expect(page.locator(".task-card")).toHaveCount(1);

  const view = (await command("list_views")).views.find((v: { name: string }) => v.name === name);
  expect(view.shared).toBe(true);
  // "@me" is resolved for whoever reads the view: the reviewer, then an agent.
  const viewTasks = await command("list_tasks", { view: view.id });
  expect(viewTasks.tasks.map((t: { id: string }) => t.id)).toEqual([mine.id]);
  expect((await command("list_tasks", { view: view.id }, agentToken)).total).toBe(0);

  // Changing display marks the view as changed until it is saved.
  const changes = page.getByRole("region", { name: "Unsaved view changes" });
  await expect(changes).toBeHidden();
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  await expect(changes).toBeVisible();
  await page.getByLabel("Group by").selectOption("priority");
  await expect(page.locator("tbody .group-row")).toHaveCount(1);
  await expect(page.locator("tbody tr:not(.group-row)")).toHaveCount(1);
  await changes.getByRole("button", { name: "Save view" }).click();
  await expect(changes).toBeHidden();
  const saved = (await command("list_views")).views.find((v: { id: string }) => v.id === view.id);
  expect(saved.display).toEqual({ layout: "list", groupBy: "priority", orderBy: "created" });
  expect(saved.version).toBe(2);

  // Reset brings back the saved settings.
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Board" }).click();
  await expect(changes).toBeVisible();
  await changes.getByRole("button", { name: "Reset" }).click();
  await expect(changes).toBeHidden();
  await expect(page.locator("tbody tr:not(.group-row)")).toHaveCount(1);

  // A favourite appears in the sidebar and opens the view.
  await page.locator(".page-title").getByRole("button", { name: `Favorite ${name}` }).click();
  const favorites = page.getByRole("navigation", { name: "Favorites" });
  await expect(favorites.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();

  // Leaving a view drops its filters.
  await page.getByRole("navigation", { name: "Boards" }).getByRole("group", { name: "Default" }).getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("group", { name: "Filters" }).locator(".filter-chip")).toHaveCount(0);
  await favorites.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.locator("tbody tr:not(.group-row)")).toHaveCount(1);

  // The Views page lists it; deleting it removes it for everyone.
  await page.getByRole("navigation", { name: "Boards" }).getByRole("group", { name: "Default" }).getByRole("button", { name: "Views", exact: true }).click();
  await expect(page.locator(".view-row").filter({ hasText: name })).toContainText("1 tasks");
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "Edit view" }).click();
  const edit = page.getByRole("dialog", { name: /Edit view/ });
  await edit.getByRole("button", { name: "Delete view…" }).click();
  await edit.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Views");
  await expect(favorites).toBeHidden();
  expect((await command("list_views")).views.some((v: { id: string }) => v.id === view.id)).toBe(false);
});

test("A view from My tasks keeps the page scope as an @me condition", async ({ page }) => {
  const title = `Scoped ${key()}`;
  await command("create_task", { boardId: "BOARD-1", title, assignee: "reviewer" });
  await connect(page);
  await page.locator(".sidebar").getByRole("button", { name: /^My tasks/ }).click();
  await page.getByRole("searchbox").fill(title);
  // Shortcuts are ignored while typing, so leave the search field first.
  await page.locator("h1").click();
  await page.keyboard.press("Alt+KeyV");
  const dialog = page.getByRole("dialog", { name: "Save as view" });
  await expect(dialog.locator(".view-filter-summary")).toContainText("Assignee is Me");
  await expect(dialog.locator(".view-filter-summary")).toContainText(`Search “${title}”`);
  await dialog.getByLabel("Name").fill(title);
  await dialog.getByRole("button", { name: "Create view" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.locator(".task-card")).toHaveCount(1);
  // Personal views are invisible to other actors.
  const agentViews = (await command("list_views", {}, agentToken)).views;
  expect(agentViews.some((v: { name: string }) => v.name === title)).toBe(false);
});
