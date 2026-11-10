import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
async function api(name: string, args: object = {}) {
  const response = await fetch(`${baseURL}/api/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${humanToken}` }, body: JSON.stringify(args) });
  return { body: await response.json(), status: response.status, ok: response.ok };
}

test("Embedded UI initializes, writes through tools, preserves conflicts, and sends chat work", async ({ page }) => {
  const html = await readFile("dist-app/index.html", "utf8");
  const task = (await api("create_task", { boardId: "BOARD-1", title: `Embedded ${randomUUID().slice(0, 8)}`, description: "Context ![Workspace image](/files/0123456789abcdef0123456789abcdef)", acceptance: "Verified" })).body;
  const calls: { method: string; params: any }[] = [];
  let conflict = false;
  let revision = 1;
  let offline = false;
  await page.exposeFunction("bridgeRequest", async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "ui/initialize") return { protocolVersion: params.protocolVersion, hostInfo: { name: "Test host", version: "1" }, hostCapabilities: { serverTools: {}, message: { text: {} }, updateModelContext: { text: {} }, downloadFile: {}, openLinks: {} }, hostContext: { displayMode: "inline" } };
    if (method !== "tools/call") return {};
    const name = params.name.replace(/^ui_/, "");
    if (name === "workspace_revision" && offline) throw new Error("Resident is offline");
    if (name === "workspace_revision") return { content: [], _meta: { result: { instanceId: "test", revision } } };
    if (name === "read_image") return { content: [], _meta: { result: { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7V8AAAAASUVORK5CYII=" } } };
    if (name === "service_status") return { content: [], _meta: { result: { resident: true, instanceId: "test", connected: true, native: { available: false, platform: "test" }, appPlugin: { installed: false, enabled: false } } } };
    if (name === "start_chat_work") return { content: [], _meta: { result: { workSessionId: "chat-session", taskId: task.id, boardId: "BOARD-1", actorId: "chat-agent", repository: "/test/repo" } } };
    if (conflict && name === "update_task") return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "CONFLICT", status: 409, message: "Task changed elsewhere." }) }] };
    const result = await api(name, params.arguments);
    return result.ok ? { content: [], structuredContent: { ok: true }, _meta: { result: result.body } } : { isError: true, content: [{ type: "text", text: JSON.stringify({ ...result.body, status: result.status }) }] };
  });
  await page.route("**/embedded-host", route => route.fulfill({ contentType: "text/html", body: `<iframe title="TasknBoard" src="/embedded-ui" style="width:100%;height:900px;border:0"></iframe><script>window.addEventListener('message', async event => { const request = event.data; if (request.id === undefined || !request.method) return; try { const result = await window.bridgeRequest(request.method, request.params); event.source.postMessage({jsonrpc:'2.0',id:request.id,result}, '*'); } catch(error) { event.source.postMessage({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:String(error)}}, '*'); } });</script>` }));
  await page.route("**/embedded-ui", route => route.fulfill({ contentType: "text/html", body: html }));
  let directApiRequests = 0;
  page.on("request", request => { if (request.url().includes("/api/")) directApiRequests++; });
  await page.goto(`${baseURL}/embedded-host`);
  const ui = page.frameLocator('iframe[title="TasknBoard"]');
  await expect(ui.locator(".workspace-status .identity")).toContainText("reviewer");
  await ui.getByRole("button", { name: new RegExp(`${task.id}: ${task.title}`) }).click();
  await expect(ui.getByRole("img", { name: "Workspace image" })).toHaveAttribute("src", /^blob:/);
  await ui.getByRole("button", { name: "Work in chat" }).click();
  await expect.poll(() => calls.find(call => call.method === "ui/message")?.params.content[0].text).toContain("chat-session");
  expect(calls.find(call => call.method === "ui/message")?.params.content[0].text).toContain("/test/repo");
  const title = ui.getByLabel("Title", { exact: true });
  await title.fill(`${task.title} edited`);
  await ui.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await api("get_task", { id: task.id })).body.title).toBe(`${task.title} edited`);
  await expect.poll(() => calls.filter(call => call.params?.name === "ui_workspace_revision").length).toBeGreaterThan(0);
  const draft = `${task.title} unsaved draft`;
  await title.fill(draft);
  offline = true;
  await expect(ui.locator(".workspace-status")).toHaveClass(/offline/);
  await expect(title).toHaveValue(draft);
  offline = false;
  await expect(ui.locator(".workspace-status")).toHaveClass(/online/);
  await expect(title).toHaveValue(draft);
  conflict = true;
  await title.fill(`${task.title} conflict`);
  await ui.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(ui.getByRole("alert")).toContainText(/changed|conflict/i);
  await ui.locator(".sidebar").getByRole("button", { name: "Settings" }).click();
  const settings = ui.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Connection & data", exact: true }).click();
  await expect(settings.getByRole("region", { name: "Connect to Codex" })).toContainText("Workspace service: connected. Codex app: not installed.");
  await settings.getByRole("button", { name: "Export workspace", exact: true }).click();
  await expect.poll(() => calls.some(call => call.method === "ui/download-file")).toBe(true);
  const exported = calls.find(call => call.method === "ui/download-file")!.params.contents[0].resource;
  expect(exported.mimeType).toBe("application/json");
  expect(JSON.parse(exported.text).tasks.some((item: any) => item.id === task.id)).toBe(true);
  await settings.press("Escape");
  const external = (await api("create_task", { boardId: "BOARD-1", title: "Created outside embedded UI" })).body;
  const readsBefore = calls.filter(call => call.method === "tools/call" && call.params.name === "ui_list_tasks").length;
  revision++;
  await expect.poll(() => calls.filter(call => call.method === "tools/call" && call.params.name === "ui_list_tasks").length).toBeGreaterThan(readsBefore);
  await ui.getByRole("navigation", { name: "Open tasks" }).getByRole("button", { name: "Default", exact: true }).click();
  await expect(ui.getByRole("button", { name: new RegExp(`${external.id}: Created outside embedded UI`) })).toBeVisible();
  const appFrame = page.frames().find(frame => frame.url().endsWith("/embedded-ui"))!;
  await appFrame.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const pollsBefore = calls.filter(call => call.method === "tools/call" && call.params.name === "ui_workspace_revision").length;
  await page.waitForTimeout(3200);
  expect(calls.filter(call => call.method === "tools/call" && call.params.name === "ui_workspace_revision")).toHaveLength(pollsBefore);
  await appFrame.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => calls.filter(call => call.method === "tools/call" && call.params.name === "ui_workspace_revision").length).toBeGreaterThan(pollsBefore);
  expect(directApiRequests).toBe(0);
  expect(calls.some(call => call.method === "ui/update-model-context" && call.params.structuredContent.taskId === task.id)).toBe(true);
  expect(calls.filter(call => call.method === "ui/update-model-context").every(call => !JSON.stringify(call.params).includes("Verified"))).toBe(true);
});

test("Desktop adapter keeps a draft across a resident restart without browser API calls", async ({ page }) => {
  const task = (await api("create_task", {
    boardId: "BOARD-1", title: `Desktop ${randomUUID().slice(0, 8)}`,
  })).body;
  let instanceId = "first";
  let offline = false;
  await page.exposeFunction("nativeRequest", async (name: string, args: object) => {
    if (offline) throw new Error("Resident unavailable");
    if (name === "workspace-revision")
      return { status: 200, text: JSON.stringify({ instanceId, revision: "1:1" }) };
    const result = await api(name, args);
    return { status: result.status, text: JSON.stringify(result.body) };
  });
  await page.addInitScript(() => {
    window.tasknboardDesktop = true;
    // Native WebKit can keep reporting hidden even while the window accepts input.
    Object.defineProperty(document, "hidden", { get: () => true });
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: (name: string, args: { name: string; args: object }) =>
          name === "workspace_command"
            ? (window as any).nativeRequest(args.name, args.args)
            : Promise.resolve("test"),
      },
    });
  });
  const directRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/")) directRequests.push(request.url());
  });
  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(`${task.id}: ${task.title}`) }).click();
  const title = page.getByLabel("Title", { exact: true });
  await title.fill(`${task.title} draft`);
  offline = true;
  await expect(page.locator(".workspace-status")).toHaveClass(/offline/);
  instanceId = "second";
  offline = false;
  await expect(page.locator(".workspace-status")).toHaveClass(/online/);
  await expect(title).toHaveValue(`${task.title} draft`);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await api("get_task", { id: task.id })).body.title)
    .toBe(`${task.title} draft`);
  expect(directRequests).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem("tasknboard-token"))).toBeNull();
});
