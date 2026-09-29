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
  labels: string[];
  /** The board ID, which is also the prefix of the task ID. */
  board: string;
  /** An epic ID, or "" when the task is in no epic. */
  epic: string;
  version: number;
  commentCount: number;
  lease: null | { actor: string; expiresAt: number };
  updatedAt: string;
  standup?: { highlight: string; blocker: string };
  review?: { summary: string; artifactUrl: string; actor: string };
  events?: TaskEvent[];
};
/** A task container. Its ID is the prefix of its task IDs. */
export type Board = {
  id: string;
  title: string;
  showInSidebar: boolean;
  /** Former IDs that still redirect here, until a board takes them again. */
  formerIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Non-archived tasks per status, derived by the server. */
  counts: Record<Status, number>;
};
export type Epic = {
  /** A codename, custom or "EPIC-<n>". */
  id: string;
  board: string;
  title: string;
  description: string;
  /** A palette name, or a custom "#rrggbb". */
  color: string;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Non-archived tasks per status, derived by the server. */
  counts: Record<Status, number>;
};

export type Actor = {
  id: string;
  kind: "human" | "agent";
  /** Optional profile; empty means "show the ID". */
  name?: string;
  /** A small raster data URL, or empty for initials. */
  avatar?: string;
};
export type WorkspaceInfo = {
  name: string;
  actor: Actor;
  actors: Actor[];
  schemaVersion: 8;
};
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

/** A stable colour slot for free-text labels, never used as a class name. */
export function labelTone(label: string) {
  let hash = 0;
  for (const ch of label.toLowerCase())
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 6;
}

/** The server only accepts Done for reviewed work. */
export const doneLocked = (s: Status) => s !== "in_review" && s !== "done";

/** Tasks in an epic or on a board, and how many are Done. */
export function epicProgress(record: Pick<Epic, "counts">) {
  const total = Object.values(record.counts).reduce((sum, n) => sum + n, 0);
  return { total, done: record.counts.done, open: total - record.counts.done };
}

/** Orders task IDs by board prefix, then by number ("WEB-2" before "WEB-10"). */
export const compareTaskIds = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true });

/**
 * Epic colours, tuned to read on the charcoal surfaces. Names mirror
 * `epicColors` in server/domain.mjs, which validates them.
 */
export const epicPalette = [
  { id: "aurora", name: "Aurora", hex: "#5eead4" },
  { id: "lagoon", name: "Lagoon", hex: "#38bdf8" },
  { id: "cobalt", name: "Cobalt", hex: "#7b93ff" },
  { id: "iris", name: "Iris", hex: "#a78bfa" },
  { id: "orchid", name: "Orchid", hex: "#e08cf5" },
  { id: "flamingo", name: "Flamingo", hex: "#ff7eb6" },
  { id: "coral", name: "Coral", hex: "#ff8a6b" },
  { id: "tangerine", name: "Tangerine", hex: "#ffa94d" },
  { id: "saffron", name: "Saffron", hex: "#f5cf4f" },
  { id: "lime", name: "Lime", hex: "#b5e655" },
  { id: "jade", name: "Jade", hex: "#4fdc8f" },
  { id: "glacier", name: "Glacier", hex: "#a9c4e4" },
] as const;

/** The CSS colour of an epic; unknown values fall back to Glacier. */
export function epicColor(epic: Pick<Epic, "color">) {
  if (/^#[0-9a-f]{6}$/i.test(epic.color)) return epic.color;
  return (
    epicPalette.find((swatch) => swatch.id === epic.color)?.hex ?? "#a9c4e4"
  );
}

/** Inline style carrying an epic's colour into its CSS as `--epic`. */
export const epicStyle = (epic: Pick<Epic, "color">) =>
  ({ "--epic": epicColor(epic) }) as React.CSSProperties;
