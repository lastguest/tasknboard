# Live updates contract

The server tells open clients when the database changed. Clients then read
again with the normal commands. The stream carries no task data.

## Stream

`GET /api/stream` uses the same bearer token and host checks as the other
`/api` routes. A missing or wrong token fails with `401`. Other methods fail
with `405`.

The response is `text/event-stream` with `Cache-Control: no-cache` and
`X-Accel-Buffering: no`. The server writes:

- `: connected` once, when the stream opens.
- `event: change` with `data: {}` when the database changed.
- `: ping` every 25 seconds.

A `change` event says only that something changed. The client decides what
to read. The server removes the subscriber when the connection closes.

## Change detection

`server/changes.mjs` holds one change feed for each server, not one for each
client. It reads `store.dataVersion()` every 500 ms. The value combines
SQLite `data_version`, which changes on commits from other connections, and
`total_changes()`, which changes on writes from the store's own connection.
So writes from local MCP and CLI processes on the same file are seen.

The HTTP adapter also checks the feed after each successful command. A write
from the browser therefore produces an event at once, not at the next poll.
The feed sends at most one event every 250 ms. A change inside that gap
produces one trailing event.

## Client

`subscribeChanges(onChange, signal)` in `src/api.ts` reads the stream with
`fetch`, because `EventSource` cannot send the `Authorization` header. It
calls `onChange` when the stream opens, on each `change` event, and when an
open stream is lost. It reconnects after 1 s, then doubles the wait up to
30 s. A successful open resets the wait. No bytes for 60 s close the
connection and start a reconnect.

`src/App.tsx` refreshes 150 ms after the last `onChange` call. It closes the
stream while `document.hidden` is true. When the tab becomes visible, it
refreshes at once and opens the stream again. A new token from Settings
starts a new stream. There is no periodic refresh.

Lease expiry changes no data, so no event announces it. The interface
renders again at the next lease expiry of a loaded task.

## Transport

The desktop webview loads the interface from the local service, and the iOS
webview loads it from the saved HTTPS server. Both use the same origin, so
the stream needs no proxy and no CORS. The Vite development proxy passes the
stream through unbuffered. A reverse proxy in front of a shared server must
not buffer `text/event-stream` responses and must allow idle times over 25 s.
