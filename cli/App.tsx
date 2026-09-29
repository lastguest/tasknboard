import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import type { Client } from "../server/client.mjs";
import type { Board, Status, Task, WorkspaceInfo } from "../src/types.ts";
import { activeLease, columns, safeUrl, statusTitle } from "../src/types.ts";
import {
  boardList,
  commands,
  defaultBoard,
  matchCommands,
  planInput,
  UsageError,
} from "./commands.ts";
import { editLine, emptyLine, insert, type Line } from "./editor.ts";

const accent = "#9de3c1";
const danger = "#f2a7a7";
const priorityColor = { high: danger, medium: "#e8bd5a", low: "#88909e" };
const statusColor = Object.fromEntries(
  columns.map((c) => [c.id, c.color]),
) as Record<Status, string>;
const menuSize = 8;

type Notice = { tone: "ok" | "error" | "info"; text: string };
type View = "list" | "task" | "help";
type Styled = { text: string; color?: string; bold?: boolean; dim?: boolean };

/** Task text comes from other users. Control characters must never reach the terminal. */
export function clean(value: string) {
  return value
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** Wraps plain text to `width` columns, keeping paragraph breaks. */
export function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = "";
    for (const word of clean(paragraph).split(" ")) {
      for (let rest = word; ;) {
        const gap = line ? 1 : 0;
        if (line.length + gap + rest.length <= width) {
          line += (gap ? " " : "") + rest;
          break;
        }
        if (line) {
          lines.push(line);
          line = "";
          continue;
        }
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
        if (!rest) break;
      }
    }
    lines.push(line);
  }
  return lines;
}

const eventVerb: Record<string, string> = {
  created: "created the task",
  update_task: "updated",
  add_comment: "commented",
  claim_task: "claimed",
  heartbeat: "extended the claim",
  release_task: "released the claim",
  submit_review: "submitted for review",
  set_standup_notes: "set stand-up notes",
  archive_task: "archived",
};

/** One message format for every failed request. */
function errorText(e: unknown) {
  const error = e as Error & { code?: string };
  if (error.code === "UNAUTHORIZED")
    return "The server rejected TASKNBOARD_TOKEN.";
  return clean(error.code ? `${error.code}: ${error.message}` : error.message);
}

function eventText(body: string) {
  try {
    const value = JSON.parse(body);
    if (value && typeof value === "object")
      return Object.entries(value)
        .filter(([key, v]) => key !== "actor" && v !== "")
        .map(
          ([key, v]) =>
            `${key}: ${Array.isArray(v) ? v.join(", ") : String(v)}`,
        )
        .join(" · ");
  } catch {}
  return body;
}

function taskLines(task: Task, width: number): Styled[] {
  const out: Styled[] = [];
  const block = (title: string, value: string) => {
    if (!value.trim()) return;
    out.push({ text: "" }, { text: title, bold: true, color: accent });
    for (const line of wrap(value, width - 2)) out.push({ text: `  ${line}` });
  };
  const lease = activeLease(task);
  out.push({ text: `${task.id}  ${clean(task.title)}`, bold: true });
  out.push({
    text: [
      statusTitle(task.status),
      `${task.priority} priority`,
      task.assignee ? `@${clean(task.assignee)}` : "unassigned",
      task.labels.map(clean).join(", "),
      `v${task.version}`,
    ]
      .filter(Boolean)
      .join(" · "),
    color: statusColor[task.status],
  });
  if (lease) {
    const minutes = Math.max(
      1,
      Math.round((lease.expiresAt - Date.now()) / 60000),
    );
    out.push({
      text: `Claimed by ${clean(lease.actor)} · ${minutes}m left`,
      color: "#e8bd5a",
    });
  }
  block("Context", task.description);
  block("Acceptance criteria", task.acceptance);
  if (task.review) {
    const url = safeUrl(task.review.artifactUrl);
    block("Review", `${task.review.summary}${url ? `\n${url}` : ""}`);
  }
  if (task.standup) {
    block("Highlight", task.standup.highlight);
    block("Blocker", task.standup.blocker);
  }
  if (task.events?.length) {
    out.push({ text: "" }, { text: "Activity", bold: true, color: accent });
    for (const e of task.events) {
      const when = e.createdAt.slice(0, 16).replace("T", " ");
      const detail = eventText(e.body);
      const text = `${when}  ${e.actor} ${eventVerb[e.kind] ?? e.kind}${detail ? `: ${detail}` : ""}`;
      wrap(text, width - 2).forEach((line, i) =>
        out.push({ text: `  ${line}`, dim: i === 0 ? false : true }),
      );
    }
  }
  return out;
}

function helpLines(): Styled[] {
  const keys: [string, string][] = [
    ["type text", "Filter tasks by id, title, assignee or label"],
    ["↑ ↓", "Select a task, scroll a task, or move in the menu"],
    ["enter", "Open the selected task, or run the command"],
    ["tab", "Complete the highlighted command"],
    ["esc", "Clear the prompt, then go back"],
    ["ctrl+c", "Clear the prompt, or exit when it is empty"],
  ];
  return [
    { text: "Commands", bold: true, color: accent },
    ...commands.map((c) => ({ text: `  ${c.usage.padEnd(34)} ${c.summary}` })),
    { text: "" },
    { text: "Keys", bold: true, color: accent },
    ...keys.map(([k, v]) => ({ text: `  ${k.padEnd(34)} ${v}` })),
  ];
}

function Lines({ lines, height }: { lines: Styled[]; height: number }) {
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {lines.slice(0, height).map((l, i) => (
        <Text
          key={i}
          wrap="truncate-end"
          color={l.color}
          bold={l.bold}
          dimColor={l.dim}
        >
          {l.text || " "}
        </Text>
      ))}
    </Box>
  );
}

type Row =
  | { kind: "status"; status: Status; count: number }
  | { kind: "task"; task: Task };

function TaskList({
  rows,
  selectedId,
  height,
  empty,
  idWidth,
}: {
  rows: Row[];
  selectedId?: string;
  height: number;
  empty: string;
  idWidth: number;
}) {
  if (!rows.length)
    return (
      <Box height={height}>
        <Text dimColor>{empty}</Text>
      </Box>
    );
  const index = Math.max(
    0,
    rows.findIndex((r) => r.kind === "task" && r.task.id === selectedId),
  );
  const start = Math.min(
    Math.max(0, index - Math.floor(height / 2)),
    Math.max(0, rows.length - height),
  );
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {rows.slice(start, start + height).map((row) => {
        if (row.kind === "status")
          return (
            <Text
              key={row.status}
              bold
              color={statusColor[row.status]}
              wrap="truncate-end"
            >
              ● {statusTitle(row.status)} <Text dimColor>{row.count}</Text>
            </Text>
          );
        const t = row.task;
        const active = t.id === selectedId;
        const lease = activeLease(t);
        const meta = [
          t.assignee ? `@${clean(t.assignee)}` : "",
          t.commentCount ? `${t.commentCount} ✎` : "",
          lease ? "◆ claimed" : "",
        ]
          .filter(Boolean)
          .join("  ");
        return (
          <Box key={t.id}>
            <Text color={active ? accent : undefined}>
              {active ? "❯ " : "  "}
            </Text>
            <Text color={active ? accent : undefined} dimColor={!active}>
              {t.id.padEnd(idWidth)}
            </Text>
            <Text color={priorityColor[t.priority]}>● </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end" bold={active}>
                {clean(t.title)}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor> {meta}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export function App({
  client,
  pollMs = 5000,
}: {
  client: Client;
  pollMs?: number;
}) {
  const { exit } = useApp();
  const { columns: width, rows: height } = useWindowSize();
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState<string>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [detail, setDetail] = useState<Task | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<View>("list");
  const [line, setLine] = useState<Line>(emptyLine);
  const [menuIndex, setMenuIndex] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const state = useRef({ view, selectedId });
  state.current = { view, selectedId };
  // Set as soon as the user switches, so a refresh already in flight is dropped.
  const shownBoard = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const { boards } = await client.execute("list_boards", {});
      setBoards(boards);
      const board = shownBoard.current ?? defaultBoard(boards)?.id;
      if (!board) return setTasks([]);
      shownBoard.current = board;
      setBoardId(board);
      const all: Task[] = [];
      for (let total = Infinity; all.length < total;) {
        const page = await client.execute("list_tasks", {
          board,
          offset: all.length,
          limit: 100,
        });
        all.push(...page.tasks);
        total = page.tasks.length ? page.total : all.length;
      }
      if (shownBoard.current !== board) return;
      setTasks(all);
      const { view, selectedId } = state.current;
      if (view === "task" && selectedId)
        setDetail(await client.execute("get_task", { id: selectedId }));
      setOnline(true);
    } catch (e) {
      setOnline(false);
      setNotice({ tone: "error", text: errorText(e) });
    }
  }, [client]);

  useEffect(() => {
    client
      .execute("workspace_info")
      .then(setInfo)
      .catch((e) => setNotice({ tone: "error", text: errorText(e) }));
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [client, pollMs, refresh]);

  // Plain text in the prompt filters live; Enter keeps it as the active filter.
  const filter = (line.text && !line.text.startsWith("/") ? line.text : query)
    .trim()
    .toLowerCase();
  const visible = useMemo(
    () =>
      tasks.filter(
        (t) =>
          (!mine || t.assignee === info?.actor.id) &&
          (!filter ||
            `${t.id} ${t.title} ${t.assignee} ${t.labels.join(" ")}`
              .toLowerCase()
              .includes(filter)),
      ),
    [tasks, mine, filter, info],
  );
  const rows = useMemo(
    () =>
      columns.flatMap(({ id }): Row[] => {
        const group = visible.filter((t) => t.status === id);
        return group.length
          ? [
              { kind: "status", status: id, count: group.length },
              ...group.map((task) => ({ kind: "task" as const, task })),
            ]
          : [];
      }),
    [visible],
  );
  const ordered = rows.flatMap((r) => (r.kind === "task" ? [r.task] : []));
  const selected = ordered.find((t) => t.id === selectedId) ?? ordered[0];
  // An open task stays visible when a filter or refresh no longer lists it.
  const board = boards.find((b) => b.id === boardId);
  const idWidth = Math.max(9, ...ordered.map((t) => t.id.length + 2));
  const current =
    view === "task"
      ? detail && detail.id === selectedId
        ? detail
        : tasks.find((t) => t.id === selectedId)
      : selected;
  const matches = matchCommands(line.text);
  const menuOpen = matches.length > 0;

  const typedCommand =
    line.text.startsWith("/") && !menuOpen
      ? commands.find(
          (c) => c.name === line.text.slice(1).split(/\s/)[0].toLowerCase(),
        )
      : undefined;
  // Header, prompt box and status line take 6 rows; the list keeps at least 3.
  const menuRoom = Math.max(1, Math.min(menuSize, height - 9));
  const menuLines = menuOpen ? Math.min(menuRoom, matches.length) : 0;
  const bodyHeight = Math.max(3, height - 2 - menuLines - 3 - 1);
  const pageLines =
    view === "help"
      ? helpLines()
      : view === "task" && current
        ? taskLines(current, width)
        : [];
  const maxScroll = Math.max(0, pageLines.length - bodyHeight);

  useEffect(() => {
    if (view === "list" && selected && selected.id !== selectedId)
      setSelectedId(selected.id);
  }, [view, selected, selectedId]);
  useEffect(() => setMenuIndex(0), [line.text]);

  function openTask(task: Task | undefined) {
    if (!task) return;
    setView("task");
    setScroll(0);
    setDetail(null);
    client
      .execute("get_task", { id: task.id })
      .then(setDetail)
      .catch((e) => setNotice({ tone: "error", text: errorText(e) }));
  }

  async function run(input: string) {
    let action;
    try {
      action = planInput(input, current, { boards, board });
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      setNotice({ tone: "error", text: e.message });
      return;
    }
    if (action.kind === "quit") return exit();
    setLine(emptyLine);
    if (action.kind === "help") {
      setScroll(0);
      return setView("help");
    }
    if (action.kind === "refresh") {
      setNotice({ tone: "info", text: "Refreshed." });
      return void refresh();
    }
    if (action.kind === "boards")
      return setNotice({
        tone: "info",
        text: clean(boardList({ boards, board })),
      });
    if (action.kind === "board") {
      const next = action.board;
      shownBoard.current = next.id;
      setBoardId(next.id);
      setTasks([]);
      setSelectedId(undefined);
      setQuery("");
      setView("list");
      setNotice({
        tone: "info",
        text: clean(`Showing ${next.id} ${next.title}.`),
      });
      return void refresh();
    }
    if (action.kind === "mine") {
      setMine(!mine);
      return setNotice({
        tone: "info",
        text: mine ? "Showing all tasks." : "Showing only your tasks.",
      });
    }
    setBusy(true);
    try {
      const task: Task = await client.execute(
        action.request.name,
        action.request.args,
      );
      setNotice({ tone: "ok", text: action.message(task) });
      if (action.request.name === "create_task") setSelectedId(task.id);
      if (action.request.name === "archive_task") setView("list");
    } catch (e) {
      setLine({ text: input, cursor: input.length });
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  function move(delta: number) {
    const index = ordered.findIndex((t) => t.id === selected?.id);
    const next =
      ordered[Math.min(ordered.length - 1, Math.max(0, index + delta))];
    if (next) setSelectedId(next.id);
  }

  // Editing the prompt dismisses the last message, so the command hint can show.
  function edit(next: Line) {
    setLine(next);
    setNotice(null);
  }

  usePaste((text) => edit(insert(line, text)));
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (line.text) return setLine(emptyLine);
      return exit();
    }
    if (busy) return;
    if (key.escape) {
      if (line.text) return setLine(emptyLine);
      if (view !== "list") return setView("list");
      if (query) return setQuery("");
      return setNotice(null);
    }
    const page = Math.max(1, bodyHeight - 2);
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const delta = key.upArrow
        ? -1
        : key.downArrow
          ? 1
          : key.pageUp
            ? -page
            : page;
      if (menuOpen)
        return setMenuIndex(
          (i) => (i + delta + matches.length) % matches.length,
        );
      if (view === "list") return move(delta);
      return setScroll((s) => Math.min(maxScroll, Math.max(0, s + delta)));
    }
    if (key.tab && menuOpen) {
      const text = `/${matches[menuIndex].name} `;
      return setLine({ text, cursor: text.length });
    }
    if (key.return) {
      if (menuOpen) {
        const command = matches[menuIndex];
        if (command.usage === `/${command.name}`)
          return void run(command.usage);
        const text = `/${command.name} `;
        return setLine({ text, cursor: text.length });
      }
      if (line.text.startsWith("/")) return void run(line.text);
      if (view !== "list") return;
      if (line.text) {
        setQuery(line.text.trim());
        setLine(emptyLine);
      }
      return openTask(selected);
    }
    const next = editLine(line, input, key);
    if (next) edit(next);
  });

  const menuStart = Math.min(
    Math.max(0, menuIndex - menuRoom + 1),
    Math.max(0, matches.length - menuRoom),
  );
  const hints =
    view === "list"
      ? "↑↓ select · enter open · / commands · ctrl+c quit"
      : "↑↓ scroll · esc back · / commands · ctrl+c quit";
  const noticeColor =
    notice?.tone === "error"
      ? danger
      : notice?.tone === "ok"
        ? accent
        : undefined;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1}>
        <Box flexShrink={0}>
          <Text color={accent} bold>
            ✻ TasknBoard{" "}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {info
              ? clean(`${info.name} · ${info.actor.id} (${info.actor.kind})`)
              : "Connecting…"}
            {board ? clean(` · ${board.id} ${board.title}`) : ""} ·{" "}
            {client.mode} {client.target}
            {mine ? " · my tasks" : ""}
            {query ? ` · filter "${clean(query)}"` : ""}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={online ? accent : danger}>
            {" "}
            {online ? "● live" : "● offline"}
          </Text>
        </Box>
      </Box>
      <Box height={1} />
      {view !== "list" ? (
        <Lines
          lines={
            pageLines.length
              ? pageLines.slice(Math.min(scroll, maxScroll))
              : [{ text: "The task is no longer available.", dim: true }]
          }
          height={bodyHeight}
        />
      ) : (
        <TaskList
          rows={rows}
          selectedId={selected?.id}
          height={bodyHeight}
          idWidth={idWidth}
          empty={
            !online
              ? "Can't load tasks. TasknBoard retries every few seconds."
              : tasks.length
                ? "No tasks match. Press esc to clear the filter."
                : !board
                  ? "Loading boards…"
                  : "No tasks on this board yet. Type /new <title> to create one."
          }
        />
      )}
      {matches.slice(menuStart, menuStart + menuRoom).map((c, i) => {
        const active = menuStart + i === menuIndex;
        return (
          <Text
            key={c.name}
            color={active ? accent : undefined}
            wrap="truncate-end"
          >
            {active ? "❯ " : "  "}
            {c.usage.padEnd(34)}
            <Text dimColor>{c.summary}</Text>
          </Text>
        );
      })}
      <Box
        borderStyle="round"
        borderColor={busy ? "gray" : accent}
        paddingX={1}
      >
        <Text color={accent}>{"> "}</Text>
        {line.text ? (
          <Text wrap="truncate-start">
            {line.text.slice(0, line.cursor)}
            <Text inverse>{line.text[line.cursor] ?? " "}</Text>
            {line.text.slice(line.cursor + 1)}
          </Text>
        ) : (
          <Text>
            <Text inverse> </Text>
            <Text dimColor>
              {busy ? "Working…" : "Type to filter tasks, or / for commands"}
            </Text>
          </Text>
        )}
      </Box>
      <Box paddingX={1} height={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" color={noticeColor} dimColor={!notice}>
            {notice?.text ??
              (typedCommand
                ? `${typedCommand.usage} · ${typedCommand.summary}`
                : " ")}
          </Text>
        </Box>
        {!notice && (
          <Box flexShrink={0}>
            <Text dimColor> {hints}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
