export type Status = "backlog" | "in_progress" | "in_review" | "done";
export type Priority = "low" | "medium" | "high";
export type TaskEvent = {
  sequence: number;
  actor: string;
  kind: string;
  body: string;
  createdAt: string;
};
export type Task = {
  id: string;
  title: string;
  description: string;
  acceptance: string;
  status: Status;
  priority: Priority;
  assignee: string;
  label: string;
  version: number;
  lease: null | { actor: string; expiresAt: number };
  updatedAt: string;
  standup?: { highlight: string; blocker: string };
  review?: { summary: string; artifactUrl: string; actor: string };
  events?: TaskEvent[];
};
export type Actor = { id: string; kind: "human" | "agent" };
export const columns: { id: Status; title: string; color: string }[] = [
  { id: "backlog", title: "Backlog", color: "#88909e" },
  { id: "in_progress", title: "In progress", color: "#e8bd5a" },
  { id: "in_review", title: "In review", color: "#bca0f4" },
  { id: "done", title: "Done", color: "#9de3c1" },
];
export const statusTitle = (s: Status) =>
  columns.find((c) => c.id === s)?.title ?? s;
export const priorities: { id: Priority; title: string }[] = [
  { id: "low", title: "Low" },
  { id: "medium", title: "Medium" },
  { id: "high", title: "High" },
];

export const activeLease = (t: Task, now = Date.now()) =>
  t.lease && t.lease.expiresAt > now ? t.lease : null;

/**
 * Assignees are free text, so agent identity is inferred: names that hold or
 * held a claim, or that look like an agent. This is not connection telemetry.
 */
export function agentNames(tasks: Task[], actor: Actor) {
  const names = new Set<string>();
  for (const t of tasks) {
    if (t.lease && !(actor.kind === "human" && t.lease.actor === actor.id))
      names.add(t.lease.actor);
    if (/\b(agent|codex|claude|bot|gpt|copilot)\b/i.test(t.assignee))
      names.add(t.assignee);
  }
  if (actor.kind === "agent") names.add(actor.id);
  return names;
}

/** Only render review artifacts that are plain web links. */
export function safeUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function relativeTime(ms: number, now = Date.now()) {
  const diff = Math.round((ms - now) / 60000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diff) < 60) return rtf.format(diff, "minute");
  return rtf.format(Math.round(diff / 60), "hour");
}

/** A stable colour slot for free-text labels, never used as a class name. */
export function labelTone(label: string) {
  let hash = 0;
  for (const ch of label.toLowerCase())
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 6;
}

/** The server only accepts Done for reviewed work. */
export const doneLocked = (s: Status) => s !== "in_review" && s !== "done";
