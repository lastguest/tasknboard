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
  return command("create_task", { board: "TNB", title, assignee, description: "Original context" });
}
async function connect(page: Page) {
  await page.addInitScript((value) => sessionStorage.setItem("tasknboard-token", value), humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".workspace-status")).toContainText("reviewer · human");
}
const card = (page: Page, id: string) => page.getByRole("button", { name: new RegExp(`^${id}:`) });
const search = (page: Page) => page.getByRole("searchbox");
const assigneeFilter = (page: Page) => page.getByRole("group", { name: "Filter by assignee" });
async function filterBy(page: Page, name: string) {
  const face = assigneeFilter(page).getByRole("button", { name, exact: true });
  if (await face.count()) return face.click();
  await assigneeFilter(page).getByRole("button", { name: /more assignees$/ }).click();
  await page.getByRole("dialog", { name: "Filter by assignee" }).getByText(name, { exact: true }).click();
}
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
  await filterBy(page, "reviewer");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.locator(".task-card .comment-count")).toHaveText("1 comment");
  await expect(page.locator("#column-backlog + .count")).toHaveText("1");
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody .comment-count")).toHaveText("1 comment");
  await expect(card(page, mine.id)).toBeVisible();
  await nav(page, "My tasks").click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await filterBy(page, "Helpful bot");
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
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  await page.getByRole("button", { name: `Status of ${task.id}: In progress. Choose status` }).click();
  const picker = page.getByRole("dialog", { name: `Status of ${task.id}` });
  await expect(picker.getByRole("radio", { name: "Done (after review)" })).toBeDisabled();
  await picker.getByText("In review", { exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole("button", { name: `Status of ${task.id}: In review. Choose status` })).toBeVisible();
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Board" }).click();
  expect((await command("get_task", { id: task.id })).status).toBe("in_review");
});

test("Task sidebar pickers search, stage changes, and save label arrays", async ({ page }) => {
  const task = await command("create_task", {
    board: "TNB",
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
  await filterBy(page, "browser-agent");
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
  await expect(assigneeFilter(page).getByRole("button", { name: "browser-agent", exact: true })).toHaveAttribute("aria-pressed", "true");
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
  await expect.poll(() => page.evaluate(() => (window as any).testTools.size)).toBe(10);
  const title = `WebMCP ${key()}`;
  const write = page.waitForResponse((response) => response.url().endsWith("/api/create_task"));
  await page.evaluate((title) => {
    (window as any).toolWrite = (window as any).testTools.get("create_task").execute({ board: "TNB", title }, { signal: new AbortController().signal });
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
  await settings.getByRole("button", { name: "Connection" }).click();
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
  await settings.getByRole("button", { name: "Connection" }).click();
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
  // Boards is not a task view, so F opens the current board's filter.
  await nav(page, "Boards").click();
  await page.keyboard.press("f");
  await expect(assigneeFilter(page).getByRole("button").first()).toBeFocused();
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

test("Profiles show display names and pictures, and IDs stay unchanged", async ({ page }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  try {
    await command("update_profile", { name: "Build Bot", avatar: `data:image/png;base64,${png}` }, agentToken);
    const task = await create(`Profile ${key()}`, "browser-agent");
    await connect(page);
    const taskCard = page.locator("article", { has: card(page, task.id) });
    await expect(taskCard).toContainText("Build Bot");
    await expect(taskCard.locator(".avatar img")).toHaveCount(1);

    await nav(page, "Settings").click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("heading", { name: "Profile" })).toBeVisible();
    await settings.getByLabel("Display name").fill("Riley Reviewer");
    await settings.getByLabel("Profile picture file").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await expect(settings.getByRole("button", { name: "Change picture" })).toBeVisible();
    await settings.getByRole("button", { name: "Save profile" }).click();
    await expect(settings.getByRole("status")).toContainText("Profile saved");
    await settings.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.locator(".workspace-status")).toContainText("Riley Reviewer · human");
    await expect(page.locator(".workspace-status .avatar img")).toHaveCount(1);

    await nav(page, "Settings").click();
    await expect(settings.getByLabel("Display name")).toHaveValue("Riley Reviewer");
    await expect(settings.getByRole("button", { name: "Change picture" })).toBeVisible();
    await expect(settings.locator(".profile-row .avatar img")).toHaveCount(1);
    await settings.getByRole("button", { name: "Data" }).click();
    await settings.getByRole("button", { name: "Profile" }).click();
    await expect(settings.getByLabel("Display name")).toHaveValue("Riley Reviewer");
    await expect(settings.getByRole("button", { name: "Change picture" })).toBeVisible();
    await expect(settings.locator(".profile-row .avatar img")).toHaveCount(1);
    await settings.getByRole("button", { name: "Close dialog" }).click();

    const info = await command("workspace_info");
    expect(info.actor.id).toBe("reviewer");
    expect(info.actors.find((a: { id: string }) => a.id === "reviewer").avatar).toMatch(/^data:image\/jpeg;base64,/);

    await card(page, task.id).click();
    const details = page.getByRole("dialog", { name: /Task details/ });
    await details.getByRole("button", { name: "Assignee: Build Bot. Choose assignee" }).click();
    const picker = page.getByRole("dialog", { name: "Choose assignee" });
    await picker.getByRole("searchbox").fill("reviewer");
    await expect(picker.getByText("Riley Reviewer")).toBeVisible();
  } finally {
    // Later tests identify the human by its plain ID.
    await command("update_profile", { name: "", avatar: "" });
    await command("update_profile", { name: "", avatar: "" }, agentToken);
  }
});

test("Markdown descriptions format, upload pasted images, and render safely", async ({ page }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const task = await command("create_task", {
    board: "TNB",
    title: `Markdown ${key()}`,
    // "| --- | — |" is what macOS smart dashes make of a typed divider row.
    description:
      "- [ ] First step\n\n<img src=x onerror=alert(1)> [bad](javascript:alert(1))\n\n| Column | Column |\n| --- | — |\n| Cell | Cell |\nDrag tasks",
  });
  await connect(page);
  await card(page, task.id).click();
  const dialog = page.getByRole("dialog", { name: /Task details/ });
  const preview = dialog.locator(".md-preview");
  // Existing descriptions open rendered; raw HTML and script URLs stay inert text.
  await expect(preview).toContainText("<img src=x onerror=alert(1)>");
  await expect(preview.locator("img, a[href^='javascript']")).toHaveCount(0);
  await expect(preview.getByRole("columnheader")).toHaveText(["Column", "Column"]);
  await expect(preview.getByRole("cell")).toHaveText(["Cell", "Cell"]);
  await expect(preview.locator("p").last()).toHaveText("Drag tasks");
  await preview.getByRole("checkbox", { name: "Mark item done" }).check();

  await dialog.getByRole("button", { name: "Write", exact: true }).click();
  const editor = dialog.getByLabel("Context", { exact: true });
  await expect(editor).toHaveValue(/^- \[x\] First step/);
  await editor.fill("Ship it");
  await editor.selectText();
  await dialog.getByRole("button", { name: "Bold" }).click();
  await expect(editor).toHaveValue("**Ship it**");
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await editor.press("Enter");
  await editor.pressSequentially("1. One");
  await editor.press("Enter");
  await expect(editor).toHaveValue("**Ship it**\n1. One\n2. ");
  await editor.evaluate((el, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const clip = new DataTransfer();
    clip.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clip, bubbles: true, cancelable: true }));
  }, png);
  await expect(editor).toHaveValue(/!\[shot\]\(\/files\/[0-9a-f]{32}\)$/);

  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(preview.locator("strong")).toHaveText("Ship it");
  const image = preview.getByRole("img", { name: "shot" });
  await expect(image).toHaveJSProperty("naturalWidth", 1);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const saved = await command("get_task", { id: task.id });
  expect(saved.description).toMatch(/^\*\*Ship it\*\*\n1\. One\n2\. \n!\[shot\]\(\/files\/[0-9a-f]{32}\)$/);
});

test("Epics group tasks: create, file, filter, progress and guarded archive", async ({ page }) => {
  const name = `Epic ${key()}`;
  const loose = await create(`Loose ${key()}`);
  await connect(page);
  await nav(page, "Epics").click();
  await page.getByRole("button", { name: "New epic" }).first().click();
  const epicDialog = page.getByRole("dialog", { name: "New epic" });
  await epicDialog.getByLabel("Title").fill(name);
  await epicDialog.getByRole("radio", { name: "Flamingo" }).check();
  await expect(epicDialog.locator(".epic-color-preview")).toContainText("Flamingo");
  await epicDialog.getByRole("button", { name: "Create epic" }).click();
  await expect(epicDialog).toBeHidden();
  const [epic] = (await command("list_epics")).epics.filter((e: { title: string }) => e.title === name);

  // Opening the epic shows its own board; New task starts inside it.
  await page.locator(".nav-epics").getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.getByRole("heading", { name: "No tasks in this epic yet." })).toBeVisible();
  await page.getByRole("button", { name: "New task in this epic" }).click();
  const taskDialog = page.getByRole("dialog", { name: "New task" });
  await expect(taskDialog.getByRole("button", { name: `Epic: ${name}. Choose epic` })).toBeVisible();
  await taskDialog.getByLabel("Title").fill(`${name} first task`);
  await taskDialog.getByRole("button", { name: "Create task" }).click();
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.getByRole("progressbar", { name: `${name} progress` })).toHaveAttribute("aria-valuetext", "0 of 1 tasks done");

  // An existing task moves in through its Epic picker.
  await nav(page, "Studio").click();
  await search(page).fill(loose.id);
  await card(page, loose.id).click();
  const details = page.getByRole("dialog", { name: /Task details/ });
  await details.getByRole("button", { name: "Epic: None. Choose epic" }).click();
  await page.getByRole("dialog", { name: "Choose epic" }).getByText(name, { exact: true }).click();
  await details.getByRole("button", { name: "Save changes" }).click();
  await expect(details).toBeHidden();
  await expect(page.locator(".task-card .epic-tag")).toContainText(name);
  expect((await command("get_task", { id: loose.id })).epic).toBe(epic.id);
  await search(page).fill("");
  await page.locator(".nav-epics").getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.locator(".task-card")).toHaveCount(2);
  await expect(page.locator(".task-card .epic-tag")).toHaveCount(0);

  expect(epic.color).toBe("flamingo");

  // A custom colour is saved as hex and tints the epic everywhere.
  await page.getByRole("button", { name: "Edit epic" }).click();
  const edit = page.getByRole("dialog", { name: /Edit epic/ });
  await edit.getByLabel("Custom color").fill("#12ab9c");
  await expect(edit.locator(".epic-color-preview")).toContainText("Custom #12ab9c");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await expect(page.locator(".page-title .epic-glyph")).toHaveCSS("background-color", "rgb(18, 171, 156)");
  const recolored = (await command("list_epics")).epics.find((e: { id: string }) => e.id === epic.id);
  expect(recolored.color).toBe("#12ab9c");

  // Open work blocks archiving; the server explains why.
  await page.getByRole("button", { name: "Edit epic" }).click();
  await edit.getByRole("button", { name: "Archive epic…" }).click();
  await edit.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(edit.getByRole("alert")).toContainText("still has 2 open tasks");
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeHidden();
});

test("Boards number their own tasks and can hide from the sidebar", async ({ page }) => {
  const id = `B${key().toUpperCase()}`;
  const title = `Board ${key()}`;
  await connect(page);
  await page.getByRole("button", { name: "New board" }).click();
  const dialog = page.getByRole("dialog", { name: "New board" });
  const idField = dialog.getByRole("textbox", { name: /^ID/ });
  await idField.fill(id.toLowerCase());
  await expect(idField).toHaveValue(id);
  await dialog.getByLabel("Title").fill(title);
  await expect(dialog.getByRole("checkbox", { name: "Show in the sidebar" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create board" }).click();
  await expect(dialog).toBeHidden();

  // The new board is listed in the sidebar and numbers its own tasks.
  await nav(page, title).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.getByRole("heading", { name: "No tasks on this board yet." })).toBeVisible();
  await page.getByRole("button", { name: "Create the first task" }).click();
  const taskDialog = page.getByRole("dialog", { name: "New task" });
  await taskDialog.getByLabel("Title").fill(`${title} task`);
  await taskDialog.getByRole("button", { name: "Create task" }).click();
  await expect(card(page, `${id}-001`)).toBeVisible();
  await expect(page.locator(".task-card")).toHaveCount(1);

  // Hiding keeps the board on the Boards page only.
  await page.getByRole("button", { name: "Edit board" }).click();
  const edit = page.getByRole("dialog", { name: /Edit board/ });
  await edit.getByRole("checkbox", { name: "Show in the sidebar" }).uncheck();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await expect(nav(page, title)).toHaveCount(0);
  const [saved] = (await command("list_boards")).boards.filter((b: { id: string }) => b.id === id);
  expect(saved.showInSidebar).toBe(false);
  await nav(page, "Boards").click();
  const listed = page.locator(".epic-card").filter({ hasText: title });
  await expect(listed).toContainText("Hidden from the sidebar");
  await listed.getByRole("button", { name: title }).click();
  await expect(card(page, `${id}-001`)).toBeVisible();
});
