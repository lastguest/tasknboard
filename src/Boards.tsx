import { useId, useState } from "react";
import { ApiError, command, errorOf } from "./api";
import { Dialog } from "./Dialogs";
import { Icon } from "./Icons";
import type { BoardRecord } from "./types";

export function BoardControls({
  boards,
  selectedBoardId,
  canManage,
  onSelect,
  onCreate,
  onEdit,
}: {
  boards: BoardRecord[];
  selectedBoardId: string;
  canManage: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: () => void;
}) {
  const selected = boards.find((board) => board.id === selectedBoardId);
  return (
    <div
      className="board-controls"
      role="group"
      aria-label="Board selection and actions"
    >
      <label className="board-selector">
        <span className="field-label">Board</span>
        <select
          aria-label="Board"
          value={selectedBoardId}
          disabled={!boards.length}
          onChange={(event) => onSelect(event.target.value)}
        >
          {boards.map((board) => (
            <option key={board.id} value={board.id}>
              {board.name} ({board.prefix}-)
            </option>
          ))}
        </select>
      </label>
      {canManage && (
        <div className="board-control-actions">
          {selected && (
            <button
              type="button"
              className="secondary"
              onClick={onEdit}
            >
              Edit board
            </button>
          )}
          <button type="button" className="secondary" onClick={onCreate}>
            <Icon name="plus" size={15} /> New board
          </button>
        </div>
      )}
    </div>
  );
}

const prefixProblem = (value: string) =>
  !/^[A-Z][A-Z0-9]{1,9}$/.test(value)
    ? "Use 2–10 letters or digits, starting with a letter."
    : ["EPIC", "VIEW", "BOARD"].includes(value)
      ? `${value} is reserved.`
      : "";

export function BoardEditor({
  board,
  onClose,
  onSaved,
}: {
  board: BoardRecord | null;
  onClose: () => void;
  onSaved: (saved: BoardRecord, previous: BoardRecord | null) => void;
}) {
  const nameId = useId();
  const prefixId = useId();
  const [name, setName] = useState(board?.name ?? "");
  const [prefix, setPrefix] = useState(board?.prefix ?? "");
  const [pending, setPending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const normalizedName = name.trim();
  const normalizedPrefix = prefix.trim().toUpperCase();
  const nameError = normalizedName ? "" : "Enter a board name.";
  const prefixError = prefixProblem(normalizedPrefix);
  const changed =
    !board ||
    normalizedName !== board.name ||
    normalizedPrefix !== board.prefix;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setAttempted(true);
    if (nameError || prefixError) return;
    if (board && !changed) return onClose();
    setPending(true);
    setError(null);
    try {
      const saved = board
        ? await command<BoardRecord>("update_board", {
            id: board.id,
            expectedVersion: board.version,
            patch: {
              ...(normalizedName !== board.name && { name: normalizedName }),
              ...(normalizedPrefix !== board.prefix && {
                prefix: normalizedPrefix,
              }),
            },
          })
        : await command<BoardRecord>("create_board", {
            name: normalizedName,
            prefix: normalizedPrefix,
          });
      onSaved(saved, board);
    } catch (cause) {
      setError(errorOf(cause));
      setPending(false);
    }
  }

  const prefixChanged = Boolean(board && normalizedPrefix !== board.prefix);
  return (
    <Dialog
      title={board ? "Edit board" : "New board"}
      onClose={() => !pending && onClose()}
      className="board-editor"
      footer={
        <>
          {error && (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={16} />
              <span>
                {error.message} Nothing was saved. Your entries are still here.
              </span>
            </p>
          )}
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
              disabled={pending || !changed}
            >
              {pending ? "Saving…" : board ? "Save changes" : "Create board"}
            </button>
          </div>
        </>
      }
    >
      <form id="board-form" className="task-form" onSubmit={save} noValidate>
        <label className="field" htmlFor={nameId}>
          <span className="field-label" id={`${nameId}-label`}>
            Name
          </span>
          <input
            id={nameId}
            aria-labelledby={`${nameId}-label`}
            className="title-input"
            data-autofocus=""
            required
            maxLength={80}
            autoComplete="off"
            value={name}
            aria-invalid={attempted && Boolean(nameError)}
            aria-describedby={`${nameId}-hint${attempted && nameError ? ` ${nameId}-error` : ""}`}
            onChange={(event) => setName(event.target.value)}
          />
          <span className="field-hint" id={`${nameId}-hint`}>
            A clear name helps people choose the right task board.
          </span>
          {attempted && nameError && (
            <span className="field-hint inline-error" id={`${nameId}-error`}>
              {nameError}
            </span>
          )}
        </label>
        <label className="field" htmlFor={prefixId}>
          <span className="field-label" id={`${prefixId}-label`}>
            Board prefix
          </span>
          <input
            id={prefixId}
            aria-labelledby={`${prefixId}-label`}
            required
            maxLength={10}
            autoComplete="off"
            spellCheck={false}
            value={prefix}
            aria-invalid={attempted && Boolean(prefixError)}
            aria-describedby={`${prefixId}-hint${attempted && prefixError ? ` ${prefixId}-error` : ""}`}
            onChange={(event) => setPrefix(event.target.value.toUpperCase())}
          />
          <span className="field-hint" id={`${prefixId}-hint`}>
            Every task on this board uses this prefix. Prefixes must be unique
            across boards.
            {board && (
              <>
                {" "}
                {prefixChanged
                  ? "Changing this prefix renames existing task keys. Old keys in links or branch references keep opening the renamed tasks."
                  : "You can change this prefix later when you edit this board."}
                {board.formerPrefixes.length > 0 &&
                  ` Former prefixes: ${board.formerPrefixes.map((p) => `${p}-`).join(", ")}.`}
              </>
            )}
          </span>
          {attempted && prefixError && (
            <span className="field-hint inline-error" id={`${prefixId}-error`}>
              {prefixError}
            </span>
          )}
        </label>
      </form>
    </Dialog>
  );
}
