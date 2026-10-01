import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;

/** The Save button, also while it reads "Saving…". Hidden means no save is running. */
const saveButton = (scope: Locator) =>
  scope.getByRole("button", { name: /^(Save changes|Saving…)$/ });
async function command<T = any>(
  name: string,
  args: Record<string, unknown> = {},
  token = humanToken,
): Promise<T> {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`${name} returned ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}

async function connected(page: Page) {
  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
  }, humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
}

async function apiTask(title: string, assignee = "") {
  return command<any>("create_task", {
    boardId: "BOARD-1",
    title,
    assignee,
    description: `${title} context`,
    acceptance: "Browser regression fixture",
    labels: ["Browser tests"],
  });
}

test("Settings, task workflow, agent review, archive, and export", async ({ page }) => {
  const key = randomUUID().slice(0, 8);
  const title = `Browser workflow ${key}`;
  const wrongToken = "wrong-token-must-not-leak";

  await page.goto(baseURL);
  await expect(page.getByRole("alert")).toContainText("valid access token");
  await page.locator(".sidebar").getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("button", { name: "Task keys" })).toHaveCount(0);
  await expect(
    settings.getByRole("heading", { name: "Connection & data" }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Data", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Connection", exact: true }),
  ).toHaveCount(0);
  const settingsSearch = settings.getByLabel("Search settings");
  const connectionDataNav = settings.getByRole("button", {
    name: "Connection & data",
    exact: true,
  });
  await settingsSearch.fill("export");
  await expect(connectionDataNav).toBeVisible();
  await connectionDataNav.click();
  await settingsSearch.fill("token");
  await expect(connectionDataNav).toBeVisible();
  await expect(settings.getByLabel("Workspace access token")).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Export workspace" }),
  ).toBeVisible();

  const tokenField = settings.getByLabel("Workspace access token");
  await tokenField.fill(wrongToken);
  await settings.getByRole("button", { name: "Save connection" }).click();
  await expect(settings.getByRole("alert")).toContainText("Authentication failed");
  await expect(settings).not.toContainText(wrongToken);
  await expect(page.getByText(wrongToken, { exact: true })).toHaveCount(0);

  await tokenField.fill(humanToken);
  await settings.getByRole("button", { name: "Save connection" }).click();
  await expect(settings.getByRole("status")).toContainText("Connection saved");
  await settings.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");

  await page.getByRole("button", { name: "New task", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "New task" });
  await createDialog.getByLabel("Title").fill(title);
  await createDialog.getByLabel("Context").fill("Created through the browser regression suite.");
  await createDialog.getByLabel("Acceptance criteria").fill("An agent reviews it before completion.");
  await createDialog.getByRole("button", { name: "Priority: Medium" }).click();
  let picker = page.getByRole("dialog", { name: "Choose priority" });
  await picker.getByLabel("High").click();
  await expect(createDialog.getByRole("button", { name: "Priority: High" })).toBeFocused();
  await createDialog.getByRole("button", { name: "Assignee: Unassigned. Choose assignee" }).click();
  picker = page.getByRole("dialog", { name: "Choose assignee" });
  await picker.locator(".picker-option").first().click();
  await createDialog.getByRole("button", { name: "Create task" }).click();

  const card = page.getByRole("button", { name: new RegExp(`TNB-\\d+: ${title}`) });
  await expect(card).toBeVisible();
  await page.getByLabel("Search tasks by ID, title, or context").fill(key);
  await expect(card).toBeVisible();
  await card.click();
  let details = page.getByRole("region", { name: /Task details/ });
  await expect(details).toBeVisible();

  const taskId = await details.locator(".task-id").first().textContent();
  if (!taskId) throw new Error("Task details did not show the task ID");
  await details.getByLabel("Title").fill(`Edited ${title}`);
  await details.getByRole("button", { name: "Save changes" }).click();
  // The task stays open in its tab; closing the tab shows the board again.
  await expect(saveButton(details)).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Open tasks" })).toContainText(`Edited ${title}`);
  await details.getByRole("button", { name: `Close ${taskId}` }).click();
  await expect(details).toBeHidden();
  await page.getByRole("button", { name: new RegExp(`^${taskId}: Edited ${title}`) }).click();
  details = page.getByRole("region", { name: /Task details/ });
  const comment = `Browser comment ${key}`;
  await details.getByLabel("Add a comment").fill(comment);
  await details.getByRole("button", { name: "Post comment" }).click();
  await expect(details).toContainText(comment);

  // Typing @ suggests people from the roster; the keyboard picks one.
  const commentBox = details.getByLabel("Add a comment");
  await expect(commentBox).toHaveValue("");
  await commentBox.pressSequentially("Over to @brow");
  const mentions = details.getByRole("listbox", { name: "Mention someone" });
  await expect(mentions.getByRole("option")).toHaveText(["browser-agentAgent"]);
  await commentBox.press("Enter");
  await expect(mentions).toBeHidden();
  await expect(commentBox).toHaveValue("Over to @browser-agent ");
  await commentBox.pressSequentially("and @");
  await expect(mentions.getByRole("option")).toHaveCount(2);
  await commentBox.press("ArrowDown");
  await expect(mentions.getByRole("option", { selected: true })).toContainText("reviewer");
  // Escape closes the list and leaves the task open.
  await commentBox.press("Escape");
  await expect(mentions).toBeHidden();
  await expect(details).toBeVisible();
  await commentBox.press("Backspace");
  await expect(commentBox).toHaveValue("Over to @browser-agent and ");
  await commentBox.fill("");

  const latest = await command<any>("get_task", { id: taskId });
  const claimed = await command<any>("claim_task", {
    id: taskId,
    expectedVersion: latest.version,
  }, agentToken);
  const reviewed = await command<any>("submit_review", {
    id: taskId,
    expectedVersion: claimed.version,
    summary: `Reviewed in browser suite ${key}`,
    artifactUrl: "https://example.test/review/browser-regression",
  }, agentToken);
  expect(reviewed.status).toBe("in_review");
  expect(reviewed.lease).toBeNull();

  await page.reload();
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
  await page.getByRole("button", { name: new RegExp(`^${taskId}: Edited ${title}`) }).click();
  details = page.getByRole("region", { name: /Task details/ });
  await expect(details).toContainText(`Reviewed in browser suite ${key}`);
  await expect(details.getByRole("link", { name: /Open artifact/ })).toHaveAttribute(
    "href",
    "https://example.test/review/browser-regression",
  );
  await details.getByRole("button", { name: "Mark Done" }).click();
  await expect(details.getByText("Marked Done.")).toBeVisible();
  await details.getByRole("button", { name: "Archive task…" }).click();
  const confirmation = details.getByRole("group", { name: "Confirm archive" });
  await expect(confirmation).toContainText(`Archive ${taskId}?`);
  await confirmation.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(details).toBeHidden();
  await expect(page.getByRole("button", { name: new RegExp(`^${taskId}: Edited ${title}`) })).toHaveCount(0);
  expect((await command<any>("get_task", { id: taskId })).archived).toBe(true);

  await page.locator(".sidebar").getByRole("button", { name: "Settings" }).click();
  const exportDialog = page.getByRole("dialog", { name: "Settings" });
  await exportDialog.getByRole("button", { name: "Connection & data" }).click();
  await expect(
    exportDialog.getByRole("heading", { name: "Connection & data" }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await exportDialog.getByRole("button", { name: "Export workspace" }).click();
  const download = await downloadEvent;
  const exportPath = await download.path();
  if (!exportPath) throw new Error("Workspace export did not produce a file");
  const exported = JSON.parse(await readFile(exportPath, "utf8"));
  expect(exported.tasks.find((task: any) => task.id === taskId)?.archived).toBe(true);
  expect(exported.events.some((event: any) => event.task_id === taskId && event.kind === "archive_task")).toBe(true);
  await expect(exportDialog.getByRole("status")).toContainText("Export requested");
  await expect(exportDialog).not.toContainText(humanToken);
  await expect(exportDialog).not.toContainText(agentToken);
});
