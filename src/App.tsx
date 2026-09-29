import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Assignee, Board, StatusIcon } from "./Board";
import { ContextMenu, menuAt, type MenuState } from "./ContextMenu";
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
  columns,
  doneLocked,
  epicProgress,
  epicPalette,
  epicStyle,
  priorities,
  statusTitle,
  type Actor,
  type Epic,
  type Status,
  type Task,
  type WorkspaceInfo,
} from "./types";

type View = "board" | "mine" | "agents" | "epics" | "epic";
type Editor =
  | null
  | { mode: "create"; epic?: string }
  | { mode: "edit"; task: Task };
type EpicDialog = null | { epic: Epic | null };
const viewTitles: Record<Exclude<View, "epic">, string> = {
  board: "Board",
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
  const [menu, setMenu] = useState<MenuState | null>(null);
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
      const [next, info, epicList] = await Promise.all([
        loadTasks(),
        command<WorkspaceInfo>("workspace_info"),
        // Archived epics still name the finished tasks that keep them.
        command<{ epics: Epic[] }>("list_epics", { includeArchived: true }),
      ]);
      setTasks(next);
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
        setEditor({ mode: "create", epic: view === "epic" ? epicId : undefined });
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (view === "agents" || view === "epics") setView("board");
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
  }, [standup, dialogOpen, view, epicId]);

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
  const activeEpics = epics.filter((epic) => !epic.archived);
  const currentEpic = view === "epic" ? epicsById.get(epicId) : undefined;
  const title =
    view === "epic" ? (currentEpic?.title ?? "Epic") : viewTitles[view];
  /** People manage epics and archive tasks; the server enforces both. */
  const isHuman = workspaceInfoLoaded && actor.kind === "human";
  const openEpic = (epic: Epic) => {
    setEpicId(epic.id);
    setView("epic");
  };
  const newTask = () =>
    setEditor({ mode: "create", epic: view === "epic" ? epicId : undefined });
  const q = query.trim().toLowerCase();
  const filtersActive = Boolean(q || assignee);
  const inScope = (t: Task, scope: View = view) =>
    scope === "mine"
      ? workspaceInfoLoaded && t.assignee === actor.id
      : scope !== "epic" || t.epic === epicId;
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
    const shown = !["agents", "epics"].includes(view) && matches(task);
    notify({
      tone: "ok",
      title: `Created ${task.id}`,
      body:
        shown || view === "agents" || view === "epics"
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

  async function quickEdit(
    task: Task,
    patch: Partial<Pick<Task, "priority" | "assignee">>,
    body: string,
  ) {
    try {
      const saved = await command<Task>("update_task", {
        id: task.id,
        expectedVersion: task.version,
        patch,
      });
      setTasks((ts) => ts.map((t) => (t.id === saved.id ? saved : t)));
      notify({ tone: "ok", title: `Saved ${task.id}`, body });
    } catch (e) {
      notify({
        tone: "error",
        title: `${task.id} was not changed`,
        body: describeError(errorOf(e)),
      });
    } finally {
      void refresh();
    }
  }

  async function archiveTask(task: Task) {
    try {
      await command("archive_task", {
        id: task.id,
        expectedVersion: task.version,
      });
      archived(task);
    } catch (e) {
      notify({
        tone: "error",
        title: `${task.id} was not archived`,
        body: describeError(errorOf(e)),
      });
      void refresh();
    }
  }

  function copyId(id: string) {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(id))
      .then(
        () => notify({ tone: "ok", title: `Copied ${id}` }),
        () =>
          notify({
            tone: "error",
            title: `Couldn't copy ${id}`,
            body: "The browser blocked clipboard access.",
          }),
      );
  }

  function filterBy(name: string) {
    setAssignee(name);
    if (view === "agents" || view === "epics") setView("board");
  }

  function taskMenu(e: React.MouseEvent<HTMLElement>, task: Task) {
    const epic = epicsById.get(task.epic);
    const moving = pending.has(task.id);
    setMenu(
      menuAt(e, `Actions for ${task.id}`, [
        {
          items: [
            {
              label: "Open details",
              icon: <Icon name="external" size={14} />,
              disabled: Boolean(opening),
              onSelect: () => void openTask(task),
            },
          ],
        },
        {
          label: "Status",
          items: columns.map((c) => {
            const locked = c.id === "done" && doneLocked(task.status);
            return {
              label: locked ? "Done (after review)" : c.title,
              icon: <StatusIcon status={c.id} />,
              checked: task.status === c.id,
              disabled: moving || locked,
              onSelect: () => void move(task, c.id),
            };
          }),
        },
        {
          label: "Priority",
          items: priorities.map((p) => ({
            label: p.title,
            checked: task.priority === p.id,
            onSelect: () => {
              if (task.priority !== p.id)
                void quickEdit(task, { priority: p.id }, `Priority is now ${p.title}.`);
            },
          })),
        },
        {
          label: "Assignee",
          items: [
            ...(workspaceInfoLoaded && task.assignee !== actor.id
              ? [
                  {
                    label: "Assign to me",
                    icon: <Icon name="user" size={14} />,
                    onSelect: () =>
                      void quickEdit(
                        task,
                        { assignee: actor.id },
                        `Assigned to ${displayName(people, actor.id)}.`,
                      ),
                  },
                ]
              : []),
            ...(task.assignee
              ? [
                  {
                    label: "Unassign",
                    icon: <Icon name="close" size={14} />,
                    onSelect: () =>
                      void quickEdit(task, { assignee: "" }, "Now unassigned."),
                  },
                  {
                    label: `Show only ${displayName(people, task.assignee)}`,
                    icon: <Icon name="users" size={14} />,
                    checked: assignee === task.assignee,
                    onSelect: () =>
                      filterBy(assignee === task.assignee ? "" : task.assignee),
                  },
                ]
              : []),
          ],
        },
        {
          items: [
            ...(epic && !(view === "epic" && epicId === epic.id)
              ? [
                  {
                    label: `Open epic “${epic.title}”`,
                    icon: <Icon name="folder" size={14} />,
                    onSelect: () => openEpic(epic),
                  },
                ]
              : []),
            {
              label: "Copy ID",
              icon: <Icon name="list" size={14} />,
              onSelect: () => copyId(task.id),
            },
            ...(isHuman
              ? [
                  {
                    label: "Archive",
                    icon: <Icon name="archive" size={14} />,
                    confirm: `Confirm archive of ${task.id}`,
                    disabled: moving,
                    onSelect: () => void archiveTask(task),
                  },
                ]
              : []),
          ],
        },
      ]),
    );
  }

  function epicMenu(e: React.MouseEvent<HTMLElement>, epic: Epic) {
    setMenu(
      menuAt(e, `Actions for ${epic.id}`, [
        {
          items: [
            {
              label: "Open epic",
              icon: <Icon name="folder" size={14} />,
              onSelect: () => openEpic(epic),
            },
            ...(epic.archived
              ? []
              : [
                  {
                    label: "New task in this epic",
                    icon: <Icon name="plus" size={14} />,
                    onSelect: () => setEditor({ mode: "create", epic: epic.id }),
                  },
                ]),
            ...(isHuman && !epic.archived
              ? [
                  {
                    label: "Edit epic",
                    icon: <Icon name="mdWrite" size={14} />,
                    onSelect: () => setEpicDialog({ epic }),
                  },
                ]
              : []),
            {
              label: "Copy ID",
              icon: <Icon name="list" size={14} />,
              onSelect: () => copyId(epic.id),
            },
          ],
        },
      ]),
    );
  }

  function agentMenu(e: React.MouseEvent<HTMLElement>, name: string) {
    setMenu(
      menuAt(e, `Actions for ${displayName(people, name)}`, [
        {
          items: [
            {
              label: "View assigned tasks",
              icon: <Icon name="arrow" size={14} />,
              onSelect: () => {
                setQuery("");
                filterBy(name);
              },
            },
            {
              label: "Copy ID",
              icon: <Icon name="list" size={14} />,
              onSelect: () => copyId(name),
            },
          ],
        },
      ]),
    );
  }

  /** The menu for empty space in the current view. */
  function pageMenu(e: React.MouseEvent<HTMLElement>) {
    const taskView = view !== "agents" && view !== "epics";
    setMenu(
      menuAt(e, `${title} actions`, [
        {
          items: [
            ...(taskView && !currentEpic?.archived
              ? [
                  {
                    label: "New task",
                    icon: <Icon name="plus" size={14} />,
                    onSelect: newTask,
                  },
                ]
              : []),
            ...(view === "epics" && isHuman
              ? [
                  {
                    label: "New epic",
                    icon: <Icon name="plus" size={14} />,
                    onSelect: () => setEpicDialog({ epic: null }),
                  },
                ]
              : []),
            ...(currentEpic && isHuman && !currentEpic.archived
              ? [
                  {
                    label: "Edit epic",
                    icon: <Icon name="mdWrite" size={14} />,
                    onSelect: () => setEpicDialog({ epic: currentEpic }),
                  },
                ]
              : []),
          ],
        },
        {
          label: "Layout",
          items: taskView
            ? [
                {
                  label: "Board",
                  icon: <Icon name="board" size={14} />,
                  checked: !list,
                  onSelect: () => setList(false),
                },
                {
                  label: "List",
                  icon: <Icon name="list" size={14} />,
                  checked: list,
                  onSelect: () => setList(true),
                },
              ]
            : [],
        },
        {
          items: [
            ...(taskView && filtersActive
              ? [
                  {
                    label: "Clear filters",
                    icon: <Icon name="close" size={14} />,
                    onSelect: clearFilters,
                  },
                ]
              : []),
            {
              label: "Refresh",
              icon: <Icon name="refresh" size={14} />,
              onSelect: () => void refresh(),
            },
          ],
        },
      ]),
    );
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
                ["board", "board"],
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
          <nav className="nav-epics" aria-labelledby="epics-label">
            <div className="nav-section-head">
              <span className="nav-label" id="epics-label">
                Epics
              </span>
              {isHuman && (
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
                  onContextMenu={(e) => epicMenu(e, epic)}
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
                  if (view === "agents" || view === "epics") setView("board");
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
          <div className="main-content" onContextMenu={pageMenu}>
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
                  : view === "epics"
                  ? "Projects that group related tasks. Open one to see its board."
                  : view === "agents"
                  ? "Known agents from the workspace roster. A listed agent is not necessarily connected or running."
                  : view === "mine"
                    ? workspaceInfoLoaded
                      ? `Tasks assigned to ${displayName(people, actor.id)}.`
                      : ""
                    : `All active tasks in ${workspace}.`}
              </p>
            </header>
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
                canManage={isHuman}
                onEdit={() => setEpicDialog({ epic: currentEpic })}
              />
            )}
            {view === "epics" ? (
              <EpicsPage
                epics={activeEpics}
                unfiled={tasks.filter((t) => !t.epic).length}
                canManage={isHuman}
                onOpen={openEpic}
                onNew={() => setEpicDialog({ epic: null })}
                onMenu={epicMenu}
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
                onMenu={agentMenu}
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
                ) : tasks.length === 0 ? (
                  <div className="empty-state">
                    <h2>No tasks yet.</h2>
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
                    onMenu={taskMenu}
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
          tasks={tasks}
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
          key={editor.mode === "edit" ? editor.task.id : "create"}
          task={editor.mode === "edit" ? editor.task : null}
          actor={actor}
          agents={agents}
          actors={actors}
          assignees={assignees}
          labels={labels}
          epics={epics}
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
          suggestedColor={epicPalette[epics.length % epicPalette.length].id}
          onClose={() => setEpicDialog(null)}
          onSaved={epicSaved}
          onArchived={epicArchived}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {!standup && <Toasts toasts={toasts} onDismiss={dismissToast} />}
    </PeopleContext.Provider>
  );
}

function AgentsPage({
  tasks,
  agents,
  onView,
  onMenu,
}: {
  tasks: Task[];
  agents: Set<string>;
  onView: (name: string) => void;
  onMenu: (e: React.MouseEvent<HTMLElement>, name: string) => void;
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
                <li
                  className="agent-row"
                  key={name}
                  onContextMenu={(e) => onMenu(e, name)}
                >
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
