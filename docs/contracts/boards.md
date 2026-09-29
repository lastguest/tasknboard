# Boards contract

Boards group tasks and own task keys. Epics and saved views remain workspace-level records.

## Board records

Each board has this shape:

```ts
type Board = {
  id: `BOARD-${number}`;
  name: string;
  prefix: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

The server exposes these commands:

- `list_boards({})` returns `{ boards }`.
- `create_board({ name, prefix })` creates a board.
- `update_board({ id, expectedVersion, patch })` changes its name or prefix.

Board writes require a human actor. Create and update actions append events under the board ID. Updates require the current version. A stale version returns `VERSION_CONFLICT`.

Names are trimmed and contain 1–80 characters. Prefixes are trimmed, converted to uppercase, and contain 2–10 letters or digits. Prefixes must start with a letter. `EPIC`, `VIEW`, and `BOARD` are reserved. Every board prefix must be unique and must not match a prefix on a stored epic key.

## Tasks and keys

`create_task` requires a valid `boardId`. Each task stores that board ID. New task numbers start at `001` on each board and increase within that board. `list_tasks` accepts an optional `boardId`; without it, the server returns tasks from every board.

Changing a board prefix rewrites only task keys on that board and their event task references. The update and all key rewrites commit together. A former task key does not resolve after the rename. The server reserves every prefix to its original board, so another board cannot reuse it. Its owner can reclaim it. Prefix reservations appear in workspace exports.

`list_epics` accepts an optional `boardId`. It returns the workspace epics and counts tasks from that board. Without a board ID, counts include tasks from every board. Epic IDs stay internal keys such as `EPIC-1`; the interface owns custom epic names.

## Workspace and export

`workspace_info` returns the board list and schema version `11`. It does not return workspace task or epic prefix settings. `export_workspace` includes all boards, task `boardId` values, and board prefix reservations.

The schema upgrade creates `BOARD-1` with the task prefix that was active before the upgrade. It adds `boardId: "BOARD-1"` to stored tasks without changing their task keys, epic IDs, or task-to-epic references. The old workspace prefix settings are then removed from runtime storage.
