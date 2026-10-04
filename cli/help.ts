import { z } from "zod";
import { schemas } from "../server/domain.mjs";
import { acceptsTaskId } from "./arguments.ts";

const task = { id: "TNB-1", expectedVersion: 1 };
export const commandExamples: Record<string, Record<string, unknown>> = {
  list_tasks: { boardId: "BOARD-1", compact: true },
  get_task: { id: "TNB-1" },
  find_similar_tasks: { title: "Ship it", boardId: "BOARD-1" },
  get_tasks: { ids: ["TNB-1", "TNB-2"] },
  create_task: { boardId: "BOARD-1", title: "Ship it" },
  update_task: { ...task, patch: { title: "Ship the app" } },
  set_standup_notes: { ...task, highlight: "Code complete", blocker: "" },
  claim_task: task,
  heartbeat: task,
  release_task: task,
  delegate_task: { ...task, delegatedTo: "worker-1" },
  request_changes: { ...task, reason: "Add the missing check" },
  reject_task: { ...task, reason: "The task is no longer needed" },
  list_notifications: { after: 0 },
  link_commits: { ...task, commits: ["abcdef1234567890"] },
  add_comment: { id: "TNB-1", body: "The change is ready" },
  submit_review: { ...task, summary: "The change is ready", artifacts: [{ title: "Check log", url: "https://ci.example/check/1" }], verifiedBy: [{ agent: "codex/checker", checks: "The app build passed" }], via: "sonnet#run-1" },
  archive_task: task,
  restore_task: task,
  link_task: { ...task, type: "blocks", target: "TNB-2" },
  unlink_task: { ...task, target: "TNB-2" },
  link_pull_requests: { ...task, pullRequests: ["acme/app#7"] },
  unlink_pull_request: { ...task, pullRequest: "acme/app#7" },
  update_profile: { name: "Alex" },
  upload_image: { data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=" },
  list_epics: { boardId: "BOARD-1" },
  create_epic: { boardId: "BOARD-1", title: "Release", completionPolicy: "inherit" },
  update_epic: { id: "TNB-1", expectedVersion: 1, patch: { completionPolicy: "any_agent_other_than_author" } },
  archive_epic: { id: "TNB-1", expectedVersion: 1 },
  list_views: {},
  create_view: { name: "My work" },
  update_view: { id: "VIEW-1", expectedVersion: 1, patch: { name: "Team work" } },
  delete_view: { id: "VIEW-1", expectedVersion: 1 },
  favorite_view: { id: "VIEW-1", favorite: true },
  list_boards: {},
  create_board: { name: "Engineering", prefix: "ENG" },
  update_board: { id: "BOARD-1", expectedVersion: 1, patch: { policy: { humanCompletionOnly: false, completionMode: "architect", labelCompletionPolicies: { bug: "human" } } } },
  create_lane: { boardId: "BOARD-1", expectedVersion: 1, name: "Ready", role: "todo" },
  update_lane: { id: "LANE-11", expectedVersion: 1, patch: { name: "Ready" } },
  delete_lane: { id: "LANE-11", expectedVersion: 1, moveTo: "LANE-12" },
  set_board_sidebar: { id: "BOARD-1", inSidebar: true },
  list_labels: {},
  rename_label: { from: "bug", to: "defect" },
  list_inbox: { limit: 50 },
  mark_inbox_read: { upTo: 1 },
  workspace_info: {},
  export_workspace: {},
  bulk_create_tasks: { tasks: [{ boardId: "BOARD-1", title: "Ship it" }] },
  bulk_move_tasks: { tasks: [task], lane: "LANE-12" },
  claim_tasks: { tasks: [task] },
  add_comments: { comments: [{ id: "TNB-1", body: "The check passed", via: "sonnet#run-1" }] },
  submit_reviews: { reviews: [{ ...task, summary: "The change is ready" }] },
  undo_task: task,
  reorder_task: { ...task, position: 0 },
  critical_path: { id: "TNB-1" },
  list_activity: { boardId: "BOARD-1", hours: 24 },
  list_milestones: { boardId: "BOARD-1" },
  create_milestone: { boardId: "BOARD-1", title: "Release", criteria: [{ text: "The build passes", checked: false }] },
  update_milestone: { id: "MILESTONE-1", expectedVersion: 1, patch: { title: "Release candidate" } },
  archive_milestone: { id: "MILESTONE-1", expectedVersion: 1 },
  set_label_color: { label: "bug", color: "coral" },
  upload_artifact: { title: "Check log", dataUrl: "data:text/plain;base64,cGFzcw==" },
};

export function commandHelp(command: string, platform: string = process.platform): string {
  if (!Object.hasOwn(schemas, command))
    throw Object.assign(new Error(`Unknown command: ${command}. Run tasknboard help for the command list.`), { code: "USAGE" });
  const schema = z.toJSONSchema(schemas[command], { io: "input", unrepresentable: "any" });
  const required = schema.required ?? [];
  const optional = Object.keys(schema.properties ?? {}).filter((key) => !required.includes(key));
  const windows = platform === "win32";
  const lines = [
    `Usage: tasknboard ${command} --file <path>`,
    `       tasknboard ${command} --stdin`,
    ...(!windows ? [`       tasknboard ${command} '[json]'`] : []),
    `Required fields: ${required.join(", ") || "none"}`,
    `Optional fields: ${optional.join(", ") || "none"}`,
    "", "Save this JSON in args.json:",
    JSON.stringify(commandExamples[command]),
    "", "Example:",
    `  tasknboard ${command} --file args.json`,
    "", "On Windows, use --file or --stdin for all JSON input.",
    `PowerShell: Get-Content -Raw -Encoding utf8 args.json | tasknboard ${command} --stdin`,
    "Use one input mode per command.",
    ...(windows ? ["Do not put JSON in tasknboard.cmd arguments. cmd.exe can interpret JSON text as shell commands."]
      : [`Direct JSON is also supported in shells that preserve it: tasknboard ${command} '${JSON.stringify(commandExamples[command])}'`]),
  ];
  if (acceptsTaskId(command)) lines.push("", "Use id or taskId for the task key. If you set both, they must match.");
  const taskBatch = ["bulk_move_tasks", "claim_tasks", "add_comments", "submit_reviews"].includes(command);
  if (taskBatch) lines.push("", "Each task entry accepts id or taskId. Versioned actions require expectedVersion.");
  if (JSON.stringify(schema).includes('"expectedVersion"')) {
    const read = acceptsTaskId(command) || taskBatch
      ? "get_task" : command.endsWith("milestone") ? "list_milestones" : command.endsWith("epic") ? "list_epics" : command.endsWith("view") ? "list_views" : "list_boards";
    lines.push("", `Read ${read} before the mutation. Use the current version as expectedVersion.`,
      "The example version is a placeholder. The CLI does not fetch a version for you.");
    if (command.endsWith("lane") || command === "create_lane") lines.push("Lane mutations use the board version from list_boards.");
  }
  if (command === "update_profile") lines.push("", "A human can set an agent role with {\"agentId\":\"worker-1\",\"role\":\"architect\"}.");
  if (["create_board", "update_board", "create_epic", "update_epic", "update_task", "submit_review", "submit_reviews"].includes(command))
    lines.push("", "Read get_task.completionPolicy before task completion. It gives the effective mode and its source.",
      "Modes: human, any_agent, architect, any_agent_other_than_author, auto_on_evidence.",
      "Label policies override epic policies. Epic policies override the board default.",
      "The board uses human while humanCompletionOnly is true. Otherwise it uses completionMode.",
      "An epic completionPolicy of inherit uses the board default. labelCompletionPolicies maps labels to modes.",
      "auto_on_evidence needs an artifact and every linked commit on the configured default branch.",
      "Configure origin/HEAD. The check uses its local branch when present, otherwise its remote branch.",
      "Uncertain evidence keeps the task in review. Read autoCompletion.reason. The scanner checks after later merges.");
  if (command === "list_tasks") lines.push("", "Select completionPolicy, completion, or autoCompletion in fields to read approval rules and evidence state.");
  return lines.join("\n");
}
