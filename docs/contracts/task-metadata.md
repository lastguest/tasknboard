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
`schemaVersion: 3` for this contract. No import or restore command is added.

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
An empty array clears the labels. New tasks default to `["Product"]`.
The old `label` command field is rejected. Stored single labels convert once to
arrays when the database opens. Task versions and activity remain unchanged.
Status remains a single workflow state.
