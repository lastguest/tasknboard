import type { Lane } from "../server/domain.mjs";
import type { BoardRecord, Task } from "../src/types.ts";
import { linkTitle, linkTypes, priorities } from "../src/types.ts";

export type Request = { name: string; args: Record<string, unknown> };

/** The selected board, and the loaded boards whose lanes commands use. */
export type CommandContext = { boardId?: string; boards?: BoardRecord[] };

/** What a slash command asks the interface to do. */
export type Action =
  | { kind: "request"; request: Request; message: (result: { id: string }) => string }
  | { kind: "boards" }
  | { kind: "select-board"; boardId: string }
  | { kind: "mine" }
  | { kind: "refresh" }
  | { kind: "help" }
  | { kind: "quit" };

export type Command = {
  name: string;
  usage: string;
  summary: string;
  plan: (arg: string, task: Task | undefined, context: CommandContext) => Action;
};

/** A mistake in the typed command. Nothing was sent to the workspace. */
export class UsageError extends Error {}

function selected(task: Task | undefined) {
  if (!task) throw new UsageError("Select a task first.");
  return task;
}

function required(arg: string, usage: string) {
  if (!arg) throw new UsageError(`Usage: ${usage}`);
  return arg;
}

function update(task: Task, patch: object, message: string): Action {
  return {
    kind: "request",
    request: {
      name: "update_task",
      args: { id: task.id, expectedVersion: task.version, patch },
    },
    message: () => message,
  };
}

function versioned(
  name: string,
  task: Task,
  args: object,
  message: string,
): Action {
  return {
    kind: "request",
    request: {
      name,
      args: { id: task.id, expectedVersion: task.version, ...args },
    },
    message: () => message,
  };
}

/** The lanes of the task's board, in board order. */
function boardLanes(task: Task, context: CommandContext): Lane[] {
  const board = context.boards?.find((b) => b.id === task.boardId);
  if (!board) throw new UsageError("Board not loaded yet. Type /refresh.");
  return board.lanes;
}

/** Matches a lane by name, or by a unique start of one, ignoring case. */
export function findLane(arg: string, lanes: Lane[]): Lane {
  const key = arg.trim().toLowerCase();
  const exact = lanes.filter((l) => l.name.toLowerCase() === key);
  const matches = exact.length
    ? exact
    : lanes.filter((l) => l.name.toLowerCase().startsWith(key));
  if (!key || matches.length !== 1)
    throw new UsageError(
      `Choose a lane: ${lanes.map((l) => l.name).join(", ")}.`,
    );
  return matches[0];
}

export const commands: Command[] = [
  {
    name: "board",
    usage: "/board [id | create <prefix> <name>]",
    summary: "List boards, select one, or create a board",
    plan: (arg, _task, context) => {
      if (!arg) return { kind: "boards" };
      const create = /^create\s+(\S+)\s+([\s\S]+)$/i.exec(arg);
      if (create) {
        const [, prefix, name] = create;
        return {
          kind: "request",
          request: { name: "create_board", args: { name: name.trim(), prefix } },
          message: (board) => `Created board ${board.id}.`,
        };
      }
      return {
        kind: "select-board",
        boardId: required(arg, "/board <id>").toUpperCase(),
      };
    },
  },
  {
    name: "new",
    usage: "/new <title>",
    summary: "Create a task in the first to-do lane of the selected board",
    plan: (arg, _task, context) => {
      const title = required(arg, "/new <title>");
      if (!context.boardId)
        throw new UsageError("Select a board first with /board <id>.");
      return {
        kind: "request",
        request: {
          name: "create_task",
          args: { boardId: context.boardId, title },
        },
        message: (task) => `Created ${task.id}.`,
      };
    },
  },
  {
    name: "move",
    usage: "/move <lane>",
    summary: "Move the selected task to a lane of its board",
    plan: (arg, task, context) => {
      const name = required(arg, "/move <lane>");
      const t = selected(task);
      const lane = findLane(name, boardLanes(t, context));
      return update(t, { lane: lane.id }, `${t.id} moved to ${lane.name}.`);
    },
  },
  {
    name: "done",
    usage: "/done",
    summary: "Mark the reviewed task Done",
    plan: (_, task, context) => {
      const t = selected(task);
      const lane = boardLanes(t, context).find((l) => l.role === "done");
      if (!lane) throw new UsageError("The board has no Done lane.");
      return update(t, { lane: lane.id }, `${t.id} is in ${lane.name}.`);
    },
  },
  {
    name: "assign",
    usage: "/assign [name]",
    summary: "Assign the selected task, or clear the assignee",
    plan: (arg, task) => {
      const t = selected(task);
      return update(
        t,
        { assignee: arg },
        arg ? `${t.id} assigned to ${arg}.` : `${t.id} is unassigned.`,
      );
    },
  },
  {
    name: "priority",
    usage: "/priority <low|medium|high>",
    summary: "Set the priority of the selected task",
    plan: (arg, task) => {
      const key = required(arg, "/priority <low|medium|high>").toLowerCase();
      const match = priorities.find((p) => p.id.startsWith(key));
      if (!match) throw new UsageError("Choose a priority: low, medium, high.");
      const t = selected(task);
      return update(
        t,
        { priority: match.id },
        `${t.id} priority is ${match.title}.`,
      );
    },
  },
  {
    name: "comment",
    usage: "/comment <text>",
    summary: "Add a comment to the selected task",
    plan: (arg, task) => {
      const body = required(arg, "/comment <text>");
      const t = selected(task);
      return versioned("add_comment", t, { body }, `Comment added to ${t.id}.`);
    },
  },
  {
    name: "link",
    usage: "/link <type> <task id>",
    summary: "Link the selected task: blocks, blocked_by, relates, duplicates, duplicated_by",
    plan: (arg, task) => {
      const usage = "/link <type> <task id>";
      const [, typed = "", target = ""] = /^(\S+)\s+(\S+)$/.exec(arg) ?? [];
      required(target, usage);
      const type = linkTypes.find((t) => t.id === typed.toLowerCase())?.id;
      if (!type)
        throw new UsageError(
          `Choose a link type: ${linkTypes.map((t) => t.id).join(", ")}.`,
        );
      const t = selected(task);
      const id = target.toUpperCase();
      return versioned(
        "link_task",
        t,
        { type, target: id },
        `${t.id} ${linkTitle(type).toLowerCase()} ${id}.`,
      );
    },
  },
  {
    name: "unlink",
    usage: "/unlink <task id>",
    summary: "Remove the link between the selected task and another",
    plan: (arg, task) => {
      const id = required(arg, "/unlink <task id>").toUpperCase();
      const t = selected(task);
      return versioned("unlink_task", t, { target: id }, `${t.id} unlinked from ${id}.`);
    },
  },
  {
    name: "pr",
    usage: "/pr <pull request URL>…",
    summary: "Link GitHub pull requests (URL or owner/repo#123) to the selected task",
    plan: (arg, task) => {
      const pullRequests = required(arg, "/pr <pull request URL>…").split(/[\s,]+/);
      const t = selected(task);
      return versioned(
        "link_pull_requests",
        t,
        { pullRequests },
        `${pullRequests.length === 1 ? "Pull request" : "Pull requests"} linked to ${t.id}.`,
      );
    },
  },
  {
    name: "unpr",
    usage: "/unpr <pull request URL>",
    summary: "Remove a linked pull request from the selected task",
    plan: (arg, task) => {
      const pullRequest = required(arg, "/unpr <pull request URL>");
      const t = selected(task);
      return versioned(
        "unlink_pull_request",
        t,
        { pullRequest },
        `Pull request removed from ${t.id}.`,
      );
    },
  },
  {
    name: "claim",
    usage: "/claim",
    summary: "Claim the selected task for 15 minutes",
    plan: (_, task) => {
      const t = selected(task);
      return versioned("claim_task", t, {}, `You claimed ${t.id}.`);
    },
  },
  {
    name: "release",
    usage: "/release",
    summary: "Release your claim on the selected task",
    plan: (_, task) => {
      const t = selected(task);
      return versioned("release_task", t, {}, `You released ${t.id}.`);
    },
  },
  {
    name: "review",
    usage: "/review <summary> [artifact URL]",
    summary: "Submit the selected task for human review",
    plan: (arg, task) => {
      const text = required(arg, "/review <summary> [artifact URL]");
      const last = text.split(/\s+/).at(-1) ?? "";
      const artifactUrl = /^https?:\/\/\S+$/.test(last) ? last : "";
      const summary = artifactUrl ? text.slice(0, -last.length).trim() : text;
      const t = selected(task);
      return versioned(
        "submit_review",
        t,
        {
          summary: required(summary, "/review <summary> [artifact URL]"),
          artifactUrl,
        },
        `${t.id} submitted for review.`,
      );
    },
  },
  {
    name: "archive",
    usage: "/archive <task id>",
    summary: "Archive the selected task (type its id to confirm)",
    plan: (arg, task) => {
      const t = selected(task);
      if (arg.toUpperCase() !== t.id)
        throw new UsageError(`Type /archive ${t.id} to confirm.`);
      return versioned("archive_task", t, {}, `${t.id} archived.`);
    },
  },
  {
    name: "mine",
    usage: "/mine",
    summary: "Show only your tasks, or show all again",
    plan: () => ({ kind: "mine" }),
  },
  {
    name: "refresh",
    usage: "/refresh",
    summary: "Reload tasks now",
    plan: () => ({ kind: "refresh" }),
  },
  {
    name: "help",
    usage: "/help",
    summary: "Show commands and keys",
    plan: () => ({ kind: "help" }),
  },
  {
    name: "quit",
    usage: "/quit",
    summary: "Exit TasknBoard",
    plan: () => ({ kind: "quit" }),
  },
];

/** Commands for the menu while the user types a command name. */
export function matchCommands(input: string): Command[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const typed = input.slice(1).toLowerCase();
  return commands.filter((c) => c.name.startsWith(typed));
}

/** Turns one line of input into an action. Throws UsageError on mistakes. */
export function planInput(
  input: string,
  task: Task | undefined,
  context: CommandContext = {},
): Action {
  const [, name = "", arg = ""] =
    /^\/(\S*)\s*([\s\S]*)$/.exec(input.trim()) ?? [];
  const command =
    commands.find((c) => c.name === name.toLowerCase()) ??
    (name.toLowerCase() === "exit"
      ? commands.find((c) => c.name === "quit")
      : undefined);
  if (!command) throw new UsageError(`Unknown command /${name}. Type /help.`);
  return command.plan(arg.trim(), task, context);
}
