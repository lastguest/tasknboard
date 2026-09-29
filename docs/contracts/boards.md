# Boards contract

A board is a task container. Every task and every epic belongs to exactly one
board. The board ID is the prefix of its task IDs.

## Records

A board is `{ id, title, showInSidebar, version, createdAt, updatedAt, counts }`.
`id` is 2–10 capital letters or digits and starts with a letter, for example
`TNB` or `WEB2`. It is set at creation and never changes, because task IDs
contain it. `title` is 1–120 characters after trimming. `showInSidebar` tells
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
- `create_task({ board, ... })` requires `board`. An unknown board fails with
  `NOT_FOUND`.
- `list_tasks({ board? })` and `list_epics({ board? })` filter by board.

Only humans create or update boards (`FORBIDDEN` otherwise). Agents read boards
and create tasks on any board. Boards are not archived or deleted.

## Storage and audit

Migration 7 adds a `boards` table with a per-board task counter. It creates
board `TNB` ("Studio") and moves every existing task and epic onto it without
changing their IDs, versions or activity. A new workspace also starts with
board `TNB`. Board writes append events (`create_board`, `update_board`) whose
subject ID is the board ID. `workspace_info` and `export_workspace` report
`schemaVersion: 7`, and the export includes every board.

MCP exposes `list_boards` to agents. WebMCP exposes `list_boards` to the
signed-in browser user.
