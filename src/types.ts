import type { ViewDisplay, ViewFilters } from "../server/views.mjs";
export type Status = "backlog" | "in_progress" | "in_review" | "done";
export type Priority = "low" | "medium" | "high";
export type TaskEvent = {
  sequence: number;
  actor: string;
  kind: string;
  body: string;
  createdAt: string;
};
/** How a task relates to another, read from the first task's side. */
export type LinkType =
  | "relates"
  | "blocks"
  | "blocked_by"
  | "duplicates"
  | "duplicated_by";
export const linkTypes: { id: LinkType; title: string }[] = [
  { id: "blocks", title: "Blocks" },
  { id: "blocked_by", title: "Blocked by" },
  { id: "relates", title: "Related to" },
  { id: "duplicates", title: "Duplicates" },
  { id: "duplicated_by", title: "Duplicated by" },
];
export const linkTitle = (type: LinkType) =>
  linkTypes.find((t) => t.id === type)?.title ?? type;
/** The other task of a link, as `get_task` returns it. */
export type TaskLink = {
  type: LinkType;
  id: string;
  title: string;
  status: Status;
  archived: boolean;
};
/** A GitHub pull request linked to a task with `link_pull_requests`. */
export type TaskPullRequest = {
  /** `owner/repo`. */
  repository: string;
  number: number;
  /** The canonical `https://github.com/owner/repo/pull/n` URL. */
  url: string;
};
export type Task = {
  id: string;
  boardId: string;
  title: string;
  description: string;
  acceptance: string;
  status: Status;
  priority: Priority;
  assignee: string;
  labels: string[];
  /** An epic ID, or "" when the task is in no epic. */
  epic: string;
  version: number;
  commentCount: number;
  lease: null | { actor: string; expiresAt: number };
  updatedAt: string;
  standup?: { highlight: string; blocker: string };
  review?: { summary: string; artifactUrl: string; actor: string };
  /** Absent until a pull request is linked. */
  pullRequests?: TaskPullRequest[];
  /** Present on `get_task` and write results, not on `list_tasks`. */
  links?: TaskLink[];
  events?: TaskEvent[];
};
export type Epic = {
  id: string;
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

export type {
  ViewCondition,
  ViewDisplay,
  ViewField,
  ViewFilters,
  ViewGroup,
  ViewOrder,
} from "../server/views.mjs";

/** A saved view: named filters and display settings (docs/contracts/views.md). */
export type SavedView = {
  id: string;
  name: string;
  description: string;
  /** A palette name, or a custom "#rrggbb", like epics. */
  color: string;
  owner: string;
  /** Workspace view when true; otherwise only the owner sees it. */
  shared: boolean;
  filters: ViewFilters;
  display: ViewDisplay;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Starred by the reader; per person. */
  favorite: boolean;
};

export type Actor = {
  id: string;
  kind: "human" | "agent";
  /** Optional profile; empty means "show the ID". */
  name?: string;
  /** A small raster data URL, or empty for initials. */
  avatar?: string;
  /** Whether the shared roster should display this actor's Gravatar. */
  useGravatar?: boolean;
  /** Server-generated Gravatar image URL; never contains the email address. */
  gravatarUrl?: string;
  /** Present only on the authenticated actor's own profile response. */
  gravatarEmail?: string;
};
/** A board that owns task IDs and scopes task queries. */
export type BoardRecord = {
  id: string;
  name: string;
  prefix: string;
  /** Plain text shown under the board title; "" means none. */
  description: string;
  /** Absolute folder where agents assigned a task on this board start work; "" means none. */
  repository: string;
  /** Retired prefixes whose task keys still resolve on this board. */
  formerPrefixes: string[];
  /** Whether the caller lists this board in the sidebar. Each person sets it. */
  inSidebar: boolean;
  /** Active tasks In progress on this board. */
  inProgress: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type WorkspaceInfo = {
  name: string;
  actor: Actor;
  actors: Actor[];
  boards: BoardRecord[];
  schemaVersion: number;
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

/** Stand-up notes, which stop mattering once the task is Done. */
export const standupNotes = (task: Task, status: Status = task.status) =>
  status === "done" ? undefined : task.standup;

/** The server only accepts Done for reviewed work. */
export const doneLocked = (s: Status) => s !== "in_review" && s !== "done";

/** Tasks in an epic and how many are Done. */
export function epicProgress(epic: Epic) {
  const total = Object.values(epic.counts).reduce((sum, n) => sum + n, 0);
  return { total, done: epic.counts.done, open: total - epic.counts.done };
}

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
