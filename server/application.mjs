import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { listMcpConnections, restartMcpConnection } from "./mcp-control.mjs";
import { readTaskFiles } from "./task-files.mjs";
import { readTaskCommitSummary } from "./commit-links.mjs";
import { schemas } from "./domain.mjs";
import { githubSchemas } from "./github.mjs";
import {
  agentClients,
  agentEvents,
  defaultConfig,
  listConfigs,
  writeConfig,
} from "./agent-config.mjs";

const httpError = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
const object = z.object({}).strict();
export const runtimeSchemas = {
  "agent-configs": object,
  "agent-config-save": z
    .object({ identity: z.string(), config: z.record(z.string(), z.unknown()) })
    .strict(),
  "agent-event": z.discriminatedUnion("event", [
    z.object({ event: z.literal("standup") }).strict(),
    z.object({ event: z.literal("task_assigned"), taskId: z.string() }).strict(),
  ]),
  "agent-logs": z
    .object({
      taskId: z.string(),
      identity: z.string().optional(),
      file: z.string().optional(),
    })
    .strict(),
  "codex-plugin": z.object({ identity: z.string() }).strict(),
  "claude-plugin": z.object({ identity: z.string() }).strict(),
  "mcp-config": object,
  "mcp-status": object,
  "mcp-restart": z.object({ id: z.string().uuid() }).strict(),
  "task-files": z.object({ id: z.string() }).strict(),
  "task-commits": z.object({ id: z.string() }).strict(),
  "cli-helper-status": object,
  "cli-helper-install": object,
  "workspace-revision": object,
  "read-image": z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
  "start-chat-work": z
    .object({ id: z.string(), expectedVersion: z.number().int().positive() })
    .strict(),
  "pick-folder": object,
  "export-file": z
    .object({
      name: z.string().min(1).max(120),
      mime: z.string().max(120),
      data: z.string().max(15_000_000),
    })
    .strict(),
  "service-status": object,
  "service-connect": object,
  "service-control": z
    .object({ action: z.enum(["restart", "disable"]) })
    .strict(),
};
export const commandSchemas = {
  ...schemas,
  ...githubSchemas,
  ...runtimeSchemas,
};

/** The only command dispatcher. HTTP, MCP and the CLI share its side effects. */
export function createApplication({
  database,
  store,
  github,
  launcher,
  changes,
  agentLogs,
  cliHelper,
  codexPlugin,
  codexAppPlugin,
  claudePlugin,
  shared,
  instanceId,
  connection,
  runtimeFile,
  credentialHelper,
  cliEntry,
  resources,
  appRoot,
}) {
  async function dispatchAssignedTask(task, actor) {
    if (
      !task.assignee ||
      task.archived ||
      !["todo", "in_progress"].includes(task.role) ||
      task.delegatedTo ||
      task.lease?.expiresAt > Date.now()
    )
      return null;
    const { connections } = await listMcpConnections(database);
    if (
      connections.some(
        (connection) =>
          connection.identity === task.assignee &&
          connection.state === "connected",
      )
    ) {
      store.recordEvent(
        task.id,
        actor,
        "dispatch_requested",
        JSON.stringify({ to: task.assignee }),
      );
      changes.check();
      return { started: [task.assignee], notified: true };
    }
    return launcher.runTask(task) ? { started: [task.assignee] } : null;
  }
  async function agentCommand(name, args, actor) {
    if (actor.kind !== "human")
      throw httpError(
        "FORBIDDEN",
        "Only a person can manage agent settings.",
        403,
      );
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw httpError("VALIDATION", "Send a JSON object.", 400);
    const roster = () =>
      store
        .execute("workspace_info", {}, actor)
        .actors.filter((a) => a.kind === "agent")
        .map((a) => a.id);
    if (name === "agent-configs") {
      const agents = shared ? {} : listConfigs(store);
      return {
        mode: shared ? "shared" : "local",
        autoStart: launcher.enabled,
        clients: Object.entries(agentClients).map(([id, c]) => ({
          id,
          name: c.name,
          executable: c.executable,
          model: c.model,
          profile: {
            label: c.profile.label,
            flag: c.profile.flag,
            hint: c.profile.hint,
          },
        })),
        events: agentEvents.map(
          ({ id, label, description, placeholders, prompt }) => ({
            id,
            label,
            description,
            placeholders,
            hasPrompt: prompt !== null,
          }),
        ),
        defaults: defaultConfig(),
        agents: Object.fromEntries(
          Object.entries(agents).map(([id, config]) => [
            id,
            { config, ...launcher.status(id) },
          ]),
        ),
      };
    }
    if (shared)
      throw httpError(
        "AGENTS_UNSUPPORTED",
        "Configure agents from the local TasknBoard desktop app.",
        400,
      );
    if (name === "agent-config-save") {
      if (
        Object.keys(args).some((key) => !["identity", "config"].includes(key))
      )
        throw httpError("VALIDATION", "Provide only identity and config.", 400);
      return {
        identity: args.identity,
        config: writeConfig(store, args.identity, args.config),
      };
    }
    if (args.event === "task_assigned") {
      const task = store.execute("get_task", { id: args.taskId }, actor);
      const dispatched = await dispatchAssignedTask(task, actor);
      if (!dispatched)
        throw httpError("AGENT_NOT_READY", "The task needs an enabled agent, an open work lane, and no active claim or external dispatch.", 409);
      return dispatched;
    }
    if (args.event !== "standup" || Object.keys(args).length !== 1)
      throw httpError("VALIDATION", "event: Only standup can be sent.", 400);
    const identities = new Set([
      ...roster(),
      ...Object.keys(listConfigs(store)),
    ]);
    return { started: launcher.standup([...identities]) };
  }
  /** A task's agent runs, and one run's log: `{ taskId, identity?, file? }`. */
  async function agentLogsCommand(args, actor) {
    if (actor.kind !== "human")
      throw httpError("FORBIDDEN", "Only a person can read agent logs.", 403);
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      typeof args.taskId !== "string" ||
      Object.keys(args).some(
        (key) => !["taskId", "identity", "file"].includes(key),
      )
    )
      throw httpError(
        "VALIDATION",
        "Provide taskId, and identity and file to read one log.",
        400,
      );
    if (!agentLogs.root) return { available: false, runs: [] };
    const runs = await agentLogs.list(args.taskId);
    const chosen =
      args.identity !== undefined || args.file !== undefined
        ? { identity: String(args.identity), file: String(args.file) }
        : runs[0];
    return {
      available: true,
      runs,
      log: chosen
        ? await agentLogs.read(args.taskId, chosen.identity, chosen.file)
        : null,
    };
  }

  async function native(args, input) {
    if (!credentialHelper)
      throw httpError(
        "NATIVE_UNAVAILABLE",
        "The resident native helper is unavailable. Install the desktop package.",
      );
    return new Promise((resolve, reject) => {
      const child = spawn(credentialHelper, args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      let text = "",
        completed = false;
      const timer = setTimeout(() => {
        child.kill();
        finish(httpError("NATIVE_TIMEOUT", "The native operation timed out."));
      }, 120000);
      const finish = (error, result) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      child.on("error", () =>
        finish(
          httpError(
            "NATIVE_UNAVAILABLE",
            "Cannot start the resident native helper.",
          ),
        ),
      );
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.length > 1_000_000) {
          child.kill();
          finish(
            httpError(
              "NATIVE_RESPONSE",
              "The native operation returned too much data.",
            ),
          );
        }
      });
      child.on("close", (code) => {
        if (code !== 0)
          return finish(
            httpError(
              "NATIVE_ERROR",
              "The native operation failed. Check service status.",
            ),
          );
        try {
          finish(null, text.trim() ? JSON.parse(text) : {});
        } catch {
          finish(
            httpError(
              "NATIVE_RESPONSE",
              "The native operation returned an invalid response.",
            ),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input ? JSON.stringify(input) : "");
    });
  }
  async function serviceStatus() {
    return {
      resident: process.env.TASKNBOARD_RESIDENT === "1",
      instanceId,
      connected: true,
      native: {
        available: Boolean(credentialHelper),
        platform: process.platform,
      },
      appPlugin: await codexAppPlugin.status(store.setting("codex-app-plugin")),
    };
  }
  function mcpConfig() {
    if (shared) return { mode: "shared" };
    return {
      mode: "local",
      platform: process.platform,
      config: {
        mcpServers: {
          tasknboard: {
            url: connection().url + "/mcp",
            bearer_token_env_var: "TASKNBOARD_TOKEN",
          },
        },
      },
      cli: {
        command: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", cliEntry],
        env: {
          TASKNBOARD_RUNTIME_FILE: runtimeFile || "",
          TASKNBOARD_CREDENTIAL_HELPER: credentialHelper || "",
        },
      },
    };
  }
  async function execute(name, args = {}, actor) {
    if (name in runtimeSchemas) {
      if (actor.kind !== "human" && !["task-files", "task-commits"].includes(name))
        throw httpError(
          "FORBIDDEN",
          "Only a person can use this workspace operation.",
          403,
        );
      const parsed = runtimeSchemas[name].safeParse(args);
      if (!parsed.success)
        throw httpError(
          "VALIDATION",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
      args = parsed.data;
      if (name === "mcp-config") return mcpConfig();
      if (name === "mcp-status")
        return shared ? { supported: false, connections: [] } : listMcpConnections(database);
      if (name === "mcp-restart") {
        if (shared) throw httpError("MCP_CONTROL_UNSUPPORTED", "Restart MCP connections from the local TasknBoard app.", 400);
        return restartMcpConnection(database, args.id);
      }
      if (name === "task-files" || name === "task-commits") {
        const task = store.execute("get_task", { id: args.id }, actor);
        const board = store.execute("list_boards", {}, actor).boards.find(item => item.id === task.boardId);
        if (name === "task-files") return readTaskFiles(board.repository, task);
        if (!board.repository) throw httpError("REPOSITORY_REQUIRED", "Set the board repository before reading commits.", 400);
        return readTaskCommitSummary(board.repository, task.commits ?? []);
      }
      if (name === "cli-helper-status") return cliHelper.status();
      if (name === "cli-helper-install") return cliHelper.install();
      if (name === "workspace-revision")
        return { instanceId, revision: store.dataVersion() };
      if (name === "read-image") {
        const image = store.image(args.id);
        if (!image) throw httpError("NOT_FOUND", "Image not found.", 404);
        return {
          mime: image.mime,
          data: Buffer.from(image.data).toString("base64"),
        };
      }
      if (["agent-configs", "agent-config-save", "agent-event"].includes(name))
        return agentCommand(name, args, actor);
      if (name === "agent-logs") return agentLogsCommand(args, actor);
      if (["codex-plugin", "claude-plugin"].includes(name)) {
        if (shared)
          throw httpError(
            "PLUGIN_UNSUPPORTED",
            "Install agent plugins from the local workspace.",
          );
        const installed = await (
          name === "codex-plugin" ? codexPlugin : claudePlugin
        ).install(args.identity);
        launcher.register(
          installed.identity,
          name === "codex-plugin" ? "codex" : "claude",
        );
        return { ...installed, autoStart: launcher.enabled };
      }
      if (name === "start-chat-work") {
        const task = store.execute("get_task", { id: args.id }, actor);
        if (task.version !== args.expectedVersion)
          throw httpError(
            "VERSION_CONFLICT",
            "The task changed. Read it again before starting work.",
            409,
          );
        if (task.archived || task.delegatedTo || !["todo", "in_progress"].includes(task.role))
          throw httpError(
            "INVALID_STATE",
            "Only unstarted or active tasks can start chat work.",
            409,
          );
        if (task.lease && task.lease.expiresAt > Date.now())
          throw httpError(
            "CLAIM_CONFLICT",
            "The task is already claimed.",
            409,
          );
        const workSessionId = randomUUID(),
          actorId = `chat-${workSessionId}`;
        const info = store.execute("workspace_info", {}, actor);
        const board = info.boards.find((board) => board.id === task.boardId);
        const session = {
          workSessionId,
          actorId,
          taskId: task.id,
          boardId: task.boardId,
          repository: board?.repository || "",
        };
        store.setSettings({
          [`chat-work.${workSessionId}`]: JSON.stringify({
            ...session, taskRow: store.taskIdentity(task.id),
          }),
        });
        store.registerActors([{ id: actorId, kind: "agent" }]);
        return session;
      }
      if (name === "pick-folder") return native(["--service-pick-folder"]);
      if (name === "export-file") return native(["--service-export"], args);
      if (name === "service-status") return serviceStatus();
      if (name === "service-connect") {
        if (!credentialHelper || shared)
          throw httpError(
            "PLUGIN_UNSUPPORTED",
            "Connect Codex from the local TasknBoard desktop app.",
          );
        const plugin = await codexAppPlugin.install();
        store.setSettings({ "codex-app-plugin": plugin.pluginId });
        return { ...(await serviceStatus()), plugin };
      }
      if (name === "service-control") {
        // Return before disabling the service that carries this response.
        return native(["--service-control"], { action: args.action });
      }
    }
    const result = await github.execute(name, args, actor);
    const before =
      actor.kind === "human" &&
      ["update_task", "request_changes", "reject_task"].includes(name) &&
      !result
        ? store.execute("get_task", { id: args.id }, actor)
        : null;
    const output = result ?? store.execute(name, args, actor);
    // A person's edits start agents; agents cannot reassign tasks.
    if (actor.kind === "human") {
      if (["update_task", "request_changes", "reject_task"].includes(name))
        launcher.changed(before, output);
      if (name === "add_comment")
        launcher.commented(output, actor, args.body);
      const assigned =
        name === "create_task"
          ? [output]
          : name === "bulk_create_tasks"
            ? (output.tasks ?? [])
            : name === "update_task" && before.assignee !== output.assignee
              ? [output]
              : [];
      if (assigned.length) {
        const boards = store.execute("list_boards", {}, actor).boards;
        for (const task of assigned)
          if (
            boards.find((board) => board.id === task.boardId)?.policy
              .autoDispatch
          )
            await dispatchAssignedTask(task, actor);
      }
    }
    changes.check();
    return output;
  }
  function chatActor(workSessionId) {
    if (!workSessionId)
      throw httpError(
        "WORK_SESSION_REQUIRED",
        "Start work from the TasknBoard interface and pass its workSessionId.",
        403,
      );
    let session;
    try {
      session = JSON.parse(
        store.setting(`chat-work.${workSessionId}`) || "null",
      );
    } catch {
      session = null;
    }
    if (!Number.isSafeInteger(session?.taskRow))
      throw httpError(
        "WORK_SESSION_INVALID",
        "The chat work session is unavailable.",
        403,
      );
    return { id: session.actorId, kind: "agent", taskRow: session.taskRow };
  }
  return {
    execute,
    chatActor,
    mcpConfig,
    serviceStatus,
    native,
    readUi: () => readFile(join(appRoot, "index.html"), "utf8"),
  };
}
