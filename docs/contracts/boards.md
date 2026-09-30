# Boards contract

Boards group tasks and own task keys. Epics and saved views remain workspace-level records.

## Board records

Each board has this shape:

```ts
type Board = {
  id: `BOARD-${number}`;
  name: string;
  prefix: string;
  /** Retired prefixes of this board, derived from the prefix reservations. */
  formerPrefixes: string[];
  /** Whether the caller lists this board in the sidebar. */
  inSidebar: boolean;
  /** Tasks In progress on this board, without archived tasks. */
  inProgress: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

The server exposes these commands:

- `list_boards({})` returns `{ boards }`.
- `create_board({ name, prefix })` creates a board.
- `update_board({ id, expectedVersion, patch })` changes its name or prefix.
- `set_board_sidebar({ id, inSidebar })` shows or hides a board in the caller's sidebar.

Board writes require a human actor. Create and update actions append events under the board ID. Updates require the current version. A stale version returns `VERSION_CONFLICT`.

Names are trimmed and contain 1–80 characters. Prefixes are trimmed, converted to uppercase, and contain 2–10 letters or digits. Prefixes must start with a letter. `EPIC`, `VIEW`, and `BOARD` are reserved. Every board prefix must be unique and must not match a prefix on a stored epic key.

## Sidebar

The sidebar lists each board with its Board, Epics, and Views pages. Every person chooses which boards their sidebar lists. A board shows by default. `set_board_sidebar` stores only the caller's choice, so it requires a human actor. It does not change the board version and does not append an event. Every board result carries `inSidebar` for the caller. Agents always read `true`. A hidden board stays available in the board selector. The browser keeps which board rows are expanded. Each row shows the board's `inProgress` count. The server derives it on every read, so it is not stored and not exported.

## Tasks and keys

`create_task` requires a valid `boardId`. Each task stores that board ID. New task numbers start at `001` on each board and increase within that board. `list_tasks` accepts an optional `boardId`; without it, the server returns tasks from every board.

Changing a board prefix rewrites only task keys on that board and their event task references. The update and all key rewrites commit together. The server reserves every prefix to its original board, so another board cannot reuse it. Its owner can reclaim it. Prefix reservations appear in workspace exports.

A former task key keeps resolving after the rename. Every command that takes a task ID accepts a key with a former prefix of a board. It acts on the task with the same number under the current prefix of that board, and its result carries the current key. A key resolves through one lookup, also after several renames. A key with a prefix that no board ever used returns `NOT_FOUND`. `list_boards`, `workspace_info`, `create_board`, and `update_board` return `formerPrefixes` on each board. Workspace exports do not repeat it, because they include the reservations.

`list_epics` accepts an optional `boardId`. It returns the workspace epics and counts tasks from that board. Without a board ID, counts include tasks from every board. Epic IDs stay internal keys such as `EPIC-1`; the interface owns custom epic names.

## Workspace and export

`workspace_info` returns the board list and schema version `12`. It does not return workspace task or epic prefix settings. `export_workspace` includes all boards, task `boardId` values, board prefix reservations, and `boardSidebarHidden` as `{ actor, boardId }` rows.

The schema upgrade creates `BOARD-1` with the task prefix that was active before the upgrade. It adds `boardId: "BOARD-1"` to stored tasks without changing their task keys, epic IDs, or task-to-epic references. The old workspace prefix settings are then removed from runtime storage. Schema version `12` adds the per-person sidebar choices; every board starts in every sidebar.
