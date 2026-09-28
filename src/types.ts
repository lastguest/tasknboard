export type Status = "backlog" | "in_progress" | "in_review" | "done";
export type Task = {
  id: string;
  title: string;
  description: string;
  acceptance: string;
  status: Status;
  priority: "low" | "medium" | "high";
  assignee: string;
  label: string;
  version: number;
  lease: null | { actor: string; expiresAt: number };
  updatedAt: string;
  standup?: { highlight: string; blocker: string };
  review?: { summary: string; artifactUrl: string; actor: string };
  events?: {
    sequence: number;
    actor: string;
    kind: string;
    body: string;
    createdAt: string;
  }[];
};
export type Actor = { id: string; kind: "human" | "agent" };
export const columns: { id: Status; title: string; color: string }[] = [
  { id: "backlog", title: "Backlog", color: "#88909e" },
  { id: "in_progress", title: "In progress", color: "#e8bd5a" },
  { id: "in_review", title: "In review", color: "#bca0f4" },
  { id: "done", title: "Done", color: "#9de3c1" },
];
