# Views contract

A view is a saved set of task filters and display settings with a name, like
Linear's custom views. It is a live query: its tasks change as tasks change.

## Records

A view is `{ id, name, description, color, owner, shared, filters, display,
version, createdAt, updatedAt, favorite }`. IDs are `VIEW-<n>`, allocated in
creation order and never reused. `name` is 1–80 characters after trimming.
`description` is Markdown, up to 20,000 characters. `color` follows the
[epic colour rules](epics.md). `owner` is the actor that created the view and
does not change. `favorite` is the reader's own star, not a shared property.

`filters` is `{ query, conditions }`. `query` (up to 300 characters, trimmed)
matches task ID, title, and description, like the search box. `conditions` is
up to 20 `{ field, op, values }` entries, and a task must satisfy all of them:

- `field` is `role`, `lane`, `priority`, `assignee`, `label`, or `epic`.
- `op` is `is` (the task has any of the values) or `is_not` (it has none).
- `values` is 1–50 values, de-duplicated after normalising. Lane roles,
  lanes, and priorities use their IDs. A lane of any board is valid
  (`NOT_FOUND` for an unknown lane). See the [lanes contract](lanes.md). Labels are trimmed. Epics are epic IDs.
  `""` means none: unassigned, no labels, or no epic.
- The assignee value `@me` stands for the actor reading the view. One shared
  "My open reviews" view shows each person their own tasks.

`display` is `{ layout, groupBy, orderBy }`: `layout` is `board` or `list`;
`groupBy` is `lane`, `assignee`, `priority`, `epic`, or `none`, and applies to
the list layout (the board always has the lanes of the selected board as
columns); `orderBy` is `created`,
`updated`, `priority`, or `title`. Omitted display fields take the defaults
`board`, `lane`, `created`.

`server/views.mjs` is the one implementation of matching and ordering. The
store uses it for `list_tasks({ view })`, and the web interface uses it for
the live board.

## Visibility

A shared view (`shared: true`) is a workspace view: every actor can read it.
A personal view is visible only to its owner. To anyone else it does not
exist, and every command that names it fails with `NOT_FOUND`.

## Commands

- `list_views({})` returns `{ views }` in creation order: shared views and the
  reader's personal views.
- `create_view({ name, description?, color?, shared?, filters?, display? })`
  returns the new view. It is personal unless `shared` is `true`.
- `update_view({ id, expectedVersion, patch })` changes `name`, `description`,
  `color`, `shared`, `filters`, or `display`. `filters` and `display` are
  replaced whole. A stale version fails with `VERSION_CONFLICT`. Any person
  may edit a shared view. Only the owner may change `shared`
  (`FORBIDDEN` otherwise).
- `delete_view({ id, expectedVersion })` removes the view and every actor's
  star on it, and returns `{ id, deleted: true }`. Tasks are not changed.
- `favorite_view({ id, favorite })` stars or unstars a view for the caller. It
  does not change the view's version or append an event.
- `list_tasks({ view })` applies a view's filters for the caller, together
  with any other `list_tasks` filters.

Filters may name only existing epics (`NOT_FOUND` otherwise). Archived epics
stay valid. Only humans create, edit, delete, or star views (`FORBIDDEN`
otherwise). Agents read shared views and list their tasks.

## Storage and audit

Migration 7 adds a `views` table and a `view_favorites(actor, view_id)` table.
Existing tasks are not touched. View writes append events (`created`,
`update_view`, `delete_view`) whose subject ID is the view ID. The deletion
event's body is the view as it was. `workspace_info` and `export_workspace`
report `schemaVersion: 18` since [lanes](lanes.md). The export includes every view (personal ones too,
since exports are human-only backups) and `viewFavorites`.

MCP exposes `list_views` to agents. WebMCP exposes `list_views` and
`create_view` to the signed-in browser user.

## Interface

Every task page has a filter bar of condition chips. Click a chip's operator to
switch between is and is not, or its values to change them. Group (list only) and
Order sit beside the Board and List tabs. **Save as view** (⌥/Alt V) turns
the current page into a view. The page scope becomes conditions: My tasks
becomes `assignee is @me`, and an epic page becomes `epic is <id>`.
Opening a view loads its settings into the page. The selected board limits its
tasks; switching boards keeps task keys tied to their owning board. Changing them shows an
unsaved-changes bar with Reset, Save as new view, and Save view. Leaving the
view drops its settings. Starred views are listed under Favorites in the
sidebar with their live task counts.

Not implemented: changing a view's owner, notifications when tasks enter a
view, and team-scoped views (a workspace has no teams).
