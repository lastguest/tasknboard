import { expect, test, type Page } from "@playwright/test";

async function openAgents(page: Page) {
  await page.addInitScript((token) => {
    sessionStorage.setItem("tasknboard-token", token);
  }, process.env.TASKNBOARD_HUMAN_TOKEN!);
  await page.goto(process.env.TASKNBOARD_BASE_URL!);
  await page.locator(".sidebar").getByRole("button", { name: "Agents", exact: true }).click();
  return page.getByRole("region", { name: "MCP status", exact: true });
}

test("MCP connections show their state and restart the selected connection", async ({ page }) => {
  let state = "connected";
  let restartedId = "";
  await page.route("**/api/mcp-status", (route) => route.fulfill({
    json: { supported: true, connections: [{ id: "mcp-42", identity: "browser-agent", state }] },
  }));
  await page.route("**/api/mcp-restart", async (route) => {
    expect(route.request().method()).toBe("POST");
    restartedId = route.request().postDataJSON().id;
    state = "reconnecting";
    await route.fulfill({ json: { restarted: true } });
  });
  const section = await openAgents(page);
  const row = section.getByRole("listitem");
  const restart = row.getByRole("button", { name: /Restart MCP for/ });
  await expect(row).toContainText("browser-agent");
  await expect(row.getByRole("status")).toHaveText("Connected");
  await expect(restart).toBeEnabled();
  await restart.click();
  await expect(row.getByRole("status")).toHaveText("Reconnecting");
  expect(restartedId).toBe("mcp-42");
  await expect(restart).toBeDisabled();
  state = "connected";
  await expect(row.getByRole("status")).toHaveText("Connected");
  await expect(restart).toBeEnabled();
});

test("MCP status errors clear when the next status request succeeds", async ({ page }) => {
  let fail = true;
  await page.route("**/api/mcp-status", (route) => route.fulfill(fail ? {
    status: 503, json: { message: "The MCP host is unavailable." },
  } : {
    json: { supported: true, connections: [{ id: "mcp-43", identity: "browser-agent", state: "connected" }] },
  }));
  const section = await openAgents(page);
  await expect(section.getByRole("alert")).toContainText("The MCP host is unavailable.");
  await expect(section.getByRole("button", { name: /Restart MCP/ })).toHaveCount(0);
  fail = false;
  await expect(section.getByRole("status")).toHaveText("Connected");
  await expect(section.getByRole("alert")).toHaveCount(0);
});

test("MCP restart errors leave the connection available for another attempt", async ({ page }) => {
  await page.route("**/api/mcp-status", (route) => route.fulfill({
    json: { supported: true, connections: [{ id: "mcp-44", identity: "browser-agent", state: "connected" }] },
  }));
  await page.route("**/api/mcp-restart", (route) => route.fulfill({
    status: 409, json: { message: "The MCP connection cannot restart." },
  }));
  const section = await openAgents(page);
  const restart = section.getByRole("button", { name: /Restart MCP for/ });
  await restart.click();
  await expect(section.getByRole("alert")).toHaveText("The MCP connection cannot restart.");
  await expect(section.getByRole("status")).toHaveText("Connected");
  await expect(restart).toBeEnabled();
});

for (const supported of [true, false]) {
  test(`MCP status shows ${supported ? "an empty connection list" : "the local host requirement"}`, async ({ page }) => {
    await page.route("**/api/mcp-status", (route) => route.fulfill({
      json: { supported, connections: [] },
    }));
    const section = await openAgents(page);
    await expect(section).toContainText(supported
      ? "No active MCP connections."
      : "View and restart MCP connections on the local agent host.");
    await expect(section.getByRole("button", { name: /Restart MCP/ })).toHaveCount(0);
  });
}
