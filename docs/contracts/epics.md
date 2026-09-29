# Epics contract

An epic is a project: a named folder of tasks. A task belongs to at most one epic.
The interface identifies each epic by its custom name. Create or change that
name on the epic page. Internal IDs connect records; they are not epic names.

## Records

An epic is `{ id, title, description, color, version, archived, createdAt, updatedAt, counts }`.
Internal IDs are allocated once and never reused. `title` is
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

- `list_epics({ includeArchived? })` returns `{ epics }` in creation order.
  Archived epics are left out unless `includeArchived` is `true`.
- `create_epic({ title, description?, color? })` returns the new epic.
- `update_epic({ id, expectedVersion, patch: { title?, description?, color? } })`
  uses the same version check as tasks. A stale version fails with
  `VERSION_CONFLICT`.
- `archive_epic({ id, expectedVersion })` hides the epic. It fails with
  `EPIC_NOT_EMPTY` while any non-archived task in it is not Done. Done and
  archived tasks keep their `epic` value, so history still names the project.
- `list_tasks({ epic })` accepts an epic ID, or `"none"` for tasks without one.
- `create_task({ epic })` and `update_task({ patch: { epic } })` accept an epic
  ID or `""`. Unknown IDs fail with `NOT_FOUND`. Assigning a task to an
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
never includes them. `workspace_info` and `export_workspace` reported
`schemaVersion: 6` (7 since [views](views.md)), and the export includes every
epic, including archived ones.

MCP exposes `list_epics` to agents. WebMCP exposes `list_epics` and
`create_epic` to the signed-in browser user.

## Names and internal IDs

Create or edit an epic on its page. The interface displays its custom name.
Internal epic IDs connect tasks and saved filters. The interface has no epic
prefix setting. Task prefixes belong to [boards](boards.md).
