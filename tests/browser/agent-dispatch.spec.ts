import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;

test("assignment waits for the human Run agent action", async ({ page }) => {
  const call = async (name: string, args: object, token = humanToken) => {
    const response = await fetch(`${baseURL}/api/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    expect(response.ok).toBeTruthy();
    return response.json();
  };
  await call("workspace_info", {}, agentToken);
  const task = await call("create_task", {
    boardId: "BOARD-1", title: `Dispatch ${randomUUID()}`, assignee: "browser-agent",
  });
  const dispatches: object[] = [];
  await page.route("**/api/agent-event", async (route) => {
    dispatches.push(route.request().postDataJSON());
    await route.fulfill({ json: { started: ["browser-agent"] } });
  });
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), humanToken);
  await page.goto(baseURL);
  await page.getByRole("button", { name: `${task.id}: ${task.title}`, exact: false }).click();
  const details = page.getByRole("region", { name: /Task details/ });
  await expect(details.getByRole("button", { name: "Run agent", exact: true })).toBeVisible();
  expect(dispatches).toEqual([]);
  await details.getByRole("button", { name: "Run agent", exact: true }).click();
  await expect(details.getByText("Agent run queued.", { exact: true })).toBeVisible();
  expect(dispatches).toEqual([{ event: "task_assigned", taskId: task.id }]);
  const saved = await call("get_task", { id: task.id });
  expect(saved.assignee).toBe("browser-agent");
  expect(saved.events.some((event: { kind: string }) => event.kind === "agent_started")).toBe(false);
});
