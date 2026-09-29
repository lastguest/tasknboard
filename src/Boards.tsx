import { useState } from "react";
import { epicProgress, type Board } from "./types";
import { ApiError, command, errorOf } from "./api";
import { Dialog, ErrorNote } from "./Dialogs";
import { Icon } from "./Icons";

/** The Boards view: every board, including the ones hidden from the sidebar. */
export function BoardsPage({
  boards,
  current,
  canManage,
  onOpen,
  onEdit,
  onNew,
}: {
  boards: Board[];
  current: string;
  canManage: boolean;
  onOpen: (board: Board) => void;
  onEdit: (board: Board) => void;
  onNew: () => void;
}) {
  return (
    <div className="epics-page">
      <div className="toolbar epics-toolbar">
        <p className="result-summary" role="status">
          {boards.length} {boards.length === 1 ? "board" : "boards"}
        </p>
        {canManage && (
          <button type="button" className="primary" onClick={onNew}>
            <Icon name="plus" size={16} /> New board
          </button>
        )}
      </div>
      <ul className="epic-grid">
        {boards.map((board) => {
          const { open, done } = epicProgress(board);
          return (
            <li key={board.id} className="epic-card">
              <div className="epic-card-top">
                <Icon name="board" size={15} />
                <span className="task-id">{board.id}</span>
                <span className="epic-open-count">
                  {board.id === current ? "Current · " : ""}
                  {open} open
                </span>
              </div>
              <h2>
                <button
                  type="button"
                  className="epic-card-open"
                  onClick={() => onOpen(board)}
                >
                  {board.title}
                </button>
              </h2>
              <p className="epic-card-summary">
                {board.showInSidebar ? "Shown in the sidebar" : "Hidden from the sidebar"}
                {` · ${done} done`}
                {board.formerIds.length > 0 &&
                  ` · Formerly ${board.formerIds.join(", ")}`}
              </p>
              {canManage && (
                <div className="board-card-actions">
                  <button
                    type="button"
                    className="secondary small-button"
                    aria-label={`Edit board ${board.id}`}
                    onClick={() => onEdit(board)}
                  >
                    Edit board
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const boardErrors: Record<string, string> = {
  VERSION_CONFLICT:
    "This board changed after you opened it, so nothing was saved. Load the latest version, check your draft, and save again.",
};

/** A board ID field: capital letters and digits only. */
const boardIdInput = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Create or edit a board. Only people manage boards; the server enforces it. */
export function BoardEditor({
  board,
  onClose,
  onSaved,
  onRenamed,
}: {
  board: Board | null;
  onClose: () => void;
  onSaved: (board: Board, created: boolean) => void;
  /** The board's ID and all its task IDs changed from `from`. */
  onRenamed: (from: string, board: Board) => void;
}) {
  const [base, setBase] = useState(board);
  const [id, setId] = useState("");
  const [title, setTitle] = useState(board?.title ?? "");
  const [showInSidebar, setShowInSidebar] = useState(
    board?.showInSidebar ?? true,
  );
  const [newId, setNewId] = useState("");
  const [renameStep, setRenameStep] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const patch = {
    ...(title.trim() !== (base?.title ?? "") ? { title } : {}),
    ...(showInSidebar !== (base?.showInSidebar ?? true)
      ? { showInSidebar }
      : {}),
  };
  const dirty = Boolean(id) || Object.keys(patch).length > 0;

  async function reload() {
    if (!base) return;
    try {
      const { boards } = await command<{ boards: Board[] }>("list_boards");
      const latest = boards.find((candidate) => candidate.id === base.id);
      if (latest) setBase(latest);
      setError(null);
    } catch (e) {
      setError(errorOf(e));
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!base && !id) {
      setError(new ApiError("Give the board an ID", "VALIDATION", 400));
      return;
    }
    if (!title.trim()) {
      setError(new ApiError("Give the board a title", "VALIDATION", 400));
      return;
    }
    if (base && !dirty) return onClose();
    setPending(true);
    setError(null);
    try {
      const saved = base
        ? await command<Board>("update_board", {
            id: base.id,
            expectedVersion: base.version,
            patch,
          })
        : await command<Board>("create_board", { id, title, showInSidebar });
      onSaved(saved, !base);
    } catch (e) {
      setError(errorOf(e));
      setPending(false);
    }
  }

  async function rename() {
    if (!base || pending) return;
    setPending(true);
    setError(null);
    try {
      onRenamed(
        base.id,
        await command<Board>("rename_board", {
          id: base.id,
          expectedVersion: base.version,
          newId,
        }),
      );
    } catch (e) {
      setError(errorOf(e));
      setPending(false);
    }
  }

  const footer = (
    <>
      {error &&
        (boardErrors[error.code] ? (
          <div className="inline-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{boardErrors[error.code]}</span>
            <button
              type="button"
              className="secondary small-button"
              onClick={reload}
            >
              <Icon name="refresh" size={14} /> Load latest
            </button>
          </div>
        ) : (
          <ErrorNote
            error={error}
            kept={!pending && dirty ? "Your draft is still here." : ""}
            busy={pending}
          />
        ))}
      <div className="form-actions">
        <span className="spacer" />
        <button
          type="button"
          className="secondary"
          onClick={onClose}
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="submit"
          form="board-form"
          className="primary"
          disabled={pending}
        >
          {pending ? "Saving…" : base ? "Save changes" : "Create board"}
        </button>
      </div>
    </>
  );

  return (
    <Dialog
      title={
        base ? (
          <>
            <span className="task-id">{base.id}</span> Edit board
          </>
        ) : (
          "New board"
        )
      }
      onClose={() => !pending && onClose()}
      footer={footer}
      className="epic-dialog"
    >
      <form id="board-form" className="task-form" onSubmit={save} noValidate>
        {!base && (
          <label className="field">
            <span className="field-label">ID</span>
            <span className="field-hint" id="board-id-hint">
              The prefix of its task IDs, for example WEB for WEB-001. 2–10
              capital letters or digits. It can't change later.
            </span>
            <input
              data-autofocus=""
              required
              maxLength={10}
              aria-describedby="board-id-hint"
              placeholder="WEB"
              autoCapitalize="characters"
              spellCheck={false}
              value={id}
              onChange={(e) => setId(boardIdInput(e.target.value))}
            />
          </label>
        )}
        <label className="field">
          <span className="field-label">Title</span>
          <input
            className="title-input"
            data-autofocus={base ? "" : undefined}
            required
            maxLength={120}
            placeholder="A team or product, e.g. “Website”"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={showInSidebar}
            onChange={(e) => setShowInSidebar(e.target.checked)}
          />
          <span>Show in the sidebar</span>
        </label>
        <p className="small">
          Hidden boards stay available on the Boards page. The setting applies
          to everyone in the workspace.
        </p>
      </form>
      {base && (
        <section className="side-block epic-archive" aria-label="Change ID">
          {!renameStep ? (
            <button
              type="button"
              className="quiet"
              onClick={() => setRenameStep(true)}
              disabled={pending}
            >
              Change ID…
            </button>
          ) : (
            <div
              className="confirm-archive"
              role="group"
              aria-label="Confirm ID change"
            >
              <label className="field">
                <span className="field-label">New ID</span>
                <input
                  autoFocus
                  maxLength={10}
                  placeholder={base.id}
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={newId}
                  onChange={(e) => setNewId(boardIdInput(e.target.value))}
                />
              </label>
              <p>
                Every task on this board moves to the new prefix, for example{" "}
                {base.id}-001 becomes {newId || "NEW"}-001. Its history moves
                with it. {base.id} keeps redirecting to the new ID until a new
                board takes {base.id}. Claimed tasks must be released first.
              </p>
              {dirty && (
                <p className="small">
                  Save or undo your other changes before you change the ID.
                </p>
              )}
              <div className="review-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={pending}
                  onClick={() => setRenameStep(false)}
                >
                  Keep {base.id}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={pending || dirty || !newId || newId === base.id}
                  onClick={rename}
                >
                  {pending ? "Changing…" : `Change ID to ${newId || "…"}`}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </Dialog>
  );
}
