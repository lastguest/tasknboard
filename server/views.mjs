/**
 * Saved-view filtering and ordering. Pure functions shared by the store
 * (list_tasks with a view) and the web interface, so both apply one rule.
 */

/** Task properties a view condition can test. */
export const viewFields = ["role", "lane", "priority", "assignee", "label", "epic", "delegated"];
/** Condition operators: the task has any of the values, or none of them. */
export const viewOps = ["is", "is_not"];
/** An assignee value that stands for whoever is looking at the view. */
export const ME = "@me";
export const viewLayouts = ["board", "list"];
export const viewGroups = ["lane", "assignee", "priority", "epic", "none"];
export const viewOrders = ["created", "updated", "priority", "title", "position"];

export const emptyFilters = () => ({ query: "", conditions: [] });
export const defaultDisplay = () => ({
  layout: "board",
  groupBy: "lane",
  orderBy: "priority",
});

/**
 * The values a task has for a field. "" stands for "none": no assignee,
 * no epic, or no labels.
 */
function valuesOf(task, field) {
  if (field === "delegated") return [String(Boolean(task.delegatedTo))];
  if (field === "label") return task.labels.length ? task.labels : [""];
  if (field === "epic") return [task.epic || ""];
  return [task[field] || ""];
}

/** True when the task satisfies every condition and the text query. */
export function taskMatchesView(task, filters, actorId) {
  const query = filters.query?.trim().toLowerCase();
  if (
    query &&
    !`${task.id} ${task.title} ${task.description}`
      .toLowerCase()
      .includes(query)
  )
    return false;
  return (filters.conditions ?? []).every(({ field, op, values }) => {
    const wanted = new Set(
      values.map((value) => (field === "assignee" && value === ME ? actorId : value)),
    );
    const hit = valuesOf(task, field).some((value) => wanted.has(value));
    return op === "is" ? hit : !hit;
  });
}

const priorityRank = { high: 0, medium: 1, low: 2 };
const taskNumber = (task) => Number(task.id.slice(task.id.lastIndexOf("-") + 1));

/** A new array in the view's order. Ties keep creation order. */
export function sortTasks(tasks, orderBy) {
  const byCreated = (a, b) => taskNumber(a) - taskNumber(b);
  const compare = {
    position: (a,b) => (a.position ?? 0) - (b.position ?? 0) || byCreated(a,b),
    created: byCreated,
    updated: (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || byCreated(a, b),
    priority: (a, b) =>
      priorityRank[a.priority] - priorityRank[b.priority] || (a.position ?? 0) - (b.position ?? 0) || byCreated(a, b),
    title: (a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
      byCreated(a, b),
  }[orderBy] ?? byCreated;
  return [...tasks].sort(compare);
}
