import { createStore } from "./store.mjs";
import { dbPath } from "./config.mjs";
const store = createStore(dbPath),
  actor = { id: "you", kind: "human" };
if (store.execute("list_tasks", {}, actor).total)
  throw new Error("Demo seed only works on an empty workspace");
const samples = [
  ["Define workspace architecture", "Infrastructure", "high", "you", "backlog"],
  ["Add keyboard navigation", "UX", "medium", "Morgan", "in_progress"],
  ["Implement local persistence", "Data", "medium", "Priya", "in_review"],
  ["Agent claim protocol", "Agents", "high", "TasknBoard Agent", "backlog"],
  ["Review task permissions", "Security", "medium", "Alex", "in_progress"],
  ["Ship the first slice", "Product", "low", "Taylor", "done"],
  ["Polish empty states", "UX", "low", "TasknBoard Agent", "done"],
];
for (const [title, label, priority, assignee, status] of samples) {
  let task = store.execute(
    "create_task",
    {
      title,
      label,
      priority,
      assignee,
      description:
        "Demo task — replace this context with the scope, constraints and useful repository paths for your team.",
      acceptance:
        "Define observable acceptance criteria.\nInclude verification steps and relevant tests.",
    },
    actor,
  );
  if (["in_review", "done"].includes(status))
    task = store.execute(
      "update_task",
      {
        id: task.id,
        expectedVersion: task.version,
        patch: { status: "in_review" },
      },
      actor,
    );
  if (status !== "backlog")
    store.execute(
      "update_task",
      { id: task.id, expectedVersion: task.version, patch: { status } },
      actor,
    );
}
store.close();
console.log("Demo workspace created");
