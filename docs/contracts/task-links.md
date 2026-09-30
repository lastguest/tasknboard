# Task links contract

A link records how two tasks relate. Links inform people and agents.
The server does not use them to accept or reject a status change.

## Types

Each link is read from one task's side. The other task reads the inverse type.

| Type | Inverse |
| --- | --- |
| `relates` | `relates` |
| `blocks` | `blocked_by` |
| `duplicates` | `duplicated_by` |

Two tasks have at most one link. A task cannot link to itself.

## Commands

- `link_task({ id, expectedVersion, type, target })` links task `id` to
  `target`. `type` is one of the five types above, read from `id`'s side.
  A second link between the same two tasks fails with `LINK_EXISTS`.
  An archived target fails with `ARCHIVED`.
- `unlink_task({ id, expectedVersion, target })` removes the link between the
  two tasks, in either direction. A missing link fails with `NOT_FOUND`.

Both commands are writes on task `id`. They need its current version and
follow the normal lease rules: an agent needs its own active claim, and
another actor's active claim blocks a human. `target` accepts a former key.

The write advances the version of task `id` only. Each task appends one
event, `link_task` or `unlink_task`, with body `{ type, target }` read from
that task's side. The target keeps its version, so a link never invalidates
a draft on the other task.

## Reads

`get_task` and every task write return `links`:
`{ type, id, title, status, archived }[]`, ordered by type and then key.
`id` is the other task's current key. `list_tasks` does not return links.
Links to archived tasks stay and carry `archived: true`.

## Storage

Migration 14 adds `task_links(from_number, to_number, kind)`. Rows use task
row numbers, so a board prefix change keeps every link. `kind` stores only
`relates`, `blocks`, and `duplicates`; `blocked_by` and `duplicated_by` are
stored in the other direction. `workspace_info` and `export_workspace` use
`schemaVersion: 14`. The export lists `taskLinks: { source, type, target }[]`.

## Interfaces

The task details panel lists links under **Links**. A link opens the other
task in a tab. The picker offers the loaded board's tasks. MCP, WebMCP, and
the HTTP API accept tasks on any board. The CLI adds `/link <type> <task id>`
and `/unlink <task id>`, and shows links in the task detail.
