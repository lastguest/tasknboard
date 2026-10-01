import { AppVersion } from "./AppUpdates";
import { ConnectionHelpers } from "./ConnectionHelpers";
import { AgentLogs } from "./AgentLogs";
import {
  AgentSettings,
  useAgentSettings,
  type AgentSettingsInfo,
} from "./AgentSettings";
import { isMcpStatus, type McpStatus } from "./connection-helpers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Assignee, Board, StatusIcon } from "./Board";
import {
  ContextMenu,
  menuAt,
  useKeyboardContextMenu,
  type MenuState,
} from "./ContextMenu";
import {
  Settings,
  ShortcutHelp,
  TaskEditor,
  describeError,
  type RefreshResult,
} from "./Dialogs";
import { Icon } from "./Icons";
import { AssigneeFilter, UNASSIGNED } from "./AssigneeFilter";
import { ApiError, command, errorOf, loadTasks, taskNumber, token } from "./api";
import { Standup } from "./Standup";
import { BoardControls, BoardEditor, type BoardPage, SidebarBoards } from "./Boards";
import {
  EpicEditor,
  EpicsPage,
  EpicSummary,
} from "./Epics";
import { type Toast, Toasts } from "./Toasts";
import { PullRequestsPage, parsePullRef, pullHash, type PullRef } from "./PullRequests";
import type { SettingsPage } from "./Dialogs";
import {
  DisplayOptions,
  FilterBar,
  ViewEditor,
  ViewGlyph,
  ViewsPage,
  ViewSummary,
  groupTasks,
  nextViewColor,
  conditionDescriber,
  type FilterContext,
} from "./Views";
import {
  ME,
  defaultDisplay,
  sortTasks,
  taskMatchesView,
} from "../server/views.mjs";
import type { ModelContext } from "./webmcp";
import { formatUtcTimestamp } from "./formatting";
import { Avatar, displayName, PeopleContext, usePeople } from "./People";
import {
  activeLease,
  columns,
  doneLocked,
  epicPalette,
  epicStyle,
  priorities,
  statusTitle,
  type Actor,
  type BoardRecord,
  type Epic,
  type SavedView,
  type Status,
  type Task,
  type ViewCondition,
  type ViewDisplay,
  type ViewFilters,
  type WorkspaceInfo,
} from "./types";

type View = "board" | "mine" | "agents" | "epics" | "epic" | "views" | "saved" | "pulls";
/** The new-task dialog. Existing tasks open in tabs. */
type Editor = null | { boardId: string; epic?: string };
/** An open task tab. A new closeRequest value asks its editor to close. */
type TaskTab = { task: Task; closeRequest: number };
type EpicDialog = null | { epic: Epic | null };
type ViewDialog =
  | null
  | { view: SavedView }
  | { view: null; filters: ViewFilters; display: ViewDisplay };
type BoardDialog = null | { board: BoardRecord | null };
const viewTitles: Record<Exclude<View, "epic" | "saved">, string> = {
  board: "Board",
  mine: "My tasks",
  agents: "Agents",
  epics: "Epics",
  views: "Views",
  pulls: "Pull requests",
};
/** Pages without a task board. */
const overviews: View[] = ["agents", "epics", "views", "pulls"];
const SELECTED_BOARD_KEY = "tasknboard.selectedBoardId";
const readSelectedBoardId = () => {
  try {
    return localStorage.getItem(SELECTED_BOARD_KEY) ?? "";
  } catch {
    return "";
  }
};
const persistSelectedBoardId = (id: string) => {
  try {
    if (id) localStorage.setItem(SELECTED_BOARD_KEY, id);
    else localStorage.removeItem(SELECTED_BOARD_KEY);
  } catch {
    // Board selection still works for this page when storage is unavailable.
  }
};
const taskIdFromHash = (hash: string) =>
  /^#(?:task\/)?([A-Z][A-Z0-9]{1,9}-\d+)$/i.exec(hash)?.[1].toUpperCase() ?? "";
const isTaskId = (value: string) => /^[A-Z][A-Z0-9]{1,9}-\d+$/i.test(value);
const sameSettings = (
  a: { filters: ViewFilters; display: ViewDisplay },
  b: { filters: ViewFilters; display: ViewDisplay },
) =>
  JSON.stringify([a.filters, a.display]) ===
  JSON.stringify([b.filters, b.display]);

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [boards, setBoards] = useState<BoardRecord[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState(readSelectedBoardId);
  const selectedBoardRef = useRef(selectedBoardId);
  const boardSelectionEpoch = useRef(0);
  const boardDataGeneration = useRef(0);
  const handledTaskHash = useRef("");
  const [boardDialog, setBoardDialog] = useState<BoardDialog>(null);
  const [actor, setActor] = useState<Actor>({ id: "you", kind: "human" });
  const [actors, setActors] = useState<Actor[]>([]);
  const [workspaceInfoLoaded, setWorkspaceInfoLoaded] = useState(false);
  const [workspace, setWorkspace] = useState("Workspace");
  const [view, setPage] = useState<View>("board");
  const [epics, setEpics] = useState<Epic[]>([]);
  const [epicId, setEpicId] = useState("");
  const [epicDialog, setEpicDialog] = useState<EpicDialog>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState("");
  /** The open view as it was loaded or last saved; the working copy is below. */
  const [viewBase, setViewBase] = useState<SavedView | null>(null);
  const [viewDialog, setViewDialog] = useState<ViewDialog>(null);
  const [viewSaving, setViewSaving] = useState(false);
  const [viewError, setViewError] = useState<ApiError | null>(null);
  const [display, setDisplay] = useState<ViewDisplay>(defaultDisplay);
  const list = display.layout === "list";
  const setList = (next: boolean) =>
    setDisplay((d) => ({ ...d, layout: next ? "list" : "board" }));
  const [query, setQuery] = useState("");
  const [assignee, setAssignee] = useState("");
  const [conditions, setConditions] = useState<ViewCondition[]>([]);
  const [editor, setEditor] = useState<Editor>(null);
  const [tabs, setTabs] = useState<TaskTab[]>([]);
  /** The task ID of the active tab; empty for the page tab. */
  const [activeTab, setActiveTab] = useState("");
  // Archiving closes a tab after an await, so read the latest tabs here.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [opening, setOpening] = useState("");
  const [settings, setSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>();
  const [pullTarget, setPullTarget] = useState<PullRef | null>(null);
  /** Bumped when Settings closes, so the section sees a new GitHub connection. */
  const [settingsClosed, setSettingsClosed] = useState(0);
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  useKeyboardContextMenu();
  /** The task whose agent run logs are open. */
  const [logTask, setLogTask] = useState("");
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
  /** Leaving a saved view drops its filters so they don't follow you around. */
  const setView = (next: View) => {
    if (view === "saved" && next !== "saved") {
      setQuery("");
      setAssignee("");
      setConditions([]);
      setDisplay(defaultDisplay());
      setViewBase(null);
      setViewError(null);
    }
    setPage(next);
    setActiveTab("");
  };
  const saveAsRef = useRef<() => void>(() => {});
  const search = useRef<HTMLInputElement>(null);
  const filter = useRef<HTMLButtonElement>(null);
  const standupButton = useRef<HTMLButtonElement>(null);
  const running = useRef<Promise<RefreshResult> | null>(null);
  const queued = useRef<Promise<RefreshResult> | null>(null);

  const load = useCallback(async (): Promise<RefreshResult> => {
    const requestedBoardId = selectedBoardRef.current;
    const generation = boardDataGeneration.current;
    let scopedBoardId = requestedBoardId;
    try {
      const [info, viewList] = await Promise.all([
        command<WorkspaceInfo>("workspace_info"),
        command<{ views: SavedView[] }>("list_views"),
      ]);
      if (
        selectedBoardRef.current !== requestedBoardId ||
        boardDataGeneration.current !== generation
      )
        return { ok: true };
      setBoards(info.boards);
      setViews(viewList.views);
      setActor(info.actor);
      setActors(info.actors);
      setWorkspace(info.name);
      setWorkspaceInfoLoaded(true);

      const selected =
        info.boards.find((board) => board.id === selectedBoardRef.current) ??
        info.boards[0];
      scopedBoardId = selected?.id ?? "";
      if (selectedBoardRef.current !== scopedBoardId) {
        selectedBoardRef.current = scopedBoardId;
        setSelectedBoardId(scopedBoardId);
        persistSelectedBoardId(scopedBoardId);
      }
      const [next, epicList] = scopedBoardId
        ? await Promise.all([
            loadTasks(scopedBoardId),
            // Epic names are workspace-wide; task counts use this board.
            command<{ epics: Epic[] }>("list_epics", {
              includeArchived: true,
              boardId: scopedBoardId,
            }),
          ])
        : [[], { epics: [] as Epic[] }];
      // A slow response for the previous selection must never replace this board.
      if (
        selectedBoardRef.current !== scopedBoardId ||
        boardDataGeneration.current !== generation
      )
        return { ok: true };
      setTasks(next);
      setEpics(epicList.epics);
      setSync({
        loaded: true,
        connected: true,
        error: null,
        lastSync: formatUtcTimestamp(Date.now()),
      });
      return { ok: true };
    } catch (e) {
      if (
        boardDataGeneration.current !== generation ||
        (scopedBoardId && selectedBoardRef.current !== scopedBoardId)
      )
        return { ok: true };
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

  const selectBoard = useCallback(
    (id: string) => {
      if (!id || id === selectedBoardRef.current) return;
      boardSelectionEpoch.current += 1;
      boardDataGeneration.current += 1;
      selectedBoardRef.current = id;
      setSelectedBoardId(id);
      persistSelectedBoardId(id);
      setTasks([]);
      setEpics([]);
      setSync({ loaded: false, connected: false, error: null, lastSync: "" });
      setPending(new Map());
      setMoveError("");
      setEditor(null);
      setOpening("");
      setEpicDialog(null);
      setViewDialog(null);
      setViewId("");
      setViewBase(null);
      setViewError(null);
      setQuery("");
      setAssignee("");
      setConditions([]);
      setDisplay(defaultDisplay());
      setPullTarget(null);
      setStandup(false);
      setPage("board");
      void refresh();
    },
    [refresh],
  );

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
    boardDialog !== null ||
    epicDialog !== null ||
    viewDialog !== null ||
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
      if (target.closest('input,textarea,select,[contenteditable="true"]'))
        return;
      // Option+V types a character on macOS, so match the physical key.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyV") {
        e.preventDefault();
        saveAsRef.current();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        const boardId = selectedBoardRef.current;
        if (boardId)
          setEditor({ boardId, epic: view === "epic" ? epicId : undefined });
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setActiveTab("");
        if (overviews.includes(view)) setView("board");
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

  // Pull requests have links: #pulls, #pulls/owner/repo/123, or a GitHub URL
  // with "https://" replaced by this app's address and "#".
  useEffect(() => {
    const follow = () => {
      const hash = decodeURIComponent(location.hash);
      const ref = parsePullRef(hash);
      if (!ref && hash !== "#pulls") return;
      setPullTarget(ref);
      setView("pulls");
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  useEffect(() => {
    const followTask = () => {
      const hash = decodeURIComponent(location.hash);
      const id = taskIdFromHash(hash);
      if (!id || !workspaceInfoLoaded || handledTaskHash.current === hash) return;
      handledTaskHash.current = hash;
      void openTaskById(id);
    };
    followTask();
    window.addEventListener("hashchange", followTask);
    return () => window.removeEventListener("hashchange", followTask);
  }, [workspaceInfoLoaded, boards]);
  const previousView = useRef(view);
  useEffect(() => {
    // Leaving the section drops its link, so a reload opens the board.
    if (previousView.current === "pulls" && view !== "pulls")
      history.replaceState(null, "", location.pathname + location.search);
    previousView.current = view;
  }, [view]);
  const openPull = (ref: PullRef | null) => {
    setPullTarget(ref);
    setView("pulls");
    const hash = ref ? pullHash(ref) : "#pulls";
    if (location.hash !== hash) history.pushState(null, "", hash);
  };
  const openGitHubSettings = () => {
    setSettingsPage("github");
    setSettings(true);
  };

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
  // A renamed key prefix keeps the open epic: its number does not change.
  useEffect(() => {
    if (!epicId || epicsById.has(epicId)) return;
    const same = epics.find((e) => taskNumber(e.id) === taskNumber(epicId));
    if (same) setEpicId(same.id);
  }, [epics, epicsById, epicId]);
  const activeEpics = epics.filter((epic) => !epic.archived);
  const currentBoard = boards.find((board) => board.id === selectedBoardId);
  const currentEpic = view === "epic" ? epicsById.get(epicId) : undefined;
  const currentSaved =
    view === "saved" ? views.find((v) => v.id === viewId) : undefined;
  const title =
    view === "epic"
      ? (currentEpic?.title ?? "Epic")
      : view === "saved"
        ? (currentSaved?.name ?? viewBase?.name ?? "View")
        : view === "board"
          ? currentBoard?.name
          : viewTitles[view];
  /** People manage epics and archive tasks; the server enforces both. */
  const isHuman = workspaceInfoLoaded && actor.kind === "human";
  // Logs exist where the desktop app starts agents.
  const [logsAvailable, setLogsAvailable] = useState(false);
  useEffect(() => {
    if (!isHuman) return;
    const controller = new AbortController();
    command<{ autoStart: boolean }>("agent-configs", {}, controller.signal)
      .then((info) => setLogsAvailable(info.autoStart))
      .catch(() => setLogsAvailable(false));
    return () => controller.abort();
  }, [isHuman]);
  const openEpic = (epic: Epic) => {
    setEpicId(epic.id);
    setView("epic");
  };
  const newTask = () => {
    if (!currentBoard) return;
    setEditor({
      boardId: currentBoard.id,
      epic: view === "epic" ? epicId : undefined,
    });
  };
  const q = query.trim().toLowerCase();
  const filtersActive = Boolean(q || assignee || conditions.length);
  const inScope = (t: Task, scope: View = view) =>
    scope === "mine"
      ? workspaceInfoLoaded && t.assignee === actor.id
      : scope !== "epic" || t.epic === epicId;
  const matches = (t: Task, scope: View = view) =>
    inScope(t, scope) &&
    (!assignee ||
      (assignee === UNASSIGNED ? !t.assignee : t.assignee === assignee)) &&
    (!q || `${t.id} ${t.title} ${t.description}`.toLowerCase().includes(q)) &&
    (!conditions.length ||
      taskMatchesView(t, { query: "", conditions }, actor.id));
  const scoped = tasks.filter((t) => inScope(t));
  const visible = sortTasks(
    tasks.filter((t) => matches(t)),
    display.orderBy,
  );
  const groups = list
    ? groupTasks(visible, display.groupBy, {
        epics: epicsById,
        name: (id) => displayName(people, id),
      })
    : undefined;
  const filterContext: FilterContext = {
    assignees,
    agents,
    me: actor.id,
    labels,
    epics,
  };
  const describe = conditionDescriber(filterContext, people);
  const viewCount = (v: SavedView) =>
    tasks.filter((t) => taskMatchesView(t, v.filters, actor.id)).length;
  const favorites = views.filter((v) => v.favorite);

  /**
   * The page's filters as a view would store them. The page scope (My tasks,
   * an epic) and the assignee avatar filter become ordinary conditions.
   */
  const working = (): { filters: ViewFilters; display: ViewDisplay } => ({
    filters: {
      query: query.trim(),
      conditions: [
        ...(view === "mine"
          ? [{ field: "assignee", op: "is", values: [ME] } satisfies ViewCondition]
          : []),
        ...(view === "epic"
          ? [{ field: "epic", op: "is", values: [epicId] } satisfies ViewCondition]
          : []),
        ...conditions,
        ...(assignee
          ? [
              {
                field: "assignee",
                op: "is",
                values: [assignee === UNASSIGNED ? "" : assignee],
              } satisfies ViewCondition,
            ]
          : []),
      ],
    },
    display,
  });
  const viewDirty =
    view === "saved" && viewBase !== null && !sameSettings(working(), viewBase);

  /** Load a view's settings into the page. */
  function seedView(saved: SavedView) {
    setQuery(saved.filters.query);
    setConditions(saved.filters.conditions);
    setAssignee("");
    setDisplay(saved.display);
    setViewBase(saved);
    setViewError(null);
  }
  function openSavedView(saved: SavedView) {
    setViewId(saved.id);
    setPage("saved");
    seedView(saved);
  }
  // Someone else saved the open view: follow them unless you have changes.
  useEffect(() => {
    if (
      currentSaved &&
      viewBase?.id === currentSaved.id &&
      currentSaved.version !== viewBase.version &&
      !viewDirty
    )
      seedView(currentSaved);
  }, [currentSaved?.version]);
  const canSaveView =
    isHuman && !overviews.includes(view) && sync.connected;
  saveAsRef.current = () => {
    if (canSaveView) setViewDialog({ view: null, ...working() });
  };

  async function saveViewChanges() {
    if (!viewBase || viewSaving) return;
    setViewSaving(true);
    setViewError(null);
    try {
      const next = working();
      const saved = await command<SavedView>("update_view", {
        id: viewBase.id,
        expectedVersion: viewBase.version,
        patch: next,
      });
      setViews((list) => list.map((v) => (v.id === saved.id ? saved : v)));
      seedView(saved);
      notify({ tone: "ok", title: `Saved ${saved.name}` });
    } catch (e) {
      setViewError(errorOf(e));
    } finally {
      setViewSaving(false);
      void refresh();
    }
  }

  function openBoardPage(boardId: string, page: BoardPage) {
    selectBoard(boardId);
    setView(page);
  }

  async function setBoardSidebar(board: BoardRecord, inSidebar: boolean) {
    try {
      const saved = await command<BoardRecord>("set_board_sidebar", {
        id: board.id,
        inSidebar,
      });
      setBoards((list) => list.map((b) => (b.id === saved.id ? saved : b)));
    } catch (e) {
      notify({
        tone: "error",
        title: `Couldn't update the sidebar`,
        body: errorOf(e).message,
      });
    }
  }

  function boardMenu(e: React.MouseEvent<HTMLElement>, board: BoardRecord) {
    setMenu(
      menuAt(e, `Actions for ${board.name}`, [
        {
          items: [
            {
              label: "Open board",
              icon: <Icon name="board" size={14} />,
              onSelect: () => openBoardPage(board.id, "board"),
            },
            ...(isHuman
              ? [
                  {
                    label: "Edit board",
                    icon: <Icon name="mdWrite" size={14} />,
                    onSelect: () => setBoardDialog({ board }),
                  },
                  {
                    label: "Hide from sidebar",
                    icon: <Icon name="eye" size={14} />,
                    onSelect: () => void setBoardSidebar(board, false),
                  },
                ]
              : []),
          ],
        },
      ]),
    );
  }

  function boardSwitchMenu(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({
      label: "Boards",
      x: rect.left,
      y: rect.bottom + 4,
      trigger: e.currentTarget,
      groups: [
        {
          items: boards.map((board) => ({
            label: `${board.name} (${board.prefix})`,
            checked: board.id === selectedBoardId,
            onSelect: () => selectBoard(board.id),
          })),
        },
      ],
    });
  }

  function hiddenBoardsMenu(e: React.MouseEvent<HTMLElement>) {
    setMenu(
      menuAt(e, "Hidden boards", [
        {
          label: "Show in sidebar",
          items: boards
            .filter((board) => !board.inSidebar)
            .map((board) => ({
              label: board.name,
              icon: <Icon name="eye" size={14} />,
              onSelect: () => void setBoardSidebar(board, true),
            })),
        },
      ]),
    );
  }

  async function toggleFavorite(target: SavedView) {
    try {
      const saved = await command<SavedView>("favorite_view", {
        id: target.id,
        favorite: !target.favorite,
      });
      setViews((list) => list.map((v) => (v.id === saved.id ? saved : v)));
    } catch (e) {
      notify({
        tone: "error",
        title: `Couldn't update favorites`,
        body: errorOf(e).message,
      });
    }
  }

  function viewSaved(saved: SavedView, isNew: boolean) {
    setViewDialog(null);
    setViews((list) =>
      isNew ? [...list, saved] : list.map((v) => (v.id === saved.id ? saved : v)),
    );
    // A new view opens with the settings it was saved from.
    if (isNew) openSavedView(saved);
    // Metadata edits keep your unsaved filters, on the new version.
    else if (viewBase?.id === saved.id) setViewBase(saved);
    void refresh();
    notify({
      tone: "ok",
      title: isNew ? `Created ${saved.name}` : `Saved ${saved.name}`,
      body: isNew
        ? saved.shared
          ? "Everyone in the workspace can open it from Views."
          : "Only you can see it. Star it to keep it in the sidebar."
        : undefined,
    });
  }

  function viewDeleted(deleted: SavedView) {
    setViewDialog(null);
    setViews((list) => list.filter((v) => v.id !== deleted.id));
    if (view === "saved" && viewId === deleted.id) setView("views");
    void refresh();
    notify({ tone: "ok", title: `Deleted ${deleted.name}` });
  }

  function clearFilters() {
    setQuery("");
    setAssignee("");
    setConditions([]);
  }

  async function openTaskById(id: string) {
    if (opening) return;
    if (tabs.some((tab) => tab.task.id === id)) {
      setActiveTab(id);
      return;
    }
    const request = ++boardSelectionEpoch.current;
    const generation = boardDataGeneration.current;
    setOpening(id);
    try {
      const task = await command<Task>("get_task", { id });
      if (
        request !== boardSelectionEpoch.current ||
        generation !== boardDataGeneration.current
      )
        return;
      let availableBoards = boards;
      if (!availableBoards.some((board) => board.id === task.boardId)) {
        const info = await command<WorkspaceInfo>("workspace_info");
        if (
          request !== boardSelectionEpoch.current ||
          generation !== boardDataGeneration.current
        )
          return;
        availableBoards = info.boards;
        setBoards(availableBoards);
      }
      if (!availableBoards.some((board) => board.id === task.boardId))
        throw new ApiError(
          `The owning board for ${task.id} is not available in this workspace.`,
          "BOARD_NOT_FOUND",
          404,
        );
      // A former key resolves to the task's current ID, which may be open already.
      setTabs((list) =>
        list.some((tab) => tab.task.id === task.id)
          ? list
          : [...list, { task, closeRequest: 0 }],
      );
      setActiveTab(task.id);
    } catch (e) {
      if (request === boardSelectionEpoch.current)
        notify({
          tone: "error",
          title: `Couldn't open ${id}`,
          body: errorOf(e).message,
          actions: [{ label: "Retry", run: () => void openTaskById(id) }],
        });
    } finally {
      if (request === boardSelectionEpoch.current) setOpening("");
    }
  }

  async function openTask(task: Task) {
    return openTaskById(task.id);
  }

  function closeTab(id: string) {
    const list = tabsRef.current;
    const index = list.findIndex((tab) => tab.task.id === id);
    if (index < 0) return;
    setTabs((current) => current.filter((tab) => tab.task.id !== id));
    if (activeTabRef.current !== id) return;
    const next = (list[index + 1] ?? list[index - 1])?.task.id ?? "";
    setActiveTab(next);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-tab="${next}"]`)
        ?.focus(),
    );
  }

  function requestTabClose(id: string) {
    setTabs((list) =>
      list.map((tab) =>
        tab.task.id === id
          ? { ...tab, closeRequest: tab.closeRequest + 1 }
          : tab,
      ),
    );
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
    const shown = !overviews.includes(view) && matches(task);
    notify({
      tone: "ok",
      title: `Created ${task.id}`,
      body:
        shown || overviews.includes(view)
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
    setTasks((ts) => ts.map((t) => (t.id === task.id ? task : t)));
    void refresh();
    notify({
      tone: "ok",
      title: `Saved ${task.id}`,
      body: matches(task) ? undefined : "Your current filters now hide it.",
    });
  }

  function archived(task: Task) {
    closeTab(task.id);
    setTasks((ts) => ts.filter((t) => t.id !== task.id));
    void refresh();
    notify({
      tone: "ok",
      title: `Archived ${task.id}`,
      body: "Its history is kept and included in exports.",
    });
  }

  function boardSaved(saved: BoardRecord, previous: BoardRecord | null) {
    setBoardDialog(null);
    setBoards((list) =>
      previous
        ? list.map((board) => (board.id === saved.id ? saved : board))
        : [...list, saved],
    );
    if (!previous) {
      selectBoard(saved.id);
    } else if (
      previous.id === selectedBoardRef.current &&
      previous.prefix !== saved.prefix
    ) {
      boardSelectionEpoch.current += 1;
      boardDataGeneration.current += 1;
      setTasks([]);
      setEpics([]);
      setSync({ loaded: false, connected: false, error: null, lastSync: "" });
      setOpening("");
      clearFilters();
      void refresh();
    }
    notify({
      tone: "ok",
      title: previous ? `Saved ${saved.name}` : `Created ${saved.name}`,
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
      title: isNew ? `Created ${epic.title}` : `Saved ${epic.title}`,
      body: isNew ? "Ready for tasks." : undefined,
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
      title: `Archived ${epic.title}`,
      body: "Done tasks keep the epic, and it stays in exports.",
    });
  }

  async function quickEdit(
    task: Task,
    patch: Partial<Pick<Task, "priority" | "assignee" | "epic">>,
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

  function setEpic(task: Task, epic: string) {
    return quickEdit(
      task,
      { epic },
      epic
        ? `Now in ${epicsById.get(epic)?.title ?? "the epic"}.`
        : "No longer in an epic.",
    );
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
            ...(logsAvailable
              ? [
                  {
                    label: "Agent logs",
                    icon: <Icon name="terminal" size={14} />,
                    onSelect: () => setLogTask(task.id),
                  },
                ]
              : []),
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
            ...(epic.archived || !currentBoard
              ? []
              : [
                  {
                    label: "New task in this epic",
                    icon: <Icon name="plus" size={14} />,
                    onSelect: () =>
                      setEditor({ boardId: currentBoard.id, epic: epic.id }),
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

  const boardName = (id: string) =>
    boards.find((board) => board.id === id)?.name ?? "Unavailable board";

  const openStandup = () => {
    setEditor(null);
    setStandup(true);
    // Agents bound to the stand-up start in the desktop app; elsewhere nothing happens.
    if (isHuman) void command("agent-event", { event: "standup" }).catch(() => {});
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
                ["agents", "cursor"],
                ["epics", "folder"],
                ["views", "layers"],
                ["pulls", "pull"],
              ] as const
            ).map(([id, icon]) => (
              <button
                key={id}
                type="button"
                className={`nav-item ${view === id ? "selected" : ""} ${
                  id === "board" || id === "epics" || id === "views"
                    ? "nav-board-scoped"
                    : ""
                }`}
                aria-current={view === id ? "page" : undefined}
                title={collapsed ? viewTitles[id] : undefined}
                onClick={() => (id === "pulls" ? openPull(pullTarget) : setView(id))}
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
          <div className="sidebar-scroll">
            {favorites.length > 0 && (
              <nav
                className="nav-epics nav-favorites"
                aria-labelledby="favorites-label"
              >
                <div className="nav-section-head">
                  <span className="nav-label" id="favorites-label">
                    Favorites
                  </span>
                </div>
                {favorites.map((saved) => {
                  const selected = view === "saved" && viewId === saved.id;
                  const count = viewCount(saved);
                  return (
                    <button
                      key={saved.id}
                      type="button"
                      className={`nav-item nav-epic ${selected ? "selected" : ""}`}
                      aria-current={selected ? "page" : undefined}
                      title={collapsed ? saved.name : undefined}
                      onClick={() => openSavedView(saved)}
                    >
                      <ViewGlyph view={saved} size={14} />
                      <span className="nav-epic-title">{saved.name}</span>
                      <small aria-label={`${count} tasks`}>{count}</small>
                    </button>
                  );
                })}
              </nav>
            )}
            <SidebarBoards
              boards={boards}
              selectedBoardId={selectedBoardId}
              page={view}
              collapsed={collapsed}
              canManage={isHuman}
              onOpen={openBoardPage}
              onCreate={() => setBoardDialog({ board: null })}
              onMenu={boardMenu}
              onHiddenMenu={hiddenBoardsMenu}
            />
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
                const inProgress = epic.counts.in_progress;
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
                    <small
                      aria-label={`${inProgress} ${inProgress === 1 ? "task" : "tasks"} in progress`}
                      title="In progress"
                    >
                      {inProgress}
                    </small>
                  </button>
                );
              })}
              {sync.loaded && !activeEpics.length && (
                <p className="nav-empty">
                  Group related tasks into a project.
                </p>
              )}
            </nav>
          </div>
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
            <AppVersion />
          </div>
        </aside>
        <main>
          <div className="topbar">
            <span className="breadcrumb">
              {workspace} <span className="slash">/</span>{" "}
              {(view === "epic" || view === "saved") && (
                <>
                  <button
                    type="button"
                    className="breadcrumb-link"
                    onClick={() => setView(view === "epic" ? "epics" : "views")}
                  >
                    {view === "epic" ? "Epics" : "Views"}
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
                onKeyDown={(e) => {
                  const taskId = query.trim();
                  const typed = /github\.com\//i.test(query)
                    ? parsePullRef(query)
                    : null;
                  if (e.key === "Enter" && isTaskId(taskId)) {
                    e.preventDefault();
                    setQuery("");
                    setAssignee("");
                    setConditions([]);
                    void openTaskById(taskId.toUpperCase());
                    return;
                  }
                  if (e.key === "Enter" && typed) {
                    setQuery("");
                    openPull(typed);
                  }
                }}
                onChange={(e) => {
                  // A pasted GitHub pull request link opens it, as in Linear.
                  // A typed link waits for Enter, so /pull/4 isn't opened on the way to /pull/42.
                  const pasted =
                    (e.nativeEvent as InputEvent).inputType === "insertFromPaste" &&
                    /github\.com\//i.test(e.target.value)
                      ? parsePullRef(e.target.value)
                      : null;
                  if (pasted) {
                    setQuery("");
                    openPull(pasted);
                    e.target.blur();
                    return;
                  }
                  setQuery(e.target.value);
                  setActiveTab("");
                  if (overviews.includes(view)) setView("board");
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
          {tabs.length > 0 && (
            <nav className="task-tabs" aria-label="Open tasks">
              <button
                type="button"
                data-tab=""
                className={`task-tab page-tab ${activeTab === "" ? "selected" : ""}`}
                aria-current={activeTab === "" ? "page" : undefined}
                onClick={() => setActiveTab("")}
              >
                {title}
              </button>
              {tabs.map(({ task }) => {
                const selected = activeTab === task.id;
                const label =
                  tasks.find((t) => t.id === task.id)?.title ?? task.title;
                return (
                  <div
                    key={task.id}
                    className={`task-tab ${selected ? "selected" : ""}`}
                  >
                    <button
                      type="button"
                      data-tab={task.id}
                      className="task-tab-open"
                      aria-current={selected ? "page" : undefined}
                      title={label}
                      onClick={() => setActiveTab(task.id)}
                    >
                      <span className="task-id">{task.id}</span>
                      <span className="task-tab-title">{label}</span>
                    </button>
                    <button
                      type="button"
                      className="task-tab-close"
                      aria-label={`Close ${task.id}`}
                      onClick={() => requestTabClose(task.id)}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                );
              })}
            </nav>
          )}
          {tabs.map(({ task, closeRequest }) => (
            <div
              key={task.id}
              className="task-tab-panel"
              hidden={activeTab !== task.id}
            >
              <TaskEditor
                task={task}
                boardId={task.boardId}
                boardName={boardName(task.boardId)}
                actor={actor}
                agents={agents}
                actors={actors}
                assignees={assignees}
                labels={labels}
                epics={epics}
                linkCandidates={tasks}
                latestVersion={tasks.find((t) => t.id === task.id)?.version}
                closeRequest={closeRequest}
                onReveal={() => setActiveTab(task.id)}
                onClose={() => closeTab(task.id)}
                onCreated={created}
                onSaved={saved}
                onChanged={() => void refresh()}
                onArchived={archived}
                onOpenTask={(id) => void openTaskById(id)}
              />
            </div>
          ))}
          <div
            className="main-content"
            hidden={activeTab !== ""}
            onContextMenu={pageMenu}
          >
            <header className="page-title">
              <div className="page-title-row">
                <h1 tabIndex={-1} data-focus-fallback="">
                  {currentEpic && (
                    <span
                      className="epic-glyph large"
                      style={epicStyle(currentEpic)}
                      aria-hidden="true"
                    />
                  )}
                  {currentSaved && <ViewGlyph view={currentSaved} size={22} />}
                  {title}
                  {view === "board" && (
                    <button
                      type="button"
                      className="board-switch"
                      aria-label={`Switch board, current ${currentBoard?.name ?? "none"}`}
                      aria-haspopup="menu"
                      disabled={!boards.length}
                      onClick={boardSwitchMenu}
                    >
                      <Icon name="chevronDown" size={20} />
                    </button>
                  )}
                </h1>
                {/* Board actions share the title row so the header doesn't spend a line on them. */}
                {view === "board" && isHuman && (
                  <BoardControls
                    canEdit={!!currentBoard}
                    onCreate={() => setBoardDialog({ board: null })}
                    onEdit={() =>
                      currentBoard && setBoardDialog({ board: currentBoard })
                    }
                  />
                )}
              </div>
              {view === "board" ? (
                currentBoard?.description && <p>{currentBoard.description}</p>
              ) : (
                <p>
                  {view === "epic"
                    ? currentEpic
                      ? `${currentEpic.archived ? "Archived epic" : "Epic"} · Tasks on ${currentBoard?.name ?? "the selected board"}`
                      : "This epic isn't in the workspace."
                    : view === "saved"
                    ? currentSaved
                      ? `Saved filters and display · Counts for ${currentBoard?.name ?? "the selected board"}`
                      : "This view was deleted or is no longer shared with you."
                    : view === "views"
                    ? `Saved filters and display settings. Counts reflect ${currentBoard?.name ?? "the selected board"}. Star a view to keep it in the sidebar.`
                    : view === "pulls"
                    ? "GitHub pull requests that involve you. Paste any pull request link to open it."
                    : view === "epics"
                    ? "Projects that group related tasks. Open one to see its board."
                    : view === "agents"
                    ? "Coding agents that work on tasks in this workspace."
                    : workspaceInfoLoaded
                      ? `Tasks assigned to ${displayName(people, actor.id)} on ${currentBoard?.name ?? "the selected board"}.`
                      : ""}
                </p>
              )}
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
            {currentSaved && (
              <ViewSummary
                view={currentSaved}
                dirty={viewDirty}
                canManage={isHuman}
                saving={viewSaving}
                error={viewError}
                onSave={() => void saveViewChanges()}
                onSaveAs={() => saveAsRef.current()}
                onReset={() => seedView(currentSaved)}
                onEdit={() => setViewDialog({ view: currentSaved })}
                onFavorite={() => void toggleFavorite(currentSaved)}
              />
            )}
            {view === "views" ? (
              <ViewsPage
                views={views}
                me={actor.id}
                count={viewCount}
                describe={describe}
                canManage={isHuman}
                onOpen={openSavedView}
                onNew={() =>
                  setViewDialog({
                    view: null,
                    filters: { query: "", conditions: [] },
                    display: defaultDisplay(),
                  })
                }
                onFavorite={(saved) => void toggleFavorite(saved)}
              />
            ) : view === "pulls" ? (
              <PullRequestsPage
                target={pullTarget}
                tasks={tasks}
                onTarget={openPull}
                onOpenTask={openTask}
                onSettings={openGitHubSettings}
                settingsClosed={settingsClosed}
              />
            ) : view === "epics" ? (
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
                    <DisplayOptions display={display} onChange={setDisplay} />
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
                      disabled={!currentBoard}
                    >
                      <Icon name="plus" size={16} />
                      New task
                    </button>
                  </div>
                </div>
                <div className="filter-row">
                  <FilterBar
                    conditions={conditions}
                    context={filterContext}
                    onChange={setConditions}
                  />
                  {canSaveView &&
                    view !== "saved" &&
                    (filtersActive || view === "mine" || view === "epic") && (
                      <button
                        type="button"
                        className="quiet save-view"
                        title="Save as view (⌥V)"
                        onClick={() => saveAsRef.current()}
                      >
                        <Icon name="layers" size={14} /> Save as view
                      </button>
                    )}
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
                        disabled={!currentBoard}
                      >
                      <Icon name="plus" size={16} /> Create the first task
                    </button>
                  </div>
                ) : visible.length === 0 ? (
                  <div className="empty-state">
                    {view === "saved" && !viewDirty ? (
                      <>
                        <h2>No tasks match this view.</h2>
                        <p>
                          {[
                            ...(query.trim() ? [`Search “${query.trim()}”`] : []),
                            ...conditions.map(describe),
                          ].join(" · ") || "All active tasks"}
                        </p>
                      </>
                    ) : filtersActive ? (
                      <>
                        <h2>No tasks match these filters.</h2>
                        <p>
                          {[
                            q && `Search “${query.trim()}”`,
                            assignee &&
                              `Assignee: ${assignee === UNASSIGNED ? "Unassigned" : displayName(people, assignee)}`,
                            ...conditions.map(describe),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          {view === "mine" && " · Only your tasks"}
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          onClick={
                            view === "saved" && currentSaved
                              ? () => seedView(currentSaved)
                              : clearFilters
                          }
                        >
                          {view === "saved" && currentSaved
                            ? "Reset view"
                            : "Clear filters"}
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
                    onEpic={setEpic}
                    onNew={newTask}
                    onMenu={taskMenu}
                    onLogs={logsAvailable ? (t) => setLogTask(t.id) : undefined}
                    pending={pending}
                    list={list}
                    groups={groups}
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
          task={null}
          boardId={editor.boardId}
          boardName={boardName(editor.boardId)}
          actor={actor}
          agents={agents}
          actors={actors}
          assignees={assignees}
          labels={labels}
          epics={epics}
          initialEpic={editor.epic}
          onClose={() => setEditor(null)}
          onCreated={created}
          onSaved={saved}
          onChanged={() => void refresh()}
          onArchived={archived}
        />
      )}
      {boardDialog && (
        <BoardEditor
          key={boardDialog.board?.id ?? "create"}
          board={boardDialog.board}
          boards={boards}
          onClose={() => setBoardDialog(null)}
          onSaved={boardSaved}
        />
      )}
      {settings && (
        <Settings
          actor={actor}
          connected={sync.connected}
          initialPage={settingsPage}
          onClose={() => {
            setSettings(false);
            setSettingsPage(undefined);
            setSettingsClosed((n) => n + 1);
          }}
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
      {viewDialog && (
        <ViewEditor
          key={viewDialog.view?.id ?? "create"}
          view={viewDialog.view}
          draft={
            viewDialog.view ?? {
              filters: viewDialog.filters,
              display: viewDialog.display,
            }
          }
          me={actor.id}
          suggestedColor={nextViewColor(views)}
          describe={describe}
          onClose={() => setViewDialog(null)}
          onSaved={viewSaved}
          onDeleted={viewDeleted}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {logTask && <AgentLogs taskId={logTask} onClose={() => setLogTask("")} />}
      {!standup && <Toasts toasts={toasts} onDismiss={dismissToast} />}
    </PeopleContext.Provider>
  );
}

/** The CLI and auto-start state shown on an agent's Settings button. */
function autoStartLabel(info: AgentSettingsInfo, identity: string) {
  const config = info.agents[identity]?.config;
  if (!config) return "Not configured. Assigned tasks do not start it.";
  const client = info.clients.find((c) => c.id === config.client)?.name;
  return `${client} · ${config.enabled ? "starts automatically" : "auto-start off"}`;
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
  const settings = useAgentSettings();
  const [selected, setSelected] = useState("");
  const local = settings.info?.mode === "local";
  // Configured identities appear before their CLI first connects.
  const roster = [
    ...new Set([...agents, ...Object.keys(settings.info?.agents ?? {})]),
  ].sort((a, b) =>
    displayName(people, a).localeCompare(displayName(people, b)),
  );
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpError, setMcpError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const bearer = token.get();
    void fetch("/api/mcp-config", {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]),
    })
      .then(async (response) => {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new ApiError(
            `The workspace service returned an unexpected response (${response.status}).`,
            "BAD_RESPONSE",
            response.status,
          );
        }
        if (!response.ok) {
          const error =
            body && typeof body === "object" && !Array.isArray(body)
              ? (body as Record<string, unknown>)
              : {};
          throw new ApiError(
            typeof error.message === "string"
              ? error.message
              : `MCP configuration request failed (${response.status}).`,
            typeof error.code === "string"
              ? error.code
              : response.status === 401
                ? "UNAUTHORIZED"
                : "HTTP_ERROR",
            response.status,
          );
        }
        if (!isMcpStatus(body))
          throw new ApiError(
            "The workspace service returned an unexpected MCP configuration.",
            "BAD_RESPONSE",
            response.status,
          );
        return body;
      })
      .then(setMcpStatus)
      .catch((error) => {
        if (!controller.signal.aborted) setMcpError(errorOf(error).message);
      });
    return () => controller.abort();
  }, []);
  if (selected && settings.info && local)
    return (
      <div className="agents-page">
        <AgentSettings
          identity={selected}
          info={settings.info}
          onBack={() => setSelected("")}
          onSaved={settings.reload}
        />
      </div>
    );
  return (
    <div className="agents-page">
      <section aria-labelledby="roster-title">
        <h2 id="roster-title" className="section-title">
          Roster
        </h2>
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
                  <span className="agent-row-actions">
                  {local && (
                    <button
                      type="button"
                      className="secondary small-button"
                      onClick={() => setSelected(name)}
                      aria-label={`Settings for ${displayName(people, name)}`}
                      title={autoStartLabel(settings.info!, name)}
                    >
                      <Icon name="settings" size={13} /> Settings
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary small-button"
                    onClick={() => onView(name)}
                    aria-label={`View tasks assigned to ${displayName(people, name)}`}
                  >
                    View tasks <Icon name="arrow" size={13} />
                  </button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-state compact">
            No agents yet. Connect one below.
          </p>
        )}
      </section>
      <section className="integration" aria-labelledby="mcp-title">
        <h2 id="mcp-title" className="section-title">
          Connect a coding agent
        </h2>
        {mcpStatus?.mode === "shared" && (
          <p>
            Run the MCP bridge on the agent host with{" "}
            <code>TASKNBOARD_SERVER_URL={window.location.origin}</code> and an
            agent token in <code>TASKNBOARD_TOKEN</code>.
          </p>
        )}
        {mcpStatus?.mode === "local" && (
          <ConnectionHelpers
            runtime={mcpStatus}
            onInstalled={settings.reload}
          />
        )}
        {!mcpStatus && !mcpError && (
          <p className="small" role="status">
            Loading MCP configuration…
          </p>
        )}
        {mcpError && (
          <p className="small" role="alert">
            {mcpError}
          </p>
        )}
        {settings.error && (
          <p className="small" role="alert">
            {settings.error}
          </p>
        )}
      </section>
    </div>
  );
}
