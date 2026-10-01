import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;

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

test("a comment that cites another task shows a live chip that opens it", async ({ page }) => {
  const suffix = randomUUID().slice(0, 6).toUpperCase().replace(/^\d/, "R");
  const [home] = (await command<any>("list_boards")).boards;
  // The cited task is on a board the page has not loaded.
  const other = await command<any>("create_board", { name: `Refs ${suffix}`, prefix: `R${suffix}` });
  const target = await command<any>("create_task", {
    boardId: other.id,
    title: `Cited work ${suffix}`,
  });
  const source = await command<any>("create_task", {
    boardId: home.id,
    title: `Citing work ${suffix}`,
  });
  await command("add_comment", {
    id: source.id,
    expectedVersion: source.version,
    body: `Waits on ${target.id}, not ${other.prefix}-999 or \`${target.id}\`.`,
  });

  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
  }, humanToken);
  await page.goto(`${baseURL}/#task/${source.id}`);
  const details = page.locator(".task-panel");
  await expect(details.locator("h2")).toContainText(source.id);

  const comment = details.locator(".event.kind-add_comment .markdown");
  const chip = comment.locator("a.task-ref");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAccessibleName(`${target.id} ${target.title}, Backlog`);
  await expect(chip).toHaveAttribute("href", `#task/${target.id}`);
  // A missing task and a code span stay text.
  await expect(comment).toContainText(`not ${other.prefix}-999 or ${target.id}.`);
  await expect(comment.locator("code")).toHaveText(target.id);

  await chip.hover();
  await expect(chip.locator(".task-ref-title")).toBeVisible();
  await expect(chip.locator(".task-ref-title")).toHaveText(target.title);

  // The next app refresh carries the change into the chip.
  const moved = await command<any>("update_task", {
    id: target.id,
    expectedVersion: target.version,
    patch: { lane: other.lanes.find((lane: any) => lane.role === "in_progress").id },
  });
  await expect(chip.locator(".task-ref-state")).toHaveText("In progress", { timeout: 10_000 });
  await command("archive_task", { id: target.id, expectedVersion: moved.version });
  await expect(chip.locator(".task-ref-state")).toHaveText("Archived", { timeout: 10_000 });

  // Keyboard focus shows the title, and Enter opens the archived task in a tab.
  await page.mouse.move(0, 0);
  await chip.focus();
  await expect(chip.locator(".task-ref-title")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: `${target.id} Task details` })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Open tasks" })).toContainText(target.id);
});
