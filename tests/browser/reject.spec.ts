import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;

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

test("Reject releases a claim and archives the task", async ({ page }) => {
  let task = await command("create_task", {
    boardId: "BOARD-1", title: `Reject ${randomUUID()}`, assignee: "browser-agent",
  });
  task = await command("claim_task", { id: task.id, expectedVersion: task.version }, agentToken);
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), humanToken);
  await page.goto(baseURL);
  await page.getByRole("button", { name: `${task.id}: ${task.title}`, exact: false }).click();
  const details = page.getByRole("region", { name: /Task details/ });
  await details.getByRole("button", { name: "Reject task", exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${task.id}: ${task.title}`, exact: false })).toHaveCount(0);
  const saved = await command("get_task", { id: task.id });
  expect(saved.archived).toBe(true);
  expect(saved.lane).toBe(task.lane);
  expect(saved.lease).toBeNull();
  expect(saved.assignee).toBe("browser-agent");
  expect(saved.events.at(-1).kind).toBe("reject_task");
  await page.reload();
  await expect(page.getByRole("button", { name: `${task.id}: ${task.title}`, exact: false })).toHaveCount(0);
  expect((await command("list_boards", {})).boards.flatMap((board: any) => board.lanes).some((lane: any) => lane.name === "Rejected")).toBe(false);
});
