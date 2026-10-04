import { z } from "zod";
import { schemas } from "../server/domain.mjs";
import { acceptsTaskId } from "./arguments.ts";

const task = { id: "TNB-1", expectedVersion: 1 };
export const commandExamples: Record<string, Record<string, unknown>> = {
  list_tasks: { boardId: "BOARD-1" },
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
  list_notifications: { after: 0 },
  link_commits: { ...task, commits: ["abcdef1234567890"] },
  add_comment: { id: "TNB-1", body: "The change is ready" },
  submit_review: { ...task, summary: "The change is ready", artifactUrl: "src/main.ts" },
  archive_task: task,
  link_task: { ...task, type: "blocks", target: "TNB-2" },
  unlink_task: { ...task, target: "TNB-2" },
  link_pull_requests: { ...task, pullRequests: ["acme/app#7"] },
  unlink_pull_request: { ...task, pullRequest: "acme/app#7" },
  update_profile: { name: "Alex" },
  upload_image: { data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=" },
  list_epics: { boardId: "BOARD-1" },
  create_epic: { boardId: "BOARD-1", title: "Release" },
  update_epic: { id: "TNB-1", expectedVersion: 1, patch: { title: "Release plan" } },
  archive_epic: { id: "TNB-1", expectedVersion: 1 },
  list_views: {},
  create_view: { name: "My work" },
  update_view: { id: "VIEW-1", expectedVersion: 1, patch: { name: "Team work" } },
  delete_view: { id: "VIEW-1", expectedVersion: 1 },
  favorite_view: { id: "VIEW-1", favorite: true },
  list_boards: {},
  create_board: { name: "Engineering", prefix: "ENG" },
  update_board: { id: "BOARD-1", expectedVersion: 1, patch: { name: "Product" } },
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
};

export function commandHelp(command: string): string {
  if (!Object.hasOwn(schemas, command))
    throw Object.assign(new Error(`Unknown command: ${command}. Run tasknboard help for the command list.`), { code: "USAGE" });
  const schema = z.toJSONSchema(schemas[command], { io: "input", unrepresentable: "any" });
  const required = schema.required ?? [];
  const optional = Object.keys(schema.properties ?? {}).filter((key) => !required.includes(key));
  const lines = [
    `Usage: tasknboard ${command} '[json]'`,
    `       tasknboard ${command} --file <path>`,
    `       tasknboard ${command} --stdin`,
    `Required fields: ${required.join(", ") || "none"}`,
    `Optional fields: ${optional.join(", ") || "none"}`,
    "", "Example:",
    `  tasknboard ${command} '${JSON.stringify(commandExamples[command])}'`,
    "", "On Windows, use --file or --stdin to keep JSON out of cmd.exe arguments.",
    `Save the example JSON in args.json, then run tasknboard ${command} --file args.json.`,
    `PowerShell: Get-Content -Raw -Encoding utf8 args.json | tasknboard ${command} --stdin`,
    "Use one input mode per command. Direct JSON requires a shell that preserves it.",
  ];
  if (acceptsTaskId(command)) lines.push("", "Use id or taskId for the task key. If you set both, they must match.");
  if (command === "bulk_move_tasks") lines.push("", "Each tasks entry accepts id or taskId and requires expectedVersion.");
  if (JSON.stringify(schema).includes('"expectedVersion"')) {
    const read = acceptsTaskId(command) || command === "bulk_move_tasks"
      ? "get_task" : command.endsWith("epic") ? "list_epics" : command.endsWith("view") ? "list_views" : "list_boards";
    lines.push("", `Read ${read} before the mutation. Use the current version as expectedVersion.`,
      "The example version is a placeholder. The CLI does not fetch a version for you.");
    if (command.endsWith("lane") || command === "create_lane") lines.push("Lane mutations use the board version from list_boards.");
  }
  if (command === "update_profile") lines.push("", "A human can set an agent role with {\"agentId\":\"worker-1\",\"role\":\"architect\"}.");
  return lines.join("\n");
}
