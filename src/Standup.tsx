import { useEffect, useRef, useState } from "react";
import { Avatar, Board } from "./Board";
import { Dialog } from "./Dialogs";
import { Icon } from "./Icons";
import { command } from "./api";
import { columns, type Task } from "./types";

type Stage = { key: string; name: string; assignee?: string };
function stagesFor(tasks: Task[]): Stage[] {
  const owners = [
    ...new Set(tasks.map((t) => t.assignee).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  return [
    { key: "team", name: "Team overview" },
    ...owners.map((name) => ({ key: `owner:${name}`, name, assignee: name })),
    ...(tasks.some((t) => !t.assignee)
      ? [{ key: "unassigned", name: "Unassigned", assignee: "" }]
      : []),
  ];
}

function StandupNotes({
  task,
  onClose,
  onSaved,
  connected,
}: {
  task: Task;
  onClose: () => void;
  onSaved: (t: Task) => void;
  connected: boolean;
}) {
  const [highlight, setHighlight] = useState(task.standup?.highlight || "");
  const [blocker, setBlocker] = useState(task.standup?.blocker || "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(
        await command<Task>("set_standup_notes", {
          id: task.id,
          expectedVersion: task.version,
          highlight,
          blocker,
        }),
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`${task.id} · ${columns.find((c) => c.id === task.status)?.title}`}
      onClose={onClose}
      wide
    >
      <form className="standup-notes" onSubmit={save}>
        <h2>{task.title}</h2>
        <div className="standup-task-owner">
          <Avatar name={task.assignee} />
          {task.assignee || "Unassigned"}
        </div>
        {task.description && (
          <p className="standup-context">{task.description}</p>
        )}
        <label className="field">
          Highlight
          <textarea
            autoFocus
            aria-label="Highlight"
            maxLength={500}
            rows={3}
            placeholder="What is worth sharing with the team?"
            value={highlight}
            onChange={(e) => setHighlight(e.target.value)}
          />
        </label>
        <label className="field">
          Blocker
          <textarea
            aria-label="Blocker"
            maxLength={500}
            rows={3}
            placeholder="What is blocked, and what help is needed?"
            value={blocker}
            onChange={(e) => setBlocker(e.target.value)}
          />
        </label>
        <p className="small">
          Notes stay on the task until cleared. Leave a field empty to clear it.
        </p>
        {error && (
          <p className="error" role="alert">
            {error} Close and reopen the task to load its latest version; your
            notes have not been saved.
          </p>
        )}
        {!connected && (
          <p className="error" role="alert">
            Disconnected. Notes can be saved when the workspace reconnects.
          </p>
        )}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !connected}>
            {busy ? "Saving…" : "Save notes"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function Standup({
  tasks,
  connected,
  onExit,
  onSaved,
}: {
  tasks: Task[];
  connected: boolean;
  onExit: () => void;
  onSaved: (t: Task) => void;
}) {
  // Keep the speaking order stable while polling updates the tasks underneath it.
  const [stages] = useState(() => stagesFor(tasks));
  const [index, setIndex] = useState(0),
    [focus, setFocus] = useState<"all" | "highlight" | "blocker">("all");
  const [selected, setSelected] = useState<Task | null>(null),
    [error, setError] = useState(""),
    [fullscreen, setFullscreen] = useState(false);
  const content = useRef<HTMLDivElement>(null),
    previousFocus = useRef<HTMLElement | null>(null);
  const stage = stages[index];
  const scope = tasks.filter(
    (t) => stage.assignee === undefined || t.assignee === stage.assignee,
  );
  const visible = scope
    .filter((t) => focus === "all" || Boolean(t.standup?.[focus]))
    .sort(
      (a, b) =>
        Number(Boolean(b.standup?.blocker)) -
          Number(Boolean(a.standup?.blocker)) ||
        Number(Boolean(b.standup?.highlight)) -
          Number(Boolean(a.standup?.highlight)) ||
        a.id.localeCompare(b.id),
    );
  function go(next: number) {
    setIndex(Math.max(0, Math.min(stages.length - 1, next)));
    setFocus("all");
    setError("");
  }
  function exit() {
    if (document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    onExit();
  }
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    content.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  useEffect(() => {
    content.current?.scrollTo({ top: 0, left: 0 });
    content.current
      ?.querySelectorAll(".cards")
      .forEach((el) => el.scrollTo({ top: 0 }));
  }, [index, focus]);
  useEffect(() => {
    const change = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        selected ||
        e.defaultPrevented ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        (e.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        )
      )
        return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(index + 1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(index - 1);
      }
      if (e.key === "Home") {
        e.preventDefault();
        go(0);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        exit();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, selected, stages.length]);
  async function openTask(t: Task) {
    setError("");
    try {
      setSelected(await command<Task>("get_task", { id: t.id }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError(
        "Fullscreen is unavailable here. Stand-up mode is still active.",
      );
    }
  }
  return (
    <div className="standup-shell">
      <header className="standup-bar">
        <div className="standup-identity">
          <span className="standup-wordmark">◩</span>
          <div>
            <span className="standup-eyebrow">
              STAND-UP <span>Product</span>
            </span>
            <h1 aria-live="polite">{stage.name}</h1>
          </div>
        </div>
        <div className="standup-turns">
          <button
            className="icon-button previous-turn"
            aria-label="Previous participant"
            title="Previous · ←"
            disabled={index === 0}
            onClick={() => go(index - 1)}
          >
            <Icon name="arrow" />
          </button>
          <label className="sr-only" htmlFor="standup-stage">
            Stand-up participant
          </label>
          <select
            id="standup-stage"
            value={index}
            onChange={(e) => go(Number(e.target.value))}
          >
            {stages.map((s, i) => (
              <option key={s.key} value={i}>
                {i === 0
                  ? "Team overview"
                  : `${i} / ${stages.length - 1} · ${s.name}`}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            aria-label="Next participant"
            title="Next · →"
            disabled={index === stages.length - 1}
            onClick={() => go(index + 1)}
          >
            <Icon name="arrow" />
          </button>
        </div>
        <div className="standup-controls">
          {document.fullscreenEnabled && (
            <button
              className="icon-button"
              title={fullscreen ? "Leave fullscreen" : "Fullscreen"}
              aria-label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
              onClick={toggleFullscreen}
            >
              <Icon name="screen" />
            </button>
          )}
          <button className="secondary" onClick={exit}>
            <Icon name="close" size={15} />
            Exit stand-up
          </button>
        </div>
      </header>
      <div className="standup-summary">
        <div
          className="standup-filters"
          role="group"
          aria-label="Talking points"
        >
          <button
            aria-pressed={focus === "all"}
            onClick={() => setFocus("all")}
          >
            All tasks <span>{scope.length}</span>
          </button>
          <button
            className="highlight-filter"
            aria-pressed={focus === "highlight"}
            onClick={() =>
              setFocus((f) => (f === "highlight" ? "all" : "highlight"))
            }
          >
            Highlights{" "}
            <span>{scope.filter((t) => t.standup?.highlight).length}</span>
          </button>
          <button
            className="blocker-filter"
            aria-pressed={focus === "blocker"}
            onClick={() =>
              setFocus((f) => (f === "blocker" ? "all" : "blocker"))
            }
          >
            Blockers{" "}
            <span>{scope.filter((t) => t.standup?.blocker).length}</span>
          </button>
        </div>
        <span className="standup-hint">
          {index === 0
            ? "The whole team, then one person at a time."
            : `${index} of ${stages.length - 1} · ${index === stages.length - 1 ? "Last turn" : `Up next: ${stages[index + 1].name}`}`}{" "}
          <kbd>←</kbd>
          <kbd>→</kbd>
        </span>
      </div>
      {!connected && (
        <div className="standup-offline" role="alert">
          Connection lost — showing the last loaded board. Updates may be
          missing.
        </div>
      )}
      {error && (
        <div className="standup-offline" role="alert">
          {error}
        </div>
      )}
      <div
        className="standup-canvas"
        ref={content}
        tabIndex={-1}
        aria-label="Stand-up kanban"
      >
        <Board
          tasks={visible}
          onOpen={openTask}
          onMove={() => {}}
          onNew={() => {}}
          list={false}
          presentation
        />
        {!visible.length && (
          <p className="standup-empty">
            {focus === "all"
              ? "No tasks for this turn. Continue to the next participant."
              : `No ${focus === "highlight" ? "highlights" : "blockers"} for this turn.`}
          </p>
        )}
      </div>
      {selected && (
        <StandupNotes
          task={selected}
          connected={connected}
          onClose={() => setSelected(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
