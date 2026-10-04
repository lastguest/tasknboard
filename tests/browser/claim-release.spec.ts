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

async function openTask(page: Page, task: { id: string; title: string }, token: string) {
  await page.addInitScript((value) => sessionStorage.setItem("tasknboard-token", value), token);
  await page.goto(baseURL);
  await page.getByRole("button", { name: `${task.id}: ${task.title}`, exact: false }).click();
  return page.getByRole("region", { name: /Task details/ });
}

test("the claim holder releases a claim and keeps the task lane", async ({ page }) => {
  await command("workspace_info", {}, agentToken);
  await command("update_profile", { agentId: "browser-agent", role: "worker" });
  let task = await command("create_task", { boardId: "BOARD-1", title: `Release own ${randomUUID()}` });
  task = await command("claim_task", { id: task.id, expectedVersion: task.version }, agentToken);
  const details = await openTask(page, task, agentToken);
  await details.getByRole("button", { name: "Release claim", exact: true }).click();
  await expect(details.getByRole("region", { name: "Claim", exact: true })).toContainText("Not claimed.");
  const saved = await command("get_task", { id: task.id });
  expect(saved.lease).toBeNull();
  expect(saved.lane).toBe(task.lane);
  expect(saved.events.at(-1).kind).toBe("release_task");
});

test("an architect releases another actor's claim and keeps an unsaved draft", async ({ page }) => {
  await command("workspace_info", {}, agentToken);
  await command("update_profile", { agentId: "browser-agent", role: "architect" });
  let task = await command("create_task", { boardId: "BOARD-1", title: `Release foreign ${randomUUID()}` });
  task = await command("claim_task", { id: task.id, expectedVersion: task.version });
  const details = await openTask(page, task, agentToken);
  const draft = `${task.title} draft`;
  await details.getByLabel("Title", { exact: true }).fill(draft);
  await details.getByRole("button", { name: "Release claim", exact: true }).click();
  await expect(details.getByRole("region", { name: "Claim", exact: true })).toContainText("Not claimed.");
  await expect(details.getByLabel("Title", { exact: true })).toHaveValue(draft);
  const saved = await command("get_task", { id: task.id });
  expect(saved.title).toBe(task.title);
  expect(saved.lease).toBeNull();
  await details.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(details.getByLabel("Title", { exact: true })).toHaveValue(draft);
  expect((await command("get_task", { id: task.id })).title).toBe(draft);
});

test("another human cannot release a worker's claim", async ({ page }) => {
  await command("workspace_info", {}, agentToken);
  await command("update_profile", { agentId: "browser-agent", role: "worker" });
  let task = await command("create_task", { boardId: "BOARD-1", title: `Keep claim ${randomUUID()}` });
  task = await command("claim_task", { id: task.id, expectedVersion: task.version }, agentToken);
  const details = await openTask(page, task, humanToken);
  await expect(details.getByRole("button", { name: "Release claim", exact: true })).toHaveCount(0);
});
