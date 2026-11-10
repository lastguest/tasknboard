import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { credentialFor } from "../../server/local-auth.mjs";

test("production embedded resource edits and starts chat work through the local MCP bridge", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "tasknboard-embedded-resident-"));
  const secret = "browser-resident-secret-123456789";
  const runtime = join(dir, "runtime.json");
  const service = spawn(process.execPath, [resolve("server/http.mjs")], {
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: "0", TASKNBOARD_RESIDENT: "1",
      TASKNBOARD_DB: join(dir, "workspace.sqlite"), TASKNBOARD_LOCAL_SECRET: secret,
      TASKNBOARD_RUNTIME_FILE: runtime, TASKNBOARD_APP_DIR: resolve("dist-app"),
      TASKNBOARD_TOKENS: "", TASKNBOARD_ALLOWED_HOSTS: "", TASKNBOARD_CREDENTIAL_HELPER: "",
      TASKNBOARD_USER_HOME: dir, TASKNBOARD_SUPERVISOR_PID: "", TASKNBOARD_STOP_FILE: "",
    }, stdio: ["pipe", "ignore", "pipe"],
  });
  const client = new Client({ name: "embedded-resident-test", version: "1" });
  let transport: StdioClientTransport | undefined;
  try {
    await new Promise<void>((resolveReady, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Resident startup timeout: ${output}`)), 10000);
      service.stderr.on("data", chunk => {
        output += chunk;
        if (output.includes("listening")) { clearTimeout(timer); resolveReady(); }
      });
      service.once("exit", () => { clearTimeout(timer); reject(new Error(`Resident exited: ${output}`)); });
      service.once("error", reject);
    });
    const descriptor = JSON.parse(await readFile(runtime, "utf8"));
    expect(descriptor.pid).toBe(service.pid);
    expect(JSON.stringify(descriptor)).not.toContain(secret);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/mcp-bridge.mjs")],
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")) as Record<string, string>,
        TASKNBOARD_SERVER_URL: descriptor.mcpUrl,
        TASKNBOARD_TOKEN: credentialFor(secret, { id: "codex-app", kind: "app" }),
      },
    });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const opener = tools.find(tool => tool.name === "open_tasknboard")!;
    const resource = await client.readResource({ uri: opener._meta!.ui.resourceUri });
    const html = resource.contents[0].text as string;
    expect(resource.contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(html).toBe(await readFile("dist-app/index.html", "utf8"));
    const calls: { method: string; params: any; result?: any }[] = [];
    await page.exposeFunction("residentBridge", async (request: any) => {
      const call = { method: request.method, params: request.params, result: undefined as any };
      calls.push(call);
      if (request.id === undefined) return;
      if (request.method === "ui/initialize") {
        call.result = { protocolVersion: request.params.protocolVersion, hostInfo: { name: "Resident test host", version: "1" }, hostCapabilities: { serverTools: {}, message: { text: {} }, updateModelContext: { text: {} }, openLinks: {} }, hostContext: { displayMode: "inline" } };
      } else if (request.method === "tools/call") {
        call.result = await client.callTool(request.params);
      } else {
        call.result = {};
      }
      return call.result;
    });
    await page.route("**/resident-host", route => route.fulfill({ contentType: "text/html", body: `<iframe title="TasknBoard" src="/resident-ui" style="width:100%;height:900px;border:0"></iframe><script>window.addEventListener('message', async event => { const request=event.data; if(!request.method)return; try {const result=await window.residentBridge(request); if(request.id!==undefined)event.source.postMessage({jsonrpc:'2.0',id:request.id,result},'*');}catch(error){if(request.id!==undefined)event.source.postMessage({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:String(error)}},'*');}});</script>` }));
    await page.route("**/resident-ui", route => route.fulfill({ contentType: "text/html", body: html }));
    const directRequests: string[] = [];
    page.on("request", request => { if (request.url().includes("/api/")) directRequests.push(request.url()); });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(descriptor.url + "/resident-host");
    const ui = page.frameLocator('iframe[title="TasknBoard"]');
    await expect(ui.locator(".workspace-status .identity")).toContainText("you");
    await expect.poll(() => calls.find(call => call.params?.name === "ui_workspace_revision")?.result?._meta?.result?.revision).toMatch(/^\d+:\d+$/);
    const initialRevision = calls.find(call => call.params?.name === "ui_workspace_revision")!.result._meta.result.revision;
    await ui.getByRole("button", { name: "New task", exact: true }).click();
    const dialog = ui.getByRole("dialog", { name: "New task" });
    await dialog.getByLabel("Title", { exact: true }).fill("Resident embedded work");
    await dialog.getByLabel("Context", { exact: true }).fill("Created through production resource and real MCP.");
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    const card = ui.getByRole("button", { name: /TNB-\d+: Resident embedded work/ });
    await expect(card).toBeVisible();
    await card.click();
    const details = ui.getByRole("region", { name: /Task details/ });
    await details.getByLabel("Title", { exact: true }).fill("Resident embedded work edited");
    await details.getByRole("button", { name: "Save changes", exact: true }).click();
    const model = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return JSON.parse((result.content as any[])[0].text);
    };
    await expect.poll(async () => (await model("list_tasks")).tasks.some((item: any) => item.title === "Resident embedded work edited")).toBe(true);
    const tasks = await model("list_tasks");
    const task = tasks.tasks.find((item: any) => item.title === "Resident embedded work edited");
    expect(task).toBeTruthy();
    await details.getByRole("button", { name: "Work in chat", exact: true }).click();
    await expect.poll(() => calls.find(call => call.method === "ui/message")?.params.content[0].text).toContain("workSessionId");
    const prompt = calls.find(call => call.method === "ui/message")!.params.content[0].text;
    const work = calls.find(call => call.method === "tools/call" && call.params.name === "ui_start_chat_work")!.result._meta.result;
    expect(prompt).toContain(work.workSessionId);
    expect(prompt).toContain(task.id);
    expect(work.taskId).toBe(task.id);
    let current = await model("get_task", { id: task.id, workSessionId: work.workSessionId });
    expect(current.title).toBe("Resident embedded work edited");
    current = await model("claim_task", { id: task.id, expectedVersion: current.version, workSessionId: work.workSessionId });
    expect(current.lease.actor).toBe(work.actorId);
    expect(current.assignee).toBe("");
    current = await model("submit_review", { id: task.id, expectedVersion: current.version, workSessionId: work.workSessionId, summary: "Verified production resource and real MCP host forwarding." });
    expect(current.role).toBe("in_review");
    expect(current.lease).toBeNull();
    await expect.poll(() => calls.filter(call => call.params?.name === "ui_workspace_revision" && call.result).at(-1)?.result._meta.result.revision).not.toBe(initialRevision);
    await details.getByRole("button", { name: "Load latest", exact: true }).click();
    await expect(details.getByRole("button", { name: "Mark Done", exact: true })).toBeVisible();
    const revision = calls.find(call => call.method === "tools/call" && call.params.name === "ui_workspace_revision")!.result._meta.result;
    expect(revision.instanceId).toBe(descriptor.instanceId);
    expect(revision.revision).toMatch(/^\d+:\d+$/);
    expect(calls.some(call => call.method === "ui/notifications/initialized")).toBe(true);
    expect(directRequests).toEqual([]);
  } finally {
    await page.close();
        await client.close();
    service.kill("SIGTERM");
    await new Promise<void>(resolveExit => {
      if (service.exitCode !== null) return resolveExit();
      const timer = setTimeout(() => { service.kill("SIGKILL"); resolveExit(); }, 3000);
      service.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
    await rm(dir, { recursive: true, force: true });
  }
});
