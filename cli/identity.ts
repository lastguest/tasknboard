const readCommands = new Set([
  "workspace_info", "export_workspace", "list_tasks", "get_task", "get_tasks",
  "find_similar_tasks", "list_boards", "list_epics", "list_views", "list_labels",
  "list_inbox", "list_notifications",
]);

/** Require an explicit agent identity for commands from scripts that change data. */
export function cliActor(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  stdinIsTTY = Boolean(process.stdin.isTTY),
): { id: string; kind: "agent"; role?: "worker" | "architect" } | undefined {
  const id = env.TASKNBOARD_AGENT_ID?.trim();
  const role = env.TASKNBOARD_AGENT_ROLE;
  if (role !== undefined && (role !== "worker" && role !== "architect"))
    throw Object.assign(new Error("TASKNBOARD_AGENT_ROLE must be worker or architect."), { code: "USAGE" });
  if (role !== undefined && !id)
    throw Object.assign(new Error("TASKNBOARD_AGENT_ROLE requires TASKNBOARD_AGENT_ID."), { code: "USAGE" });
  if (!id && !stdinIsTTY && !readCommands.has(command))
    throw Object.assign(new Error("Non-interactive writes require TASKNBOARD_AGENT_ID. Set it to your agent identity."), { code: "ACTOR_REQUIRED" });
  return id ? { id, kind: "agent" as const, ...(role ? { role } : {}) } : undefined;
}
