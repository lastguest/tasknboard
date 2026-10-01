import { useEffect, useRef, useState } from "react";
import { Assignee, Board } from "./Board";
import { Dialog, ErrorNote } from "./Dialogs";
import { Icon } from "./Icons";
import { Markdown } from "./Markdown";
import { ApiError, command, errorOf, taskNumber } from "./api";
import { standupNotes, statusTitle, type Actor, type Task } from "./types";
import { Avatar, displayName, usePeople } from "./People";

type Stage = { key: string; name: string; assignee?: string };
type Focus = "all" | "highlight" | "blocker";

/** Speaking order: alphabetical display names (agents included), Unassigned last. */
export function stagesFor(
  tasks: Task[],
  people: ReadonlyMap<string, Actor> = new Map(),
): Stage[] {
  const owners = [...new Set(tasks.map((t) => t.assignee).filter(Boolean))]
    .map((id) => ({ id, name: displayName(people, id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    { key: "team", name: "Team overview" },
    ...owners.map(({ id, name }) => ({
      key: `owner:${id}`,
      name,
      assignee: id,
    })),
    ...(tasks.some((t) => !t.assignee)
      ? [{ key: "unassigned", name: "Unassigned", assignee: "" }]
      : []),
  ];
}

function StandupNotes({
  task,
  agents,
  connected,
  onClose,
  onSaved,
}: {
  task: Task;
  agents: Set<string>;
  connected: boolean;
  onClose: () => void;
  onSaved: (t: Task) => void;
}) {
  const [current, setCurrent] = useState(task);
  const [highlight, setHighlight] = useState(task.standup?.highlight || "");
  const [blocker, setBlocker] = useState(task.standup?.blocker || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloaded, setReloaded] = useState(false);

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await command<Task>("set_standup_notes", {
          id: current.id,
          expectedVersion: current.version,
          highlight,
          blocker,
        }),
      );
      onClose();
    } catch (e) {
      setError(errorOf(e));
      setBusy(false);
    }
  }

  /** Take the latest version while keeping the notes typed so far. */
  async function reload() {
    setBusy(true);
    try {
      const latest = await command<Task>("get_task", { id: current.id });
      setCurrent(latest);
      setReloaded(true);
      setError(null);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
    }
  }

  const latestNotes = reloaded ? current.standup : undefined;
  return (
    <Dialog
      title={
        <>
          <span className="task-id">{current.id}</span>{" "}
          {statusTitle(current.status)}
        </>
      }
      onClose={() => !busy && onClose()}
      closeDisabled={busy}
      wide
      footer={
        <>
          {error && (
            <ErrorNote
              error={error}
              kept="Your notes are still here."
              onReload={reload}
              onRetry={() => save()}
              busy={busy}
            />
          )}
          {!connected && (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={16} />
              Disconnected. Notes can be saved once the workspace reconnects.
            </p>
          )}
          <div className="form-actions">
            <span className="spacer" />
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              form="standup-notes-form"
              className="primary"
              disabled={busy || !connected}
            >
              {busy ? "Saving…" : "Save notes"}
            </button>
          </div>
        </>
      }
    >
      <form id="standup-notes-form" className="standup-notes" onSubmit={save}>
        <h3 className="notes-title">{current.title}</h3>
        <Assignee
          name={current.assignee}
          agent={agents.has(current.assignee)}
        />
        {current.description && (
          <Markdown className="standup-context" source={current.description} />
        )}
        {reloaded && (
          <div className="inline-notice" role="status">
            <Icon name="refresh" size={16} />
            <span>
              Loaded version {current.version}. Saved notes now read —
              highlight: <q>{latestNotes?.highlight || "none"}</q>, blocker:{" "}
              <q>{latestNotes?.blocker || "none"}</q>. Your typed notes are
              kept.
            </span>
          </div>
        )}
        <label className="field">
          <span className="field-label">Highlight</span>
          <textarea
            data-autofocus=""
            maxLength={500}
            rows={3}
            placeholder="What is worth sharing with the team?"
            value={highlight}
            onChange={(e) => setHighlight(e.target.value)}
          />
          <span className="counter">{highlight.length} / 500</span>
        </label>
        <label className="field">
          <span className="field-label">Blocker</span>
          <textarea
            maxLength={500}
            rows={3}
            placeholder="What is blocked, and what help is needed?"
            value={blocker}
            onChange={(e) => setBlocker(e.target.value)}
          />
          <span className="counter">{blocker.length} / 500</span>
        </label>
        <p className="small">
          Notes stay on the task until cleared. Leave a field empty to clear it.
          Saving notes does not change the task's claim or status.
        </p>
      </form>
    </Dialog>
  );
}

export function Standup({
  tasks,
  agents,
  connected,
  lastSync,
  onExit,
  onSaved,
}: {
  tasks: Task[];
  agents: Set<string>;
  connected: boolean;
  lastSync: string;
  onExit: () => void;
  onSaved: (t: Task) => void;
}) {
  // Keep the speaking order fixed while polling updates the tasks underneath it.
  const people = usePeople();
  const [stages] = useState(() => stagesFor(tasks, people));
  const [index, setIndex] = useState(0);
  const [focus, setFocus] = useState<Focus>("all");
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [fullscreen, setFullscreen] = useState(
    Boolean(document.fullscreenElement),
  );
  const content = useRef<HTMLDivElement>(null);
  const exitRequested = useRef(false);
  const stage = stages[index];
  const scope = tasks.filter(
    (t) => stage.assignee === undefined || t.assignee === stage.assignee,
  );
  const visible = scope
    .filter((t) => focus === "all" || Boolean(standupNotes(t)?.[focus]))
    .sort(
      (a, b) =>
        Number(Boolean(standupNotes(b)?.blocker)) -
          Number(Boolean(standupNotes(a)?.blocker)) ||
        Number(Boolean(standupNotes(b)?.highlight)) -
          Number(Boolean(standupNotes(a)?.highlight)) ||
        taskNumber(a.id) - taskNumber(b.id),
    );

  // Relative moves use the latest index, so fast key repeats are not lost.
  function go(next: number | ((current: number) => number)) {
    setIndex((current) =>
      Math.max(
        0,
        Math.min(
          stages.length - 1,
          typeof next === "number" ? next : next(current),
        ),
      ),
    );
  }
  useEffect(() => {
    // Talking-point filters apply to one turn only.
    setFocus("all");
    setError("");
  }, [index]);
  function exit() {
    exitRequested.current = true;
    if (document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    onExit();
  }

  useEffect(() => {
    content.current?.focus();
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
      // An open notes dialog handles Escape itself and closes first.
      if (selected || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey)
        return;
      if (e.key === "Escape") {
        e.preventDefault();
        exit();
        return;
      }
      if (
        (e.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        )
      )
        return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go((i) => i + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go((i) => i - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        go(0);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  async function openTask(t: Task) {
    setError("");
    try {
      setSelected(await command<Task>("get_task", { id: t.id }));
    } catch (e) {
      setError(`Couldn't open ${t.id}: ${errorOf(e).message}`);
    }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await document.documentElement.requestFullscreen();
        // Escape can close stand-up before the browser finishes entering fullscreen.
        if (exitRequested.current && document.fullscreenElement)
          await document.exitFullscreen();
      }
    } catch {
      if (!exitRequested.current)
        setError(
          "Fullscreen is unavailable here. Stand-up mode is still active.",
        );
    }
  }

  const counts = {
    highlight: scope.filter((t) => standupNotes(t)?.highlight).length,
    blocker: scope.filter((t) => standupNotes(t)?.blocker).length,
  };
  return (
    <div className="standup-shell">
      <header className="standup-bar">
        {stage.assignee && (
          <Avatar
            name={stage.assignee}
            agent={agents.has(stage.assignee)}
            size="large"
          />
        )}
        <div className="standup-identity">
          <span className="standup-eyebrow">Stand-up</span>
          <h1 aria-live="polite">{stage.name}</h1>
        </div>
        <nav className="standup-turns" aria-label="Participants">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous participant"
            title="Previous (←)"
            disabled={index === 0}
            onClick={() => go((i) => i - 1)}
          >
            <Icon name="back" />
          </button>
          <label className="sr-only" htmlFor="standup-stage">
            Participant
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
            type="button"
            className="icon-button"
            aria-label="Next participant"
            title="Next (→)"
            disabled={index === stages.length - 1}
            onClick={() => go((i) => i + 1)}
          >
            <Icon name="arrow" />
          </button>
        </nav>
        <div className="standup-controls">
          {document.fullscreenEnabled && (
            <button
              type="button"
              className="icon-button"
              title={fullscreen ? "Leave fullscreen" : "Fullscreen"}
              aria-label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
              onClick={toggleFullscreen}
            >
              <Icon name={fullscreen ? "shrink" : "expand"} />
            </button>
          )}
          <button type="button" className="secondary" onClick={exit}>
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
            type="button"
            aria-pressed={focus === "all"}
            onClick={() => setFocus("all")}
          >
            All tasks <span>{scope.length}</span>
          </button>
          <button
            type="button"
            className="highlight-filter"
            aria-pressed={focus === "highlight"}
            onClick={() =>
              setFocus((f) => (f === "highlight" ? "all" : "highlight"))
            }
          >
            Highlights <span>{counts.highlight}</span>
          </button>
          <button
            type="button"
            className="blocker-filter"
            aria-pressed={focus === "blocker"}
            onClick={() =>
              setFocus((f) => (f === "blocker" ? "all" : "blocker"))
            }
          >
            Blockers <span>{counts.blocker}</span>
          </button>
        </div>
        <span className="standup-hint">
          {index === 0
            ? "The whole team, then one participant at a time."
            : `${index} of ${stages.length - 1} · ${
                index === stages.length - 1
                  ? "Last turn"
                  : `Up next: ${stages[index + 1].name}`
              }`}
          <span className="standup-keys" aria-hidden="true">
            <kbd>←</kbd>
            <kbd>→</kbd>
          </span>
        </span>
      </div>
      {!connected && (
        <div className="standup-offline" role="alert">
          <Icon name="alert" size={16} />
          Connection lost. Showing the board as of {lastSync || "the last load"}
          ; it may be out of date.
        </div>
      )}
      {error && (
        <div className="standup-offline" role="alert">
          <Icon name="alert" size={16} />
          {error}
        </div>
      )}
      <div
        className="standup-canvas"
        ref={content}
        tabIndex={-1}
        aria-label={`Stand-up board: ${stage.name}`}
      >
        <Board tasks={visible} agents={agents} onOpen={openTask} presentation />
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
          agents={agents}
          connected={connected}
          onClose={() => setSelected(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
