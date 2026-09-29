import { useEffect, useId, useState } from "react";
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

/** The board pages that each sidebar board row expands to. */
export type BoardPage = "board" | "epics" | "views";
const boardPages: [BoardPage, string, string][] = [
  ["board", "board", "Board"],
  ["epics", "folder", "Epics"],
  ["views", "layers", "Views"],
];
const SIDEBAR_BOARDS_KEY = "tasknboard.sidebarBoards";
/** Expanded board rows and the section state are this browser's layout, not workspace data. */
type SidebarLayout = { open: boolean; expanded: string[] };
const readSidebarLayout = (): SidebarLayout | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(SIDEBAR_BOARDS_KEY) ?? "null");
    return typeof stored?.open === "boolean" && Array.isArray(stored.expanded)
      ? stored
      : null;
  } catch {
    return null;
  }
};

/**
 * The sidebar Boards section: one expandable row per board the person keeps
 * in the sidebar, each with its Board, Epics, and Views pages.
 */
export function SidebarBoards({
  boards,
  selectedBoardId,
  page,
  collapsed,
  canManage,
  onOpen,
  onCreate,
  onMenu,
  onHiddenMenu,
}: {
  boards: BoardRecord[];
  selectedBoardId: string;
  /** The open page; it marks a board page only on the selected board. */
  page: string;
  /** The icon-only sidebar shows every page of every listed board. */
  collapsed: boolean;
  canManage: boolean;
  onOpen: (boardId: string, page: BoardPage) => void;
  onCreate: () => void;
  onMenu: (e: React.MouseEvent<HTMLElement>, board: BoardRecord) => void;
  onHiddenMenu: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const [layout, setLayout] = useState<SidebarLayout>(
    () => readSidebarLayout() ?? { open: true, expanded: [selectedBoardId] },
  );
  const update = (change: (current: SidebarLayout) => SidebarLayout) =>
    setLayout((current) => {
      const next = change(current);
      try {
        localStorage.setItem(SIDEBAR_BOARDS_KEY, JSON.stringify(next));
      } catch {
        // The layout still works for this page when storage is unavailable.
      }
      return next;
    });
  // The selected board opens, so its current page stays visible.
  useEffect(() => {
    if (selectedBoardId)
      update((current) =>
        current.expanded.includes(selectedBoardId)
          ? current
          : { ...current, expanded: [...current.expanded, selectedBoardId] },
      );
  }, [selectedBoardId]);
  const listed = boards.filter((board) => board.inSidebar);
  const hidden = boards.length - listed.length;
  const open = layout.open || collapsed;
  return (
    <nav className="nav-epics nav-boards" aria-labelledby="boards-label">
      <div className="nav-section-head">
        <button
          type="button"
          className="nav-label nav-section-toggle"
          id="boards-label"
          aria-expanded={open}
          onClick={() => update((current) => ({ ...current, open: !current.open }))}
        >
          Boards
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        </button>
        {canManage && (
          <button
            type="button"
            className="icon-button nav-add"
            aria-label="New board"
            title="New board"
            onClick={onCreate}
          >
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      {open &&
        listed.map((board) => {
          const expanded = collapsed || layout.expanded.includes(board.id);
          return (
            <div
              key={board.id}
              className="nav-board"
              role="group"
              aria-label={board.name}
            >
              <button
                type="button"
                className="nav-item nav-epic nav-board-row"
                aria-expanded={expanded}
                title={collapsed ? board.name : undefined}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    expanded: current.expanded.includes(board.id)
                      ? current.expanded.filter((id) => id !== board.id)
                      : [...current.expanded, board.id],
                  }))
                }
                onContextMenu={(e) => onMenu(e, board)}
              >
                <span className="board-glyph" aria-hidden="true">
                  {board.prefix.slice(0, 2)}
                </span>
                <span className="nav-epic-title">{board.name}</span>
                <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
              </button>
              {expanded &&
                boardPages.map(([id, icon, label]) => {
                  const selected =
                    board.id === selectedBoardId &&
                    (page === id || (id === "epics" && page === "epic") ||
                      (id === "views" && page === "saved"));
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`nav-item nav-epic nav-board-page ${selected ? "selected" : ""}`}
                      aria-current={selected ? "page" : undefined}
                      title={collapsed ? `${board.name} ${label}` : undefined}
                      onClick={() => onOpen(board.id, id)}
                    >
                      <Icon name={icon} size={15} />
                      <span>{label}</span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      {open && hidden > 0 && (
        <button
          type="button"
          className="nav-hidden-boards"
          aria-haspopup="menu"
          onClick={onHiddenMenu}
        >
          {hidden === 1 ? "1 hidden board" : `${hidden} hidden boards`}
        </button>
      )}
    </nav>
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
