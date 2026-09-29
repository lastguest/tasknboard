# TasknBoard 0.1 — executable foundation

A small-team task manager, with humans and coding agents using one application core.

## Boundaries

React/Vite → HTTP adapter → commands + domain validation → SQLite.
MCP stdio → same commands locally OR authenticated HTTP commands remotely.
No business rules in React or MCP. Node 24 SQLite, WAL, versioned migrations,
transactional writes, per-task optimistic concurrency, auditable events.
One workspace per database/server. No external AI service, Redis or ORM.

## Persistence modes

Local: web UI and local service, one SQLite file; MCP opens that same absolute
file (separate processes, SQLite serializes transactions). Works without internet.
Centralized: one service is the writer authority; agent stdio bridges use
TASKNBOARD_SERVER_URL and personal TASKNBOARD_TOKEN. Browser authenticates with a human
bearer token in sessionStorage. No offline replica or silent fallback when disconnected.
Desktop: Tauri starts the bundled Node service on an available loopback port.
The webview loads the interface from that service, so assets and API calls share
one origin. The service uses SQLite in the application data directory.
The Rust host owns the service lifecycle. Domain rules stay in the existing Node core.
The packaged runtime removes the need for a separate Node installation.
iOS: the Tauri shell is a client for a centralized server. A bundled setup page
saves one HTTPS server origin, checks that it responds, and loads it in the webview.
The webview stays on that origin and opens other links in the system browser.
The shell injects `window.tasknboardShell.changeServer()`. Settings uses it to
return to the setup page. Remote pages have no Tauri IPC access.

CLI: `server/client.mjs` owns the choice between the local store and the
authenticated HTTP API. MCP and the terminal client both use it. The CLI is an
Ink interface in `cli/`: pure command planning (`commands.ts`), a line editor
(`editor.ts`), and the view (`App.tsx`). It holds no business rules. Each write
sends the last read version, and the CLI never retries a rejected write.
Task text is stripped of control characters before it reaches the terminal.

## Agent lifecycle

List → get → claim (expected version, 15-minute lease) → heartbeat → update /
comment → submit_review (summary + artifact URL) → human review → done.
Claim is atomic inside BEGIN IMMEDIATE. Every mutation increments the task
version. The actor is derived from configuration/authentication, not a tool
argument. An agent can only edit a task with its own unexpired lease. A review
submission releases the lease. Agents cannot mark work done. Human writes are
also blocked by another actor's active lease, except the narrowly scoped human
`set_standup_notes` command, which annotates without changing execution ownership. Expired leases can be reclaimed.
Heartbeat is a task write: use the returned version in your next command.

## Scope and follow-up

Implemented: task CRUD (archive rather than delete), filters, board/list,
keyboard shortcuts, persisted comments/events, MCP tools, lease coordination,
version conflicts, minimal actor tokens, server polling, backup export.
Not implemented: organization membership UI, OAuth/SSO, remote Streamable HTTP
MCP endpoint, granular per-project roles, offline replica sync, notification
service, general attachments (only description images are stored), dependencies, custom workflows.
Remote MCP currently means a local stdio bridge to the shared authenticated API.
For public deployment, terminate HTTPS and configure tokens. Token rotation is
by process configuration. Database must be on local disk, not NFS.

## Visual system

Reference: generated TasknBoard full-screen concept. Charcoal #111214, sidebar
#17181b, surfaces #1b1d20, border #2b2d32, mint #9de3c1, system sans.
220px navigation, 4-column kanban, quiet footer, restrained 8px radii.
Native buttons, select inputs and dialog semantics. Task detail extends this
system with a side inspector. No fake operating-system traffic-light buttons.

## Stand-up presentation

`src/Standup.tsx` composes the shared board in presentation mode. It owns only
the selected speaking turn, talking-point filter, fullscreen state and note dialog.
The ordinary application retains its navigation/filter state while presentation
is mounted. Participant order is frozen on entry; task data remains live.
The shared Board hides creation controls and disables drag/drop in this mode.
Highlights and blockers are optional task metadata, validated and audited by the
same transactional store; exposed through HTTP and MCP as `set_standup_notes`.

## Task metadata

The [task metadata contract](contracts/task-metadata.md) defines the server actor
roster and derived comment counts. SQLite stores explicit actor kinds; assignee
names remain free text. The UI never guesses kinds from names or claims.
Comment counts come from persisted comment events. Existing version, lease,
and authorization checks still apply.

## Boards

The [boards contract](contracts/boards.md) makes a board the container of tasks
and epics. The board ID is the task ID prefix, and each board keeps its own task
counter. `showInSidebar` is a shared board setting that the UI reads to fill
the sidebar Boards section. Only humans manage boards.

## Epics

The [epics contract](contracts/epics.md) groups tasks into projects. A task has
at most one epic. Epic counts are derived from tasks when read. Only humans
manage epics, and an epic with open work cannot be archived.

The UI loads WebMCP validation only when the browser exposes
`document.modelContext`. Ordinary browsers do not download that chunk. Polling
pauses while the document is hidden and resumes with an immediate refresh.
