import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Locator } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agentToken = process.env.TASKNBOARD_AGENT_TOKEN!;
const key = () => randomUUID().slice(0, 8);

async function command(name: string, args: object = {}, token = humanToken) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  expect(response.ok, `${name}: ${body.code || response.status}`).toBeTruthy();
  return body;
}
async function create(title: string, assignee = "") {
  return command("create_task", { title, assignee, description: "Original context" });
}
async function connect(page: Page) {
  await page.addInitScript((value) => sessionStorage.setItem("tasknboard-token", value), humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
}
const card = (page: Page, id: string) => page.getByRole("button", { name: new RegExp(`^${id}:`) });
const search = (page: Page) => page.getByRole("searchbox");
const nav = (page: Page, name: string) => page.locator(".sidebar").getByRole("button", { name: new RegExp(`^${name}(?:\\s|$)`) });

// Each test creates its own identifiable records in the runner's disposable database.
test("Board, List and My tasks combine filters and agree on counts", async ({ page }) => {
  const prefix = `Filters ${key()}`;
  const mine = await create(`${prefix} mine`, "reviewer");
  await create(`${prefix} other`, "Helpful bot");
  await create(`Outside ${key()}`, "reviewer");
  await command("add_comment", { id: mine.id, expectedVersion: mine.version, body: "A counted comment" });
  await connect(page);
  await search(page).fill(prefix);
  await expect(page.locator(".task-card")).toHaveCount(2);
  await expect(page.locator(".task-card .kind-tag")).toHaveCount(0);
  await expect(page.locator(".result-summary")).toContainText("Showing 2 of");
  await page.getByLabel("Filter by assignee").selectOption("reviewer");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.locator(".task-card .comment-count")).toHaveText("1 comment");
  await expect(page.locator("#column-backlog + .count")).toHaveText("1");
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator('[data-label="Comments"]')).toHaveText("1");
  await expect(card(page, mine.id)).toBeVisible();
  await nav(page, "My tasks").click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Filter by assignee").selectOption("Helpful bot");
  await expect(page.getByRole("heading", { name: "No tasks match these filters." })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).first().click();
  await expect(card(page, mine.id)).toBeVisible();
  await expect(page.locator("tbody")).not.toContainText(`${prefix} other`);
});

test("Status menu saves and the server rejects an invalid drag", async ({ page }) => {
  const task = await create(`Status ${key()}`);
  await connect(page);
  await search(page).fill(task.id);
  const status = page.getByLabel(`Status of ${task.id}`);
  await status.selectOption("in_progress");
  await expect(status).toHaveValue("in_progress");
  await expect(page.getByRole("status").filter({ hasText: `Moved ${task.id}` })).toBeVisible();
  const transfer = await page.evaluateHandle((id) => {
    const data = new DataTransfer();
    data.setData("text/plain", id);
    return data;
  }, task.id);
  await page.locator('section[aria-labelledby="column-done"]').dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByRole("alert")).toContainText("must be reviewed before completion");
  await expect(status).toHaveValue("in_progress");
  expect((await command("get_task", { id: task.id })).status).toBe("in_progress");
});

test("Task sidebar pickers search, stage changes, and save label arrays", async ({ page }) => {
  const task = await command("create_task", {
    title: `Picker ${key()}`,
    priority: "medium",
    labels: ["Existing"],
  });
  await connect(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await card(page, task.id).click();

  let details = page.getByRole("dialog", { name: /Task details/ });
  let status = details.getByRole("button", { name: "Status: Backlog. Choose status" });
  await status.click();
  let picker = page.getByRole("dialog", { name: "Choose status" });
  const statusSearch = picker.getByRole("searchbox", { name: "Search status" });
  await expect(statusSearch).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(status).toBeFocused();
  await status.click();
  picker = page.getByRole("dialog", { name: "Choose status" });
  await expect(statusSearch).toBeFocused();
  await statusSearch.fill("in review");
  await picker.getByLabel("In review").click();
  await expect(picker).toBeHidden();
  status = details.getByRole("button", { name: "Status: In review. Choose status" });
  await expect(status).toBeFocused();

  let assignee = details.getByRole("button", { name: "Assignee: Unassigned. Choose assignee" });
  await assignee.click();
  picker = page.getByRole("dialog", { name: "Choose assignee" });
  const userSearch = picker.getByRole("searchbox", { name: "Search users" });
  await expect(userSearch).toBeFocused();
  await expect(picker.locator(".picker-option").first()).toContainText("reviewer");
  await userSearch.fill("browser-agent");
  await picker.locator(".picker-option").filter({ hasText: "browser-agent" }).click();
  await expect(picker).toBeHidden();
  assignee = details.getByRole("button", { name: "Assignee: browser-agent. Choose assignee" });
  await expect(assignee).toBeFocused();

  await details.getByRole("button", { name: "Priority: Medium" }).click();
  picker = page.getByRole("dialog", { name: "Choose priority" });
  await expect(picker.getByRole("searchbox", { name: "Search priority" })).toBeFocused();
  await picker.getByLabel("High").click();
  await expect(details.getByRole("button", { name: "Priority: High" })).toBeVisible();

  const labels = details.getByRole("button", { name: "Labels: Existing. Edit labels" });
  await labels.click();
  picker = page.getByRole("dialog", { name: "Choose labels" });
  const labelSearch = picker.getByRole("searchbox", { name: "Search labels" });
  await expect(labelSearch).toBeFocused();
  const box = await picker.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);
  expect(box?.height).toBeLessThan(844);
  await labelSearch.fill("Second label");
  await picker.getByRole("button", { name: "Add “Second label”" }).click();
  await picker.getByRole("button", { name: "Done" }).click();

  details = page.getByRole("dialog", { name: /Task details/ });
  await expect(details.getByRole("button", { name: "Labels: Existing, Second label. Edit labels" })).toBeVisible();
  await details.getByRole("button", { name: "Save changes" }).click();
  const saved = await command("get_task", { id: task.id });
  expect(saved.status).toBe("in_review");
  expect(saved.priority).toBe("high");
  expect(saved.assignee).toBe("browser-agent");
  expect(saved.labels).toEqual(["Existing", "Second label"]);

  await card(page, task.id).click();
  details = page.getByRole("dialog", { name: /Task details/ });
  await details.getByRole("button", { name: "Labels: Existing, Second label. Edit labels" }).click();
  picker = page.getByRole("dialog", { name: "Choose labels" });
  await picker.getByLabel("Existing").uncheck();
  await picker.getByLabel("Second label").uncheck();
  await picker.getByRole("button", { name: "Done" }).click();
  await expect(details.getByRole("button", { name: "Labels: None. Edit labels" })).toBeVisible();
  await details.getByRole("button", { name: "Save changes" }).click();
  expect((await command("get_task", { id: task.id })).labels).toEqual([]);
});

test("A stale save keeps the draft and merges untouched fields", async ({ page }) => {
  const task = await create(`Stale ${key()}`);
  await connect(page);
  await card(page, task.id).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill("My unsaved title");
  await command("update_task", { id: task.id, expectedVersion: task.version, patch: { description: "Remote context" } });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("nothing was saved");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("My unsaved title");
  await dialog.getByRole("button", { name: "Load latest" }).first().click();
  await expect(dialog.getByLabel("Context", { exact: true })).toHaveValue("Remote context");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("My unsaved title");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const saved = await command("get_task", { id: task.id });
  expect(saved.title).toBe("My unsaved title");
  expect(saved.description).toBe("Remote context");
});

test("An active agent claim rejects edits and keeps the draft", async ({ page }) => {
  let task = await create(`Claim ${key()}`);
  task = await command("claim_task", { id: task.id, expectedVersion: task.version }, agentToken);
  await connect(page);
  await card(page, task.id).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill("Blocked draft");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("claimed by browser-agent");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("Blocked draft");
  expect((await command("get_task", { id: task.id })).title).toBe(task.title);
});

test("Stand-up fixes participant order, saves claimed-task notes and restores state", async ({ page }) => {
  const task = await create(`Standup ${key()}`, "reviewer");
  const claimed = await command("claim_task", { id: task.id, expectedVersion: task.version }, agentToken);
  await create(`Unassigned ${key()}`);
  await connect(page);
  await search(page).fill(task.id);
  await page.getByLabel("Filter by assignee").selectOption("browser-agent");
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  await nav(page, "Stand-up").click();
  await expect(page.getByRole("heading", { name: "Team overview" })).toBeVisible();
  const participants = page.getByLabel("Participant", { exact: true });
  const order = await participants.locator("option").allTextContents();
  expect(order.at(-1)).toContain("Unassigned");
  const names = order.slice(1, -1).map((name) => name.split(" · ")[1]);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  await page.getByRole("button", { name: /^Highlights/ }).click();
  await page.keyboard.press("ArrowRight");
  await expect(participants).toHaveValue("1");
  await expect(page.getByRole("button", { name: /^All tasks/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(participants).toHaveValue("0");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Home");
  await expect(participants).toHaveValue("0");
  await card(page, task.id).click();
  const notes = page.getByRole("dialog");
  await notes.getByLabel("Highlight").fill("Saved while claimed");
  await notes.getByRole("button", { name: "Save notes" }).click();
  await expect(notes).toBeHidden();
  const saved = await command("get_task", { id: task.id });
  expect(saved.standup.highlight).toBe("Saved while claimed");
  expect(saved.lease).toEqual(claimed.lease);
  const late = await create(`Late participant ${key()}`, `Late ${key()}`);
  await expect(card(page, late.id)).toBeVisible();
  expect(await participants.locator("option").allTextContents()).toEqual(order);
  await card(page, task.id).click();
  await expect(notes).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(notes).toBeHidden();
  await expect(page.locator(".standup-shell")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".standup-shell")).toBeHidden();
  await expect(search(page)).toHaveValue(task.id);
  await expect(page.getByLabel("Filter by assignee")).toHaveValue("browser-agent");
  await expect(page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
});

test("WebMCP writes refresh after a read already in flight", async ({ page }) => {
  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
    const tools = new Map();
    Object.assign(window, { testTools: tools });
    Object.defineProperty(document, "modelContext", { configurable: true, value: {
      registerTool(tool: any, { signal }: { signal: AbortSignal }) {
        tools.set(tool.name, tool);
        signal.addEventListener("abort", () => tools.delete(tool.name));
        return Promise.resolve();
      },
    } });
  }, humanToken);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route("**/api/list_tasks", async (route) => {
    if (held) return route.continue();
    held = true;
    const oldResponse = await route.fetch();
    await gate;
    await route.fulfill({ response: oldResponse });
  });
  await page.goto(baseURL);
  await expect.poll(() => page.evaluate(() => (window as any).testTools.size)).toBe(7);
  const title = `WebMCP ${key()}`;
  const write = page.waitForResponse((response) => response.url().endsWith("/api/create_task"));
  await page.evaluate((title) => {
    (window as any).toolWrite = (window as any).testTools.get("create_task").execute({ title }, { signal: new AbortController().signal });
  }, title);
  await write;
  release();
  await page.evaluate(() => (window as any).toolWrite);
  await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();
});

test("Hidden tabs pause polling and visible tabs refresh immediately", async ({ page }) => {
  await connect(page);
  await page.clock.install();
  let reads = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/list_tasks")) reads++; });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(15_001);
  expect(reads).toBe(0);
  const response = page.waitForResponse((response) => response.url().endsWith("/api/list_tasks"));
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await response;
  expect(reads).toBe(1);
});

test("Initial My tasks hides placeholder identity and ordinary browsers skip WebMCP", async ({ page }) => {
  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
    Object.defineProperty(document, "modelContext", { configurable: true, value: undefined });
  }, humanToken);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/workspace_info", async (route) => { await gate; await route.continue(); });
  const scripts: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(request.url()); });
  await page.goto(baseURL);
  await nav(page, "My tasks").click();
  await expect(page.locator(".page-title p")).toBeEmpty();
  release();
  await expect(page.locator(".page-title p")).toHaveText("Tasks assigned to reviewer.");
  expect(scripts.some((url) => /\/webmcp-/.test(url))).toBe(false);
});

test("Settings offers Change server only inside the iOS shell", async ({ page }) => {
  await connect(page);
  await nav(page, "Settings").click();
  let settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("heading", { name: "Connection" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Change server" })).toHaveCount(0);

  // The iOS shell injects this contract into every page it loads.
  await page.addInitScript(() => {
    Object.defineProperty(window, "tasknboardShell", {
      value: { changeServer: () => { (window as any).serverChangeRequested = true; } },
    });
  });
  await page.reload();
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
  await nav(page, "Settings").click();
  settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toContainText(`Server: ${new URL(baseURL).origin}`);
  await settings.getByRole("button", { name: "Change server" }).click();
  expect(await page.evaluate(() => (window as any).serverChangeRequested)).toBe(true);
});

test("Phone navigation, fullscreen dialogs and keyboard focus remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await create(`Phone ${key()}`);
  await connect(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sidebar = await page.locator(".sidebar").boundingBox();
  expect(sidebar!.y).toBeGreaterThan(650);
  await nav(page, "My tasks").click();
  await expect(page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.width).toBe(375);
  expect(box!.height).toBe(812);
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => ({ inside: element.contains(document.activeElement), active: document.activeElement?.tagName })), `Tab ${i}`).toMatchObject({ inside: true });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(nav(page, "My tasks")).toBeFocused();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await nav(page, "Board").click();
  await page.keyboard.press("f");
  await expect(page.getByLabel("Filter by assignee")).toBeFocused();
});

test("Needs changes explains retained review evidence", async ({ page }) => {
  let task = await create(`Review round ${key()}`);
  task = await command("claim_task", { id: task.id, expectedVersion: task.version }, agentToken);
  task = await command("submit_review", { id: task.id, expectedVersion: task.version, summary: "Earlier submission" }, agentToken);
  await connect(page);
  await card(page, task.id).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Needs changes" }).click();
  await expect(dialog).toContainText("earlier submission for context");
  await expect(dialog.locator(".review-summary")).toHaveText("Earlier submission");
  expect((await command("get_task", { id: task.id })).status).toBe("in_progress");
});

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Control is not reachable with Tab");
}

test("Keyboard-only actions reach each view and the task, notes, settings and help dialogs", async ({ page }) => {
  await connect(page);
  const title = `Keyboard ${key()}`;
  await page.keyboard.press("n");
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  await page.keyboard.type(title);
  await tabTo(page, dialog.getByRole("button", { name: "Create task", exact: true }));
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(title);
  const open = page.getByRole("button", { name: new RegExp(`TNB-\\d+: ${title}`) });
  await expect(open).toBeVisible();
  await tabTo(page, open);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await tabTo(page, dialog.getByLabel("Add a comment"));
  await page.keyboard.type("Keyboard comment");
  await tabTo(page, dialog.getByRole("button", { name: "Post comment" }));
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".event-body")).toContainText(["Keyboard comment"]);
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await tabTo(page, nav(page, "Agents"));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await tabTo(page, nav(page, "Settings"));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(nav(page, "Settings")).toBeFocused();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await tabTo(page, nav(page, "My tasks"));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await tabTo(page, nav(page, "Stand-up"));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Team overview" })).toBeVisible();
  await tabTo(page, open);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await tabTo(page, dialog.getByLabel("Highlight"));
  await page.keyboard.type("Keyboard highlight");
  await tabTo(page, dialog.getByRole("button", { name: "Save notes" }));
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "My tasks" })).toBeVisible();
});


test("Escape leaves fullscreen, including an entry that completes after exit", async ({ page }) => {
  await create(`Fullscreen ${key()}`);
  await connect(page);
  await nav(page, "Stand-up").click();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".standup-shell")).toBeHidden();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

  // Keep the real browser operation; delay only its completion notification.
  await page.evaluate(() => {
    const nativeRequest = document.documentElement.requestFullscreen.bind(document.documentElement);
    document.documentElement.requestFullscreen = async () => {
      await nativeRequest();
      await new Promise<void>((resolve) => { (window as any).finishFullscreen = resolve; });
    };
  });
  await nav(page, "Stand-up").click();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishFullscreen)).toBe("function");
  // Simulate the gap where the browser request is pending and fullscreenElement
  // has not reached the page yet, while still exercising actual browser exit.
  await page.evaluate(() => Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null }));
  await page.keyboard.press("Escape");
  await expect(page.locator(".standup-shell")).toBeHidden();
  await page.evaluate(() => {
    delete (document as any).fullscreenElement;
    (window as any).finishFullscreen();
  });
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});
