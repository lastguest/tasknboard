import { useEffect, useId, useState } from "react";
import { ApiError, command, errorOf } from "./api";
import { Dialog } from "./Dialogs";
import { Icon } from "./Icons";
import type { BoardRecord } from "./types";

export function BoardControls({
  canEdit,
  onCreate,
  onEdit,
}: {
  canEdit: boolean;
  onCreate: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="board-controls" role="group" aria-label="Board actions">
      {canEdit && (
        <button type="button" className="secondary" onClick={onEdit}>
          Edit board
        </button>
      )}
      <button type="button" className="secondary" onClick={onCreate}>
        <Icon name="plus" size={15} /> New board
      </button>
    </div>
  );
}

/** The board pages that each sidebar board row expands to. */
export type BoardPage = "board" | "epics" | "views";
const boardPages: [BoardPage, string, string][] = [
  ["board", "board", "Tasks"],
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
 * in the sidebar, each with its Tasks, Epics, and Views pages.
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
                <small
                  aria-label={`${board.inProgress} ${board.inProgress === 1 ? "task" : "tasks"} in progress`}
                  title="In progress"
                >
                  {board.inProgress}
                </small>
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
  boards,
  onClose,
  onSaved,
}: {
  board: BoardRecord | null;
  /** Every board, to warn before taking another board's former prefix. */
  boards: BoardRecord[];
  onClose: () => void;
  onSaved: (saved: BoardRecord, previous: BoardRecord | null) => void;
}) {
  const nameId = useId();
  const prefixId = useId();
  const descriptionId = useId();
  const repositoryId = useId();
  const [name, setName] = useState(board?.name ?? "");
  const [description, setDescription] = useState(board?.description ?? "");
  const [prefix, setPrefix] = useState(board?.prefix ?? "");
  const [repository, setRepository] = useState(board?.repository ?? "");
  const [pending, setPending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const normalizedName = name.trim();
  const normalizedPrefix = prefix.trim().toUpperCase();
  // Taking another board's former prefix ends the redirect of its old keys.
  const retiredBy = boards.find(
    (other) =>
      other.id !== board?.id && other.formerPrefixes.includes(normalizedPrefix),
  );
  const normalizedDescription = description.trim();
  const normalizedRepository = repository.trim();
  const nameError = normalizedName ? "" : "Enter a board name.";
  const prefixError = prefixProblem(normalizedPrefix);
  const repositoryError =
    !normalizedRepository ||
    normalizedRepository.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(normalizedRepository)
      ? ""
      : "Enter an absolute folder path, such as /Users/you/projects/app.";
  const changed =
    !board ||
    normalizedName !== board.name ||
    normalizedPrefix !== board.prefix ||
    normalizedDescription !== board.description ||
    normalizedRepository !== (board.repository ?? "");

  /** `confirmed` is true after the person accepts a retired prefix. */
  async function save(event?: React.FormEvent, confirmed = false) {
    event?.preventDefault();
    if (pending) return;
    setAttempted(true);
    if (nameError || prefixError || repositoryError) return;
    if (board && !changed) return onClose();
    if (retiredBy && !confirmed) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
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
              ...(normalizedDescription !== board.description && {
                description: normalizedDescription,
              }),
              ...(normalizedRepository !== (board.repository ?? "") && {
                repository: normalizedRepository,
              }),
            },
          })
        : await command<BoardRecord>("create_board", {
            name: normalizedName,
            prefix: normalizedPrefix,
            description: normalizedDescription,
            repository: normalizedRepository,
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
      closeDisabled={pending}
      className="board-editor"
      footer={
        <>
          {confirming && retiredBy && (
            <div
              className="discard-bar"
              role="alertdialog"
              aria-label="Use a retired prefix"
            >
              <span>
                {normalizedPrefix}- is a former prefix of {retiredBy.name}.
                Using it here will orphan the old {normalizedPrefix}- task keys:
                links to them will stop opening {retiredBy.name} tasks. Are you
                sure?
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="secondary"
                autoFocus
                onClick={() => setConfirming(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void save(undefined, true)}
              >
                Use {normalizedPrefix} anyway
              </button>
            </div>
          )}
          {error && (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={16} />
              <span>
                {error.message} Nothing was saved. Your entries are still here.
              </span>
            </p>
          )}
          <div className="form-actions" hidden={confirming && Boolean(retiredBy)}>
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
            onChange={(event) => {
              setPrefix(event.target.value.toUpperCase());
              setConfirming(false);
            }}
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
        <label className="field" htmlFor={descriptionId}>
          <span className="field-label" id={`${descriptionId}-label`}>
            Description
          </span>
          <textarea
            id={descriptionId}
            aria-labelledby={`${descriptionId}-label`}
            aria-describedby={`${descriptionId}-hint`}
            rows={2}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className="field-hint" id={`${descriptionId}-hint`}>
            Optional. It shows under the board title.
          </span>
        </label>
        <label className="field" htmlFor={repositoryId}>
          <span className="field-label" id={`${repositoryId}-label`}>
            Repository folder
          </span>
          <input
            id={repositoryId}
            aria-labelledby={`${repositoryId}-label`}
            maxLength={1000}
            autoComplete="off"
            spellCheck={false}
            placeholder="/Users/you/projects/app"
            value={repository}
            aria-invalid={attempted && Boolean(repositoryError)}
            aria-describedby={`${repositoryId}-hint${attempted && repositoryError ? ` ${repositoryId}-error` : ""}`}
            onChange={(event) => setRepository(event.target.value)}
          />
          <span className="field-hint" id={`${repositoryId}-hint`}>
            Optional. When you assign a task on this board to an agent
            configured on the Agents page, the desktop app starts that agent
            here without asking for approvals. Leave empty to start agents by
            hand.
          </span>
          {attempted && repositoryError && (
            <span className="field-hint inline-error" id={`${repositoryId}-error`}>
              {repositoryError}
            </span>
          )}
        </label>
      </form>
    </Dialog>
  );
}
