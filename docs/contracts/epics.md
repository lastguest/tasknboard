# Epics contract

An epic is a project: a named folder of tasks. A task belongs to at most one epic.

## Records

An epic is `{ id, board, title, description, color, version, archived, createdAt, updatedAt, counts }`.
`board` is the ID of the board that holds the epic; see the
[boards contract](boards.md). `id` is a codename. The creator can choose it,
for example `Q3-LAUNCH`: up to 32 capital letters or digits, in groups joined
by single hyphens. A codename cannot look like a task ID (`WEB-12`), and
`EPIC-<n>` is kept for the server. Without a codename the server allocates
`EPIC-<n>`. IDs are unique in the workspace, never change and are never
reused. A used codename fails with `EPIC_EXISTS`. `title` is
1–120 characters after trimming. `description` is Markdown, up to 20,000
characters, rendered with the same rules as task descriptions. `color` is a
palette name (`aurora`, `lagoon`, `cobalt`, `iris`, `orchid`, `flamingo`,
`coral`, `tangerine`, `saffron`, `lime`, `jade`, `glacier`) or a custom
`#rrggbb` value, stored lowercase. The UI owns the palette's hex values. A new
epic without a color takes the next palette color in creation order. `counts` maps
each status to the number of non-archived tasks in the epic. Counts are
derived from tasks when read; they are not stored.

Tasks carry `epic: string`: an epic ID, or `""` for no epic. It appears in
create, update, list, detail, and export responses. New tasks default to `""`.

## Commands

- `list_epics({ board?, includeArchived? })` returns `{ epics }` in creation
  order. Archived epics are left out unless `includeArchived` is `true`.
- `create_epic({ board, id?, title, description?, color? })` returns the new
  epic.
- `update_epic({ id, expectedVersion, patch: { title?, description?, color? } })`
  uses the same version check as tasks. A stale version fails with
  `VERSION_CONFLICT`.
- `archive_epic({ id, expectedVersion })` hides the epic. It fails with
  `EPIC_NOT_EMPTY` while any non-archived task in it is not Done. Done and
  archived tasks keep their `epic` value, so history still names the project.
- `list_tasks({ epic })` accepts an epic ID, or `"none"` for tasks without one.
- `create_task({ epic })` and `update_task({ patch: { epic } })` accept an epic
  ID or `""`. Unknown IDs fail with `NOT_FOUND`. An epic on another board
  fails with `EPIC_BOARD_MISMATCH`. Assigning a task to an
  archived epic fails with `EPIC_ARCHIVED`. A task already in an epic that
  was later archived keeps it through unrelated edits.

Only humans create, update, or archive epics (`FORBIDDEN` otherwise). Agents
read epics and may set `epic` in `create_task` and on tasks they have claimed,
under the normal lease rules. Moving a task between epics is a task write: it
needs the task's version and respects another actor's active lease.

## Storage and audit

Migration 6 adds an `epics` table and sets `epic: ""` on existing tasks without
changing their versions or activity. Epic writes append events (`created`,
`update_epic`, `archive_epic`) whose subject ID is the epic ID. Task activity
never includes them. Migration 7 adds boards; see the [boards contract](boards.md).
`workspace_info` and `export_workspace` report
`schemaVersion: 7`, and the export includes every epic, including archived ones.

MCP exposes `list_epics` to agents. WebMCP exposes `list_epics` and
`create_epic` to the signed-in browser user.
