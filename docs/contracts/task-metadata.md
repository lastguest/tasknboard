# Task metadata contract

This contract defines the TODO changes before backend implementation.

## Actor identity

`workspace_info` returns `actors: { id: string, kind: "human" | "agent" }[]`.
The server stores known actors in SQLite. HTTP configuration and local MCP
configuration register explicit identities. Authenticated command actors also
register their identity. Tokens never enter this roster or the database.

An actor ID identifies one kind. A conflicting kind must fail explicitly.
The roster persists across connections and restarts. It describes known
identities, not active sessions, membership, or connection status.

Task assignees remain free text. The UI identifies an agent only when its exact
assignee ID matches an agent in the roster. Unknown assignees remain neutral.
Names and lease ownership must not determine actor kind.

`export_workspace` includes the actor roster. `workspace_info` and exports use
`schemaVersion: 20`. Version 20 removes obsolete rejected lanes and archives their tasks in [lanes](lanes.md).

Task reads include `archiveCategory`: `archived`, `rejected`, or `null` for active tasks.
The latest `archive_task` or `reject_task` event supplies the category.
Restore clears the displayed category. A later archive action supplies a new category.
The task keeps its saved lane for restore. Archive categories are not lane roles.
Version 18 added lanes. Version 17 added the [Inbox](inbox.md) read positions.
Version 16 moved embedded images to storage. Version 15 renamed task keys to their board prefix.
Version 14 added [task links](task-links.md). Version 13 added board descriptions.
Version 12 added board sidebar choices. Version 11 added [boards](boards.md).
Version 7 added views. Version 6 added epics. Version 5 added description images.
No workspace import or workspace restore command is added.

## Comment counts

Every task returned by `list_tasks`, `get_task`, or a mutation includes
`commentCount`, a nonnegative integer. It counts persisted `add_comment` events
for that task. Other activity does not count. Rejected writes do not count.

Counts are derived from events, not duplicated in task JSON. List reads obtain
counts in a bounded query, without loading full event histories per task.
Detail responses and mutation responses agree with the list response.

## Existing rules

All writes retain version checks, lease checks, and server authorization.
This change adds no commands and no task restoration.
Existing task and event records remain intact.

## Labels

Tasks use `labels: string[]` in create, update, list, detail, and export responses.
Each label contains 1–40 characters after trimming. Duplicate labels are removed.
An empty array clears the labels. New tasks start with no labels.
The old `label` command field is rejected. Stored single labels convert once to
arrays when the database opens. Task versions and activity remain unchanged.
A task is in one lane of its board at a time.

`list_labels({})` returns `{ labels: { name, tasks }[] }`: every label on a
non-archived task, sorted by name, with how many such tasks carry it.

`rename_label({ from, to })` replaces `from` with `to` on every non-archived
task; renaming into an existing label merges the two, and `to: ""` removes the
label. People and agents may both call it. It is a workspace-wide edit, so it
takes no `expectedVersion` and ignores claims, but each changed task advances
its version and records a `rename_label` event with `{ from, to }`; open drafts
and lease holders see the usual version conflict. Saved views whose label
conditions name `from` follow a rename the same way. A removal leaves views
unchanged, so a view never widens to match more tasks. Archived tasks keep
their labels. It returns `{ from, to, tasks, views }`, the counts changed.
`from` and `to` must differ.

## Profiles

Roster entries also carry `name` and `avatar`, both empty strings by default.
`update_profile({ name?, avatar? })` edits only the calling actor's own entry and
returns it; the actor ID never changes, so assignees, leases, and events keep
using IDs. `name` is trimmed, up to 80 characters. `avatar` is empty or a PNG,
JPEG, or WebP base64 data URL of at most 48,000 characters; the UI crops and
re-encodes uploads to 128px JPEG before sending. Remote URLs and SVG are rejected.
The UI shows the name in place of the ID wherever a known actor appears, and
coloured initials when no picture is set. Migration 4 adds both columns.

## Rich descriptions

`description` stays a plain string, stored and returned as Markdown source.
Agents read and write the same text. The UI renders headings, emphasis,
strikethrough, links, inline and fenced code, quotes, nested and ordered lists,
task lists, tables, dividers and images. Rendering builds React elements; raw
HTML stays literal text. Links allow only `http`, `https`, and `mailto`. Images
load only from `/files/<id>`; other image URLs become plain links. Ticking a
task-list box in Preview edits the draft; it is saved with the normal version check.

`upload_image({ data })` accepts a PNG, JPEG, WebP, or GIF data URL up to 5 MB of
decoded bytes and returns `{ id, url, mime, bytes }`. The server checks the file
signature against the declared type. SVG is rejected. Images are stored in the
`images` table (migration 5) and are not tied to a task. `GET /files/<id>`
serves them with `Content-Security-Policy: sandbox` and `nosniff`. The route
needs no token, so `<img>` tags work: the 128-bit random ID is the capability.
Anyone holding the URL can view the image. `export_workspace` includes every
image as base64. Images are not deleted when a description stops using them.

Image data embedded in Markdown, as in `![alt](data:image/png;base64,…)`, is
saved the same way. Any command text (descriptions, acceptance, comments,
review summaries, epic descriptions) has such targets stored in `images` and
rewritten to `/files/<id>` before validation, so task data and activity history
never hold the bytes. Identical data in one command is stored once. Data that
fails the signature check rejects the command with `VALIDATION`; a command that
fails removes the images it stored. Profile avatars stay data URLs. Migration
16 moves embedded image data already saved in tasks, epics and activity into
`images`; invalid data is left as written. In the editor, pasted HTML with
embedded images keeps its plain text and uploads each image.
