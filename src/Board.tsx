import { useState } from "react";
import {
  activeLease,
  columns,
  doneLocked,
  labelTone,
  priorities,
  statusTitle,
  type Status,
  type Task,
} from "./types";
import { Icon } from "./Icons";
import { formatUtcTimestamp } from "./formatting";

export function Avatar({ name, agent }: { name: string; agent: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0])
    .join("")
    .toUpperCase();
  return (
    <span className={`avatar ${agent ? "bot" : ""} ${name ? "" : "none"}`}>
      {agent ? <Icon name="bot" size={15} /> : initials || "—"}
    </span>
  );
}

export function Assignee({ name, agent }: { name: string; agent: boolean }) {
  return (
    <span className="assignee">
      <Avatar name={name} agent={agent} />
      <span className={name ? "assignee-name" : "assignee-name unassigned"}>
        {name || "Unassigned"}
      </span>
      {agent && <span className="kind-tag">Agent</span>}
    </span>
  );
}

function PriorityMark({ task }: { task: Task }) {
  const title = `${priorities.find((p) => p.id === task.priority)?.title} priority`;
  return (
    <span className={`priority ${task.priority}`} title={title}>
      <Icon
        name={
          task.priority === "high"
            ? "priorityHigh"
            : task.priority === "medium"
              ? "priorityMedium"
              : "priorityLow"
        }
        size={17}
      />
      <span className="sr-only">{title}</span>
    </span>
  );
}

export function Label({ label }: { label: string }) {
  if (!label) return null;
  return <span className={`label tone-${labelTone(label)}`}>{label}</span>;
}

export function ClaimChip({ task }: { task: Task }) {
  const lease = activeLease(task);
  if (!lease) return null;
  const expiry = formatUtcTimestamp(lease.expiresAt);
  return (
    <span
      className="claim-chip"
      title={`Claimed by ${lease.actor} until ${expiry}`}
    >
      <Icon name="lock" size={12} />
      <span>
        Claimed by {lease.actor} · expires {expiry}
      </span>
    </span>
  );
}

/** The keyboard and touch alternative to drag and drop. */
export function StatusSelect({
  task,
  pending,
  onMove,
}: {
  task: Task;
  pending?: Status;
  onMove: (t: Task, s: Status) => void;
}) {
  return (
    <label className="status-select">
      <span className="sr-only">Status of {task.id}</span>
      <select
        aria-label={`Status of ${task.id}`}
        value={pending ?? task.status}
        disabled={Boolean(pending)}
        onChange={(e) => onMove(task, e.target.value as Status)}
      >
        {columns.map((c) => (
          <option
            key={c.id}
            value={c.id}
            disabled={c.id === "done" && doneLocked(task.status)}
          >
            {c.id === "done" && doneLocked(task.status)
              ? "Done (after review)"
              : c.title}
          </option>
        ))}
      </select>
      {pending && <span className="moving">Moving…</span>}
    </label>
  );
}

type BoardProps = {
  tasks: Task[];
  agents: Set<string>;
  onOpen: (t: Task) => void;
  onMove?: (t: Task, s: Status) => void;
  onNew?: () => void;
  pending?: Map<string, Status>;
  list?: boolean;
  presentation?: boolean;
};

export function TaskCard({
  task,
  agents,
  onOpen,
  onMove,
  pending,
  presentation,
}: Omit<BoardProps, "tasks" | "pending" | "list" | "onNew"> & {
  task: Task;
  pending?: Status;
}) {
  const commentLabel = `${task.commentCount} ${task.commentCount === 1 ? "comment" : "comments"}`;
  const signal = task.standup?.blocker
    ? "has-blocker"
    : task.standup?.highlight
      ? "has-highlight"
      : "";
  return (
    <article
      className={`task-card ${signal} ${pending ? "is-pending" : ""}`}
      aria-label={`${task.id}: ${task.title}, ${commentLabel}`}
      draggable={Boolean(onMove) && !pending}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="card-top">
        <span className="task-id">{task.id}</span>
        {task.status === "done" ? (
          <span className="done-check" title="Done">
            <Icon name="check" size={12} />
            <span className="sr-only">Done</span>
          </span>
        ) : (
          <PriorityMark task={task} />
        )}
      </div>
      <h3 className="task-title">
        <button
          type="button"
          className="card-open"
          onClick={() => onOpen(task)}
          aria-label={`${task.id}: ${task.title}, ${commentLabel}${presentation ? ", edit stand-up notes" : ""}`}
        >
          {task.title}
        </button>
      </h3>
      <div className="task-labels">
        {task.labels.map((label) => <Label key={label} label={label} />)}
      </div>
      {task.standup?.blocker && (
        <div className="task-signal blocker">
          <strong>Blocker</strong>
          <span>{task.standup.blocker}</span>
        </div>
      )}
      {task.standup?.highlight && (
        <div className="task-signal highlight">
          <strong>Highlight</strong>
          <span>{task.standup.highlight}</span>
        </div>
      )}
      <div className="card-bottom">
        <Assignee name={task.assignee} agent={agents.has(task.assignee)} />
        <span className="comment-count" aria-hidden="true">
          {commentLabel}
        </span>
      </div>
      <ClaimChip task={task} />
      {onMove && !presentation && (
        <StatusSelect task={task} pending={pending} onMove={onMove} />
      )}
    </article>
  );
}

export function Board({
  tasks,
  agents,
  onOpen,
  onMove,
  onNew,
  pending = new Map(),
  list = false,
  presentation = false,
}: BoardProps) {
  const [dropTarget, setDropTarget] = useState<Status | null>(null);
  const canDrag = Boolean(onMove) && !presentation;
  if (list) {
    const rows = [...tasks].sort(
      (a, b) =>
        columns.findIndex((c) => c.id === a.status) -
        columns.findIndex((c) => c.id === b.status),
    );
    return (
      <div className="task-list" role="region" aria-label="Task list">
        <table>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Comments</th>
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Assignee</th>
              <th scope="col">Label</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={pending.has(t.id) ? "is-pending" : ""}>
                <td className="list-task">
                  <span className="task-id">{t.id}</span>
                  <button
                    type="button"
                    className="list-open"
                    onClick={() => onOpen(t)}
                    aria-label={`${t.id}: ${t.title}, ${t.commentCount} ${t.commentCount === 1 ? "comment" : "comments"}`}
                  >
                    {t.title}
                  </button>
                  <ClaimChip task={t} />
                </td>
                <td
                  data-label="Comments"
                  aria-label={`${t.commentCount} ${t.commentCount === 1 ? "comment" : "comments"}`}
                >
                  {t.commentCount}
                </td>
                <td data-label="Status">
                  {onMove ? (
                    <StatusSelect
                      task={t}
                      pending={pending.get(t.id)}
                      onMove={onMove}
                    />
                  ) : (
                    statusTitle(t.status)
                  )}
                </td>
                <td data-label="Priority">
                  <span className="priority-cell">
                    <PriorityMark task={t} />
                    {priorities.find((p) => p.id === t.priority)?.title}
                  </span>
                </td>
                <td data-label="Assignee">
                  <Assignee name={t.assignee} agent={agents.has(t.assignee)} />
                </td>
                <td data-label="Labels">
                  <div className="task-labels">
                    {t.labels.map((label) => <Label key={label} label={label} />)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="board" role="region" aria-label="Kanban board">
      {columns.map((col) => {
        const cards = tasks.filter((t) => t.status === col.id);
        return (
          <section
            className={`column ${dropTarget === col.id ? "drop-target" : ""}`}
            key={col.id}
            aria-labelledby={`column-${col.id}`}
            onDragOver={(e) => {
              if (!canDrag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dropTarget !== col.id) setDropTarget(col.id);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setDropTarget(null);
            }}
            onDrop={(e) => {
              setDropTarget(null);
              if (!canDrag) return;
              e.preventDefault();
              const t = tasks.find(
                (t) => t.id === e.dataTransfer.getData("text/plain"),
              );
              if (t && t.status !== col.id) onMove?.(t, col.id);
            }}
          >
            <header>
              <span className="status-dot" style={{ background: col.color }} />
              <h2 id={`column-${col.id}`}>{col.title}</h2>
              <span className="count" aria-label={`${cards.length} tasks`}>
                {cards.length}
              </span>
              {onNew && col.id === "backlog" && (
                <button
                  type="button"
                  className="icon-button column-add"
                  aria-label="New task in Backlog"
                  title="New task in Backlog"
                  onClick={onNew}
                >
                  <Icon name="plus" size={16} />
                </button>
              )}
            </header>
            <div className="cards">
              {cards.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  agents={agents}
                  onOpen={onOpen}
                  onMove={canDrag ? onMove : undefined}
                  pending={pending.get(t.id)}
                  presentation={presentation}
                />
              ))}
              {!cards.length && (
                <div className="empty-column">No tasks in {col.title}</div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
