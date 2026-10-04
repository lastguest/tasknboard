import { readFile } from "node:fs/promises";

export async function readCommandInput(args: string[]): Promise<string> {
  const usageError = (message: string) => Object.assign(new Error(message), { code: "USAGE" });
  if (args[0] === "--file") {
    if (args.length !== 2 || !args[1] || args[1].startsWith("--"))
      throw usageError("Use --file <path> alone. Do not combine JSON input modes.");
    try {
      return (await readFile(args[1], "utf8")).replace(/^\uFEFF/, "");
    } catch (error) {
      throw usageError(`Cannot read JSON file ${args[1]}: ${(error as Error).message}`);
    }
  }
  if (args[0] === "--stdin") {
    if (args.length !== 1)
      throw usageError("Use --stdin alone. Do not combine JSON input modes.");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
  }
  if (args.length > 1)
    throw usageError("Use one JSON argument, --file <path>, or --stdin. Do not combine JSON input modes.");
  return args[0] ?? "{}";
}

const taskCommands = new Set([
  "get_task", "update_task", "set_standup_notes", "claim_task", "heartbeat",
  "release_task", "delegate_task", "request_changes", "reject_task", "link_commits", "add_comment",
  "submit_review", "archive_task", "restore_task", "link_task", "unlink_task", "link_pull_requests",
  "unlink_pull_request", "undo_task", "reorder_task", "critical_path",
]);

export function normalizeArguments(command: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const args = value as Record<string, unknown>;
  const batchField = ({ bulk_move_tasks: "tasks", claim_tasks: "tasks", add_comments: "comments", submit_reviews: "reviews" } as Record<string, string>)[command];
  if (batchField && Array.isArray(args[batchField]))
    return { ...args, [batchField]: args[batchField].map((task) => normalizeArguments("update_task", task)) };
  if (!taskCommands.has(command) || !Object.hasOwn(args, "taskId")) return args;
  if (Object.hasOwn(args, "id") && args.id !== args.taskId)
    throw Object.assign(new Error("id and taskId must identify the same task."), { code: "USAGE" });
  const { taskId, ...rest } = args;
  return { ...rest, id: taskId };
}

export function acceptsTaskId(command: string): boolean {
  return taskCommands.has(command);
}

export function requireExpectedVersion(command: string, args: unknown): void {
  const result = schemas[command].safeParse(args);
  if (result.success) return;
  const missing = result.error.issues.find((issue) => {
    if (issue.path.at(-1) !== "expectedVersion") return false;
    let value: unknown = args;
    for (const key of issue.path)
      value = value && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[key] : undefined;
    return value === undefined;
  });
  if (missing)
    throw Object.assign(new Error(`${missing.path.join(".")} is required. Read the current version first. Run tasknboard help ${command} for an example.`), { code: "USAGE" });
}
import { schemas } from "../server/domain.mjs";
