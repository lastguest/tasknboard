import { useEffect, useState } from "react";
import { command, errorOf } from "./api";
import type { Task } from "./types";

type Milestone = {
  id: string;
  boardId: string;
  title: string;
  criteria: { text: string; checked: boolean }[];
  version: number;
  archived: boolean;
};
type Activity = {
  events: {
    sequence: number;
    taskId: string;
    actor: string;
    kind: string;
    body: string;
    createdAt: string;
  }[];
  running: (Task & {
    elapsedSeconds: number;
    lastActivityAt: string;
    lastComment?: string;
  })[];
  hours: number;
};

export function RunningNow({
  boardId,
  onOpen,
}: {
  boardId: string;
  onOpen: (id: string) => void;
}) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      command<Activity>(
        "list_activity",
        { boardId, hours: 24, limit: 1 },
        controller.signal,
      )
        .then((value) => {
          setActivity(value);
          setError("");
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setError(errorOf(failure).message);
        });
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [boardId]);
  return (
    <section className="running-now" aria-label="Running now">
      <strong>Running now</strong>
      {activity?.running.length ? (
        activity.running.map((task) => (
          <button
            type="button"
            className="quiet"
            key={task.id}
            title={task.lastComment || undefined}
            onClick={() => onOpen(task.id)}
          >
            {task.id} · {task.delegatedTo} ·{" "}
            {Math.floor(task.elapsedSeconds / 60)} min ·{" "}
            {task.lastComment
              ? task.lastComment.replace(/\s+/g, " ").slice(0, 100)
              : `last activity ${new Date(task.lastActivityAt).toLocaleTimeString()}`}
          </button>
        ))
      ) : (
        <span className="small">No active delegations.</span>
      )}
      {error && <span role="alert">{error}</span>}
    </section>
  );
}

export function RecentMovement({
  boardId,
  agent,
  onOpen,
}: {
  boardId?: string;
  agent?: string;
  onOpen: (id: string) => void;
}) {
  const [hours, setHours] = useState(24);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void command<Activity>(
      "list_activity",
      {
        hours,
        ...(boardId ? { boardId } : {}),
        ...(agent ? { agent } : {}),
        limit: 100,
      },
      controller.signal,
    )
      .then((value) => {
        setActivity(value);
        setError("");
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorOf(failure).message);
      });
    return () => controller.abort();
  }, [hours, boardId, agent]);
  const moves =
    activity?.events.filter((event) =>
      [
        "update_task",
        "delegate_task",
        "submit_review",
        "request_changes",
        "archive_task",
        "reject_task",
        "restore_task",
        "undo_task",
        "auto_complete",
      ].includes(event.kind),
    ) ?? [];
  return (
    <details className="workflow-panel">
      <summary>
        Recent movement{agent ? ` for ${agent}` : ""} ({moves.length})
      </summary>
      <label>
        Hours
        <input
          type="number"
          min={1}
          max={720}
          value={hours}
          onChange={(event) =>
            setHours(
              Math.max(1, Math.min(720, Number(event.target.value) || 1)),
            )
          }
        />
      </label>
      <ul>
        {moves.map((event) => (
          <li key={event.sequence}>
            <button
              type="button"
              className="quiet"
              onClick={() => onOpen(event.taskId)}
            >
              {event.taskId}
            </button>{" "}
            · {event.actor} · {event.kind.replaceAll("_", " ")} ·{" "}
            {new Date(event.createdAt).toLocaleString()}
            <pre className="small">{event.body}</pre>
          </li>
        ))}
      </ul>
      {!moves.length && (
        <p className="small">No task movement in this period.</p>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}

export function Milestones({
  boardId,
  tasks,
  canManage,
  onOpen,
  onSaved,
}: {
  boardId: string;
  tasks: Task[];
  canManage: boolean;
  onOpen: (id: string) => void;
  onSaved: (task: Task) => void;
}) {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    command<{ milestones: Milestone[] }>("list_milestones", { boardId }).then(
      (value) => setMilestones(value.milestones),
    );
  useEffect(() => {
    let mounted = true;
    void command<{ milestones: Milestone[] }>("list_milestones", { boardId })
      .then((value) => {
        if (mounted) setMilestones(value.milestones);
      })
      .catch((failure) => {
        if (mounted) setError(errorOf(failure).message);
      });
    return () => {
      mounted = false;
    };
  }, [boardId]);
  async function write(name: string, args: object) {
    setBusy(true);
    setError("");
    try {
      await command(name, args);
      await load();
      return true;
    } catch (failure) {
      setError(errorOf(failure).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="workflow-panel">
      <summary>Milestones ({milestones.length})</summary>
      {milestones.map((milestone) => (
        <section key={milestone.id} aria-label={`Milestone ${milestone.title}`}>
          <h3>{milestone.title}</h3>
          {milestone.criteria.map((criterion, index) => (
            <label key={index}>
              <input
                type="checkbox"
                checked={criterion.checked}
                disabled={!canManage || busy}
                onChange={() =>
                  void write("update_milestone", {
                    id: milestone.id,
                    expectedVersion: milestone.version,
                    patch: {
                      criteria: milestone.criteria.map((entry, at) =>
                        at === index
                          ? { ...entry, checked: !entry.checked }
                          : entry,
                      ),
                    },
                  })
                }
              />
              {criterion.text}
            </label>
          ))}
          <ul>
            {tasks
              .filter((task) => task.milestone === milestone.id)
              .map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => onOpen(task.id)}
                  >
                    {task.id}: {task.title}
                  </button>{" "}
                  ({task.role})
                </li>
              ))}
          </ul>
          {canManage && (
            <>
              <label>
                Link task
                <select
                  aria-label={`Link task to ${milestone.title}`}
                  value=""
                  disabled={busy}
                  onChange={async (event) => {
                    const task = tasks.find(
                      (entry) => entry.id === event.target.value,
                    );
                    if (!task) return;
                    setBusy(true);
                    try {
                      onSaved(
                        await command<Task>("update_task", {
                          id: task.id,
                          expectedVersion: task.version,
                          patch: { milestone: milestone.id },
                        }),
                      );
                    } catch (failure) {
                      setError(errorOf(failure).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <option value="">Choose task…</option>
                  {tasks
                    .filter((task) => task.milestone !== milestone.id)
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.id}: {task.title}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="quiet danger"
                disabled={busy}
                onClick={() =>
                  void write("archive_milestone", {
                    id: milestone.id,
                    expectedVersion: milestone.version,
                  })
                }
              >
                Archive milestone
              </button>
            </>
          )}
        </section>
      ))}
      {canManage && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void write("create_milestone", {
              boardId,
              title,
              criteria: criteria
                .split("\n")
                .filter((line) => line.trim())
                .map((text) => ({ text: text.trim(), checked: false })),
            }).then((saved) => {
              if (saved) {
                setTitle("");
                setCriteria("");
              }
            });
          }}
        >
          <label>
            Milestone title
            <input
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Exit criteria (one per line)
            <textarea
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !title.trim()}>
            Create milestone
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
