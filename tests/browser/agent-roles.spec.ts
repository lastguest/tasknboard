import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;

async function command(name: string, args: object, token = humanToken) {
  return fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
}

test("human grants and revokes the agent role in the roster", async ({ page }) => {
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), humanToken);
  await page.goto(baseURL);
  await page.locator(".sidebar").getByRole("button", { name: /^Agents(?:\s|$)/ }).click();
  const row = page.locator(".agent-row").filter({ has: page.getByRole("combobox", { name: "Role for browser-agent", exact: true }) });
  const role = row.getByRole("combobox", { name: "Role for browser-agent", exact: true });
  await expect(row).toContainText("Current role: Worker");
  await expect(row.getByRole("button", { name: "Save role" })).toBeDisabled();
  await role.selectOption("architect");
  await row.getByRole("button", { name: "Save role" }).click();
  await expect(row).toContainText("Current role: Architect");
  await expect(row.getByRole("status")).toHaveText("Role saved.");
  await page.reload();
  await page.locator(".sidebar").getByRole("button", { name: /^Agents(?:\s|$)/ }).click();
  await expect(role).toHaveValue("architect");
  const reconnect = await command("workspace_info", {}, agentToken);
  expect(reconnect.ok).toBeTruthy();
  expect((await reconnect.json()).actor.role).toBe("architect");
  const denied = await command("update_profile", { agentId: "browser-agent", role: "worker" }, agentToken);
  expect(denied.status).toBe(403);
  expect((await denied.json()).code).toBe("FORBIDDEN");
  await role.selectOption("worker");
  await row.getByRole("button", { name: "Save role" }).click();
  await expect(row).toContainText("Current role: Worker");
  const info = await command("workspace_info", {}, agentToken);
  expect((await info.json()).actor.role ?? "worker").toBe("worker");
});
