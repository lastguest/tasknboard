import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";

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

  const boardSwitch = page.getByRole("button", { name: /^Switch board/ });
  await expect(boardSwitch).toHaveAccessibleName("Switch board, current Default");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Default");
  // A board without a description shows no subtitle.
  await expect(page.locator(".page-title p")).toHaveCount(0);
  await page
    .getByRole("group", { name: "Board actions" })
    .getByRole("button", { name: "New board" })
    .click();
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
  await expect(boardSwitch).toHaveAccessibleName(`Switch board, current ${boardName}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(boardName);

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
  await editBoard.getByRole("textbox", { name: "Description" }).fill("Runbooks and incidents.");
  const renamedBoard = `${boardName} renamed`;
  await editBoard.getByRole("textbox", { name: "Name" }).fill(renamedBoard);
  await editBoard.getByRole("button", { name: "Save changes" }).click();
  await expect(editBoard).toBeHidden();
  await expect(page.locator(".page-title p")).toHaveText("Runbooks and incidents.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(renamedBoard);

  const formerKey = task.id.replace(/^[^-]+/, prefix);
  const oldKey = await fetch(`${baseURL}/api/get_task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${humanToken}`,
    },
    body: JSON.stringify({ id: formerKey }),
  });
  expect(oldKey.status).toBe(200);
  expect((await oldKey.json()).id).toBe(task.id);

  await page.reload();
  await expect(boardSwitch).toHaveAccessibleName(`Switch board, current ${renamedBoard}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(renamedBoard);
  await expect(page.locator(".task-card").filter({ hasText: taskTitle })).toBeVisible();
  await boardSwitch.click();
  await expect(
    page.getByRole("menuitemradio", { name: `${renamedBoard} (${nextPrefix})` }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Default (TNB)" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Default");
  await expect(page.locator(".task-card").filter({ hasText: original.title })).toBeVisible();
  await expect(page.locator(".task-card").filter({ hasText: taskTitle })).toHaveCount(0);
  expect((await command<any>("get_task", { id: original.id })).boardId).toBe("BOARD-1");

  // A link with the former key opens the renamed task in a tab; the board stays.
  await page.goto(`${baseURL}/#task/${formerKey}`);
  await expect(page.getByRole("region", { name: /Task details/ })).toContainText(task.id);
  await expect(page.getByRole("navigation", { name: "Open tasks" })).toContainText(task.id);
  await page.getByRole("navigation", { name: "Open tasks" }).getByRole("button", { name: "Default", exact: true }).click();
  await expect(boardSwitch).toHaveAccessibleName("Switch board, current Default");
});

/** Menus close on scroll, so scroll a sidebar control into view before it opens one. */
async function reveal(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  return target;
}

test("the sidebar lists boards with their pages, and each person hides boards", async ({ page }) => {
  const suffix = key();
  const name = `Sidebar ${suffix}`;
  const board = await command<any>("create_board", { name, prefix: `SB${suffix}` });
  await command("create_task", { boardId: board.id, title: `Sidebar task ${suffix}` });
  await connect(page);

  const sidebar = page.getByRole("navigation", { name: "Boards" });
  // The row's name ends with its In progress count.
  const row = sidebar.getByRole("button", {
    name: new RegExp(`^${name} \\d+ tasks? in progress$`),
  });
  await expect(row).toHaveAccessibleName(`${name} 0 tasks in progress`);
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  const pages = sidebar.getByRole("group", { name });
  await pages.getByRole("button", { name: "Epics", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Epics");
  await pages.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(pages.getByRole("button", { name: "Tasks", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("button", { name: /^Switch board/ })).toHaveAccessibleName(
    `Switch board, current ${name}`,
  );
  await expect(page.getByText(`Sidebar task ${suffix}`)).toBeVisible();
  // Starting the task updates the count without a reload.
  await page.locator(".task-card").filter({ hasText: `Sidebar task ${suffix}` }).click({ button: "right" });
  await page.getByRole("menuitemradio", { name: "In progress" }).click();
  await expect(row).toHaveAccessibleName(`${name} 1 task in progress`);

  // Rows stay expanded after a reload; the section collapses as a whole.
  await page.reload();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await sidebar.getByRole("button", { name: "Boards" }).click();
  await expect(row).toBeHidden();
  await sidebar.getByRole("button", { name: "Boards" }).click();

  await (await reveal(page, row)).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide from sidebar" }).click();
  await expect(row).toBeHidden();
  expect(
    (await command<{ boards: any[] }>("list_boards")).boards.find((b) => b.id === board.id)
      .inSidebar,
  ).toBe(false);
  // The board stays available from the board selector.
  await page.getByRole("button", { name: /^Switch board/ }).click();
  await expect(page.getByRole("menuitemradio", { name: new RegExp(`^${name} \\(`) })).toHaveCount(1);
  await page.keyboard.press("Escape");

  await (await reveal(page, sidebar.getByRole("button", { name: /hidden board/ }))).click();
  await page.getByRole("menuitem", { name }).click();
  await expect(row).toBeVisible();
});

test("taking another board's former prefix asks for confirmation and ends the redirect", async ({ page }) => {
  const suffix = key();
  const retired = `OLD${suffix}`;
  const owner = await command<any>("create_board", { name: `Owner ${suffix}`, prefix: retired });
  const task = await command<any>("create_task", { boardId: owner.id, title: `Owned ${suffix}` });
  await command("update_board", {
    id: owner.id,
    expectedVersion: owner.version,
    patch: { prefix: `NEW${suffix}` },
  });
  await connect(page);

  await page
    .getByRole("group", { name: "Board actions" })
    .getByRole("button", { name: "New board" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New board" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(`Taker ${suffix}`);
  await dialog.getByRole("textbox", { name: "Board prefix" }).fill(retired);
  await dialog.getByRole("button", { name: "Create board" }).click();
  const confirm = dialog.getByRole("alertdialog", { name: "Use a retired prefix" });
  await expect(confirm).toContainText(`will orphan the old ${retired}- task keys`);
  await expect(confirm).toContainText("Are you sure?");
  await expect(dialog.getByRole("button", { name: "Create board" })).toBeHidden();

  // Keep editing sends nothing, and the redirect still works.
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(confirm).toBeHidden();
  expect((await command<any>("get_task", { id: task.id })).id).toBe(`NEW${suffix}-1`);

  await dialog.getByRole("button", { name: "Create board" }).click();
  await confirm.getByRole("button", { name: `Use ${retired} anyway` }).click();
  await expect(dialog).toBeHidden();
  const boards = (await command<{ boards: any[] }>("list_boards")).boards;
  expect(boards.find((b) => b.name === `Taker ${suffix}`)?.prefix).toBe(retired);
  expect(boards.find((b) => b.id === owner.id)?.formerPrefixes).toEqual([]);
  const old = await fetch(`${baseURL}/api/get_task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${humanToken}` },
    body: JSON.stringify({ id: task.id }),
  });
  expect(old.status).toBe(404);
});

test("the desktop app fills the repository folder from the OS folder picker", async ({ page }) => {
  await page.addInitScript((token) => {
    sessionStorage.setItem("tasknboard-token", token);
    const state = window as unknown as { pickCalls: unknown[] };
    state.pickCalls = [];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { start: string | null }) => {
          if (command === "app_version") return "1.0.0";
          if (command === "pick_folder") {
            state.pickCalls.push(args.start);
            if (state.pickCalls.length === 1) return "/Users/you/projects/picked";
            if (state.pickCalls.length === 2) return null;
            throw "Dialog unavailable";
          }
          throw `Unexpected command: ${command}`;
        },
      },
    });
  }, humanToken);
  await page.goto(baseURL);
  await page
    .getByRole("group", { name: "Board actions" })
    .getByRole("button", { name: "New board" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New board" });
  const folder = dialog.getByRole("textbox", { name: "Repository folder" });
  const choose = dialog.getByRole("button", { name: "Choose…" });
  await choose.click();
  await expect(folder).toHaveValue("/Users/you/projects/picked");
  // Cancelling keeps the folder, and the picker opens where it points.
  await choose.click();
  await expect(choose).toBeEnabled();
  await expect(folder).toHaveValue("/Users/you/projects/picked");
  expect(await page.evaluate(() => (window as any).pickCalls)).toEqual([
    null,
    "/Users/you/projects/picked",
  ]);
  await choose.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Could not open the folder picker: Dialog unavailable",
  );
  await expect(folder).toHaveValue("/Users/you/projects/picked");
});

test("the browser has no folder picker button", async ({ page }) => {
  await connect(page);
  await page
    .getByRole("group", { name: "Board actions" })
    .getByRole("button", { name: "New board" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New board" });
  await expect(dialog.getByRole("textbox", { name: "Repository folder" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Choose…" })).toHaveCount(0);
});
