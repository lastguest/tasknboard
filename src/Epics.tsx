import { useState } from "react";
import {
  epicColor,
  epicPalette,
  epicProgress,
  epicStyle,
  completionPolicies,
  type Epic,
} from "./types";
import { ApiError, command, errorOf } from "./api";
import { Dialog, ErrorNote } from "./Dialogs";
import { Icon } from "./Icons";
import { Markdown, MarkdownEditor, plainText } from "./Markdown";

export function EpicTag({ epic }: { epic: Epic | undefined }) {
  if (!epic) return null;
  return (
    <span
      className="epic-tag"
      style={epicStyle(epic)}
      title={`Epic: ${epic.title}${epic.archived ? " (archived)" : ""}`}
    >
      <span
        className="epic-glyph"
                    style={epicStyle(epic)}
        aria-hidden="true"
      />
      <span className="epic-tag-title">{epic.title}</span>
      <span className="sr-only">(epic)</span>
    </span>
  );
}

export function EpicProgress({ epic }: { epic: Epic }) {
  const { total, done } = epicProgress(epic);
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="epic-progress" style={epicStyle(epic)}>
      <div
        className="epic-progress-bar"
        role="progressbar"
        aria-label={`${epic.title} progress`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${total} tasks done`}
      >
        {(["done", "in_review", "in_progress", "todo"] as const).map((role) => <span key={role} title={`${role}: ${epic.counts[role]}`} style={{ width: `${total ? epic.counts[role] / total * 100 : 0}%`, background: role === "done" ? "#9de3c1" : role === "in_review" ? "#bca0f4" : role === "in_progress" ? "#e8bd5a" : "#88909e" }} />)}
      </div>
      <span className="epic-progress-text" title={`${percent}% done · ${epic.counts.in_review} review · ${epic.counts.in_progress} in progress · ${epic.counts.todo} to do`}>
        {total ? `${done} of ${total} done` : "No tasks yet"}
      </span>
    </div>
  );
}

/** The Epics view: every active epic with its progress. */
export function EpicsPage({
  epics,
  unfiled,
  canManage,
  onOpen,
  onNew,
  onMenu,
}: {
  epics: Epic[];
  unfiled: number;
  canManage: boolean;
  onOpen: (epic: Epic) => void;
  onNew: () => void;
  onMenu: (e: React.MouseEvent<HTMLElement>, epic: Epic) => void;
}) {
  return (
    <div className="epics-page">
      <div className="toolbar epics-toolbar">
        <p className="result-summary" role="status">
          {epics.length} {epics.length === 1 ? "epic" : "epics"}
          {unfiled > 0 &&
            ` · ${unfiled} ${unfiled === 1 ? "task" : "tasks"} without an epic`}
        </p>
        {canManage && (
          <button type="button" className="primary" onClick={onNew}>
            <Icon name="plus" size={16} /> New epic
          </button>
        )}
      </div>
      {epics.length ? (
        <ul className="epic-grid">
          {epics.map((epic) => {
            const { open } = epicProgress(epic);
            const summary = plainText(epic.description);
            return (
              <li
                key={epic.id}
                className="epic-card"
                onContextMenu={(e) => onMenu(e, epic)}
              >
                <div className="epic-card-top">
                  <span
                    className="epic-glyph large"
                    style={epicStyle(epic)}
                    aria-hidden="true"
                  />
                  <span className="epic-open-count">{open} open</span>
                </div>
                <h2>
                  <button
                    type="button"
                    className="epic-card-open"
                    onClick={() => onOpen(epic)}
                  >
                    {epic.title}
                  </button>
                </h2>
                {summary && <p className="epic-card-summary">{summary}</p>}
                {epic.status && <p className="small" title={epic.statusAt ?? undefined}>Latest: {plainText(epic.status).split("\n")[0]}</p>}
                <EpicProgress epic={epic} />
                <dl className="epic-counts">
                  {(
                    [
                      ["To do", epic.counts.todo],
                      ["In progress", epic.counts.in_progress],
                      ["In review", epic.counts.in_review],
                    ] as const
                  ).map(([label, count]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty-state">
          <h2>No epics yet.</h2>
          <p>
            An epic is a project: a folder that groups related tasks and shows
            how far along they are.
          </p>
          {canManage && (
            <button type="button" className="primary" onClick={onNew}>
              <Icon name="plus" size={16} /> Create the first epic
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The heading block of one epic's board. */
export function EpicSummary({
  epic,
  canManage,
  onEdit,
}: {
  epic: Epic;
  canManage: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="epic-summary">
      {epic.description.trim() && (
        <Markdown source={epic.description} className="epic-description" />
      )}
      <div className="epic-summary-row">
        <EpicProgress epic={epic} />
        {canManage && !epic.archived && (
          <button
            type="button"
            className="secondary small-button"
            onClick={onEdit}
          >
            Edit epic
          </button>
        )}
      </div>
      {epic.archived && (
        <p className="small">
          This epic is archived. Its finished tasks stay here for reference.
        </p>
      )}
    </div>
  );
}

const epicErrors: Record<string, string> = {
  VERSION_CONFLICT:
    "This epic changed after you opened it, so nothing was saved. Load the latest version, check your draft, and save again.",
  ARCHIVED: "This epic has been archived. Nothing was saved.",
};

/** Palette swatches plus a custom colour, as one radio group. */
export function ColorField({
  value,
  title,
  onChange,
  name = "epic-color",
  preview,
}: {
  value: string;
  title: string;
  onChange: (color: string) => void;
  /** The radio group's name, unique per form. */
  name?: string;
  /** Replaces the epic tag preview. */
  preview?: React.ReactNode;
}) {
  const custom = value.startsWith("#");
  const hex = epicColor({ color: value });
  return (
    <fieldset className="field epic-color-field">
      <legend className="field-label">Color</legend>
      <div className="epic-swatches">
        {epicPalette.map((swatch) => (
          <label
            key={swatch.id}
            className="epic-swatch"
            title={swatch.name}
            style={{ "--epic": swatch.hex } as React.CSSProperties}
          >
            <input
              type="radio"
              name={name}
              checked={value === swatch.id}
              onChange={() => onChange(swatch.id)}
            />
            <span className="sr-only">{swatch.name}</span>
          </label>
        ))}
        <label
          className={`epic-swatch custom ${custom ? "is-custom" : ""}`}
          title="Custom color"
          style={
            custom ? ({ "--epic": hex } as React.CSSProperties) : undefined
          }
        >
          <input
            type="color"
            aria-label="Custom color"
            value={hex}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      </div>
      <span className="epic-color-preview">
        {preview ?? <EpicTag
          epic={{
            id: "",
            title: title.trim() || "Epic preview",
            description: "",
            color: value,
            version: 1,
            archived: false,
            createdAt: "",
            updatedAt: "",
            counts: { todo: 0, in_progress: 0, in_review: 0, done: 0 },
          }}
        />}
        <span className="small">
          {custom
            ? `Custom ${hex}`
            : epicPalette.find((swatch) => swatch.id === value)?.name}
        </span>
      </span>
    </fieldset>
  );
}

/** Create or edit an epic on the selected board. */
export function EpicEditor({
  epic,
  boardId,
  suggestedColor,
  onClose,
  onSaved,
  onArchived,
}: {
  epic: Epic | null;
  boardId: string;
  /** The palette colour a new epic starts with. */
  suggestedColor: string;
  onClose: () => void;
  onSaved: (epic: Epic, created: boolean) => void;
  onArchived: (epic: Epic) => void;
}) {
  const [base, setBase] = useState(epic);
  const [title, setTitle] = useState(epic?.title ?? "");
  const [description, setDescription] = useState(epic?.description ?? "");
  const [color, setColor] = useState(epic?.color ?? suggestedColor);
  const [completionPolicy, setCompletionPolicy] = useState(epic?.completionPolicy ?? "inherit");
  const [pending, setPending] = useState<null | "save" | "archive">(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [archiveStep, setArchiveStep] = useState(false);
  const [discard, setDiscard] = useState(false);
  const patch = {
    ...(title.trim() !== (base?.title ?? "") ? { title } : {}),
    ...(description !== (base?.description ?? "") ? { description } : {}),
    ...(color !== (base?.color ?? suggestedColor) ? { color } : {}),
    ...(completionPolicy !== (base?.completionPolicy ?? "inherit") ? { completionPolicy } : {}),
  };
  const dirty = Object.keys(patch).length > 0;

  function requestClose() {
    if (pending) return;
    if (discard) setDiscard(false);
    else if (dirty) setDiscard(true);
    else onClose();
  }

  async function reload() {
    if (!base) return;
    try {
      const { epics } = await command<{ epics: Epic[] }>("list_epics", {
        includeArchived: true,
        boardId,
      });
      const latest = epics.find((candidate) => candidate.id === base.id);
      if (latest) setBase(latest);
      setError(null);
    } catch (e) {
      setError(errorOf(e));
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!title.trim()) {
      setError(new ApiError("Give the epic a title", "VALIDATION", 400));
      return;
    }
    if (base && !dirty) return onClose();
    setPending("save");
    setError(null);
    try {
      const saved = base
        ? await command<Epic>("update_epic", {
            id: base.id,
            expectedVersion: base.version,
            patch,
          })
        : await command<Epic>("create_epic", { boardId, title, description, color, completionPolicy });
      onSaved(saved, !base);
    } catch (e) {
      setError(errorOf(e));
      setPending(null);
    }
  }

  async function archive() {
    if (!base || pending) return;
    setPending("archive");
    setError(null);
    try {
      onArchived(
        await command<Epic>("archive_epic", {
          id: base.id,
          expectedVersion: base.version,
        }),
      );
    } catch (e) {
      setError(errorOf(e));
      setPending(null);
    }
  }

  const footer = discard ? (
    <div className="discard-bar" role="alertdialog" aria-label="Discard changes">
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
      {error &&
        (epicErrors[error.code] ? (
          // The shared note words these codes for tasks.
          <div className="inline-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{epicErrors[error.code]}</span>
            {error.code === "VERSION_CONFLICT" && (
              <button
                type="button"
                className="secondary small-button"
                onClick={reload}
              >
                <Icon name="refresh" size={14} /> Load latest
              </button>
            )}
          </div>
        ) : (
          <ErrorNote
            error={error}
            kept={pending === null && dirty ? "Your draft is still here." : ""}
            busy={Boolean(pending)}
          />
        ))}
      <div className="form-actions">
        <span className="spacer" />
        <button
          type="button"
          className="secondary"
          onClick={requestClose}
          disabled={Boolean(pending)}
        >
          Cancel
        </button>
        <button
          type="submit"
          form="epic-form"
          className="primary"
          disabled={Boolean(pending)}
        >
          {pending === "save"
            ? "Saving…"
            : base
              ? "Save changes"
              : "Create epic"}
        </button>
      </div>
    </>
  );

  return (
    <Dialog
      title={
        base ? (
          "Edit epic"
        ) : (
          "New epic"
        )
      }
      onClose={requestClose}
      closeDisabled={Boolean(pending)}
      footer={footer}
      className="epic-dialog"
    >
      <form id="epic-form" className="task-form" onSubmit={save} noValidate>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="title-input"
            data-autofocus=""
            required
            maxLength={120}
            placeholder="A project, e.g. “Mobile onboarding”"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <ColorField value={color} title={title} onChange={setColor} />
        <label className="field">Completion policy<select aria-label="Completion policy" value={completionPolicy} onChange={(event) => setCompletionPolicy(event.target.value as typeof completionPolicy)}>
          <option value="inherit">Use board and label policies</option>
          {completionPolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.title}</option>)}
        </select></label>
        <div className="field">
          <label className="field-label" htmlFor="epic-description">
            Description
          </label>
          <span className="field-hint" id="epic-description-hint">
            Goal, scope and links. Markdown is supported.
          </span>
          <MarkdownEditor
            id="epic-description"
            aria-describedby="epic-description-hint"
            rows={6}
            maxLength={20000}
            placeholder="What is this project for, and when is it finished?"
            value={description}
            onChange={setDescription}
          />
        </div>
      </form>
      {base && (
        <section className="side-block epic-archive" aria-label="Archive">
          {!archiveStep ? (
            <button
              type="button"
              className="quiet danger"
              onClick={() => setArchiveStep(true)}
              disabled={Boolean(pending)}
            >
              <Icon name="archive" size={15} /> Archive epic…
            </button>
          ) : (
            <div
              className="confirm-archive"
              role="group"
              aria-label="Confirm archive"
            >
              <p>
                Archive {base.title}? It leaves the sidebar and Epics page. Done
                tasks keep it, and it stays in the JSON export. Epics with open
                tasks can't be archived.
              </p>
              <div className="review-actions">
                <button
                  type="button"
                  className="secondary"
                  autoFocus
                  disabled={pending === "archive"}
                  onClick={() => setArchiveStep(false)}
                >
                  Keep epic
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
        </section>
      )}
    </Dialog>
  );
}
