# Inbox contract

The Inbox tells the connected actor when work waits for them.
It lives only in the application. It sends no email and no push notification.

## Items

Items derive from the `events` table on every read. No event is copied.
An item is an event by another actor that concerns the reader.
The reader's own events never appear.

| Event kind | Reason | Who receives it |
| --- | --- | --- |
| `add_comment` | `mention` | Each actor written as `@<actorId>` in the body |
| `add_comment` | `comment` | The task's creator and assignee, if not mentioned |
| `submit_review` | `review` | The task's creator and assignee |

Each event gives at most one item. A mention wins over `comment`.
Mentions use `mentionedIdentities` in `server/agent-config.mjs`, the same
parser that starts agents. The match is exact on the actor ID.

The creator is the actor of the task's `created` event. Tasks store no
creator field. The assignee is the task's current `assignee` value. It is
free text, so it matches only an identical actor ID.

A review on a task whose creator and assignee are both not known humans
goes to every human in the roster. An agent can create a task and claim
it, so the review would otherwise reach no person. "Known human" means a
roster entry of kind `human`.

The rules use event kinds only. They do not read task status, so custom
workflow states do not change them. Archived tasks give no items.

## Commands

- `list_inbox({ limit? })` returns
  `{ items: [{ sequence, taskId, taskTitle, actor, kind, reason, excerpt, createdAt }], unread }`.
  Items are newest first. `limit` is 1–100, default 50.
  `taskId` and `taskTitle` are the task's current values.
  `excerpt` is the comment body or the review summary, with whitespace
  collapsed, at most 160 characters.
  `unread` counts every item with a sequence above the read cursor, also
  items beyond `limit`. So the first `unread` items in the list are unread.
- `mark_inbox_read({ upTo })` sets the reader's cursor to `upTo`, an event
  sequence. It returns `{ sequence, unread }` with the stored cursor.
  The cursor is monotonic: a lower value leaves it unchanged.
  An `upTo` above the latest event sequence fails with `VALIDATION`.
  It is not a task write: no task version changes and no event is added.

People and agents can call both commands through HTTP at `/api/<command>`.
Agents get no MCP tool for them.

## Interface

The sidebar shows Inbox with a badge for the unread count. The page lists
who, what, the task key and title, and the relative time. A click opens the
task. Opening the page or a task marks nothing read. Mark all read sends the
newest listed sequence, so items that arrive later stay unread. The page
updates with the application's normal refresh.

## Storage

Migration 17 adds `inbox_cursors(actor TEXT PRIMARY KEY, sequence INTEGER NOT NULL)`.
An actor without a row has cursor 0, so all their items are unread.
`export_workspace` does not include cursors. They are personal read state,
not workspace data, and the export schema version does not change.
