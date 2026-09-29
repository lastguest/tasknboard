import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const key = () => randomUUID().slice(0, 6).toUpperCase();

async function command<T = any>(name: string, args: object = {}): Promise<T> {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${humanToken}`,
    },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  expect(response.ok, `${name}: ${body.code || response.status}`).toBeTruthy();
  return body as T;
}

async function connect(page: Page) {
  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
  }, humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
}

test("boards scope task keys, persist selection, and own task deep links", async ({ page }) => {
  const suffix = key();
  const original = await command<any>("create_task", {
    boardId: "BOARD-1",
    title: `Default board ${suffix}`,
  });
  await connect(page);

  const boardSelect = page.getByRole("combobox", { name: "Board" });
  await expect(boardSelect).toHaveValue("BOARD-1");
  await page.getByRole("button", { name: "New board" }).click();
  const newBoard = page.getByRole("dialog", { name: "New board" });
  const boardName = `Operations ${suffix}`;
  const prefix = `OPS${suffix}`;
  const nextPrefix = `RUN${suffix}`;
  await newBoard.getByRole("textbox", { name: "Name" }).fill(boardName);
  await newBoard.getByRole("textbox", { name: "Board prefix" }).fill(prefix);
  await newBoard.getByRole("button", { name: "Create board" }).click();
  await expect(newBoard).toBeHidden();
  const board = (await command<{ boards: any[] }>("list_boards")).boards.find(
    (item) => item.name === boardName,
  );
  expect(board).toBeTruthy();
  await expect(boardSelect).toHaveValue(board.id);

  const taskTitle = `Operations task ${suffix}`;
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const taskDialog = page.getByRole("dialog", { name: "New task" });
  await expect(taskDialog).toContainText(`created on ${boardName}`);
  await taskDialog.getByLabel("Title").fill(taskTitle);
  await taskDialog.getByRole("button", { name: "Create task" }).click();
  await expect(taskDialog).toBeHidden();
  let boardTasks = await command<{ tasks: any[] }>("list_tasks", {
    boardId: board.id,
  });
  let task = boardTasks.tasks.find((item) => item.title === taskTitle);
  expect(task?.boardId).toBe(board.id);
  expect(task?.id).toMatch(new RegExp(`^${prefix}-`));

  await page.getByRole("button", { name: "Edit board" }).click();
  const editBoard = page.getByRole("dialog", { name: "Edit board" });
  await editBoard.getByRole("textbox", { name: "Board prefix" }).fill(nextPrefix);
  await expect(editBoard).toContainText(
    "Changing this prefix renames existing task keys. Old keys in links or branch references keep opening the renamed tasks.",
  );
  await editBoard.getByRole("button", { name: "Save changes" }).click();
  await expect(editBoard).toBeHidden();
  boardTasks = await command("list_tasks", { boardId: board.id });
  task = boardTasks.tasks.find((item: any) => item.title === taskTitle);
  expect(task?.id).toMatch(new RegExp(`^${nextPrefix}-`));
  expect(task?.boardId).toBe(board.id);
  await page.getByRole("button", { name: "Edit board" }).click();
  await expect(editBoard).toContainText(`Former prefixes: ${prefix}-.`);
  await editBoard.getByRole("button", { name: "Cancel" }).click();

  const oldKey = await fetch(`${baseURL}/api/get_task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${humanToken}`,
    },
    body: JSON.stringify({ id: `${prefix}-001` }),
  });
  expect(oldKey.status).toBe(200);
  expect((await oldKey.json()).id).toBe(task.id);

  await page.reload();
  await expect(boardSelect).toHaveValue(board.id);
  await expect(page.locator(".task-card").filter({ hasText: taskTitle })).toBeVisible();
  await boardSelect.selectOption("BOARD-1");
  await expect(page.locator(".task-card").filter({ hasText: original.title })).toBeVisible();
  await expect(page.locator(".task-card").filter({ hasText: taskTitle })).toHaveCount(0);
  expect((await command<any>("get_task", { id: original.id })).boardId).toBe("BOARD-1");

  // A link with the former key opens the renamed task in a tab; the board stays.
  await page.goto(`${baseURL}/#task/${prefix}-001`);
  await expect(page.getByRole("region", { name: /Task details/ })).toContainText(task.id);
  await expect(page.getByRole("navigation", { name: "Open tasks" })).toContainText(task.id);
  await page.getByRole("navigation", { name: "Open tasks" }).getByRole("button", { name: "Board" }).click();
  await expect(boardSelect).toHaveValue("BOARD-1");
});
