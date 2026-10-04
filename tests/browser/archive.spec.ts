import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;
const baseURL = process.env.TASKNBOARD_BASE_URL!;

async function command(name: string, args: object, token = humanToken) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  expect(response.ok, `${name}: ${JSON.stringify(body)}`).toBeTruthy();
  return body;
}

async function openTask(page: Page, task: { id: string; title: string }) {
  await page.getByRole("button", { name: `${task.id}: ${task.title}`, exact: false }).click();
  return page.getByRole("region", { name: /Task details/ });
}

test("the task header opens archive confirmation and preserves history", async ({ page }) => {
  const task = await command("create_task", { boardId: "BOARD-1", title: `Archive ${randomUUID()}` });
  await command("add_comment", { id: task.id, body: "Keep this history." });
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), humanToken);
  await page.goto(baseURL);
  const details = await openTask(page, task);
  const archive = details.locator(".dialog-head").getByRole("button", { name: "Archive task…" });
  await expect(archive).toBeInViewport();
  await archive.click();
  const confirmation = page.getByRole("dialog", { name: `Archive ${task.id}?`, exact: true });
  await expect(confirmation).toContainText("Its history stays");
  await confirmation.getByRole("button", { name: "Keep task" }).click();
  await expect(details).toBeVisible();
  expect((await command("list_tasks", {})).tasks.some((entry: any) => entry.id === task.id)).toBe(true);
  await archive.click();
  await confirmation.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${task.id}: ${task.title}`, exact: false })).toHaveCount(0);
  expect((await command("list_tasks", {})).tasks.some((entry: any) => entry.id === task.id)).toBe(false);
  const exported = await command("export_workspace", {});
  const saved = exported.tasks.find((entry: any) => entry.id === task.id);
  expect(saved.archived).toBe(true);
  expect(exported.events.some((event: any) => event.task_id === task.id && event.body === "Keep this history.")).toBe(true);
});

test("archive controls follow the agent role and task creator", async ({ page }) => {
  await command("workspace_info", {}, agentToken);
  await command("update_profile", { agentId: "browser-agent", role: "worker" });
  const own = await command("create_task", { boardId: "BOARD-1", title: `Own ${randomUUID()}` }, agentToken);
  const other = await command("create_task", { boardId: "BOARD-1", title: `Other ${randomUUID()}` });
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), agentToken);
  await page.goto(baseURL);
  const ownDetails = await openTask(page, own);
  await expect(ownDetails.locator(".dialog-head").getByRole("button", { name: "Archive task…" })).toBeVisible();
  await ownDetails.getByRole("button", { name: `Close ${own.id}` }).click();
  const otherDetails = await openTask(page, other);
  await expect(otherDetails.getByRole("button", { name: "Archive task…" })).toHaveCount(0);
  await command("update_profile", { agentId: "browser-agent", role: "architect" });
  await page.reload();
  const architectDetails = await openTask(page, other);
  await expect(architectDetails.locator(".dialog-head").getByRole("button", { name: "Archive task…" })).toBeVisible();
});

test("a failed archive keeps the task and its draft open", async ({ page }) => {
  const task = await command("create_task", { boardId: "BOARD-1", title: `Archive conflict ${randomUUID()}` });
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), humanToken);
  await page.goto(baseURL);
  const details = await openTask(page, task);
  const draft = `${task.title} draft`;
  await details.getByLabel("Title", { exact: true }).fill(draft);
  await command("add_comment", { id: task.id, body: "A concurrent change." });
  await details.locator(".dialog-head").getByRole("button", { name: "Archive task…" }).click();
  const confirmation = page.getByRole("dialog", { name: `Archive ${task.id}?`, exact: true });
  await expect(confirmation).toContainText("Your unsaved changes will be discarded.");
  await confirmation.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("This task changed after you opened it");
  await confirmation.getByRole("button", { name: "Keep task" }).click();
  await expect(details.getByLabel("Title", { exact: true })).toHaveValue(draft);
  expect((await command("list_tasks", {})).tasks.some((entry: any) => entry.id === task.id)).toBe(true);
});
