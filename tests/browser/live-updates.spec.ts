import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;

async function command(name: string, args: object, token: string) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  expect(response.ok, name).toBeTruthy();
  return response.json();
}

test("A change in one page appears in another open page without a reload", async ({ context }) => {
  await context.addInitScript((value) => sessionStorage.setItem("tasknboard-token", value), humanToken);
  const [writer, reader] = [await context.newPage(), await context.newPage()];
  for (const page of [writer, reader]) {
    await page.goto(baseURL);
    await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
  }
  let reloads = 0;
  reader.on("load", () => reloads++);

  const title = `Live ${randomUUID().slice(0, 8)}`;
  await writer.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = writer.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create task" }).click();
  const card = (page: typeof reader) =>
    page.getByRole("button", { name: new RegExp(`TNB-\\d+: ${title}`) });
  await expect(card(writer)).toBeVisible();

  await expect(card(reader)).toBeVisible({ timeout: 3000 });
  expect(reloads).toBe(0);
});

test("An agent claim appears live and its chip goes away when the lease expires", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript((value) => sessionStorage.setItem("tasknboard-token", value), humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
  const title = `Lease ${randomUUID().slice(0, 8)}`;
  const task = await command("create_task", { boardId: "BOARD-1", title }, humanToken);
  await command("claim_task", { id: task.id, expectedVersion: task.version }, agentToken);
  // The page clock moves only when the test advances it; the debounce needs a step.
  const card = page.locator(".task-card").filter({ hasText: title });
  const chip = card.locator(".claim-chip");
  await expect
    .poll(async () => {
      await page.clock.runFor(200);
      return chip.isVisible();
    }, { timeout: 3000 })
    .toBe(true);
  await page.clock.runFor(15 * 60_000 + 1000);
  await expect(chip).toBeHidden();
});
