import { columns, type Task, type Status } from "./types";
import { Icon } from "./Icons";
export function Avatar({ name }: { name: string }) {
  const bot = /agent|codex|claude|bot/i.test(name);
  return (
    <span className={`avatar ${bot ? "bot" : ""}`}>
      {bot ? (
        <Icon name="bot" size={16} />
      ) : name ? (
        name.slice(0, 2).toUpperCase()
      ) : (
        "—"
      )}
    </span>
  );
}
export function TaskCard({
  task,
  onOpen,
  presentation = false,
}: {
  task: Task;
  onOpen: (t: Task) => void;
  presentation?: boolean;
}) {
  return (
    <button
      className={`task-card ${task.standup?.blocker ? "has-blocker" : task.standup?.highlight ? "has-highlight" : ""}`}
      draggable={!presentation}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
      onClick={() => onOpen(task)}
    >
      <div className="card-top">
        <span>{task.id}</span>
        <span
          className={`priority ${task.priority}`}
          aria-label={`${task.priority} priority`}
        >
          {task.status === "done" ? (
            <span className="done-check">
              <Icon name="check" size={13} />
            </span>
          ) : task.priority === "high" ? (
            <Icon name="priorityHigh" size={18} />
          ) : task.priority === "medium" ? (
            <Icon name="priorityMedium" size={18} />
          ) : (
            <Icon name="priorityLow" size={18} />
          )}
        </span>
      </div>
      <div className="task-title">{task.title}</div>
      <span className={`label ${task.label.toLowerCase()}`}>
        {task.label || "Product"}
      </span>
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
        <Avatar name={task.assignee} />
        <span>{task.assignee || "Unassigned"}</span>
        {task.lease && task.lease.expiresAt > Date.now() && (
          <span
            className="lease-dot"
            title={`Claimed by ${task.lease.actor}`}
          />
        )}
      </div>
    </button>
  );
}
export function Board({
  tasks,
  onOpen,
  onMove,
  onNew,
  list,
  presentation = false,
}: {
  tasks: Task[];
  onOpen: (t: Task) => void;
  onMove: (t: Task, s: Status) => void;
  onNew: () => void;
  list: boolean;
  presentation?: boolean;
}) {
  if (list)
    return (
      <div className="task-list">
        <div className="list-head">
          <span>Task</span>
          <span>Status</span>
          <span>Assignee</span>
        </div>
        {tasks.map((t) => (
          <button className="list-row" key={t.id} onClick={() => onOpen(t)}>
            <span>
              <small>{t.id}</small>
              {t.title}
            </span>
            <span>{columns.find((c) => c.id === t.status)?.title}</span>
            <span>
              <Avatar name={t.assignee} />
              {t.assignee || "Unassigned"}
            </span>
          </button>
        ))}
        {!tasks.length && (
          <div className="empty">
            No tasks here. Create one or change your filters.
          </div>
        )}
      </div>
    );
  return (
    <div className="board">
      {columns.map((col) => (
        <section
          className="column"
          key={col.id}
          onDragOver={(e) => {
            if (presentation) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            if (presentation) return;
            e.preventDefault();
            const t = tasks.find(
              (t) => t.id === e.dataTransfer.getData("text/plain"),
            );
            if (t && t.status !== col.id) onMove(t, col.id);
          }}
        >
          <header>
            <span className="status-dot" style={{ background: col.color }} />
            <h2>{col.title}</h2>
            <span className="count">
              {tasks.filter((t) => t.status === col.id).length}
            </span>
            {!presentation && (
              <button
                className="icon-button column-add"
                aria-label={`Create task from ${col.title}`}
                onClick={onNew}
              >
                <Icon name="plus" size={16} />
              </button>
            )}
          </header>
          <div className="cards">
            {tasks
              .filter((t) => t.status === col.id)
              .map((t) => (
                <TaskCard
                  task={t}
                  onOpen={onOpen}
                  key={t.id}
                  presentation={presentation}
                />
              ))}
            {!tasks.some((t) => t.status === col.id) && (
              <div className="empty-column">Nothing here yet</div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
