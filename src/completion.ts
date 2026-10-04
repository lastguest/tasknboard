import { completionPolicies, type Actor, type Task } from "./types";

export const completionTitles: Record<string, string> = Object.fromEntries(
  completionPolicies.map((policy) => [policy.id, policy.title]),
);

/** The server also checks authority and the evidence at the time of the write. */
export function canCompleteTask(actor: Actor, task: Task) {
  if (actor.kind === "human") return true;
  const mode = task.completionPolicy?.mode ?? "human";
  if (mode === "any_agent") return true;
  if (mode === "architect") return actor.role === "architect";
  if (mode === "any_agent_other_than_author")
    return Boolean(task.review?.author && task.review.author !== actor.id);
  return false;
}
