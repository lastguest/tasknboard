# TasknBoard 0.1 — executable foundation

A small-team task manager, with humans and coding agents using one application core.

## Boundaries

React/Vite → HTTP adapter → commands + domain validation → SQLite.
MCP stdio → same commands locally OR authenticated HTTP commands remotely.
No business rules in React or MCP. Node 24 SQLite, WAL, versioned migrations,
transactional writes, per-task optimistic concurrency, auditable events.
One workspace per database/server, with separate boards. Each board owns a task
prefix and number sequence. Each task belongs to one board. No external AI service, Redis or ORM.

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
comment → update_task (done lane), or submit_review (summary + artifact URL)
→ human review → done.
Each board has its own [lanes](contracts/lanes.md). The flow reads lane roles
(todo, in_progress, in_review, done), not lane names.
Claim is atomic inside BEGIN IMMEDIATE. Every mutation increments the task
version. The actor is derived from configuration/authentication, not a tool
argument. An agent can only edit a task with its own unexpired lease. A review
submission or direct completion releases the lease. Agents can move their
claimed task to a done lane of its board with `update_task`. Human writes are
also blocked by another actor's active lease, except the narrowly scoped human
`set_standup_notes` command, which annotates without changing execution ownership. Expired leases can be reclaimed.
Heartbeat is a task write: use the returned version in your next command.

## Agent settings

The [agent settings contract](contracts/agent-settings.md) describes how the
desktop app starts agent CLIs. `server/agent-config.mjs` owns the supported
CLIs, the events, and validation. `server/agent-launcher.mjs` queues one run per
agent. Settings live in the internal `settings` table, so exports never include
them. Shared servers return no settings and start no agents.

## Scope and follow-up

Implemented: task CRUD (archive rather than delete), filters, board/list,
keyboard shortcuts, persisted comments/events, MCP tools, lease coordination,
version conflicts, minimal actor tokens, live updates, backup export.
Not implemented: organization membership UI, OAuth/SSO, remote Streamable HTTP
MCP endpoint, granular per-project roles, offline replica sync, external
notifications (email, push), general attachments (only description images are stored), enforced
dependencies (task links do not block lane changes), lane transitions beyond the four roles.
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

## Epics

The [epics contract](contracts/epics.md) groups tasks into projects. A task has
at most one epic. Epic counts are derived from tasks when read. Only humans
manage epics, and an epic with open work cannot be archived.

## Task links

The [task links contract](contracts/task-links.md) relates two tasks:
relates, blocks, or duplicates. A link is a versioned write on one task.
Links inform; the server does not block lane changes because of them.

## Similar tasks

The [similar tasks contract](contracts/similar-tasks.md) warns about possible
duplicates before a task is created. `server/similarity.mjs` holds the pure
trigram and Jaccard scoring. The store scans non-archived tasks in memory, with
no index. `find_similar_tasks` is a read. MCP agents call it before
`create_task`. The New task dialog lists matches but never blocks a create.

## Task references

The [task references contract](contracts/task-references.md) turns a task key
in rendered Markdown into a chip with the current status of the task. A pure
function recognizes keys with known board prefixes. The `get_tasks` command
reads the cited tasks in one batch. The application refresh reads them again.

## Views

The [views contract](contracts/views.md) saves task filters and display
settings under a name. `server/views.mjs` holds the only matching and ordering
rules. The store applies them in `list_tasks({ view })`, and the interface
applies them to the live board, so both agree. Workspace views are shared.
Personal views exist only for their owner. Stars are per person and are not
versioned.

The UI loads WebMCP validation only when the browser exposes
`document.modelContext`. Ordinary browsers do not download that chunk.

## Live updates

The [live updates contract](contracts/live-updates.md) replaces browser
polling. `GET /api/stream` sends an event when the database changes.
One change feed per server reads the SQLite data version, so writes from
local MCP and CLI processes count too. The stream carries no data: the
client reads again with the normal commands. The stream closes while the
document is hidden and reopens with an immediate refresh.

## Inbox

The [inbox contract](contracts/inbox.md) lists comments, mentions and review
submissions by others that concern the reader. Items derive from `events`
when read; nothing is copied. Each actor has one read cursor in
`inbox_cursors`. Marking read is not a task write, and exports omit cursors.

## GitHub pull requests

The [GitHub integration contract](contracts/github.md) describes the read-only
Pull requests section. `server/github.mjs` calls GitHub from the service.
The browser never holds the GitHub token. These commands are asynchronous and
are separate from the synchronous store. They use no task version or event.
The store only saves the token in its internal `settings` table.
