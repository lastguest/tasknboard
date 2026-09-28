import { useCallback, useEffect, useRef, useState } from "react";
import { Board, Avatar } from "./Board";
import { Dialog, Settings, TaskEditor } from "./Dialogs";
import { Icon } from "./Icons";
import { command, loadTasks } from "./api";
import { Standup } from "./Standup";
import type { Actor, Task, Status } from "./types";
export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]),
    [actor, setActor] = useState<Actor>({ id: "you", kind: "human" }),
    [view, setView] = useState("board"),
    [list, setList] = useState(false),
    [query, setQuery] = useState(""),
    [assignee, setAssignee] = useState(""),
    [editor, setEditor] = useState<Task | null | undefined>(undefined),
    [settings, setSettings] = useState(false),
    [help, setHelp] = useState(false),
    [standup, setStandup] = useState(false),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [connected, setConnected] = useState(false),
    [lastSync, setLastSync] = useState("");
  const search = useRef<HTMLInputElement>(null),
    filter = useRef<HTMLSelectElement>(null),
    running = useRef(false);
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const [next, info] = await Promise.all([
        loadTasks(),
        command<{ actor: Actor }>("workspace_info"),
      ]);
      setTasks(next);
      setActor(info.actor);
      setConnected(true);
      setLastSync(new Date().toLocaleTimeString());
      setError("");
    } catch (e) {
      setConnected(false);
      setError((e as Error).message);
    } finally {
      setLoaded(true);
      running.current = false;
    }
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (standup || editor !== undefined || settings || help) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (
        (e.target as HTMLElement).matches("input,textarea,select") ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (e.key === "n") setEditor(null);
      if (e.key === "f") filter.current?.focus();
      if (e.key === "?") setHelp(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editor, settings, help, standup]);
  async function openTask(task: Task) {
    try {
      setEditor(await command<Task>("get_task", { id: task.id }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function move(t: Task, status: Status) {
    try {
      await command("update_task", {
        id: t.id,
        expectedVersion: t.version,
        patch: { status },
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const visible = tasks.filter(
    (t) =>
      (view !== "mine" || t.assignee === actor.id) &&
      (!assignee || t.assignee === assignee) &&
      `${t.id} ${t.title} ${t.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const agents = [
    ...new Set(
      tasks
        .filter((t) => /agent|codex|claude|bot/i.test(t.assignee) || t.lease)
        .map((t) => t.lease?.actor || t.assignee),
    ),
  ];
  if (standup)
    return (
      <Standup
        tasks={tasks}
        connected={connected}
        onExit={() => setStandup(false)}
        onSaved={(task) => {
          setTasks((current) =>
            current.map((t) => (t.id === task.id ? task : t)),
          );
          void refresh();
        }}
      />
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("board");
          }}
        >
          <svg
            className="brand-symbol"
            width="28"
            height="32"
            viewBox="0 0 28 32"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M2 9 13 2v25L2 31V9Zm13-7 10 8-10 8V2Zm0 18 10 10H15V20Z"
            />
          </svg>
          TasknBoard
        </a>
        <span className="nav-label">Workspace</span>
        <nav>
          {[
            ["board", "Board", "board"],
            ["mine", "My tasks", "user"],
            ["agents", "Agents", "bot"],
          ].map(([id, title, icon]) => (
            <button
              key={id}
              aria-label={title}
              className={`nav-item ${view === id ? "selected" : ""}`}
              onClick={() => setView(id)}
            >
              <Icon name={icon} />
              <span>{title}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            aria-label="Stand-up"
            className="nav-item standup-launch"
            disabled={!loaded || !connected}
            onClick={() => setStandup(true)}
          >
            <Icon name="screen" />
            <span>Stand-up</span>
          </button>
          <button className="nav-item" onClick={() => setSettings(true)}>
            <Icon name="settings" />
            Settings
          </button>
          <div className="workspace-status">
            <Icon name="screen" />
            <span>Studio workspace</span>
            <span className={`connection-dot ${connected ? "online" : ""}`} />
          </div>
        </div>
      </aside>
      <main>
        <div className="topbar">
          <span>
            Workspace <span className="slash">/</span>{" "}
            {view === "agents" ? "Agents" : "Product"}
          </span>
          <div className="search">
            <Icon name="search" size={17} />
            <input
              ref={search}
              aria-label="Search tasks"
              placeholder="Search tasks, agents, or anything…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (view === "agents") setView("board");
              }}
            />
            <kbd>⌘ K</kbd>
          </div>
        </div>
        <div className="main-content">
          <header className="page-title">
            <h1>
              {view === "mine"
                ? "My tasks"
                : view === "agents"
                  ? "Agents"
                  : "Product"}
            </h1>
            <p>
              {view === "agents"
                ? "A clear handoff between people and agents."
                : view === "mine"
                  ? "Your work, with room to focus."
                  : "A small team. A clear direction."}
            </p>
          </header>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button onClick={() => setSettings(true)}>Settings</button>
              <button onClick={refresh}>Retry</button>
            </div>
          )}
          {view === "agents" ? (
            <div className="agents-page">
              <div className="agent-intro">
                <Icon name="bot" size={28} />
                <div>
                  <h2>Agents are part of the workflow.</h2>
                  <p>
                    Claim a task, keep the lease alive, submit evidence for
                    review.
                  </p>
                </div>
                <span className="label agents">MCP</span>
              </div>
              <div className="agents-table">
                {agents.map((name) => (
                  <div className="agent-row" key={name}>
                    <Avatar name={name} />
                    <strong>{name}</strong>
                    <span>
                      {
                        tasks.filter(
                          (t) =>
                            t.assignee === name && t.status === "in_progress",
                        ).length
                      }{" "}
                      in progress
                    </span>
                    <span>
                      {
                        tasks.filter(
                          (t) =>
                            t.lease?.actor === name &&
                            t.lease.expiresAt > Date.now(),
                        ).length
                      }{" "}
                      active claims
                    </span>
                    <button
                      className="secondary"
                      onClick={() => {
                        setAssignee(name);
                        setView("board");
                      }}
                    >
                      View tasks <Icon name="arrow" size={13} />
                    </button>
                  </div>
                ))}
                {!agents.length && (
                  <p className="empty">
                    No agent assignments yet. Connect a client and claim your
                    first task.
                  </p>
                )}
              </div>
              <div className="integration">
                <h3>Connect a coding agent</h3>
                <p>
                  Run the bundled MCP server through your client’s stdio
                  configuration. Use an absolute database path shared with this
                  workspace.
                </p>
                <pre>{`{\n  "mcpServers": {\n    "tasknboard": {\n      "command": "node",\n      "args": ["/absolute/path/tasknboard/server/mcp.mjs"],\n      "env": {\n        "TASKNBOARD_DB": "/absolute/path/tasknboard/data/tasknboard.sqlite",\n        "TASKNBOARD_AGENT_ID": "codex"\n      }\n    }\n  }\n}`}</pre>
                <p className="small">
                  Agent names here are inferred from assignments and claims.
                  They are not connection telemetry. See README for the shared
                  server setup.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="toolbar">
                <div className="tabs">
                  <button
                    className={!list ? "active" : ""}
                    onClick={() => setList(false)}
                  >
                    Board
                  </button>
                  <button
                    className={list ? "active" : ""}
                    onClick={() => setList(true)}
                  >
                    List
                  </button>
                </div>
                <div className="toolbar-actions">
                  <div className="assignee-filter">
                    <Icon name="users" />
                    <select
                      ref={filter}
                      aria-label="Filter by assignee"
                      value={assignee}
                      onChange={(e) => setAssignee(e.target.value)}
                    >
                      <option value="">All assignees</option>
                      {[
                        ...new Set(
                          tasks.map((t) => t.assignee).filter(Boolean),
                        ),
                      ].map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                  </div>
                  <button className="primary" onClick={() => setEditor(null)}>
                    <Icon name="plus" />
                    New task
                  </button>
                </div>
              </div>
              {loaded ? (
                <Board
                  tasks={visible}
                  onOpen={openTask}
                  onMove={move}
                  onNew={() => setEditor(null)}
                  list={list}
                />
              ) : (
                <div className="empty">Opening your workspace…</div>
              )}
              {loaded && tasks.length === 0 && connected && (
                <div className="first-task">
                  <h2>Make room for your next idea.</h2>
                  <p>
                    Create a task. Add context. Give your team a clear next
                    step.
                  </p>
                  <button className="primary" onClick={() => setEditor(null)}>
                    Create your first task
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <footer>
          <span className={`connection-dot ${connected ? "online" : ""}`} />
          <span>{connected ? "Connected" : "Disconnected"}</span>
          <span className="footer-detail">
            / &nbsp;{" "}
            {connected
              ? `Saved in workspace · checked ${lastSync}`
              : "Changes require a connection to the workspace"}
          </span>
          <div className="footer-keys">
            <span>
              <kbd>N</kbd>New task
            </span>
            <span>
              <kbd>F</kbd>Filter
            </span>
            <button onClick={() => setHelp(true)}>
              <kbd>?</kbd>Show shortcuts
            </button>
          </div>
        </footer>
      </main>
      {editor !== undefined && (
        <TaskEditor
          task={editor}
          onClose={() => setEditor(undefined)}
          onSaved={refresh}
        />
      )}{" "}
      {settings && (
        <Settings onClose={() => setSettings(false)} onRefresh={refresh} />
      )}{" "}
      {help && (
        <Dialog title="Keyboard shortcuts" onClose={() => setHelp(false)}>
          <div className="settings-body shortcuts">
            {[
              ["N", "Create a task"],
              ["⌘ / Ctrl K", "Search tasks"],
              ["F", "Filter by assignee"],
              ["Esc", "Close dialog"],
              ["Tab / Enter", "Navigate and activate controls"],
            ].map(([key, label]) => (
              <div key={key}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
            <p>
              Drag cards between columns, or change status in task details with
              the keyboard. Work moves through review before completion.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
