import { invoke } from "@tauri-apps/api/core";
import type { Task } from "./types";
import { embeddedApp, workspaceChanged } from "./embedded";

export const nativeWorkspace = () => window.tasknboardDesktop === true;

const TOKEN_KEY = "tasknboard-token";

/** A failed command. `code` mirrors the server's DomainError codes. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY) || "",
  set: (value: string) =>
    value
      ? sessionStorage.setItem(TOKEN_KEY, value)
      : sessionStorage.removeItem(TOKEN_KEY),
};

export async function command<T>(
  name: string,
  args: unknown = {},
  signal?: AbortSignal,
  timeoutMs = ["pick_folder", "export_file", "service-connect"].includes(name) ? 130000 : 15000,
): Promise<T> {
  const app = embeddedApp();
  if (app) {
    const result = await app.callServerTool({ name: `ui_${name.replaceAll("-", "_")}`, arguments: args as Record<string, unknown> }, { signal, timeout: timeoutMs });
    if (result.isError) {
      const block = result.content.find(item => item.type === "text");
      let error: { message?: string; code?: string; status?: number; details?: Record<string, unknown> } = {};
      try { error = JSON.parse(block?.type === "text" ? block.text : "{}"); } catch { /* Preserve a useful error for malformed results. */ }
      throw new ApiError(error.message || "The workspace command failed.", error.code || "TOOL_ERROR", error.status || 0, error.details);
    }
    if (!result._meta || !("result" in result._meta)) throw new ApiError("The workspace returned an invalid tool result.", "BAD_RESPONSE", 0);
    if (!/^(list_|get_|find_|search_|workspace_|read_|agent_configs$|agent_logs$|export_workspace$|pick_folder$|export_file$|.*(?:status|config)$)/.test(name.replaceAll("-", "_"))) workspaceChanged.dispatchEvent(new Event("change"));
    return result._meta.result as T;
  }
  const bearer = token.get();
  let res: Response;
  try {
    if (nativeWorkspace()) {
      signal?.throwIfAborted();
      const result = await invoke<{ status: number; text: string }>("workspace_command", { name, args });
      signal?.throwIfAborted();
      res = new Response(result.text, { status: result.status });
    } else res = await fetch(`/api/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(args),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(
      "Cannot reach the workspace service. A write can complete before a connection fails. Read the current state before retrying.",
      "NETWORK",
      0,
    );
  }
  let value: { code?: string; message?: string; details?: Record<string, unknown> } & Record<string, unknown>;
  try {
    value = await res.json();
  } catch {
    throw new ApiError(
      `The workspace service returned an unexpected response (${res.status}).`,
      "BAD_RESPONSE",
      res.status,
    );
  }
  if (!res.ok)
    throw new ApiError(
      value.message || `Request failed (${res.status})`,
      value.code || (res.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR"),
      res.status,
      value.details,
    );
  return value as T;
}

export const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? e
    : new ApiError((e as Error)?.message || "Unexpected error", "UNKNOWN", 0);

export const taskNumber = (id: string) =>
  Number(id.slice(id.lastIndexOf("-") + 1));

/** Read every page so no task is silently dropped by the API page size. */
export async function loadTasks(boardId: string, archived = false) {
  const byId = new Map<string, Task>();
  let offset = 0,
    total = 0;
  do {
    const page = await command<{ tasks: Task[]; total: number }>("list_tasks", {
      boardId,
      archived,
      limit: 100,
      offset,
    });
    for (const task of page.tasks) byId.set(task.id, task);
    total = page.total;
    offset += page.tasks.length;
    if (!page.tasks.length) break;
  } while (offset < total);
  return [...byId.values()].sort((a, b) => taskNumber(a.id) - taskNumber(b.id));
}

/** Export through the host in embedded mode, or the browser download action. */
export async function downloadText(name: string, mime: string, text: string) {
  const app = embeddedApp();
  if (app) {
    if (app.getHostCapabilities()?.downloadFile) {
      const result = await app.downloadFile({ contents: [{ type: "resource", resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType: mime, text } }] });
      if (result.isError) throw new ApiError("The host cancelled the export.", "EXPORT_CANCELLED", 0);
    } else {
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const result = await command<{ saved: boolean }>("export_file", { name, mime, data: btoa(binary) });
      if (!result.saved) throw new ApiError("The export was cancelled.", "EXPORT_CANCELLED", 0);
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
