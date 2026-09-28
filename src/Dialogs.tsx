import { cloneElement, useEffect, useId, useRef, useState } from "react";
import {
  activeLease,
  columns,
  doneLocked,
  priorities,
  safeUrl,
  statusTitle,
  type Actor,
  type Priority,
  type Status,
  type Task,
  type TaskEvent,
} from "./types";
import { ApiError, command, errorOf, token } from "./api";
import { formatUtcTimestamp } from "./formatting";
import { Assignee, Label } from "./Board";
import { Icon } from "./Icons";

export type RefreshResult = { ok: true } | { ok: false; error: ApiError };

/**
 * Modal dialog built on <dialog>: the browser contains focus while it is open,
 * and focus returns to the element that opened it when it closes.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide = false,
  dismissOnBackdrop = false,
  className = "",
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  dismissOnBackdrop?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    // showModal() ignores React's autoFocus, so honour an explicit marker.
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog.close();
      // If the trigger is gone (an archived card), land on the page heading.
      const target = trigger?.isConnected
        ? trigger
        : document.querySelector<HTMLElement>("[data-focus-fallback]");
      target?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`dialog ${wide ? "wide" : ""} ${className}`}
      onKeyDown={(e) => {
        if (e.key === "Tab" && !e.defaultPrevented) {
          const dialog = e.currentTarget;
          const controls = Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]',
            ),
          ).filter(
            (element) =>
              element.tabIndex >= 0 &&
              !element.matches(":disabled") &&
              !element.closest("[hidden],[inert]") &&
              element.closest("dialog") === dialog &&
              element.getClientRects().length > 0 &&
              getComputedStyle(element).visibility === "visible",
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          const active = document.activeElement;
          if (
            !controls.includes(active as HTMLElement) ||
            (e.shiftKey ? active === first : active === last)
          ) {
            e.preventDefault();
            (e.shiftKey ? last : first)?.focus();
          }
        }
        // Handle Escape ourselves so a draft can ask before it is discarded.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close.current();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => {
        if (dismissOnBackdrop && e.target === ref.current) close.current();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={() => close.current()}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </dialog>
  );
}

export function describeError(error: ApiError, kept = "") {
  const tail = kept ? ` ${kept}` : "";
  switch (error.code) {
    case "VERSION_CONFLICT":
      return `This task changed after you opened it, so nothing was saved.${tail}`;
    case "LEASE_CONFLICT":
      return `${error.message}. The server rejects changes from others while that claim is active, so nothing was saved.${tail}`;
    case "ARCHIVED":
      return "This task has been archived. Nothing was saved.";
    case "UNAUTHORIZED":
      return `The workspace rejected your access token. Update it in Settings. Nothing was saved.${tail}`;
    case "NETWORK":
      return `Can't reach the workspace service. Nothing was saved.${tail}`;
    default:
      return `${error.message.replace(/\.$/, "")}. Nothing was saved.${tail}`;
  }
}

export function ErrorNote({
  error,
  kept,
  onReload,
  onRetry,
  busy,
}: {
  error: ApiError;
  kept?: string;
  onReload?: () => void;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const reload =
    onReload && ["VERSION_CONFLICT", "LEASE_CONFLICT"].includes(error.code);
  return (
    <div className="inline-error" role="alert">
      <Icon name="alert" size={16} />
      <span>{describeError(error, kept)}</span>
      {reload && (
        <button
          type="button"
          className="secondary small-button"
          onClick={onReload}
          disabled={busy}
        >
          <Icon name="refresh" size={14} />
          Load latest
        </button>
      )}
      {!reload && onRetry && error.code === "NETWORK" && (
        <button
          type="button"
          className="secondary small-button"
          onClick={onRetry}
          disabled={busy}
        >
          Retry
        </button>
      )}
    </div>
  );
}

const kindText: Record<string, string> = {
  created: "created the task",
  update_task: "updated the task",
  add_comment: "commented",
  claim_task: "claimed the task",
  heartbeat: "renewed the claim",
  release_task: "released the claim",
  submit_review: "submitted for review",
  archive_task: "archived the task",
  set_standup_notes: "updated stand-up notes",
};
const fieldLabels: Record<string, string> = {
  title: "title",
  description: "context",
  acceptance: "acceptance criteria",
  status: "status",
  priority: "priority",
  assignee: "assignee",
  label: "label",
};

function eventDetail(e: TaskEvent) {
  if (!e.body) return "";
  try {
    const body = JSON.parse(e.body);
    if (e.kind === "update_task")
      return Object.entries(body)
        .map(([k, v]) =>
          k === "status"
            ? `Status → ${statusTitle(v as Status)}`
            : ["description", "acceptance"].includes(k)
              ? `Edited ${fieldLabels[k]}`
              : `${fieldLabels[k] ?? k} → ${String(v) || "none"}`,
        )
        .join(" · ");
    if (e.kind === "set_standup_notes")
      return (
        [
          body.highlight && `Highlight: ${body.highlight}`,
          body.blocker && `Blocker: ${body.blocker}`,
        ]
          .filter(Boolean)
          .join("\n") || "Notes cleared."
      );
    if (e.kind === "submit_review") return body.summary;
  } catch {
    // Older or free-text bodies are shown as plain text below.
  }
  return e.body;
}

function Activity({ events }: { events: TaskEvent[] }) {
  if (!events.length) return <p className="small">No activity yet.</p>;
  return (
    <ol className="activity-list">
      {events.map((e) => {
        const detail = eventDetail(e);
        return (
          <li key={e.sequence} className={`event kind-${e.kind}`}>
            <div className="event-head">
              <strong>{e.actor}</strong>
              <span>{kindText[e.kind] ?? e.kind.replaceAll("_", " ")}</span>
              <time dateTime={e.createdAt}>
                {formatUtcTimestamp(e.createdAt)}
              </time>
            </div>
            {detail && <p className="event-body">{detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}

type Draft = {
  title: string;
  description: string;
  acceptance: string;
  status: Status;
  priority: Priority;
  assignee: string;
  label: string;
};
const draftKeys = [
  "title",
  "description",
  "acceptance",
  "status",
  "priority",
  "assignee",
  "label",
] as const;
const draftOf = (t: Task | null): Draft =>
  t
    ? {
        title: t.title,
        description: t.description,
        acceptance: t.acceptance,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee,
        label: t.label,
      }
    : {
        title: "",
        description: "",
        acceptance: "",
        status: "backlog",
        priority: "medium",
        assignee: "",
        label: "",
      };

type Pending = null | "save" | "comment" | "review" | "archive" | "reload";

export function TaskEditor({
  task,
  actor,
  agents,
  assignees,
  labels,
  latestVersion,
  onClose,
  onCreated,
  onSaved,
  onChanged,
  onArchived,
}: {
  task: Task | null;
  actor: Actor;
  agents: Set<string>;
  assignees: string[];
  labels: string[];
  latestVersion?: number;
  onClose: () => void;
  onCreated: (t: Task) => void;
  onSaved: (t: Task) => void;
  onChanged: (t: Task) => void;
  onArchived: (t: Task) => void;
}) {
  const [current, setCurrent] = useState(task);
  const [draft, setDraft] = useState(() => draftOf(task));
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [merge, setMerge] = useState<null | {
    version: number;
    updated: string[];
    conflicts: (keyof Draft)[];
  }>(null);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<ApiError | null>(null);
  const [reviewError, setReviewError] = useState<ApiError | null>(null);
  const [archiveStep, setArchiveStep] = useState(false);
  const [archiveError, setArchiveError] = useState<ApiError | null>(null);
  const [discard, setDiscard] = useState(false);
  const [notice, setNotice] = useState("");
  const listId = useId();

  const patch = current
    ? Object.fromEntries(
        draftKeys
          .filter((k) => draft[k] !== current[k])
          .map((k) => [k, draft[k]]),
      )
    : {};
  const dirty = current
    ? Object.keys(patch).length > 0
    : draftKeys.some((k) => draft[k] !== draftOf(null)[k]);
  const conflicted = (k: keyof Draft) =>
    Boolean(merge?.conflicts.includes(k) && current && draft[k] !== current[k]);
  const lease = current && activeLease(current);
  const foreignLease = lease && lease.actor !== actor.id ? lease : null;
  const stale =
    current && latestVersion !== undefined && latestVersion > current.version;
  const set =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) => {
      setDraft((d) => ({ ...d, [key]: value }));
      setNotice("");
    };

  function requestClose() {
    if (pending) return;
    // Only the explicit Discard button drops a draft; Escape backs out.
    if (discard) setDiscard(false);
    else if (dirty) setDiscard(true);
    else onClose();
  }

  async function reload() {
    if (!current) return;
    setPending("reload");
    try {
      const latest = await command<Task>("get_task", { id: current.id });
      // Three-way merge: untouched fields take the latest value; fields edited
      // on both sides are flagged so the person chooses what to keep.
      const updated = draftKeys.filter((k) => latest[k] !== current[k]);
      const conflicts = updated.filter(
        (k) => draft[k] !== current[k] && draft[k] !== latest[k],
      );
      setDraft((d) => {
        const next = { ...d };
        for (const k of updated)
          if (d[k] === current[k])
            (next as Record<string, unknown>)[k] = latest[k];
        return next;
      });
      setCurrent(latest);
      setMerge({ version: latest.version, updated, conflicts });
      setError(null);
      setCommentError(null);
      setReviewError(null);
      setArchiveError(null);
      onChanged(latest);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setPending(null);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!draft.title.trim()) {
      setError(new ApiError("Title is required", "VALIDATION", 400));
      return;
    }
    if (current && !dirty) {
      onClose();
      return;
    }
    setPending("save");
    setError(null);
    try {
      if (current) {
        const saved = await command<Task>("update_task", {
          id: current.id,
          expectedVersion: current.version,
          patch,
        });
        onSaved(saved);
      } else {
        // Omitted optional values take the server's defaults.
        const args: Record<string, string> = {
          title: draft.title,
          priority: draft.priority,
        };
        for (const k of [
          "description",
          "acceptance",
          "assignee",
          "label",
        ] as const)
          if (draft[k].trim()) args[k] = draft[k];
        onCreated(await command<Task>("create_task", args));
      }
    } catch (e) {
      setError(errorOf(e));
      setPending(null);
    }
  }

  async function postComment(e?: React.FormEvent) {
    e?.preventDefault();
    if (!current || pending || !comment.trim()) return;
    setPending("comment");
    setCommentError(null);
    try {
      const next = await command<Task>("add_comment", {
        id: current.id,
        expectedVersion: current.version,
        body: comment,
      });
      setCurrent(next);
      setComment("");
      onChanged(next);
    } catch (e) {
      setCommentError(errorOf(e));
    } finally {
      setPending(null);
    }
  }

  async function review(status: Status) {
    if (!current || pending) return;
    setPending("review");
    setReviewError(null);
    try {
      const next = await command<Task>("update_task", {
        id: current.id,
        expectedVersion: current.version,
        patch: { status },
      });
      setCurrent(next);
      setDraft((d) => ({ ...d, status: next.status }));
      setNotice(
        status === "done" ? "Marked Done." : `Moved to ${statusTitle(status)}.`,
      );
      onChanged(next);
    } catch (e) {
      setReviewError(errorOf(e));
    } finally {
      setPending(null);
    }
  }

  async function archive() {
    if (!current || pending) return;
    setPending("archive");
    setArchiveError(null);
    try {
      await command("archive_task", {
        id: current.id,
        expectedVersion: current.version,
      });
      onArchived(current);
    } catch (e) {
      setArchiveError(errorOf(e));
      setPending(null);
    }
  }

  const artifact = safeUrl(current?.review?.artifactUrl);
  const footer = discard ? (
    <div
      className="discard-bar"
      role="alertdialog"
      aria-label="Discard changes"
    >
      <span>Discard your unsaved changes?</span>
      <span className="spacer" />
      <button
        type="button"
        className="secondary"
        autoFocus
        onClick={() => setDiscard(false)}
      >
        Keep editing
      </button>
      <button type="button" className="danger-button" onClick={onClose}>
        Discard
      </button>
    </div>
  ) : (
    <>
      {error && (
        <ErrorNote
          error={error}
          kept={
            current
              ? "Your draft is still here."
              : "Your entries are still here."
          }
          onReload={current ? reload : undefined}
          onRetry={() =>
            (
              document.getElementById(
                `${listId}-form`,
              ) as HTMLFormElement | null
            )?.requestSubmit()
          }
          busy={Boolean(pending)}
        />
      )}
      <div className="form-actions">
        {current && dirty && !pending && (
          <span className="small dirty-note">Unsaved changes</span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="secondary"
          onClick={requestClose}
          disabled={pending === "save"}
        >
          Cancel
        </button>
        <button
          type="submit"
          form={`${listId}-form`}
          className="primary"
          disabled={Boolean(pending)}
        >
          {pending === "save"
            ? "Saving…"
            : current
              ? "Save changes"
              : "Create task"}
        </button>
      </div>
    </>
  );

  return (
    <Dialog
      title={
        current ? (
          <>
            <span className="task-id">{current.id}</span> Task details
          </>
        ) : (
          "New task"
        )
      }
      onClose={requestClose}
      footer={footer}
      wide
    >
      <datalist id={`${listId}-assignees`}>
        {assignees.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <datalist id={`${listId}-labels`}>
        {labels.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <div className={current ? "editor-layout" : "editor-layout create"}>
        <form
          id={`${listId}-form`}
          className="task-form"
          onSubmit={save}
          noValidate
        >
          {!current && (
            <p className="small form-intro">
              New tasks start in <strong>Backlog</strong>.
            </p>
          )}
          {stale && !pending && (
            <div className="inline-notice" role="status">
              <Icon name="refresh" size={16} />
              <span>
                This task was updated elsewhere (version {latestVersion}). Your
                draft is kept.
              </span>
              <button
                type="button"
                className="secondary small-button"
                onClick={reload}
              >
                Load latest
              </button>
            </div>
          )}
          {merge && (
            <div className="inline-notice" role="status">
              <Icon name="refresh" size={16} />
              <span>
                Loaded version {merge.version}.{" "}
                {merge.updated.length
                  ? `Changed elsewhere: ${merge.updated.map((k) => fieldLabels[k]).join(", ")}.`
                  : "No fields changed elsewhere."}{" "}
                {merge.conflicts.length
                  ? "Choose which value to keep for the highlighted fields, then save."
                  : "Review your draft and save again."}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss"
                onClick={() => setMerge(null)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          <Field
            label="Title"
            conflict={conflicted("title") ? current?.title : undefined}
            onUseLatest={() => set("title")(current!.title)}
          >
            <input
              className="title-input"
              data-autofocus={current ? undefined : ""}
              required
              maxLength={300}
              placeholder="What needs to happen?"
              value={draft.title}
              onChange={(e) => set("title")(e.target.value)}
            />
          </Field>
          <Field
            label="Context"
            hint="Scope, repository paths, constraints."
            conflict={
              conflicted("description") ? current?.description : undefined
            }
            onUseLatest={() => set("description")(current!.description)}
          >
            <textarea
              rows={5}
              maxLength={20000}
              value={draft.description}
              onChange={(e) => set("description")(e.target.value)}
            />
          </Field>
          <Field
            label="Acceptance criteria"
            hint="What must be true when this is done?"
            conflict={
              conflicted("acceptance") ? current?.acceptance : undefined
            }
            onUseLatest={() => set("acceptance")(current!.acceptance)}
          >
            <textarea
              rows={4}
              maxLength={20000}
              value={draft.acceptance}
              onChange={(e) => set("acceptance")(e.target.value)}
            />
          </Field>
          <div className="form-grid">
            {current && (
              <Field
                label="Status"
                conflict={
                  conflicted("status") ? statusTitle(current.status) : undefined
                }
                onUseLatest={() => set("status")(current.status)}
              >
                <select
                  value={draft.status}
                  onChange={(e) => set("status")(e.target.value as Status)}
                >
                  {columns.map((c) => (
                    <option
                      value={c.id}
                      key={c.id}
                      disabled={c.id === "done" && doneLocked(current.status)}
                    >
                      {c.id === "done" && doneLocked(current.status)
                        ? "Done (after review)"
                        : c.title}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field
              label="Priority"
              conflict={conflicted("priority") ? current?.priority : undefined}
              onUseLatest={() => set("priority")(current!.priority)}
            >
              <select
                value={draft.priority}
                onChange={(e) => set("priority")(e.target.value as Priority)}
              >
                {priorities.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Assignee"
              conflict={
                conflicted("assignee")
                  ? current?.assignee || "Unassigned"
                  : undefined
              }
              onUseLatest={() => set("assignee")(current!.assignee)}
            >
              <input
                maxLength={80}
                placeholder="Unassigned"
                list={`${listId}-assignees`}
                value={draft.assignee}
                onChange={(e) => set("assignee")(e.target.value)}
              />
            </Field>
            <Field
              label="Label"
              conflict={
                conflicted("label") ? current?.label || "None" : undefined
              }
              onUseLatest={() => set("label")(current!.label)}
            >
              <input
                maxLength={40}
                placeholder={current ? "None" : "Product (default)"}
                list={`${listId}-labels`}
                value={draft.label}
                onChange={(e) => set("label")(e.target.value)}
              />
            </Field>
          </div>
          {current && draft.status === "done" && current.status !== "done" && (
            <p className="small">Saving marks this task Done.</p>
          )}
        </form>
        {current && (
          <aside className="editor-side" aria-label="Task state">
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>{statusTitle(current.status)}</dd>
              </div>
              <div>
                <dt>Assignee</dt>
                <dd>
                  <Assignee
                    name={current.assignee}
                    agent={agents.has(current.assignee)}
                  />
                </dd>
              </div>
              <div>
                <dt>Label</dt>
                <dd>
                  {current.label ? <Label label={current.label} /> : "None"}
                </dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{current.version}</dd>
              </div>
            </dl>
            <section className="side-block" aria-label="Claim">
              <h3>
                <Icon name="lock" size={14} /> Claim
              </h3>
              {!current.lease ? (
                <p className="small">Not claimed.</p>
              ) : lease ? (
                <>
                  <p>
                    Claimed by <strong>{lease.actor}</strong>, expires{" "}
                    {formatUtcTimestamp(lease.expiresAt)}.
                  </p>
                  {foreignLease && (
                    <p className="small warn">
                      While this claim is active, the server rejects edits,
                      comments and archiving from anyone else. Stand-up notes
                      remain editable.
                    </p>
                  )}
                </>
              ) : (
                <p className="small">
                  Claim by {current.lease.actor} expired at{" "}
                  {formatUtcTimestamp(current.lease.expiresAt)}.
                </p>
              )}
            </section>
            <section className="side-block" aria-label="Review">
              <h3>
                <Icon name="check" size={14} /> Review
              </h3>
              {current.review ? (
                <>
                  {current.status === "in_progress" && (
                    <p className="small">
                      Needs changes keeps this review evidence on the task. It
                      records the earlier submission for context.
                    </p>
                  )}
                  <p className="small">Submitted by {current.review.actor}</p>
                  <p className="review-summary">{current.review.summary}</p>
                  {artifact ? (
                    <a
                      className="artifact-link"
                      href={artifact}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open artifact <Icon name="external" size={13} />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    current.review.artifactUrl && (
                      <p className="small">Artifact link is not a web URL.</p>
                    )
                  )}
                </>
              ) : (
                <p className="small">No review evidence yet.</p>
              )}
              {current.status === "in_review" && actor.kind === "human" && (
                <div className="review-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={Boolean(pending)}
                    onClick={() => review("done")}
                  >
                    {pending === "review" ? "Saving…" : "Mark Done"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={Boolean(pending)}
                    onClick={() => review("in_progress")}
                  >
                    Needs changes
                  </button>
                </div>
              )}
              {reviewError && (
                <ErrorNote
                  error={reviewError}

                  onReload={reload}
                  busy={Boolean(pending)}
                />
              )}
              {notice && (
                <p className="small ok" role="status">
                  {notice}
                </p>
              )}
            </section>
            {actor.kind === "human" && (
              <section className="side-block" aria-label="Archive">
                {!archiveStep ? (
                  <button
                    type="button"
                    className="quiet danger"
                    onClick={() => setArchiveStep(true)}
                    disabled={Boolean(pending)}
                  >
                    <Icon name="archive" size={15} /> Archive task…
                  </button>
                ) : (
                  <div
                    className="confirm-archive"
                    role="group"
                    aria-label="Confirm archive"
                  >
                    <p>
                      Archive {current.id}? It leaves the board and lists. Its
                      history stays in the database and the JSON export.
                    </p>
                    <div className="review-actions">
                      <button
                        type="button"
                        className="secondary"
                        autoFocus
                        disabled={pending === "archive"}
                        onClick={() => {
                          setArchiveStep(false);
                          setArchiveError(null);
                        }}
                      >
                        Keep task
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={Boolean(pending)}
                        onClick={archive}
                      >
                        {pending === "archive" ? "Archiving…" : "Archive"}
                      </button>
                    </div>
                  </div>
                )}
                {archiveError && (
                  <ErrorNote
                    error={archiveError}

                    onReload={reload}
                    busy={Boolean(pending)}
                  />
                )}
              </section>
            )}
          </aside>
        )}
        {current && (
          <section className="activity" aria-label="Comments and activity">
            <h3>Activity</h3>
            <Activity events={current.events ?? []} />
            <form className="comment-form" onSubmit={postComment}>
              <label className="field">
                <span className="field-label">Add a comment</span>
                <textarea
                  aria-label="Add a comment"
                  rows={3}
                  maxLength={10000}
                  placeholder="Progress, questions, or review notes…"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                      postComment();
                  }}
                />
              </label>
              {commentError && (
                <ErrorNote
                  error={commentError}
                  kept="Your comment is still here."
                  onReload={reload}
                  onRetry={() => postComment()}
                  busy={Boolean(pending)}
                />
              )}
              <div className="comment-actions">
                <span className="small">
                  {comment.length > 9000 && `${comment.length} / 10,000 · `}
                  <kbd>⌘/Ctrl ↵</kbd> to post
                </span>
                <button
                  className="secondary"
                  disabled={Boolean(pending) || !comment.trim()}
                >
                  {pending === "comment" ? "Posting…" : "Post comment"}
                </button>
              </div>
            </form>
          </section>
        )}
      </div>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  conflict,
  onUseLatest,
  children,
}: {
  label: string;
  hint?: string;
  conflict?: string;
  onUseLatest?: () => void;
  children: React.ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const id = useId();
  return (
    <div className={`field ${conflict !== undefined ? "has-conflict" : ""}`}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {cloneElement(children, {
        id,
        "aria-describedby": hint ? `${id}-hint` : undefined,
      })}
      {conflict !== undefined && (
        <div className="conflict-value">
          <span>
            Latest:{" "}
            <q>
              {conflict.length > 160
                ? `${conflict.slice(0, 160)}…`
                : conflict || "empty"}
            </q>
          </span>
          <button type="button" className="quiet" onClick={onUseLatest}>
            Use latest
          </button>
        </div>
      )}
    </div>
  );
}

export function Settings({
  actor,
  connected,
  onClose,
  onReconnect,
}: {
  actor: Actor;
  connected: boolean;
  onClose: () => void;
  onReconnect: () => Promise<RefreshResult>;
}) {
  const [value, setValue] = useState(token.get());
  const [stored, setStored] = useState(Boolean(token.get()));
  const [connection, setConnection] = useState<null | {
    ok: boolean;
    text: string;
  }>(null);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exported, setExported] = useState<null | {
    ok: boolean;
    text: string;
  }>(null);

  async function saveConnection(next: string) {
    setSaving(true);
    setConnection(null);
    token.set(next.trim());
    setStored(Boolean(next.trim()));
    if (!next.trim()) setValue("");
    const result = await onReconnect();
    setSaving(false);
    setConnection(
      result.ok
        ? { ok: true, text: "Connection saved. The workspace is refreshed." }
        : {
            ok: false,
            text:
              result.error.code === "UNAUTHORIZED"
                ? "Authentication failed. The workspace rejected this token."
                : `Couldn't connect: ${result.error.message}`,
          },
    );
  }

  async function exportWorkspace() {
    setExporting(true);
    setExported(null);
    try {
      const data = await command<{ tasks: unknown[]; events: unknown[] }>(
        "export_workspace",
      );
      const name = `tasknboard-export-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExported({
        ok: true,
        text: `Exported ${data.tasks.length} tasks and ${data.events.length} activity events to ${name}.`,
      });
    } catch (e) {
      setExported({ ok: false, text: `Export failed: ${errorOf(e).message}` });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog title="Settings" onClose={onClose} dismissOnBackdrop>
      <div className="settings-body">
        <section>
          <h3>Connection</h3>
          <p className="small">
            {connected
              ? `Connected as ${actor.id} (${actor.kind}).`
              : "Not connected to the workspace service."}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveConnection(value);
            }}
          >
            <label className="field">
              <span className="field-label">Workspace access token</span>
              <span className="field-hint">
                Needed only for a shared server. Kept for this browser session
                only and never shown again.
              </span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  stored
                    ? "A token is stored for this session"
                    : "Not needed for local mode"
                }
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <div className="review-actions">
              <button className="primary" disabled={saving}>
                {saving ? "Connecting…" : "Save connection"}
              </button>
              {stored && (
                <button
                  type="button"
                  className="secondary"
                  disabled={saving}
                  onClick={() => saveConnection("")}
                >
                  Remove token
                </button>
              )}
            </div>
          </form>
          {connection && (
            <p
              className={connection.ok ? "small ok" : "inline-error"}
              role={connection.ok ? "status" : "alert"}
            >
              {connection.text}
            </p>
          )}
        </section>
        <section>
          <h3>Export</h3>
          <p className="small">
            Download all tasks, archived work, and the full activity log as
            JSON. Import is not available.
          </p>
          <button
            type="button"
            className="secondary"
            onClick={exportWorkspace}
            disabled={exporting}
          >
            <Icon name="download" size={16} />
            {exporting ? "Exporting…" : "Export workspace"}
          </button>
          {exported && (
            <p
              className={exported.ok ? "small ok" : "inline-error"}
              role={exported.ok ? "status" : "alert"}
            >
              {exported.text}
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}

export const shortcuts: [string, string][] = [
  ["N", "Create a task"],
  ["⌘/Ctrl K", "Focus search"],
  ["F", "Focus the assignee filter"],
  ["?", "Open keyboard help"],
  ["Esc", "Close a dialog, or exit stand-up"],
  ["← / →", "Stand-up: previous / next participant"],
  ["Home", "Stand-up: back to Team overview"],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} dismissOnBackdrop>
      <div className="settings-body">
        <dl className="shortcuts">
          {shortcuts.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                <kbd>{key}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p className="small">
          Shortcuts are ignored while you type in a field. Each card's Status
          menu moves it without dragging. Done is available after review.
        </p>
      </div>
    </Dialog>
  );
}
