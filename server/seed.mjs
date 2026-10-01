import { createStore } from "./store.mjs";
import { dbPath } from "./config.mjs";
const store = createStore(dbPath),
  actor = { id: "you", kind: "human" };
const boardId = store.execute("list_boards", {}, actor).boards[0].id;
if (store.execute("list_tasks", {}, actor).total)
  throw new Error("Demo seed only works on an empty workspace");
store.registerActors([
  actor,
  { id: "Morgan", kind: "human" },
  { id: "Priya", kind: "human" },
  { id: "Alex", kind: "human" },
  { id: "Taylor", kind: "human" },
  { id: "TasknBoard Agent", kind: "agent" },
]);
for (const [id, kind, name] of [
  ["Morgan", "human", "Morgan Reyes"],
  ["Priya", "human", "Priya Natarajan"],
  ["Alex", "human", "Alex Kowalski"],
  ["Taylor", "human", "Taylor Brooks"],
])
  store.execute("update_profile", { name }, { id, kind });
const epic = (title, description) =>
  store.execute("create_epic", { title, description }, actor).id;
const foundation = epic(
  "Workspace foundation",
  "Local-first storage, permissions and the agent protocol.",
);
const polish = epic(
  "First-run polish",
  "Make the first ten minutes pleasant for a new team.",
);
const lanes = Object.fromEntries(
  store
    .execute("list_boards", {}, actor)
    .boards[0].lanes.map((lane) => [lane.role, lane.id]),
);
const samples = [
  ["Define workspace architecture", "Infrastructure", "high", "you", "todo", foundation],
  ["Add keyboard navigation", "UX", "medium", "Morgan", "in_progress", polish],
  ["Implement local persistence", "Data", "medium", "Priya", "in_review", foundation],
  ["Agent claim protocol", "Agents", "high", "TasknBoard Agent", "todo", foundation],
  ["Review task permissions", "Security", "medium", "Alex", "in_progress", ""],
  ["Ship the first slice", "Product", "low", "Taylor", "done", ""],
  ["Polish empty states", "UX", "low", "TasknBoard Agent", "done", polish],
];
for (const [title, label, priority, assignee, role, epic] of samples) {
  let task = store.execute(
    "create_task",
    {
      boardId,
      title,
      labels: [label],
      priority,
      assignee,
      epic,
      description:
        "Demo task — replace this context with the scope, constraints and useful repository paths for your team.",
      acceptance:
        "Define observable acceptance criteria.\nInclude verification steps and relevant tests.",
    },
    actor,
  );
  // Done tasks pass through review first, as the workflow requires.
  for (const step of role === "done" ? ["in_review", "done"] : role === "todo" ? [] : [role])
    task = store.execute(
      "update_task",
      { id: task.id, expectedVersion: task.version, patch: { lane: lanes[step] } },
      actor,
    );
}
store.close();
console.log("Demo workspace created");
