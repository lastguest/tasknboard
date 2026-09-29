import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Assignee, Board } from "./Board";
import {
  Settings,
  ShortcutHelp,
  TaskEditor,
  describeError,
  type RefreshResult,
} from "./Dialogs";
import { Icon } from "./Icons";
import { AssigneeFilter, UNASSIGNED } from "./AssigneeFilter";
import { ApiError, command, errorOf, loadTasks } from "./api";
import { Standup } from "./Standup";
import { BoardEditor, BoardsPage } from "./Boards";
import {
  EpicEditor,
  EpicsPage,
  EpicSummary,
} from "./Epics";
import { type Toast, Toasts } from "./Toasts";
import type { ModelContext } from "./webmcp";
import { formatUtcTimestamp } from "./formatting";
import { Avatar, displayName, PeopleContext, usePeople } from "./People";
import {
  activeLease,
  epicProgress,
  epicPalette,
  epicStyle,
  statusTitle,
  type Actor,
  type Board as BoardRecord,
  type Epic,
  type Status,
  type Task,
  type WorkspaceInfo,
} from "./types";

type View = "boards" | "board" | "mine" | "agents" | "epics" | "epic";
type Editor =
  | null
  | { mode: "create"; board: string; epic?: string }
  | { mode: "edit"; task: Task };
type EpicDialog = null | { epic: Epic | null };
type BoardDialog = null | { board: BoardRecord | null };
const BOARD_KEY = "tasknboard.board";
/** Views that show tasks, with search, filters and New task. */
const taskViews: View[] = ["board", "mine", "epic"];
const viewTitles: Record<Exclude<View, "epic" | "board">, string> = {
  boards: "Boards",
  mine: "My tasks",
  agents: "Agents",
  epics: "Epics",
};

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [actor, setActor] = useState<Actor>({ id: "you", kind: "human" });
  const [actors, setActors] = useState<Actor[]>([]);
  const [workspaceInfoLoaded, setWorkspaceInfoLoaded] = useState(false);
  const [workspace, setWorkspace] = useState("Workspace");
  const [view, setView] = useState<View>("board");
  const [boards, setBoards] = useState<BoardRecord[]>([]);
  const [boardId, setBoardId] = useState(() => {
    try {
      return localStorage.getItem(BOARD_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [boardDialog, setBoardDialog] = useState<BoardDialog>(null);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [epicId, setEpicId] = useState("");
  const [epicDialog, setEpicDialog] = useState<EpicDialog>(null);
  const [list, setList] = useState(false);
  const [query, setQuery] = useState("");
  const [assignee, setAssignee] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [opening, setOpening] = useState("");
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [standup, setStandup] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("tasknboard.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("tasknboard.sidebarCollapsed", collapsed ? "1" : "0");
    } catch {
      // Storage unavailable; the preference just won't persist.
    }
  }, [collapsed]);
  useEffect(() => {
    try {
      if (boardId) localStorage.setItem(BOARD_KEY, boardId);
    } catch {
      // Storage unavailable; the board choice just won't persist.
    }
  }, [boardId]);
  const [sync, setSync] = useState<{
    loaded: boolean;
    connected: boolean;
    error: ApiError | null;
    lastSync: string;
  }>({ loaded: false, connected: false, error: null, lastSync: "" });
  const [pending, setPending] = useState(new Map<string, Status>());
  const [moveError, setMoveError] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const filter = useRef<HTMLButtonElement>(null);
  const standupButton = useRef<HTMLButtonElement>(null);
  const running = useRef<Promise<RefreshResult> | null>(null);
  const queued = useRef<Promise<RefreshResult> | null>(null);

  const load = useCallback(async (): Promise<RefreshResult> => {
    try {
      const [next, info, boardList, epicList] = await Promise.all([
        loadTasks(),
        command<WorkspaceInfo>("workspace_info"),
        command<{ boards: BoardRecord[] }>("list_boards"),
        // Archived epics still name the finished tasks that keep them.
        command<{ epics: Epic[] }>("list_epics", { includeArchived: true }),
      ]);
      setTasks(next);
      setBoards(boardList.boards);
      setEpics(epicList.epics);
      setActor(info.actor);
      setActors(info.actors);
      setWorkspace(info.name);
      setWorkspaceInfoLoaded(true);
      setSync({
        loaded: true,
        connected: true,
        error: null,
        lastSync: formatUtcTimestamp(Date.now()),
      });
      return { ok: true };
    } catch (e) {
      const error = errorOf(e);
      // Keep the last loaded tasks, but mark them as stale.
      setSync((s) => ({ ...s, loaded: true, connected: false, error }));
      return { ok: false, error };
    }
  }, []);

  /**
   * Reads never overlap. A refresh requested while one is running (for
   * example after a write) runs once more afterwards, so it sees the write.
   */
  const refresh = useCallback((): Promise<RefreshResult> => {
    if (queued.current) return queued.current;
    const start = () => {
      const run = load();
      running.current = run;
      void run.finally(() => {
        if (running.current === run) running.current = null;
      });
      return run;
    };
    if (!running.current) return start();
    const next = running.current.then(() => {
      queued.current = null;
      return start();
    });
    queued.current = next;
    return next;
  }, [load]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext })
      .modelContext;
    if (!context) return;

    const controller = new AbortController();
    void import("./webmcp")
      .then(({ registerWebMCP }) =>
        registerWebMCP(
          context,
          command,
          async () => {
            await refresh();
          },
          controller.signal,
        ),
      )
      .catch((error) => {
        if (!controller.signal.aborted)
          console.error("WebMCP tool registration failed", error);
      });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    let timer: number | undefined;
    const startPolling = () => {
      void refresh();
      timer = window.setInterval(() => {
        if (!document.hidden) void refresh();
      }, 5000);
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
      } else if (timer === undefined) {
        startPolling();
      }
    };

    if (!document.hidden) startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [refresh]);

  const toastSeq = useRef(0);
  const notify = useCallback((next: Omit<Toast, "id">) => {
    const id = ++toastSeq.current;
    // Newest last (closest to the corner); keep the stack short.
    setToasts((ts) => [...ts, { ...next, id }].slice(-3));
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const dialogOpen =
    editor !== null ||
    epicDialog !== null ||
    boardDialog !== null ||
    settings ||
    help ||
    Boolean(opening);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (standup || dialogOpen || e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      const target = e.target as HTMLElement;
      if (
        target.closest('input,textarea,select,[contenteditable="true"]') ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        newTask();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (!taskViews.includes(view)) setView("board");
        requestAnimationFrame(() => filter.current?.focus());
      } else if (e.key === "?") {
        e.preventDefault();
        setHelp(true);
      } else if (e.key === "[") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const wasPresenting = useRef(false);
  useEffect(() => {
    if (wasPresenting.current && !standup) standupButton.current?.focus();
    wasPresenting.current = standup;
  }, [standup]);

  const people = useMemo(
    () => new Map(actors.map((a) => [a.id, a])),
    [actors],
  );
  const agents = useMemo(
    () => new Set(actors.filter((a) => a.kind === "agent").map((a) => a.id)),
    [actors],
  );
  const assignees = useMemo(
    () =>
      [...new Set(tasks.map((t) => t.assignee).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [tasks],
  );
  const labels = useMemo(
    () => [...new Set(tasks.flatMap((t) => t.labels))].sort(),
    [tasks],
  );
  const epicsById = useMemo(
    () => new Map(epics.map((epic) => [epic.id, epic])),
    [epics],
  );
  const sidebarBoards = boards.filter((board) => board.showInSidebar);
  // Until someone picks a board (or if the remembered one is not in this
  // workspace), show the first sidebar board.
  const currentBoard =
    boards.find((board) => board.id === boardId) ??
    sidebarBoards[0] ??
    boards[0];
  const activeBoard = currentBoard?.id ?? "";
  const boardTasks = tasks.filter((t) => t.board === activeBoard);
  const activeEpics = epics.filter(
    (epic) => !epic.archived && epic.board === activeBoard,
  );
  const currentEpic = view === "epic" ? epicsById.get(epicId) : undefined;
  const title =
    view === "epic"
      ? (currentEpic?.title ?? "Epic")
      : view === "board"
        ? (currentBoard?.title ?? "Board")
        : viewTitles[view];
  const canManageEpics = workspaceInfoLoaded && actor.kind === "human";
  const openBoard = (board: BoardRecord) => {
    setBoardId(board.id);
    setView("board");
  };
  const openEpic = (epic: Epic) => {
    setBoardId(epic.board);
    setEpicId(epic.id);
    setView("epic");
  };
  // An epic's tasks are created on the epic's board.
  const newTask = () =>
    currentBoard &&
    setEditor(
      view === "epic" && currentEpic
        ? { mode: "create", board: currentEpic.board, epic: currentEpic.id }
        : { mode: "create", board: activeBoard },
    );
  const q = query.trim().toLowerCase();
  const filtersActive = Boolean(q || assignee);
  const inScope = (t: Task, scope: View = view) =>
    scope === "mine"
      ? workspaceInfoLoaded && t.assignee === actor.id
      : scope === "epic"
        ? t.epic === epicId
        : t.board === activeBoard;
  const matches = (t: Task, scope: View = view) =>
    inScope(t, scope) &&
    (!assignee ||
      (assignee === UNASSIGNED ? !t.assignee : t.assignee === assignee)) &&
    (!q || `${t.id} ${t.title} ${t.description}`.toLowerCase().includes(q));
  const scoped = tasks.filter((t) => inScope(t));
  const visible = tasks.filter((t) => matches(t));

  function clearFilters() {
    setQuery("");
    setAssignee("");
  }

  async function openTask(task: Task) {
    if (opening) return;
    setOpening(task.id);
    try {
      setEditor({
        mode: "edit",
        task: await command<Task>("get_task", { id: task.id }),
      });
    } catch (e) {
      notify({
        tone: "error",
        title: `Couldn't open ${task.id}`,
        body: errorOf(e).message,
        actions: [{ label: "Retry", run: () => void openTask(task) }],
      });
    } finally {
      setOpening("");
    }
  }

  async function move(task: Task, status: Status) {
    if (pending.has(task.id) || task.status === status) return;
    setPending((p) => new Map(p).set(task.id, status));
    setMoveError("");
    try {
      const saved = await command<Task>("update_task", {
        id: task.id,
        expectedVersion: task.version,
        patch: { status },
      });
      setTasks((ts) => ts.map((t) => (t.id === saved.id ? saved : t)));
      notify({
        tone: "ok",
        title: `Moved ${task.id}`,
        body: `Now in ${statusTitle(status)}.`,
      });
    } catch (e) {
      const error = errorOf(e);
      setMoveError(
        error.code === "VERSION_CONFLICT"
          ? `${task.id} changed since the board loaded, so it was not moved. The board has been refreshed; try again.`
          : `${task.id} was not moved to ${statusTitle(status)}. ${describeError(error)}`,
      );
    } finally {
      setPending((p) => {
        const next = new Map(p);
        next.delete(task.id);
        return next;
      });
      void refresh();
    }
  }

  async function created(task: Task) {
    setEditor(null);
    await refresh();
    const shown = taskViews.includes(view) && matches(task);
    notify({
      tone: "ok",
      title: `Created ${task.id}`,
      body:
        shown || !taskViews.includes(view)
          ? "Added to Backlog."
          : "Added to Backlog. Your current filters hide it.",
      actions: [
        ...(shown
          ? []
          : [
              {
                label: "Show on board",
                run: () => {
                  clearFilters();
                  setBoardId(task.board);
                  setView("board");
                },
              },
            ]),
        { label: "Open", run: () => void openTask(task) },
      ],
    });
  }

  function saved(task: Task) {
    setEditor(null);
    setTasks((ts) => ts.map((t) => (t.id === task.id ? task : t)));
    void refresh();
    notify({
      tone: "ok",
      title: `Saved ${task.id}`,
      body: matches(task) ? undefined : "Your current filters now hide it.",
    });
  }

  function archived(task: Task) {
    setEditor(null);
    setTasks((ts) => ts.filter((t) => t.id !== task.id));
    void refresh();
    notify({
      tone: "ok",
      title: `Archived ${task.id}`,
      body: "Its history is kept and included in exports.",
    });
  }

  async function epicSaved(epic: Epic, isNew: boolean) {
    setEpicDialog(null);
    setEpics((list) =>
      isNew ? [...list, epic] : list.map((e) => (e.id === epic.id ? epic : e)),
    );
    void refresh();
    notify({
      tone: "ok",
      title: isNew ? `Created ${epic.id}` : `Saved ${epic.id}`,
      body: isNew ? `“${epic.title}” is ready for tasks.` : undefined,
      actions: isNew
        ? [{ label: "Open", run: () => openEpic(epic) }]
        : undefined,
    });
  }

  function boardSaved(board: BoardRecord, isNew: boolean) {
    setBoardDialog(null);
    setBoards((list) =>
      isNew
        ? [...list, board]
        : list.map((b) => (b.id === board.id ? board : b)),
    );
    void refresh();
    notify({
      tone: "ok",
      title: isNew ? `Created board ${board.id}` : `Saved board ${board.id}`,
      body: isNew
        ? `Its tasks are numbered ${board.id}-001, ${board.id}-002, and so on.`
        : board.showInSidebar
          ? undefined
          : "It is hidden from the sidebar. Find it on the Boards page.",
      actions: isNew
        ? [{ label: "Open", run: () => openBoard(board) }]
        : undefined,
    });
  }

  function epicArchived(epic: Epic) {
    setEpicDialog(null);
    setEpics((list) => list.map((e) => (e.id === epic.id ? epic : e)));
    setView("epics");
    void refresh();
    notify({
      tone: "ok",
      title: `Archived ${epic.id}`,
      body: "Done tasks keep the epic, and it stays in exports.",
    });
  }

  const openStandup = () => {
    setEditor(null);
    setStandup(true);
  };
  const connectionLabel = sync.connected
    ? `Connected · updated ${sync.lastSync}`
    : sync.loaded
      ? "Disconnected"
      : "Connecting…";
  const hasData = sync.lastSync !== "";

  return (
    <PeopleContext.Provider value={people}>
      <div className="app-shell" hidden={standup} inert={standup}>
        <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
          <div className="brand-row">
          <a
            className="brand"
            href="#board"
            onClick={(e) => {
              e.preventDefault();
              setView("board");
            }}
          >
            <svg
              className="brand-symbol"
              width="24"
              height="25"
              viewBox="112 104 288 304"
              aria-hidden="true"
            >
              <mask id="brand-cutout">
                <rect x="112" y="104" width="288" height="304" fill="#fff" />
                <circle cx="176" cy="172" r="30" fill="#000" />
                <rect x="148" y="244" width="216" height="28" rx="14" fill="#000" />
                <rect x="148" y="300" width="144" height="28" rx="14" fill="#000" />
              </mask>
              <rect
                x="112"
                y="104"
                width="288"
                height="304"
                rx="44"
                fill="currentColor"
                mask="url(#brand-cutout)"
              />
            </svg>
            <span>TasknBoard</span>
          </a>
          <button
            type="button"
            className="icon-button sidebar-toggle"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar ([)" : "Collapse sidebar ([)"}
            onClick={() => setCollapsed((c) => !c)}
          >
            <Icon name={collapsed ? "sidebarExpand" : "sidebarCollapse"} />
          </button>
          </div>
          <span className="nav-label" id="nav-label">
            {workspace}
          </span>
          <nav aria-labelledby="nav-label" className="nav-main">
            {(
              [
                ["boards", "board"],
                ["mine", "user"],
                ["agents", "bot"],
                ["epics", "folder"],
              ] as const
            ).map(([id, icon]) => (
              <button
                key={id}
                type="button"
                className={`nav-item ${view === id ? "selected" : ""}`}
                aria-current={view === id ? "page" : undefined}
                title={collapsed ? viewTitles[id] : undefined}
                onClick={() => setView(id)}
              >
                <Icon name={icon} />
                <span>{viewTitles[id]}</span>
                {id === "mine" && workspaceInfoLoaded && (
                  <small
                    aria-label={`${tasks.filter((t) => t.assignee === actor.id).length} tasks`}
                  >
                    {tasks.filter((t) => t.assignee === actor.id).length}
                  </small>
                )}
              </button>
            ))}
            <button
              ref={standupButton}
              type="button"
              className="nav-item standup-launch"
              disabled={!sync.connected}
              title={
                sync.connected
                  ? "Present the board for stand-up"
                  : "Stand-up needs a connection"
              }
              onClick={openStandup}
            >
              <Icon name="screen" />
              <span>Stand-up</span>
            </button>
          </nav>
          <nav className="nav-epics" aria-labelledby="boards-label">
            <div className="nav-section-head">
              <span className="nav-label" id="boards-label">
                Boards
              </span>
              {canManageEpics && (
                <button
                  type="button"
                  className="icon-button nav-add"
                  aria-label="New board"
                  title="New board"
                  onClick={() => setBoardDialog({ board: null })}
                >
                  <Icon name="plus" size={14} />
                </button>
              )}
            </div>
            {sidebarBoards.map((board) => {
              const { open } = epicProgress(board);
              const selected = view === "board" && activeBoard === board.id;
              return (
                <button
                  key={board.id}
                  type="button"
                  className={`nav-item nav-epic ${selected ? "selected" : ""}`}
                  aria-current={selected ? "page" : undefined}
                  title={collapsed ? board.title : undefined}
                  onClick={() => openBoard(board)}
                >
                  <Icon name="board" size={15} />
                  <span className="nav-epic-title">{board.title}</span>
                  <small aria-label={`${open} open tasks`}>{open}</small>
                </button>
              );
            })}
            {sync.loaded && boards.length > 0 && !sidebarBoards.length && (
              <p className="nav-empty">
                Every board is hidden. Open one from Boards.
              </p>
            )}
          </nav>
          <nav className="nav-epics" aria-labelledby="epics-label">
            <div className="nav-section-head">
              <span className="nav-label" id="epics-label">
                Epics
              </span>
              {canManageEpics && (
                <button
                  type="button"
                  className="icon-button nav-add"
                  aria-label="New epic"
                  title="New epic"
                  onClick={() => setEpicDialog({ epic: null })}
                >
                  <Icon name="plus" size={14} />
                </button>
              )}
            </div>
            {activeEpics.map((epic) => {
              const { open } = epicProgress(epic);
              const selected = view === "epic" && epicId === epic.id;
              return (
                <button
                  key={epic.id}
                  type="button"
                  className={`nav-item nav-epic ${selected ? "selected" : ""}`}
                  aria-current={selected ? "page" : undefined}
                  title={collapsed ? epic.title : undefined}
                  onClick={() => openEpic(epic)}
                >
                  <span
                    className="epic-glyph"
                    style={epicStyle(epic)}
                    aria-hidden="true"
                  />
                  <span className="nav-epic-title">{epic.title}</span>
                  <small aria-label={`${open} open tasks`}>{open}</small>
                </button>
              );
            })}
            {sync.loaded && !activeEpics.length && (
              <p className="nav-empty">
                Group related tasks into a project.
              </p>
            )}
          </nav>
          <div className="sidebar-bottom">
            <button
              type="button"
              className="nav-item"
              title={collapsed ? "Settings" : undefined}
              onClick={() => setSettings(true)}
            >
              <Icon name="settings" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              className="nav-item"
              title={collapsed ? "Shortcuts" : undefined}
              onClick={() => setHelp(true)}
            >
              <Icon name="help" />
              <span>Shortcuts</span>
            </button>
            <div className="workspace-status" role="status">
              <span
                className={`connection-dot ${sync.connected ? "online" : ""}`}
              />
              {workspaceInfoLoaded && (
                <button
                  type="button"
                  className="identity"
                  title={
                    collapsed
                      ? `${displayName(people, actor.id)} · ${actor.kind} — edit your profile`
                      : "Edit your profile"
                  }
                  onClick={() => setSettings(true)}
                >
                  <Avatar name={actor.id} agent={actor.kind === "agent"} />
                  <span>
                    {displayName(people, actor.id)} · {actor.kind}
                  </span>
                </button>
              )}
            </div>
          </div>
        </aside>
        <main>
          <div className="topbar">
            <span className="breadcrumb">
              {workspace} <span className="slash">/</span>{" "}
              {(view === "epic" || view === "epics") && currentBoard && (
                <>
                  <button
                    type="button"
                    className="breadcrumb-link"
                    onClick={() => setView("board")}
                  >
                    {currentBoard.title}
                  </button>{" "}
                  <span className="slash">/</span>{" "}
                </>
              )}
              {view === "epic" && (
                <>
                  <button
                    type="button"
                    className="breadcrumb-link"
                    onClick={() => setView("epics")}
                  >
                    Epics
                  </button>{" "}
                  <span className="slash">/</span>{" "}
                </>
              )}
              {title}
            </span>
            <div className="search">
              <Icon name="search" size={16} />
              <input
                ref={search}
                type="search"
                aria-label="Search tasks by ID, title, or context"
                placeholder="Search ID, title, or context"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (!taskViews.includes(view)) setView("board");
                }}
              />
              <kbd aria-hidden="true">⌘K</kbd>
            </div>
            <button
              type="button"
              className="icon-button topbar-help"
              aria-label="Keyboard shortcuts"
              onClick={() => setHelp(true)}
            >
              <Icon name="help" />
            </button>
          </div>
          <div className="main-content">
            <header className="page-title">
              <h1 tabIndex={-1} data-focus-fallback="">
                {currentEpic && (
                  <span
                    className="epic-glyph large"
                    style={epicStyle(currentEpic)}
                    aria-hidden="true"
                  />
                )}
                {title}
              </h1>
              <p>
                {view === "epic"
                  ? currentEpic
                    ? `${currentEpic.id} · ${currentEpic.archived ? "Archived epic" : "Epic"}`
                    : "This epic isn't in the workspace."
                  : view === "boards"
                  ? "Task containers. Each board numbers its own tasks with its ID as the prefix."
                  : view === "epics"
                  ? `Projects that group related tasks on ${currentBoard?.title ?? "this board"}. Open one to see its tasks.`
                  : view === "agents"
                  ? "Known agents from the workspace roster. A listed agent is not necessarily connected or running."
                  : view === "mine"
                    ? workspaceInfoLoaded
                      ? `Tasks assigned to ${displayName(people, actor.id)}.`
                      : ""
                    : currentBoard
                      ? `${currentBoard.id} · All active tasks on this board.`
                      : ""}
              </p>
            </header>
            {view === "board" && currentBoard && canManageEpics && (
              <div className="epic-summary">
                <div className="epic-summary-row">
                  <button
                    type="button"
                    className="secondary small-button"
                    onClick={() => setBoardDialog({ board: currentBoard })}
                  >
                    Edit board
                  </button>
                  {!currentBoard.showInSidebar && (
                    <span className="small">Hidden from the sidebar.</span>
                  )}
                </div>
              </div>
            )}
            {sync.error && (
              <div className="banner error-banner" role="alert">
                <Icon name="alert" size={16} />
                <span>
                  {sync.error.code === "UNAUTHORIZED"
                    ? "The workspace needs a valid access token. Enter it in Settings."
                    : hasData
                      ? `Connection lost: ${sync.error.message} Showing data from ${sync.lastSync}; it may be out of date and changes can't be saved.`
                      : `Can't load the workspace: ${sync.error.message}`}
                </span>
                <button
                  type="button"
                  className="secondary small-button"
                  onClick={() => void refresh()}
                >
                  <Icon name="refresh" size={14} /> Retry
                </button>
                <button
                  type="button"
                  className="secondary small-button"
                  onClick={() => setSettings(true)}
                >
                  Settings
                </button>
              </div>
            )}
            {currentEpic && (
              <EpicSummary
                epic={currentEpic}
                canManage={canManageEpics}
                onEdit={() => setEpicDialog({ epic: currentEpic })}
              />
            )}
            {view === "boards" ? (
              <BoardsPage
                boards={boards}
                current={activeBoard}
                canManage={canManageEpics}
                onOpen={openBoard}
                onEdit={(board) => setBoardDialog({ board })}
                onNew={() => setBoardDialog({ board: null })}
              />
            ) : view === "epics" ? (
              <EpicsPage
                epics={activeEpics}
                unfiled={boardTasks.filter((t) => !t.epic).length}
                canManage={canManageEpics}
                onOpen={openEpic}
                onNew={() => setEpicDialog({ epic: null })}
              />
            ) : view === "agents" ? (
              <AgentsPage
                tasks={tasks}
                agents={agents}
                onView={(name) => {
                  setQuery("");
                  setAssignee(name);
                  setView("board");
                }}
              />
            ) : (
              <>
                <div className="toolbar">
                  <div className="tabs" role="group" aria-label="Layout">
                    <button
                      type="button"
                      aria-pressed={!list}
                      className={!list ? "active" : ""}
                      onClick={() => setList(false)}
                    >
                      <Icon name="board" size={15} /> Board
                    </button>
                    <button
                      type="button"
                      aria-pressed={list}
                      className={list ? "active" : ""}
                      onClick={() => setList(true)}
                    >
                      <Icon name="list" size={15} /> List
                    </button>
                  </div>
                  <div className="toolbar-actions">
                    {filtersActive && (
                      <button
                        type="button"
                        className="quiet clear-filters"
                        onClick={clearFilters}
                      >
                        <Icon name="close" size={14} /> Clear filters
                      </button>
                    )}
                    <AssigneeFilter
                      ref={filter}
                      assignees={assignees}
                      agents={agents}
                      me={actor.id}
                      value={assignee}
                      onChange={setAssignee}
                    />
                    <button
                      type="button"
                      className="primary"
                      onClick={newTask}
                    >
                      <Icon name="plus" size={16} />
                      New task
                    </button>
                  </div>
                </div>
                <p className="result-summary" role="status">
                  {sync.loaded && hasData
                    ? filtersActive
                      ? `Showing ${visible.length} of ${scoped.length} tasks`
                      : `${visible.length} tasks`
                    : ""}
                </p>
                {moveError && (
                  <div className="banner error-banner" role="alert">
                    <Icon name="alert" size={16} />
                    <span>{moveError}</span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Dismiss"
                      onClick={() => setMoveError("")}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                )}
                {!sync.loaded ? (
                  <div className="empty-state" role="status">
                    <span className="spinner" aria-hidden="true" />
                    <p>Loading the workspace…</p>
                  </div>
                ) : !hasData ? (
                  <div className="empty-state">
                    <h2>The workspace isn't available.</h2>
                    <p>
                      Check that the TasknBoard service is running, or add an
                      access token in Settings.
                    </p>
                    <div className="review-actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void refresh()}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setSettings(true)}
                      >
                        Settings
                      </button>
                    </div>
                  </div>
                ) : scoped.length === 0 && view === "board" ? (
                  <div className="empty-state">
                    <h2>No tasks on this board yet.</h2>
                    <p>
                      Create a task with context and acceptance criteria for a
                      teammate or an agent.
                    </p>
                    <button
                      type="button"
                      className="primary"
                      onClick={newTask}
                    >
                      <Icon name="plus" size={16} /> Create the first task
                    </button>
                  </div>
                ) : visible.length === 0 ? (
                  <div className="empty-state">
                    {filtersActive ? (
                      <>
                        <h2>No tasks match these filters.</h2>
                        <p>
                          {[
                            q && `Search “${query.trim()}”`,
                            assignee &&
                              `Assignee: ${assignee === UNASSIGNED ? "Unassigned" : displayName(people, assignee)}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          {view === "mine" && " · Only your tasks"}
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          onClick={clearFilters}
                        >
                          Clear filters
                        </button>
                      </>
                    ) : view === "epic" ? (
                      <>
                        <h2>No tasks in this epic yet.</h2>
                        <p>
                          Create a task here, or move an existing task into
                          this epic from its details.
                        </p>
                        {!currentEpic?.archived && (
                          <button
                            type="button"
                            className="primary"
                            onClick={newTask}
                          >
                            <Icon name="plus" size={16} /> New task in this epic
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <h2>Nothing is assigned to {displayName(people, actor.id)}.</h2>
                        <p>
                          Pick up a task from the board by setting yourself as
                          its assignee.
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setView("board")}
                        >
                          Go to the board
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <Board
                    tasks={visible}
                    agents={agents}
                    epics={view === "epic" ? undefined : epicsById}
                    onOpen={openTask}
                    onMove={move}
                    onNew={newTask}
                    pending={pending}
                    list={list}
                  />
                )}
              </>
            )}
          </div>
          <footer>
            <span
              className={`connection-dot ${sync.connected ? "online" : ""}`}
            />
            <span>{connectionLabel}</span>
            <div className="footer-keys" aria-hidden="true">
              <span>
                <kbd>N</kbd> New task
              </span>
              <span>
                <kbd>F</kbd> Filter
              </span>
              <span>
                <kbd>?</kbd> Shortcuts
              </span>
            </div>
          </footer>
        </main>
      </div>
      {standup && (
        <Standup
          tasks={boardTasks}
          agents={agents}
          connected={sync.connected}
          lastSync={sync.lastSync}
          onExit={() => setStandup(false)}
          onSaved={(task) => {
            setTasks((ts) => ts.map((t) => (t.id === task.id ? task : t)));
            void refresh();
          }}
        />
      )}
      {editor && (
        <TaskEditor
          key={editor.mode === "edit" ? editor.task.id : `create-${editor.board}`}
          task={editor.mode === "edit" ? editor.task : null}
          actor={actor}
          agents={agents}
          actors={actors}
          assignees={assignees}
          labels={labels}
          epics={epics}
          board={editor.mode === "create" ? editor.board : editor.task.board}
          initialEpic={editor.mode === "create" ? editor.epic : undefined}
          latestVersion={
            editor.mode === "edit"
              ? tasks.find((t) => t.id === editor.task.id)?.version
              : undefined
          }
          onClose={() => setEditor(null)}
          onCreated={created}
          onSaved={saved}
          onChanged={() => void refresh()}
          onArchived={archived}
        />
      )}
      {settings && (
        <Settings
          actor={actor}
          connected={sync.connected}
          onClose={() => setSettings(false)}
          onReconnect={refresh}
        />
      )}
      {epicDialog && (
        <EpicEditor
          key={epicDialog.epic?.id ?? "create"}
          epic={epicDialog.epic}
          board={epicDialog.epic?.board ?? activeBoard}
          suggestedColor={epicPalette[epics.length % epicPalette.length].id}
          onClose={() => setEpicDialog(null)}
          onSaved={epicSaved}
          onArchived={epicArchived}
        />
      )}
      {boardDialog && (
        <BoardEditor
          key={boardDialog.board?.id ?? "create"}
          board={boardDialog.board}
          onClose={() => setBoardDialog(null)}
          onSaved={boardSaved}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {!standup && <Toasts toasts={toasts} onDismiss={dismissToast} />}
    </PeopleContext.Provider>
  );
}

function AgentsPage({
  tasks,
  agents,
  onView,
}: {
  tasks: Task[];
  agents: Set<string>;
  onView: (name: string) => void;
}) {
  const people = usePeople();
  const roster = [...agents].sort((a, b) =>
    displayName(people, a).localeCompare(displayName(people, b)),
  );
  return (
    <div className="agents-page">
      <section aria-labelledby="roster-title">
        <h2 id="roster-title" className="section-title">
          Roster
        </h2>
        <p className="small">
          Inferred from assignees and claims. A listed agent is not necessarily
          connected or running.
        </p>
        {roster.length ? (
          <ul className="agents-table">
            {roster.map((name) => {
              const assigned = tasks.filter((t) => t.assignee === name);
              const claims = tasks.filter(
                (t) => activeLease(t)?.actor === name,
              );
              return (
                <li className="agent-row" key={name}>
                  <Assignee name={name} agent />
                  <span>{assigned.length} assigned</span>
                  <span>
                    {assigned.filter((t) => t.status === "in_progress").length}{" "}
                    in progress
                  </span>
                  <span>{claims.length} active claims</span>
                  <button
                    type="button"
                    className="secondary small-button"
                    onClick={() => onView(name)}
                    aria-label={`View tasks assigned to ${displayName(people, name)}`}
                  >
                    View tasks <Icon name="arrow" size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-state compact">
            No agent assignments or claims yet. Connect a coding agent below and
            let it claim a task.
          </p>
        )}
      </section>
      <section className="integration" aria-labelledby="mcp-title">
        <h2 id="mcp-title" className="section-title">
          Connect a coding agent (MCP)
        </h2>
        <p>
          Run the bundled stdio MCP server from your client's configuration.
          Point it at the same SQLite file as this workspace, and give each
          concurrent agent its own identity.
        </p>
        <pre tabIndex={0}>{`{
  "mcpServers": {
    "tasknboard": {
      "command": "node",
      "args": ["/absolute/path/tasknboard/server/mcp.mjs"],
      "env": {
        "TASKNBOARD_DB": "/absolute/path/tasknboard/data/tasknboard.sqlite",
        "TASKNBOARD_AGENT_ID": "codex"
      }
    }
  }
}`}</pre>
        <p className="small">
          The agent workflow: read and claim a task, keep the lease alive with
          heartbeats while recording progress, then submit review evidence,
          which releases the claim. A person reviews the work and marks it Done.
          For a shared server, use TASKNBOARD_SERVER_URL and an agent token; see
          the README.
        </p>
      </section>
    </div>
  );
}
