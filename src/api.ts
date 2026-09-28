import type { Task } from "./types";
export async function command<T>(
  name: string,
  args: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = sessionStorage.getItem("tasknboard-token");
  const res = await fetch(`/api/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(args),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const value = await res.json();
  if (!res.ok)
    throw new Error(value.message || `Request failed (${res.status})`);
  return value;
}
export async function loadTasks() {
  let tasks: Task[] = [];
  let total = 0;
  do {
    const page = await command<{ tasks: Task[]; total: number }>("list_tasks", {
      limit: 100,
      offset: tasks.length,
    });
    tasks.push(...page.tasks);
    total = page.total;
    if (!page.tasks.length) break;
  } while (tasks.length < total);
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
