import type { Task } from "./types";

const TOKEN_KEY = "tasknboard-token";

/** A failed command. `code` mirrors the server's DomainError codes. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
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
): Promise<T> {
  const bearer = token.get();
  let res: Response;
  try {
    res = await fetch(`/api/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(args),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(
      "Can't reach the workspace service. Nothing was saved.",
      "NETWORK",
      0,
    );
  }
  let value: { code?: string; message?: string } & Record<string, unknown>;
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
export async function loadTasks(boardId: string) {
  const byId = new Map<string, Task>();
  let offset = 0,
    total = 0;
  do {
    const page = await command<{ tasks: Task[]; total: number }>("list_tasks", {
      boardId,
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
