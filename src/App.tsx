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
import { ApiError, command, errorOf, loadTasks } from "./api";
import { Standup } from "./Standup";
import { registerWebMCP, type ModelContext } from "./webmcp";
import {
  activeLease,
  agentNames,
  statusTitle,
  type Actor,
  type Status,
  type Task,
} from "./types";

type View = "board" | "mine" | "agents";
type Editor = null | { mode: "create" } | { mode: "edit"; task: Task };
type Toast = {
  id: number;
  text: string;
  tone: "ok" | "error";
  actions?: { label: string; run: () => void }[];
};
const UNASSIGNED = "__unassigned__";
const viewTitles: Record<View, string> = {
  board: "Board",
  mine: "My tasks",
  agents: "Agents",
};

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [actor, setActor] = useState<Actor>({ id: "you", kind: "human" });
  const [workspace, setWorkspace] = useState("Workspace");
  const [view, setView] = useState<View>("board");
  const [list, setList] = useState(false);
  const [query, setQuery] = useState("");
  const [assignee, setAssignee] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [opening, setOpening] = useState("");
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [standup, setStandup] = useState(false);
  const [sync, setSync] = useState<{
    loaded: boolean;
    connected: boolean;
    error: ApiError | null;
    lastSync: string;
  }>({ loaded: false, connected: false, error: null, lastSync: "" });
  const [pending, setPending] = useState(new Map<string, Status>());
  const [moveError, setMoveError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const filter = useRef<HTMLSelectElement>(null);
  const standupButton = useRef<HTMLButtonElement>(null);
  const running = useRef<Promise<RefreshResult> | null>(null);
  const queued = useRef<Promise<RefreshResult> | null>(null);

  const load = useCallback(async (): Promise<RefreshResult> => {
    try {
      const [next, info] = await Promise.all([
        loadTasks(),
        command<{ name: string; actor: Actor }>("workspace_info"),
      ]);
      setTasks(next);
      setActor(info.actor);
      setWorkspace(info.name);
      setSync({
        loaded: true,
        connected: true,
        error: null,
        lastSync: new Date().toLocaleTimeString(),
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
    const controller = new AbortController();
    const context = (document as Document & { modelContext?: ModelContext })
      .modelContext;
    void registerWebMCP(
      context,
      command,
      async () => {
        await refresh();
      },
      controller.signal,
    ).catch((error) => console.error("WebMCP tool registration failed", error));
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const notify = useCallback((next: Omit<Toast, "id">) => {
    setToast({ ...next, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast || toast.actions?.length) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const dialogOpen = editor !== null || settings || help || Boolean(opening);
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
        setEditor({ mode: "create" });
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (view === "agents") setView("board");
        requestAnimationFrame(() => filter.current?.focus());
      } else if (e.key === "?") {
        e.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [standup, dialogOpen, view]);

  const wasPresenting = useRef(false);
  useEffect(() => {
    if (wasPresenting.current && !standup) standupButton.current?.focus();
    wasPresenting.current = standup;
  }, [standup]);

  const agents = useMemo(() => agentNames(tasks, actor), [tasks, actor]);
  const assignees = useMemo(
    () =>
      [...new Set(tasks.map((t) => t.assignee).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [tasks],
  );
  const labels = useMemo(
    () => [...new Set(tasks.map((t) => t.label).filter(Boolean))].sort(),
    [tasks],
  );
  const q = query.trim().toLowerCase();
  const filtersActive = Boolean(q || assignee);
  const matches = (t: Task, scope: View = view) =>
    (scope !== "mine" || t.assignee === actor.id) &&
    (!assignee ||
      (assignee === UNASSIGNED ? !t.assignee : t.assignee === assignee)) &&
    (!q || `${t.id} ${t.title} ${t.description}`.toLowerCase().includes(q));
  const scoped = tasks.filter(
    (t) => view !== "mine" || t.assignee === actor.id,
  );
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
        text: `Couldn't open ${task.id}: ${errorOf(e).message}`,
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
        text: `Moved ${task.id} to ${statusTitle(status)}.`,
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
    const shown = view !== "agents" && matches(task);
    notify({
      tone: "ok",
      text: shown
        ? `Created ${task.id} in Backlog.`
        : view === "agents"
          ? `Created ${task.id} in Backlog.`
          : `Created ${task.id} in Backlog. Your current filters hide it.`,
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
      text: matches(task)
        ? `Saved ${task.id}.`
        : `Saved ${task.id}. Your current filters now hide it.`,
    });
  }

  function archived(task: Task) {
    setEditor(null);
    setTasks((ts) => ts.filter((t) => t.id !== task.id));
    void refresh();
    notify({
      tone: "ok",
      text: `Archived ${task.id}. Its history is kept and included in exports.`,
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
    <>
      <div className="app-shell" hidden={standup} inert={standup}>
        <aside className="sidebar">
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
              height="28"
              viewBox="0 0 28 32"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M2 9 13 2v25L2 31V9Zm13-7 10 8-10 8V2Zm0 18 10 10H15V20Z"
              />
            </svg>
            <span>TasknBoard</span>
          </a>
          <span className="nav-label" id="nav-label">
            {workspace}
          </span>
          <nav aria-labelledby="nav-label" className="nav-main">
            {(
              [
                ["board", "board"],
                ["mine", "user"],
                ["agents", "bot"],
              ] as const
            ).map(([id, icon]) => (
              <button
                key={id}
                type="button"
                className={`nav-item ${view === id ? "selected" : ""}`}
                aria-current={view === id ? "page" : undefined}
                onClick={() => setView(id)}
              >
                <Icon name={icon} />
                <span>{viewTitles[id]}</span>
                {id === "mine" && (
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
          <div className="sidebar-bottom">
            <button
              type="button"
              className="nav-item"
              onClick={() => setSettings(true)}
            >
              <Icon name="settings" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              className="nav-item"
              onClick={() => setHelp(true)}
            >
              <Icon name="help" />
              <span>Shortcuts</span>
            </button>
            <div className="workspace-status" role="status">
              <span
                className={`connection-dot ${sync.connected ? "online" : ""}`}
              />
              <span>
                {actor.id} · {actor.kind}
              </span>
            </div>
          </div>
        </aside>
        <main>
          <div className="topbar">
            <span className="breadcrumb">
              {workspace} <span className="slash">/</span> {viewTitles[view]}
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
                  if (view === "agents") setView("board");
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
                {viewTitles[view]}
              </h1>
              <p>
                {view === "agents"
                  ? "Agents inferred from task assignments and claims."
                  : view === "mine"
                    ? `Tasks assigned to ${actor.id}.`
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
            {view === "agents" ? (
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
                    <label className="assignee-filter">
                      <Icon name="users" size={16} />
                      <span className="sr-only">Filter by assignee</span>
                      <select
                        ref={filter}
                        aria-label="Filter by assignee"
                        value={assignee}
                        onChange={(e) => setAssignee(e.target.value)}
                      >
                        <option value="">All assignees</option>
                        {[
                          ...assignees,
                          ...(assignee &&
                          assignee !== UNASSIGNED &&
                          !assignees.includes(assignee)
                            ? [assignee]
                            : []),
                        ].map((a) => (
                          <option key={a} value={a}>
                            {a}
                            {agents.has(a) ? " (agent)" : ""}
                          </option>
                        ))}
                        <option value={UNASSIGNED}>Unassigned</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => setEditor({ mode: "create" })}
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
                      onClick={() => setEditor({ mode: "create" })}
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
                              `Assignee: ${assignee === UNASSIGNED ? "Unassigned" : assignee}`,
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
                    ) : (
                      <>
                        <h2>Nothing is assigned to {actor.id}.</h2>
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
                    onOpen={openTask}
                    onMove={move}
                    onNew={() => setEditor({ mode: "create" })}
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
          assignees={assignees}
          labels={labels}
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
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      <div className="toasts" aria-live="polite">
        {toast && !standup && (
          <div
            className={`toast ${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
            key={toast.id}
          >
            <Icon name={toast.tone === "error" ? "alert" : "check"} size={16} />
            <span>{toast.text}</span>
            {toast.actions?.map((a) => (
              <button
                key={a.label}
                type="button"
                className="quiet"
                onClick={() => {
                  setToast(null);
                  a.run();
                }}
              >
                {a.label}
              </button>
            ))}
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setToast(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
      </div>
    </>
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
  const roster = [...agents].sort((a, b) => a.localeCompare(b));
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
                    aria-label={`View tasks assigned to ${name}`}
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
