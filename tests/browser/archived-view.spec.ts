import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;

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

test("Archived shows only archived tasks on the selected board in List layout", async ({ page }) => {
  const key = randomUUID().slice(0, 6).toUpperCase();
  const first = await command("create_board", { name: `Archive first ${key}`, prefix: `A${key}` });
  const second = await command("create_board", { name: `Archive second ${key}`, prefix: `B${key}` });
  const active = await command("create_task", { boardId: first.id, title: `Active ${key}` });
  const archived = await command("create_task", { boardId: first.id, title: `Archived first ${key}` });
  const other = await command("create_task", { boardId: second.id, title: `Archived second ${key}` });
  const history = "Keep this archived history.";
  await command("add_comment", { id: archived.id, body: history });
  const currentArchived = await command("get_task", { id: archived.id });
  archived.version = currentArchived.version;
  for (const task of [archived, other]) {
    await command("archive_task", { id: task.id, expectedVersion: task.version });
  }
  await page.addInitScript(({ token, boardId }) => {
    sessionStorage.setItem("tasknboard-token", token);
    localStorage.setItem("tasknboard.selectedBoardId", boardId);
  }, { token: humanToken, boardId: first.id });
  await page.goto(baseURL);

  const taskButton = (task: { id: string; title: string }) =>
    page.getByRole("button", { name: `${task.id}: ${task.title}`, exact: false });
  const archivedButton = (boardName: string) => page.getByRole("navigation", { name: "Boards", exact: true })
    .getByRole("group", { name: boardName, exact: true }).getByRole("button", { name: "Archived", exact: true });
  await expect(taskButton(active)).toBeVisible();
  await expect(taskButton(archived)).toHaveCount(0);
  await archivedButton(first.name).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Archived");
  const layout = page.getByRole("group", { name: "Layout", exact: true });
  await expect(layout.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(layout.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Task list", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Kanban board", exact: true })).toHaveCount(0);
  await expect(taskButton(archived)).toBeVisible();
  await expect(taskButton(active)).toHaveCount(0);
  await expect(taskButton(other)).toHaveCount(0);
  await expect(page.locator("tbody tr:not(.group-row)")).toHaveCount(1);

  await page.getByRole("searchbox").fill(active.title);
  await expect(taskButton(archived)).toHaveCount(0);
  await expect(taskButton(active)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No tasks match these filters.", exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill(archived.title);
  await expect(taskButton(archived)).toBeVisible();
  await page.getByRole("searchbox").fill("");

  await taskButton(archived).click();
  const details = page.getByRole("region", { name: /Task details/ });
  await expect(details).toContainText("This task is archived. Task details are read-only.");
  await expect(details.getByLabel("Title", { exact: true })).toHaveAttribute("readonly", "");
  await expect(details).toContainText(history);
  await expect(details.getByRole("button", { name: "Archive task…", exact: true })).toHaveCount(0);
  await expect(details.getByRole("textbox", { name: "Add a comment", exact: true })).toHaveCount(0);
  await details.getByRole("button", { name: `Close ${archived.id}`, exact: true }).click();

  await layout.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("region", { name: "Task list", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Boards", exact: true })
    .getByRole("group", { name: second.name, exact: true }).getByRole("button", { name: new RegExp(`^${second.name}`) }).click();
  await archivedButton(second.name).click();
  await expect(taskButton(other)).toBeVisible();
  await expect(taskButton(archived)).toHaveCount(0);
  await expect(taskButton(active)).toHaveCount(0);
  await expect(page.locator("tbody tr:not(.group-row)")).toHaveCount(1);
});

test("Archived shows an empty state when the board has only active tasks", async ({ page }) => {
  const key = randomUUID().slice(0, 6).toUpperCase();
  const board = await command("create_board", { name: `No archive ${key}`, prefix: `E${key}` });
  await command("create_task", { boardId: board.id, title: `Keep active ${key}` });
  await page.addInitScript(({ token, boardId }) => {
    sessionStorage.setItem("tasknboard-token", token);
    localStorage.setItem("tasknboard.selectedBoardId", boardId);
  }, { token: humanToken, boardId: board.id });
  await page.goto(baseURL);
  await page.getByRole("navigation", { name: "Boards", exact: true })
    .getByRole("group", { name: board.name, exact: true }).getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No archived tasks.", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Task list", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New task", exact: true })).toHaveCount(0);
});
