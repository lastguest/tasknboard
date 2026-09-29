import { cloneElement, useEffect, useId, useRef, useState } from "react";
import {
  activeLease,
  columns,
  doneLocked,
  priorities,
  safeUrl,
  statusTitle,
  type Actor,
  type Epic,
  epicStyle,
  type Priority,
  type Status,
  type Task,
  type TaskEvent,
} from "./types";
import { ApiError, command, errorOf, token } from "./api";
import { formatUtcTimestamp } from "./formatting";
import { Assignee, Label, StatusIcon } from "./Board";
import { Icon } from "./Icons";
import { MarkdownEditor } from "./Markdown";
import { EpicTag } from "./Epics";
import {
  Avatar,
  displayName,
  PeopleContext,
  Person,
  PersonName,
  usePeople,
} from "./People";

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

export type ChoiceOption = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
};

/** Status choices shared by the task sidebar and the list view. */
export function statusChoices(current?: Status): ChoiceOption[] {
  const locked = current !== undefined && doneLocked(current);
  return columns.map((column) => ({
    value: column.id,
    label: column.id === "done" && locked ? "Done (after review)" : column.title,
    disabled: column.id === "done" && locked,
    icon: <StatusIcon status={column.id} />,
  }));
}

/** The list view's status cell: the sidebar trigger and picker, per row. */
export function StatusPicker({
  task,
  pending,
  onMove,
}: {
  task: Task;
  pending?: Status;
  onMove: (t: Task, s: Status) => void;
}) {
  const [open, setOpen] = useState(false);
  const status = pending ?? task.status;
  return (
    <>
      <button
        type="button"
        className="sidebar-picker-trigger status-picker-trigger"
        aria-label={`Status of ${task.id}: ${statusTitle(status)}. Choose status`}
        aria-haspopup="dialog"
        disabled={Boolean(pending)}
        onClick={() => setOpen(true)}
      >
        <StatusIcon status={status} />
        <span>{statusTitle(status)}</span>
        {pending && <span className="moving">Moving…</span>}
      </button>
      {open && (
        <SearchableChoiceDialog
          title={`Status of ${task.id}`}
          searchLabel="Search status"
          options={statusChoices(task.status)}
          selected={[status]}
          onSelect={(value) => {
            setOpen(false);
            if (value !== task.status) onMove(task, value as Status);
          }}
          onToggle={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function SearchableChoiceDialog({
  title,
  searchLabel,
  options,
  selected,
  multiple = false,
  allowCreate = false,
  onSelect,
  onToggle,
  onCreate,
  onClose,
}: {
  title: string;
  searchLabel: string;
  options: ChoiceOption[];
  selected: string[];
  multiple?: boolean;
  allowCreate?: boolean;
  onSelect: (value: string) => void;
  onToggle: (value: string) => void;
  onCreate?: (value: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const id = useId();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = options.filter((option) =>
    `${option.label} ${option.detail ?? ""}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
  const newLabel = query.trim();
  const canCreate =
    allowCreate &&
    Boolean(newLabel) &&
    !options.some(
      (option) =>
        option.value.toLocaleLowerCase() === newLabel.toLocaleLowerCase(),
    );

  return (
    <Dialog
      title={title}
      onClose={onClose}
      className="picker-dialog"
      footer={
        multiple ? (
          <div className="form-actions">
            <span className="small">{selected.length} selected</span>
            <span className="spacer" />
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="picker-body">
        <label className="sr-only" htmlFor={`${id}-search`}>
          {searchLabel}
        </label>
        <input
          id={`${id}-search`}
          className="picker-search"
          type="search"
          data-autofocus=""
          autoComplete="off"
          maxLength={allowCreate ? 40 : undefined}
          placeholder={searchLabel}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {filtered.length > 0 || canCreate ? (
          <ul className="picker-options" aria-label={title}>
            {filtered.map((option) => (
              <li key={option.value || "unassigned"}>
                <label className="picker-option">
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name={`${id}-choice`}
                    checked={selected.includes(option.value)}
                    disabled={option.disabled}
                    onClick={() => {
                      if (!multiple && selected.includes(option.value))
                        onSelect(option.value);
                    }}
                    onChange={() =>
                      multiple
                        ? onToggle(option.value)
                        : onSelect(option.value)
                    }
                  />
                  {option.icon}
                  <span className="picker-option-copy">
                    <span>{option.label}</span>
                    {option.detail && (
                      <span className="picker-option-detail">
                        {option.detail}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
            {canCreate && (
              <li>
                <button
                  type="button"
                  className="picker-create"
                  onClick={() => {
                    onCreate?.(newLabel);
                    setQuery("");
                  }}
                >
                  Add “{newLabel}”
                </button>
              </li>
            )}
          </ul>
        ) : (
          <p className="picker-empty" role="status">
            No matching options.
          </p>
        )}
      </div>
    </Dialog>
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
  labels: "labels",
  epic: "epic",
};

function eventDetail(e: TaskEvent, epicTitle: (id: string) => string) {
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
              : k === "epic"
                ? `Epic → ${v ? epicTitle(String(v)) : "none"}`
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

function Activity({
  events,
  epicTitle,
}: {
  events: TaskEvent[];
  epicTitle: (id: string) => string;
}) {
  if (!events.length) return <p className="small">No activity yet.</p>;
  return (
    <ol className="activity-list">
      {events.map((e) => {
        const detail = eventDetail(e, epicTitle);
        return (
          <li key={e.sequence} className={`event kind-${e.kind}`}>
            <div className="event-head">
              <Person id={e.actor} />
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
  labels: string[];
  epic: string;
};
const draftKeys = [
  "title",
  "description",
  "acceptance",
  "status",
  "priority",
  "assignee",
  "labels",
  "epic",
] as const;
const draftOf = (t: Task | null, epic = ""): Draft =>
  t
    ? {
        title: t.title,
        description: t.description,
        acceptance: t.acceptance,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee,
        labels: [...t.labels],
        epic: t.epic ?? "",
      }
    : {
        title: "",
        description: "",
        acceptance: "",
        status: "backlog",
        priority: "medium",
        assignee: "",
        labels: ["Product"],
        epic,
      };

function sameValue(left: unknown, right: unknown) {
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value) => right.includes(value))
    );
  return Object.is(left, right);
}

type Pending = null | "save" | "comment" | "review" | "archive" | "reload";

export function TaskEditor({
  task,
  actor,
  agents,
  actors,
  assignees,
  labels,
  epics,
  initialEpic = "",
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
  actors: Actor[];
  assignees: string[];
  labels: string[];
  epics: Epic[];
  initialEpic?: string;
  latestVersion?: number;
  onClose: () => void;
  onCreated: (t: Task) => void;
  onSaved: (t: Task) => void;
  onChanged: (t: Task) => void;
  onArchived: (t: Task) => void;
}) {
  const [current, setCurrent] = useState(task);
  const [draft, setDraft] = useState(() => draftOf(task, initialEpic));
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
  const [picker, setPicker] = useState<
    "status" | "priority" | "assignee" | "labels" | "epic" | null
  >(null);
  const listId = useId();

  const people = usePeople();
  const actorKinds = new Map(actors.map((candidate) => [candidate.id, candidate.kind]));
  const personOption = (id: string, detail: string[]): ChoiceOption => {
    const name = displayName(people, id);
    return {
      value: id,
      label: name,
      // The ID stays searchable and visible when a profile name replaces it.
      detail: [...(name !== id ? [id] : []), ...detail].join(" · ") || undefined,
      icon: <Avatar name={id} agent={actorKinds.get(id) === "agent"} />,
    };
  };
  const otherAssignees = [
    ...new Set([
      ...actors.map((candidate) => candidate.id),
      ...assignees,
      current?.assignee ?? "",
      draft.assignee,
    ]),
  ]
    .filter((name) => name && name !== actor.id)
    .sort((left, right) =>
      displayName(people, left).localeCompare(displayName(people, right)),
    );
  const assigneeOptions: ChoiceOption[] = [
    personOption(actor.id, [
      "You",
      actor.kind === "agent" ? "Agent" : "Human",
    ]),
    { value: "", label: "Unassigned", icon: <Avatar name="" agent={false} /> },
    ...otherAssignees.map((name) => {
      const kind = actorKinds.get(name);
      return personOption(
        name,
        kind ? [kind === "agent" ? "Agent" : "Human"] : [],
      );
    }),
  ];
  const statusOptions = statusChoices(current?.status);
  const priorityOptions: ChoiceOption[] = priorities.map((priority) => ({
    value: priority.id,
    label: priority.title,
  }));
  const epicsById = new Map(epics.map((epic) => [epic.id, epic]));
  const epicTitle = (id: string) => epicsById.get(id)?.title ?? id;
  // Archived epics cannot take new tasks; the current one stays listed.
  const epicOptions: ChoiceOption[] = [
    { value: "", label: "No epic" },
    ...epics
      .filter(
        (epic) =>
          !epic.archived ||
          epic.id === draft.epic ||
          epic.id === current?.epic,
      )
      .map((epic) => ({
        value: epic.id,
        label: epic.title,
        detail: epic.archived ? `${epic.id} · Archived` : epic.id,
        disabled: epic.archived && epic.id !== current?.epic,
        icon: (
          <span
            className="epic-glyph"
                    style={epicStyle(epic)}
            aria-hidden="true"
          />
        ),
      })),
  ];
  const labelOptions: ChoiceOption[] = [
    ...new Set([...labels, ...draft.labels]),
  ]
    .sort((left, right) => left.localeCompare(right))
    .map((label) => ({ value: label, label }));

  const patch = current
    ? Object.fromEntries(
        draftKeys
          .filter((k) => !sameValue(draft[k], current[k]))
          .map((k) => [k, draft[k]]),
      )
    : {};
  const dirty = current
    ? Object.keys(patch).length > 0
    : draftKeys.some((k) => !sameValue(draft[k], draftOf(null)[k]));
  const conflicted = (k: keyof Draft) =>
    Boolean(
      merge?.conflicts.includes(k) &&
        current &&
        !sameValue(draft[k], current[k]),
    );
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
      const updated = draftKeys.filter(
        (k) => !sameValue(latest[k], current[k]),
      );
      const conflicts = updated.filter(
        (k) =>
          !sameValue(draft[k], current[k]) &&
          !sameValue(draft[k], latest[k]),
      );
      setDraft((d) => {
        const next = { ...d };
        for (const k of updated)
          if (sameValue(d[k], current[k]))
            (next as Record<string, unknown>)[k] = Array.isArray(latest[k])
              ? [...(latest[k] as string[])]
              : latest[k];
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
        const args: Record<string, unknown> = {
          title: draft.title,
          priority: draft.priority,
          labels: draft.labels.map((label) => label.trim()).filter(Boolean),
        };
        for (const k of [
          "description",
          "acceptance",
          "assignee",
          "epic",
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
    <>
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
            <MarkdownEditor
              rows={7}
              maxLength={20000}
              placeholder="Describe the work. Markdown, tables, and pasted images are supported."
              startInPreview={Boolean(current)}
              value={draft.description}
              onChange={set("description")}
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
          {current && draft.status === "done" && current.status !== "done" && (
            <p className="small">Saving marks this task Done.</p>
          )}
        </form>
        <aside
          className="editor-side"
          aria-label={current ? "Task state" : "New task settings"}
        >
          <dl className="facts">
            {current ? (
              <div>
                <dt>Status</dt>
                <dd>
                  <button
                    type="button"
                    className="sidebar-picker-trigger"
                    aria-label={"Status: " + statusTitle(draft.status) + ". Choose status"}
                    aria-haspopup="dialog"
                    disabled={Boolean(pending)}
                    onClick={() => setPicker("status")}
                  >
                    <StatusIcon status={draft.status} />
                    <span>{statusTitle(draft.status)}</span>
                  </button>
                  {conflicted("status") && (
                    <ConflictValue
                      value={statusTitle(current.status)}
                      onUseLatest={() => set("status")(current.status)}
                    />
                  )}
                </dd>
              </div>
            ) : (
              <div>
                <dt>Status</dt>
                <dd>Backlog</dd>
              </div>
            )}
            <div>
              <dt>Priority</dt>
              <dd>
                <button
                  type="button"
                  className="sidebar-picker-trigger"
                  aria-label={"Priority: " + (priorities.find((priority) => priority.id === draft.priority)?.title ?? draft.priority)}
                  aria-haspopup="dialog"
                  disabled={Boolean(pending)}
                  onClick={() => setPicker("priority")}
                >
                  {priorities.find((priority) => priority.id === draft.priority)?.title}
                </button>
                {conflicted("priority") && current && (
                  <ConflictValue
                    value={priorities.find((priority) => priority.id === current.priority)?.title ?? current.priority}
                    onUseLatest={() => set("priority")(current.priority)}
                  />
                )}
              </dd>
            </div>
            <div>
              <dt>Assignee</dt>
              <dd>
                <button
                  type="button"
                  className="sidebar-picker-trigger assignee-picker-trigger"
                  aria-label={"Assignee: " + (displayName(people, draft.assignee) || "Unassigned") + ". Choose assignee"}
                  aria-haspopup="dialog"
                  disabled={Boolean(pending)}
                  onClick={() => setPicker("assignee")}
                >
                  <Assignee
                    name={draft.assignee}
                    agent={agents.has(draft.assignee)}
                  />
                </button>
                {conflicted("assignee") && current && (
                  <ConflictValue
                    value={current.assignee || "Unassigned"}
                    onUseLatest={() => set("assignee")(current.assignee)}
                  />
                )}
              </dd>
            </div>
            <div>
              <dt>Epic</dt>
              <dd>
                <button
                  type="button"
                  className="sidebar-picker-trigger epic-picker-trigger"
                  aria-label={
                    "Epic: " +
                    (draft.epic ? epicTitle(draft.epic) : "None") +
                    ". Choose epic"
                  }
                  aria-haspopup="dialog"
                  disabled={Boolean(pending)}
                  onClick={() => setPicker("epic")}
                >
                  {draft.epic ? (
                    <EpicTag epic={epicsById.get(draft.epic)} />
                  ) : (
                    <span className="small">None</span>
                  )}
                </button>
                {conflicted("epic") && current && (
                  <ConflictValue
                    value={current.epic ? epicTitle(current.epic) : "None"}
                    onUseLatest={() => set("epic")(current.epic)}
                  />
                )}
              </dd>
            </div>
              <div>
                <dt>Labels</dt>
                <dd>
                  <button
                    type="button"
                    className="sidebar-picker-trigger label-picker-trigger"
                    aria-label={"Labels: " + (draft.labels.join(", ") || "None") + ". Edit labels"}
                    aria-haspopup="dialog"
                    disabled={Boolean(pending)}
                    onClick={() => setPicker("labels")}
                  >
                    {draft.labels.length ? (
                      <span className="task-labels">
                      {draft.labels.map((label) => (
                        <Label label={label} key={label} />
                      ))}
                      </span>
                    ) : (
                      <span className="small">None</span>
                    )}
                  </button>
                {conflicted("labels") && current && (
                  <ConflictValue
                    value={current.labels.join(", ") || "None"}
                    onUseLatest={() => set("labels")([...current.labels])}
                  />
                )}
              </dd>
            </div>
            {current && (
              <div>
                <dt>Version</dt>
                <dd>{current.version}</dd>
              </div>
            )}
          </dl>
          {current && (
            <>
            <section className="side-block" aria-label="Claim">
              <h3>
                <Icon name="lock" size={14} /> Claim
              </h3>
              {!current.lease ? (
                <p className="small">Not claimed.</p>
              ) : lease ? (
                <>
                  <p>
                    Claimed by{" "}
                    <strong>
                      <PersonName id={lease.actor} />
                    </strong>
                    , expires{" "}
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
                  Claim by <PersonName id={current.lease.actor} /> expired at{" "}
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
                  <p className="small">
                    Submitted by <PersonName id={current.review.actor} />
                  </p>
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
            </>
          )}
        </aside>
        {current && (
          <section className="activity" aria-label="Comments and activity">
            <h3>Activity</h3>
            <Activity events={current.events ?? []} epicTitle={epicTitle} />
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
    {picker && (
      <SearchableChoiceDialog
        key={picker}
        title={
          picker === "assignee"
            ? "Choose assignee"
            : picker === "status"
              ? "Choose status"
              : picker === "priority"
                ? "Choose priority"
                : picker === "epic"
                  ? "Choose epic"
                  : "Choose labels"
        }
        searchLabel={
          picker === "assignee"
            ? "Search users"
            : picker === "status"
              ? "Search status"
              : picker === "priority"
                ? "Search priority"
                : picker === "epic"
                  ? "Search epics"
                  : "Search labels"
        }
        options={
          picker === "assignee"
            ? assigneeOptions
            : picker === "status"
              ? statusOptions
              : picker === "priority"
                ? priorityOptions
                : picker === "epic"
                  ? epicOptions
                  : labelOptions
        }
        selected={
          picker === "status"
            ? [draft.status]
            : picker === "priority"
              ? [draft.priority]
              : picker === "assignee"
                ? [draft.assignee]
                : picker === "epic"
                  ? [draft.epic]
                  : draft.labels
        }
        multiple={picker === "labels"}
        allowCreate={picker === "labels"}
        onSelect={(value) => {
          if (picker === "status") set("status")(value as Status);
          else if (picker === "priority")
            set("priority")(value as Priority);
          else if (picker === "assignee") set("assignee")(value);
          else if (picker === "epic") set("epic")(value);
          setPicker(null);
        }}
        onToggle={(value) =>
          set("labels")(
            draft.labels.includes(value)
              ? draft.labels.filter((label) => label !== value)
              : [...draft.labels, value],
          )
        }
        onCreate={(value) => {
          const label = value.trim();
          if (label && label.length <= 40 && !draft.labels.includes(label))
            set("labels")([...draft.labels, label]);
        }}
        onClose={() => setPicker(null)}
      />
    )}
    </>
  );
}

function ConflictValue({
  value,
  onUseLatest,
}: {
  value: string;
  onUseLatest: () => void;
}) {
  return (
    <div className="conflict-value">
      <span>
        Latest: <q>{value.length > 160 ? `${value.slice(0, 160)}…` : value || "empty"}</q>
      </span>
      <button type="button" className="quiet" onClick={onUseLatest}>
        Use latest
      </button>
    </div>
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
  const profileActor = usePeople().get(actor.id) ?? actor;
  const [page, setPage] = useState<SettingsPage>(
    connected ? "profile" : "connection",
  );
  const [search, setSearch] = useState("");
  const tokenId = useId();
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
        text: `Export requested: ${data.tasks.length} tasks and ${data.events.length} activity events. Check your downloads or save dialog for ${name}.`,
      });
    } catch (e) {
      setExported({ ok: false, text: `Export failed: ${errorOf(e).message}` });
    } finally {
      setExporting(false);
    }
  }

  const pages: {
    id: SettingsPage;
    label: string;
    icon: string;
    group: string;
    keywords: string;
  }[] = [
    {
      id: "profile",
      label: "Profile",
      icon: "user",
      group: "Account",
      keywords: "name display picture photo avatar image me",
    },
    {
      id: "connection",
      label: "Connection",
      icon: "plug",
      group: "Workspace",
      keywords: "token access auth server sign in status",
    },
    {
      id: "data",
      label: "Data",
      icon: "database",
      group: "Workspace",
      keywords: "export import download json backup archive activity",
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: "keyboard",
      group: "App",
      keywords: shortcuts.flat().join(" "),
    },
  ];
  const q = search.trim().toLowerCase();
  const visible = pages.filter(
    (p) => !q || `${p.label} ${p.keywords}`.toLowerCase().includes(q),
  );
  const groups = [...new Set(visible.map((p) => p.group))];
  const title = pages.find((p) => p.id === page)!.label;

  return (
    <Dialog
      title="Settings"
      onClose={onClose}
      dismissOnBackdrop
      className="settings-dialog"
    >
      <div className="settings-layout">
        <aside className="settings-nav">
          <label className="settings-search">
            <Icon name="search" size={15} />
            <span className="sr-only">Search settings</span>
            <input
              type="search"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <nav aria-label="Settings sections">
            {groups.map((group) => (
              <div key={group} className="settings-nav-group">
                <span className="settings-nav-heading">{group}</span>
                {visible
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="settings-nav-item"
                      aria-current={p.id === page ? "page" : undefined}
                      onClick={() => setPage(p.id)}
                    >
                      <Icon name={p.icon} size={16} />
                      <span>{p.label}</span>
                    </button>
                  ))}
              </div>
            ))}
            {!visible.length && (
              <p className="small settings-nav-empty">No matching settings</p>
            )}
          </nav>
        </aside>
        <div className="settings-main">
          <div className="settings-page">
            <h3 className="settings-title">{title}</h3>
            {page === "profile" && (
              <ProfileSettings
                actor={profileActor}
                connected={connected}
                onSaved={onReconnect}
              />
            )}
            {page === "connection" && (
              <>
                <SettingsGroup title="Status">
                  <SettingsRow
                    title="Workspace"
                    hint={
                      connected
                        ? `Signed in as ${actor.id} (${actor.kind}).`
                        : "Not connected to the workspace service."
                    }
                  >
                    <span
                      className={`settings-pill ${connected ? "on" : "off"}`}
                    >
                      {connected ? "Connected" : "Offline"}
                    </span>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Authentication">
                  <form
                    className="settings-row settings-row-stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveConnection(value);
                    }}
                  >
                    <div className="settings-row-text">
                      <label className="settings-row-title" htmlFor={tokenId}>
                        Workspace access token
                      </label>
                      <span className="settings-row-hint">
                        Needed only for a shared server. Kept for this browser
                        session only and never shown again.
                      </span>
                    </div>
                    <div className="settings-token">
                      <input
                        id={tokenId}
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
                      {stored && (
                        <button
                          type="button"
                          className="secondary small-button"
                          disabled={saving}
                          onClick={() => saveConnection("")}
                        >
                          Remove token
                        </button>
                      )}
                      <button
                        className="primary small-button"
                        disabled={saving}
                      >
                        {saving ? "Connecting…" : "Save connection"}
                      </button>
                    </div>
                    {connection && (
                      <p
                        className={
                          connection.ok ? "small ok" : "inline-error"
                        }
                        role={connection.ok ? "status" : "alert"}
                      >
                        {connection.text}
                      </p>
                    )}
                  </form>
                </SettingsGroup>
              </>
            )}
            {page === "data" && (
              <SettingsGroup title="Backup">
                <SettingsRow
                  title="Export workspace"
                  hint="Download all tasks, archived work, and the full activity log as JSON."
                >
                  <button
                    type="button"
                    className="secondary small-button"
                    onClick={exportWorkspace}
                    disabled={exporting}
                  >
                    <Icon name="download" size={14} />
                    {exporting ? "Exporting…" : "Export workspace"}
                  </button>
                </SettingsRow>
                <SettingsRow
                  title="Import"
                  hint="Restoring from an export file is not available."
                >
                  <span className="settings-pill off">Unavailable</span>
                </SettingsRow>
                {exported && (
                  <p
                    className={`settings-row-note ${exported.ok ? "small ok" : "inline-error"}`}
                    role={exported.ok ? "status" : "alert"}
                  >
                    {exported.text}
                  </p>
                )}
              </SettingsGroup>
            )}
            {page === "shortcuts" && (
              <SettingsGroup
                title="Shortcuts"
                note="Shortcuts are ignored while you type in a field. Each card's Status menu moves it without dragging."
              >
                {shortcuts.map(([key, label]) => (
                  <SettingsRow key={key} title={label}>
                    <kbd>{key}</kbd>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

type SettingsPage = "profile" | "connection" | "data" | "shortcuts";

const AVATAR_PIXELS = 128;

/** Crop to a centred square and re-encode small enough for one API request. */
async function avatarFromFile(file: File) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("Choose an image smaller than 10 MB.");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("This image couldn't be read.");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_PIXELS;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_PIXELS,
    AVATAR_PIXELS,
  );
  bitmap.close();
  for (const quality of [0.86, 0.7, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= 48000) return url;
  }
  throw new Error("This image is too detailed to store. Try another one.");
}

function ProfileSettings({
  actor,
  connected,
  onSaved,
}: {
  actor: Actor;
  connected: boolean;
  onSaved: () => Promise<RefreshResult>;
}) {
  const nameId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(actor.name ?? "");
  const [avatar, setAvatar] = useState(actor.avatar ?? "");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<null | { ok: boolean; text: string }>(null);
  const dirty =
    name.trim() !== (actor.name ?? "") || avatar !== (actor.avatar ?? "");
  const preview = new Map([
    [actor.id, { ...actor, name: name.trim(), avatar }],
  ]);

  async function choose(file: File | undefined) {
    if (!file) return;
    setNote(null);
    try {
      setAvatar(await avatarFromFile(file));
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    try {
      await command("update_profile", { name: name.trim(), avatar });
      await onSaved();
      setNote({ ok: true, text: "Profile saved. Everyone sees it on their next refresh." });
    } catch (err) {
      setNote({ ok: false, text: describeError(errorOf(err)) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save}>
      <SettingsGroup
        title="How others see you"
        note={`Your workspace ID stays “${actor.id}”. Assignments, claims, and history keep using it.`}
      >
        <div className="settings-row profile-row">
          <PeopleContext.Provider value={preview}>
            <Avatar
              name={actor.id}
              agent={actor.kind === "agent"}
              size="large"
            />
          </PeopleContext.Provider>
          <div className="settings-row-text">
            <span className="settings-row-title">Profile picture</span>
            <span className="settings-row-hint">
              Square crop, resized to {AVATAR_PIXELS}px. Without a picture,
              your initials are shown.
            </span>
          </div>
          <div className="settings-row-control profile-picture-actions">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              tabIndex={-1}
              aria-label="Profile picture file"
              onChange={(e) => void choose(e.target.files?.[0])}
            />
            <button
              type="button"
              className="secondary small-button"
              onClick={() => fileInput.current?.click()}
            >
              {avatar ? "Change picture" : "Upload picture"}
            </button>
            {avatar && (
              <button
                type="button"
                className="quiet small-button"
                onClick={() => setAvatar("")}
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <label className="settings-row-title" htmlFor={nameId}>
              Display name
            </label>
            <span className="settings-row-hint">
              Shown on cards, in activity, and in the assignee picker. Leave
              empty to show your ID.
            </span>
          </div>
          <input
            id={nameId}
            type="text"
            maxLength={80}
            autoComplete="name"
            placeholder={actor.id}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </SettingsGroup>
      <div className="form-actions">
        {note && (
          <p
            className={note.ok ? "small ok" : "inline-error"}
            role={note.ok ? "status" : "alert"}
          >
            {note.text}
          </p>
        )}
        <span className="spacer" />
        <button
          className="primary small-button"
          disabled={!dirty || saving || !connected}
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

function SettingsGroup({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      <h4>{title}</h4>
      <div className="settings-card">{children}</div>
      {note && <p className="small settings-group-note">{note}</p>}
    </section>
  );
}

function SettingsRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export const shortcuts: [string, string][] = [
  ["N", "Create a task"],
  ["⌘/Ctrl K", "Focus search"],
  ["F", "Focus the assignee filter"],
  ["?", "Open keyboard help"],
  ["[", "Collapse / expand the sidebar"],
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
