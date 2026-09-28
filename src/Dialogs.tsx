import { useEffect, useRef, useState } from "react";
import type { Task } from "./types";
import { columns } from "./types";
import { command } from "./api";
import { Icon } from "./Icons";
function activityText(kind: string, body: string) {
  if (kind === "set_standup_notes") {
    try {
      const notes = JSON.parse(body);
      return (
        [
          notes.highlight && `Highlight: ${notes.highlight}`,
          notes.blocker && `Blocker: ${notes.blocker}`,
        ]
          .filter(Boolean)
          .join("\n") || "Stand-up notes cleared."
      );
    } catch {
      return "Stand-up notes updated.";
    }
  }
  if (kind === "update_task") {
    try {
      const labels: Record<string, string> = {
        description: "context",
        acceptance: "acceptance criteria",
      };
      return (
        "Updated " +
        Object.keys(JSON.parse(body))
          .map((k) => labels[k] || k)
          .join(", ") +
        "."
      );
    } catch {
      return "Task updated.";
    }
  }
  if (kind === "submit_review") {
    try {
      return JSON.parse(body).summary;
    } catch {
      return "Submitted for review.";
    }
  }
  return body;
}

export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const d = ref.current;
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "dialog inspector" : "dialog"}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-head">
        <span>{title}</span>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function TaskEditor({
  task,
  onClose,
  onSaved,
}: {
  task: Task | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [current, setCurrent] = useState(task),
    [title, setTitle] = useState(task?.title || ""),
    [description, setDescription] = useState(task?.description || ""),
    [acceptance, setAcceptance] = useState(task?.acceptance || ""),
    [status, setStatus] = useState(task?.status || "backlog"),
    [priority, setPriority] = useState(task?.priority || "medium"),
    [assignee, setAssignee] = useState(task?.assignee || ""),
    [label, setLabel] = useState(task?.label || "Product"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [comment, setComment] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (current)
        await command("update_task", {
          id: current.id,
          expectedVersion: current.version,
          patch: {
            title,
            description,
            acceptance,
            status,
            priority,
            assignee,
            label,
          },
        });
      else
        await command("create_task", {
          title,
          description,
          acceptance,
          priority,
          assignee,
          label,
        });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addComment() {
    if (!current || !comment.trim()) return;
    setBusy(true);
    setError("");
    try {
      setCurrent(
        await command<Task>("add_comment", {
          id: current.id,
          expectedVersion: current.version,
          body: comment,
        }),
      );
      setComment("");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (
      !current ||
      !window.confirm(
        `Archive ${current.id}? It remains in the database and export.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await command("archive_task", {
        id: current.id,
        expectedVersion: current.version,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={task ? `${task.id} / Task details` : "Create a task"}
      onClose={onClose}
      wide
    >
      <form onSubmit={save} className="task-form">
        <label className="field">
          Title
          <input
            autoFocus
            required
            maxLength={300}
            placeholder="What needs to happen?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="form-grid">
          {current && (
            <label className="field">
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Task["status"])}
              >
                {columns.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Priority
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Task["priority"])}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="field">
            Assignee
            <input
              maxLength={80}
              placeholder="Unassigned"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            />
          </label>
          <label className="field">
            Label
            <input
              maxLength={40}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          Context
          <textarea
            rows={4}
            maxLength={20000}
            placeholder="Scope, repository paths, constraints…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="field">
          Acceptance criteria
          <textarea
            rows={3}
            maxLength={20000}
            placeholder="What must be true when this is done?"
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
          />
        </label>
        {current?.lease && (
          <div className="notice">
            Claimed by {current.lease.actor} · lease{" "}
            {current.lease.expiresAt > Date.now() ? "expires" : "expired"} at{" "}
            {new Date(current.lease.expiresAt).toLocaleTimeString()}
          </div>
        )}
        {current?.review && (
          <div className="review">
            <strong>Review handoff</strong>
            <p>{current.review.summary}</p>
            {current.review.artifactUrl && (
              <a
                href={current.review.artifactUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open artifact ↗
              </a>
            )}
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          {current && (
            <button
              type="button"
              className="quiet danger"
              onClick={archive}
              disabled={busy}
            >
              Archive
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : current ? "Save changes" : "Create task"}
          </button>
        </div>
      </form>
      {current && (
        <div className="activity">
          <h3>Activity</h3>
          {current.events?.map((e) => (
            <div className="event" key={e.sequence}>
              <div>
                <strong>{e.actor}</strong>
                <span>{e.kind.replaceAll("_", " ")}</span>
                <time>{new Date(e.createdAt).toLocaleString()}</time>
              </div>
              {e.body && <p>{activityText(e.kind, e.body)}</p>}
            </div>
          ))}
          <div className="comment-input">
            <input
              aria-label="Comment"
              placeholder="Add a note or progress update…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={10000}
            />
            <button
              className="secondary"
              disabled={busy || !comment.trim()}
              onClick={addComment}
            >
              Post
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
export function Settings({
  onClose,
  onRefresh,
}: {
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [token, setToken] = useState(
      sessionStorage.getItem("tasknboard-token") || "",
    ),
    [message, setMessage] = useState("");
  async function backup() {
    try {
      const data = await command("export_workspace");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `tasknboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Export downloaded.");
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <Dialog title="Workspace settings" onClose={onClose}>
      <div className="settings-body">
        <h2>One workspace. Your infrastructure.</h2>
        <p>
          The interface uses the TasknBoard service serving this workspace. Local
          data stays in its SQLite file. A shared deployment uses the same
          service on your server.
        </p>
        <label className="field">
          Workspace access token
          <input
            type="password"
            autoComplete="off"
            placeholder="Not needed for local mode"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <p className="small">
          Stored for this browser session only. Use a human token for the
          interface.
        </p>
        <button
          className="primary"
          onClick={() => {
            if (token) sessionStorage.setItem("tasknboard-token", token);
            else sessionStorage.removeItem("tasknboard-token");
            onRefresh();
            setMessage("Connection settings saved.");
          }}
        >
          Save connection
        </button>
        <hr />
        <h3>Portable data</h3>
        <p>
          Export tasks, archived work and the complete activity log as JSON.
        </p>
        <button className="secondary" onClick={backup}>
          <Icon name="download" />
          Export workspace
        </button>
        {message && <p role="status">{message}</p>}
      </div>
    </Dialog>
  );
}
