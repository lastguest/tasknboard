# Boards contract

A board is a task container. Every task and every epic belongs to exactly one
board. The board ID is the prefix of its task IDs.

## Records

A board is `{ id, title, showInSidebar, formerIds, version, createdAt, updatedAt, counts }`.
`id` is 2–10 capital letters or digits and starts with a letter, for example
`TNB` or `WEB2`. `EPIC` is reserved. Only `rename_board` changes it.
`formerIds` lists the old IDs that still redirect to the board. `title` is 1–120 characters after trimming. `showInSidebar` tells
the UI to list the board in the sidebar Boards section. The default is `true`.
The setting is shared by the workspace, not stored per person. `counts` maps
each status to the number of non-archived tasks on the board. Counts are
derived from tasks when read.

Task IDs are `<board>-<n>`, with `n` padded to three digits (`WEB-001`).
Each board numbers its own tasks from 1. Numbers are never reused. Tasks carry
`board: string`. A task cannot move to another board.

Epics carry `board: string`. A task can join only an epic on its own board;
otherwise the write fails with `EPIC_BOARD_MISMATCH`. An epic cannot move to
another board.

## Commands

- `list_boards({})` returns `{ boards }` in creation order.
- `create_board({ id, title, showInSidebar? })` returns the new board. A used
  ID fails with `BOARD_EXISTS`.
- `update_board({ id, expectedVersion, patch: { title?, showInSidebar? } })`
  uses the same version check as tasks. A stale version fails with
  `VERSION_CONFLICT`.
- `rename_board({ id, expectedVersion, newId })` changes the board ID and
  moves every task on the board to the new prefix: `WEB-001` becomes
  `SITE-001`. Numbers, epics and task history move with them. Each task gets
  a new version and a `rename_board` event with `{ from, to }`. The rename
  fails with `LEASE_CONFLICT` while any task on the board has an active claim,
  and with `BOARD_EXISTS` if a board holds `newId`. Text that names old IDs
  does not change.
- `create_task({ board, ... })` requires `board`. An unknown board fails with
  `NOT_FOUND`.
- `list_tasks({ board? })` and `list_epics({ board? })` filter by board.

## Redirects

After a rename, the old ID redirects to the new one. Every command that takes
a task ID or a board ID accepts the old form and acts on the renamed record:
`get_task({ id: "WEB-001" })` returns `SITE-001`, and `create_task({ board:
"WEB" })` creates a `SITE` task. Results always carry the current IDs.
Redirects are one hop: renaming `SITE` to `HOME` makes `WEB` and `SITE` both
point to `HOME`. A redirect ends when a board takes its ID again, through
`create_board` or `rename_board`. The new board then starts its own numbering
at 1.

Only humans create, update or rename boards (`FORBIDDEN` otherwise). Agents read boards
and create tasks on any board. Boards are not archived or deleted.

## Storage and audit

Migration 7 adds a `boards` table with a per-board task counter. It creates
board `TNB` ("Studio") and moves every existing task and epic onto it without
changing their IDs, versions or activity. A new workspace also starts with
board `TNB`. Board writes append events (`create_board`, `update_board`,
`rename_board`) whose subject ID is the board ID. Migration 8 adds the
`board_redirects` table. `workspace_info` and `export_workspace` report
`schemaVersion: 8`, and the export includes every board and `boardRedirects` as
`{ fromId, toId }` rows.

MCP exposes `list_boards` to agents. WebMCP exposes `list_boards` to the
signed-in browser user.
