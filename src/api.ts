import type { Task } from "./types";

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
  timeoutMs = 15000,
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
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(
      "Can't reach the workspace service. Nothing was saved.",
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

/**
 * Follows the server's change stream until `signal` aborts. Calls `onChange`
 * when the stream opens, on each change event, and when an open stream is
 * lost: each time the loaded data may be stale. Reconnects with a backoff
 * from 1 s to 30 s. EventSource cannot send the bearer header, so this reads
 * the stream with fetch.
 */
export async function subscribeChanges(
  onChange: () => void,
  signal: AbortSignal,
) {
  let delay = 1000;
  while (!signal.aborted) {
    // The server pings every 25 s; silence means a dead connection.
    const idle = new AbortController();
    let timer = 0;
    const alive = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => idle.abort(), 60000);
    };
    let opened = false;
    try {
      const bearer = token.get();
      alive();
      const res = await fetch("/api/stream", {
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
        signal: AbortSignal.any([signal, idle.signal]),
      });
      if (res.ok && res.body) {
        opened = true;
        delay = 1000;
        onChange();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          alive();
          buffer += value;
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          if (blocks.some((b) => b.split("\n").includes("event: change")))
            onChange();
        }
      }
    } catch {
      // A failed or dropped stream reconnects below.
    } finally {
      window.clearTimeout(timer);
    }
    if (signal.aborted) return;
    if (opened) onChange();
    await new Promise<void>((resolve) => {
      const wait = window.setTimeout(resolve, delay);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(wait);
          resolve();
        },
        { once: true },
      );
    });
    delay = Math.min(delay * 2, 30000);
  }
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
