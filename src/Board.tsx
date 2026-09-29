import { useState } from "react";
import {
  activeLease,
  columns,
  doneLocked,
  labelTone,
  priorities,
  statusTitle,
  type Epic,
  type Status,
  type Task,
} from "./types";
import { EpicTag } from "./Epics";
import { Icon } from "./Icons";
import { formatUtcTimestamp } from "./formatting";
import { Avatar, usePersonName } from "./People";
import { StatusPicker } from "./Dialogs";
import type { TaskGroup } from "./Views";

export { Avatar };

export function Assignee({ name, agent }: { name: string; agent: boolean }) {
  const label = usePersonName(name);
  return (
    <span className="assignee" title={label === name ? undefined : name}>
      <Avatar name={name} agent={agent} />
      <span className={name ? "assignee-name" : "assignee-name unassigned"}>
        {label || "Unassigned"}
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

/** Signal bars, filled up to the priority level, as on Linear cards. */
function PriorityBars({ task }: { task: Task }) {
  const level = priorities.findIndex((p) => p.id === task.priority) + 1;
  const title = `${priorities[level - 1]?.title} priority`;
  return (
    <span className={`card-chip priority-chip ${task.priority}`} title={title}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        {[4, 7, 10].map((h, i) => (
          <rect
            key={h}
            x={1.5 + i * 4}
            y={12 - h}
            width="3"
            height={h}
            rx="1"
            className={i < level ? "on" : "off"}
          />
        ))}
      </svg>
      <span className="sr-only">{title}</span>
    </span>
  );
}

/** Progress-circle status glyph shared by column headers and cards. */
export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const color = columns.find((c) => c.id === status)?.color;
  const fill = { backlog: 0, in_progress: 0.5, in_review: 0.75, done: 1 }[status];
  // A circle of radius 2.5 stroked 5 wide paints a pie slice via its dash.
  const pie = 2 * Math.PI * 2.5;
  return (
    <svg
      className="status-icon"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      style={{ color }}
    >
      {status === "done" ? (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path
            d="m4.4 7.2 1.8 1.8 3.5-3.7"
            stroke="var(--bg)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.75"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={status === "backlog" ? "1.4 1.6" : undefined}
          />
          {fill > 0 && (
            <circle
              cx="7"
              cy="7"
              r="2.5"
              stroke="currentColor"
              strokeWidth="5"
              strokeDasharray={`${pie * fill} ${pie}`}
              transform="rotate(-90 7 7)"
            />
          )}
        </>
      )}
    </svg>
  );
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function updatedLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `Updated ${shortDate.format(date)}`;
}

export function Label({ label }: { label: string }) {
  if (!label) return null;
  return (
    <span className="label">
      <span className={`label-dot tone-${labelTone(label)}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function ClaimChip({ task }: { task: Task }) {
  const lease = activeLease(task);
  const holder = usePersonName(lease?.actor ?? "");
  if (!lease) return null;
  const expiry = formatUtcTimestamp(lease.expiresAt);
  return (
    <span
      className="claim-chip"
      title={`Claimed by ${holder} until ${expiry}`}
    >
      <Icon name="lock" size={12} />
      <span>
        Claimed by {holder} · expires {expiry}
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
  /** Show each task's epic. Omitted inside an epic, where it is implied. */
  epics?: ReadonlyMap<string, Epic>;
  onOpen: (t: Task) => void;
  onMove?: (t: Task, s: Status) => void;
  onNew?: () => void;
  /** Opens the task's context menu. */
  onMenu?: (e: React.MouseEvent<HTMLElement>, t: Task) => void;
  pending?: Map<string, Status>;
  list?: boolean;
  /** List sections, from a view's grouping. Without them the list is by status. */
  groups?: TaskGroup[];
  presentation?: boolean;
};

export function TaskCard({
  task,
  agents,
  epics,
  onOpen,
  onMove,
  onMenu,
  pending,
  presentation,
}: Omit<BoardProps, "tasks" | "pending" | "list" | "onNew" | "groups"> & {
  task: Task;
  pending?: Status;
}) {
  const commentLabel = `${task.commentCount} ${task.commentCount === 1 ? "comment" : "comments"}`;
  const assigneeName = usePersonName(task.assignee);
  const agent = agents.has(task.assignee);
  const signal = task.standup?.blocker
    ? "has-blocker"
    : task.standup?.highlight
      ? "has-highlight"
      : "";
  const updated = updatedLabel(task.updatedAt);
  return (
    <article
      className={`task-card ${signal} ${pending ? "is-pending" : ""}`}
      aria-label={`${task.id}: ${task.title}, ${commentLabel}`}
      draggable={Boolean(onMove) && !pending}
      onContextMenu={onMenu && ((e) => onMenu(e, task))}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="card-top">
        <span className="task-id">{task.id}</span>
        <span
          className="card-assignee"
          title={
            task.assignee
              ? `Assigned to ${assigneeName}${agent ? " (agent)" : ""}`
              : "Unassigned"
          }
        >
          <Avatar name={task.assignee} agent={agent} />
          <span className="sr-only">
            {task.assignee ? `Assigned to ${assigneeName}` : "Unassigned"}
          </span>
        </span>
      </div>
      <h3 className="task-title">
        <StatusIcon status={pending ?? task.status} />
        <button
          type="button"
          className="card-open"
          onClick={() => onOpen(task)}
          aria-label={`${task.id}: ${task.title}, ${commentLabel}${presentation ? ", edit stand-up notes" : ""}`}
        >
          {task.title}
        </button>
      </h3>
      <div className="card-props">
        <PriorityBars task={task} />
        {task.epic && <EpicTag epic={epics?.get(task.epic)} />}
        {task.labels.map((label) => <Label key={label} label={label} />)}
        <ClaimChip task={task} />
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
        {updated && <span className="card-date">{updated}</span>}
        {task.commentCount > 0 && (
          <span className="comment-count" title={commentLabel}>
            <Icon name="comment" size={13} />
            <span aria-hidden="true">{task.commentCount}</span>
            <span className="sr-only">
              {task.commentCount === 1 ? " comment" : " comments"}
            </span>
          </span>
        )}
        {onMove && !presentation && (
          <StatusSelect task={task} pending={pending} onMove={onMove} />
        )}
      </div>
    </article>
  );
}

export function Board({
  tasks,
  agents,
  epics,
  onOpen,
  onMove,
  onNew,
  onMenu,
  pending = new Map(),
  list = false,
  groups,
  presentation = false,
}: BoardProps) {
  const [dropTarget, setDropTarget] = useState<Status | null>(null);
  const canDrag = Boolean(onMove) && !presentation;
  if (list) {
    const sections = groups ?? [
      {
        key: "all",
        label: null,
        tasks: [...tasks].sort(
          (a, b) =>
            columns.findIndex((c) => c.id === a.status) -
            columns.findIndex((c) => c.id === b.status),
        ),
      },
    ];
    const width = epics ? 6 : 5;
    const row = (t: Task) => (
      <tr
        key={t.id}
        className={pending.has(t.id) ? "is-pending" : ""}
        onContextMenu={onMenu && ((e) => onMenu(e, t))}
      >
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
          {t.commentCount > 0 && (
            <span
              className="comment-count"
              title={`${t.commentCount} ${t.commentCount === 1 ? "comment" : "comments"}`}
            >
              <Icon name="comment" size={13} />
              <span aria-hidden="true">{t.commentCount}</span>
              <span className="sr-only">
                {t.commentCount === 1 ? " comment" : " comments"}
              </span>
            </span>
          )}
          <ClaimChip task={t} />
        </td>
        {epics && (
          <td data-label="Epic">
            {t.epic ? (
              <EpicTag epic={epics.get(t.epic)} />
            ) : (
              <span className="small">None</span>
            )}
          </td>
        )}
        <td data-label="Status">
          {onMove ? (
            <StatusPicker
              task={t}
              pending={pending.get(t.id)}
              onMove={onMove}
            />
          ) : (
            <span className="status-cell">
              <StatusIcon status={t.status} />
              {statusTitle(t.status)}
            </span>
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
    );
    return (
      <div className="task-list" role="region" aria-label="Task list">
        <table>
          <thead>
            <tr>
              <th scope="col">Task</th>
              {epics && <th scope="col">Epic</th>}
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Assignee</th>
              <th scope="col">Label</th>
            </tr>
          </thead>
          {sections.map((section) => (
            <tbody key={section.key}>
              {section.label !== null && (
                <tr className="group-row">
                  <th scope="rowgroup" colSpan={width}>
                    <span className="group-title">{section.label}</span>
                    <span className="count">{section.tasks.length}</span>
                  </th>
                </tr>
              )}
              {section.tasks.map(row)}
            </tbody>
          ))}
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
              <StatusIcon status={col.id} />
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
                  epics={epics}
                  onOpen={onOpen}
                  onMove={canDrag ? onMove : undefined}
                  onMenu={onMenu}
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
