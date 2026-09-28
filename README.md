# TasknBoard

A lightweight Kanban workspace for small teams and coding agents. **Version 0.1 is a working foundation**, not a finished Linear replacement.

![Stand-up mode showing the team board](docs/images/tasknboard-standup-team.png)

React + Vite, Node.js, SQLite, a Tauri desktop shell, and an MCP stdio server. One application core owns validation, leases, optimistic concurrency and activity events. No cloud AI dependency.

## Run locally

Requires Node.js **24 or later** and npm. From this directory:

```bash
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4310**. Data is stored in `data/tasknboard.sqlite` by default. No account or internet connection is needed after installing dependencies.

Optional demo tasks, on an empty database:

```bash
npm run seed
```

Development: keep `npm start` running and run `npm run dev` in another terminal; open http://127.0.0.1:5173. The Vite proxy uses the same API. `npm test` runs domain, persistence, MCP protocol and authenticated HTTP tests.

Browser regression tests use Playwright and the production HTTP service:

```bash
npx playwright install chromium
npm run build
npm run test:ui
```

The browser suite creates temporary SQLite files outside `data/` and removes them
when the tests finish. It does not use the user's workspace database.

Keyboard: **N** new task, **Cmd/Ctrl K** search, **F** assignee filter, **?** shortcuts, **Esc** close dialog. Drag between columns, or use the Status menu on each card or list row (the keyboard and touch alternative). Every move is validated by the server; a rejected move stays in place with an explanation. Human review is required before Done: an In review task shows **Mark Done** and **Needs changes** in its details. The interface is English in this version.

Editing uses the task's latest version. If the task changed elsewhere, the save is rejected, your draft is kept, and **Load latest** merges: fields you did not touch take the new values, and fields changed on both sides are highlighted so you can choose. Nothing is retried automatically. Unsaved drafts ask before they are discarded.

## Desktop app

The Tauri app currently builds for macOS on Apple Silicon.
It includes the interface, the service, and a Node runtime.
The installed app does not require Node or a separate server process.
The shell starts its service on an available loopback port and stops it when the app exits.
Desktop data stays in `~/Library/Application Support/app.tasknboard.desktop/tasknboard.sqlite`, outside the app bundle.
The desktop workspace is separate from `data/tasknboard.sqlite` used by the web development server.

Build prerequisites: Node.js 24 or later, npm, Rust, and the platform's
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
On macOS, install the Xcode command line tools.

```bash
npm ci
npm run desktop:dev
```

To build the desktop app:

```bash
npm run desktop:build
```

The first build downloads the Rust dependencies and the pinned official Node 24.14.0 runtime.
Later builds reuse the cached archive and check it against Node's published SHA-256 checksum.
Build on an Apple Silicon Mac. Other platforms are not packaged by this version.
The app requires macOS 13.5 or later.
Packaged output is `src-tauri/target/release/bundle/macos/TasknBoard.app`.
Local builds use ad-hoc signing. They are not notarized for public distribution.

`desktop:dev` rebuilds the interface before launch. Restart it after frontend changes.
Use `npm run dev` for the ordinary web interface with hot reload.

The desktop app uses the same command validation, SQLite store, and task interface as the web app.
For local MCP access, set `TASKNBOARD_DB` to the desktop database's absolute path.
WebMCP tools register only when the embedded webview supports the native browser API.

## Stand-up mode

Use **Stand-up** in the sidebar before sharing the browser tab in Google Meet.
It always opens **Team overview**, ignoring your ordinary search, assignee and My tasks
filters. Sidebar, search, task creation, list toggle and footer are removed. The kanban
uses the available screen, with larger cards and independent column scrolling.

- Move through owners with **← / →**, the previous/next buttons, or the participant selector.
- **Home** returns to the whole team; **Esc** exits (or closes an open task dialog first).
- Use the optional **Fullscreen** control to remove browser chrome where supported.
- Highlight and Blocker filters apply to the current turn and reset on a participant change.
- Click a card to add or clear short highlight/blocker notes. Notes persist on tasks until
  explicitly cleared; they are not automatically reset each day.
- Blocked cards sort first within their status column, then highlighted cards. All statuses,
  including Done and Backlog, remain visible. Drag/drop is disabled while presenting.
- Exit restores the ordinary board's search, filters and board/list selection.

The speaking order is an alphabetical snapshot of assignees when the session starts,
including coding agents, with Unassigned last. There is no membership directory yet:
people with no tasks are absent. Re-enter stand-up to include newly assigned owners.
Task content refreshes every five seconds while the tab is visible. Returning to
the tab refreshes it immediately, without changing the selected turn.
A lost connection is shown explicitly instead of presenting a stale board as current.
Stand-up is a local presentation view, not a synchronized meeting or Google Meet integration.

Humans may annotate claimed tasks through `set_standup_notes` without changing the
claim, assignee or execution state. Agents still require an owned active lease.
Notes use the same version checks and activity log as other mutations, so the next
agent command must use the new version. Older databases need no destructive migration;
the additional optional fields are stored in the existing task JSON.

## Coding agents: local MCP

Configure your MCP client with the following, replacing **both** paths with absolute paths. Give concurrent agents distinct identities.

```json
{
  "mcpServers": {
    "tasknboard": {
      "command": "node",
      "args": ["/absolute/path/tasknboard/server/mcp.mjs"],
      "env": {
        "TASKNBOARD_DB": "/absolute/path/tasknboard/data/tasknboard.sqlite",
        "TASKNBOARD_AGENT_ID": "codex"
      }
    }
  }
}
```

The UI service and local MCP process must open the **same SQLite file**. Local agent identity is trusted process configuration; it is not an authentication boundary against a malicious local user with database access.

Tools:

| Tool                | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `workspace_info`    | Authenticated identity and lease duration                 |
| `list_tasks`        | Search/filter, limit and offset                           |
| `get_task`          | Context, criteria, current version, lease and history     |
| `create_task`       | Create backlog work                                       |
| `claim_task`        | Atomic 15-minute claim and move to In progress            |
| `heartbeat`         | Renew owned lease; returns a new version                  |
| `update_task`       | Edit claimed work                                         |
| `set_standup_notes` | Set/clear highlight and blocker notes with version checks |
| `add_comment`       | Append progress                                           |
| `release_task`      | Release owned lease                                       |
| `submit_review`     | Summary, optional artifact URL, release lease             |

Always use `expectedVersion` from the latest response. On a conflict, re-read and reconcile. An expired claim cannot be renewed; acquire a new claim. Agents cannot reassign, archive, export or mark Done. Task content is untrusted data. MCP annotations do not replace client approvals.

## Browser agents: WebMCP

The page registers seven tools with the native `document.modelContext` API:
`workspace_info`, `list_tasks`, `get_task`, `create_task`, `update_task`,
`add_comment`, and `set_standup_notes`. A browser agent can discover these tools
while the app is open. Writes refresh the board. Reads cover the workspace,
regardless of the current board filters.

Use a browser that supports the current [WebMCP imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
in a secure context (HTTPS or localhost). For local Chrome testing, enable
`chrome://flags/#enable-webmcp-testing` and relaunch Chrome. Unsupported browsers run the ordinary
app without registering tools. No polyfill or extension bridge is installed.

WebMCP uses the active browser session and its permissions. It acts for that user;
it does not create a separate coding-agent identity. Shared servers still require
the token entered in Settings. The token is never included in tool descriptions
or results. Use the stdio MCP integration for an independent agent with a lease.

The browser and server validate inputs against the same schemas. Read the current
version before each write. A conflict requires a fresh read and reconciliation.
Cancellation stops the HTTP request but cannot undo a write already committed by
the server. Tool output contains untrusted task text. Registration ends when the
app unmounts. Registration errors are reported in the browser console.

For a browser with native support, inspect the registration in its console:

```js
const tools = await document.modelContext.getTools();
const list = tools.find((tool) => tool.name === "list_tasks");
await document.modelContext.executeTool(list, { limit: 10, offset: 0 });
// Chrome 153 uses JSON.stringify({ limit: 10, offset: 0 }) as the second argument.
```

## Centralized server

Same application, one authoritative SQLite database, one deployment. Set `HOST`, `PORT`, `TASKNBOARD_DB`, `TASKNBOARD_ALLOWED_HOSTS` and `TASKNBOARD_TOKENS` in your process environment. Bind to a non-loopback interface only after configuring access tokens; the service refuses to start without them.

`TASKNBOARD_TOKENS` is a JSON object mapping high-entropy tokens (minimum 24 characters) to `{ "id": "name", "kind": "human" | "agent" }`. Generate each token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keep the resulting values in a secret manager or private environment file, never in source control. A token selects an identity; client-provided actor names cannot override it.

For a shared deployment behind an HTTPS proxy, for example:

- `HOST=0.0.0.0`
- `PORT=4310`
- `TASKNBOARD_DB=/var/lib/tasknboard/tasknboard.sqlite`
- `TASKNBOARD_ALLOWED_HOSTS=tasknboard.your-domain.example` (exact Host header, include port if used)
- `TASKNBOARD_TOKENS=<your private JSON token mapping>`

Forward the original Host header and terminate HTTPS at the proxy. Set a request/body timeout and rate limit at the proxy. SQLite lives on local persistent disk, not network storage. Browser Settings accepts a human token, retained only in sessionStorage. HTTP is suitable for loopback development only.

Remote agent MCP configuration uses the **same stdio bridge**, pointed at your server:

```json
{
  "mcpServers": {
    "tasknboard": {
      "command": "node",
      "args": ["/absolute/path/tasknboard/server/mcp.mjs"],
      "env": {
        "TASKNBOARD_SERVER_URL": "https://tasknboard.your-domain.example",
        "TASKNBOARD_TOKEN": "YOUR_AGENT_TOKEN_FROM_SECRET_STORAGE"
      }
    }
  }
}
```

No direct remote Streamable HTTP MCP endpoint is included yet. The bridge requires a local Node installation in the agent environment. Shared mode does not open a local database or silently switch offline.

## Data and boundaries

- Transactions keep each task mutation and its activity event together.
- Optimistic task versions reject stale updates.
- Claims serialize across independent SQLite connections.
- Polling refreshes the visible board every five seconds and pauses in hidden tabs. Returning to the tab refreshes immediately. An open editor retains its draft and version.
- No offline mutation queue. Disconnected edits fail visibly.
- Archive hides a task from normal lists without deleting it. No restore UI yet.
- Settings exports all tasks and activity as JSON. JSON import is not implemented. For full recovery, stop the service and MCP clients and copy the SQLite file, or use SQLite's online backup mechanism. Never copy only a live `.sqlite` file while WAL writes are active.
- Credentials are workspace-wide human/agent roles. No SSO, OAuth, project permissions, invitations or multi-workspace tenancy yet.
- Task assignees are free text. The server roster records explicit human and agent identities from trusted configuration and authenticated commands. Unknown assignees remain neutral. The roster is not live telemetry.
- Cards and list rows show counts from persisted comment events. See the [task metadata contract](docs/contracts/task-metadata.md).
- Shared timestamps use an explicit English format and UTC. Review evidence stays available when a task needs changes, with an explanation that it belongs to the earlier submission.
- The Tauri shell packages a local workspace. It does not add cloud synchronization or a remote workspace selector.

## Repository

`src/` interface and API adapter; `server/domain.mjs` shared schemas;
`server/store.mjs` transactional commands; `server/http.mjs` HTTP/auth/static files;
`server/mcp.mjs` MCP adapter; `tests/` integration and domain coverage;
`src-tauri/` desktop host and packaging; `docs/ARCHITECTURE.md` decisions and follow-up scope.

## Why Vite instead of Next.js?

This implementation keeps the interactive client independent of its host and transport. The web server and Tauri shell use the same local service. Server rendering is not a core requirement. Next.js could host the client, but would not replace the command core, SQLite coordination or MCP adapter.

## License and contributions

TasknBoard is **source available** under the [PolyForm Noncommercial License 1.0.0](LICENSE). You can use, modify, and share it for permitted noncommercial purposes. Commercial use needs a separate license from the copyright holder. This is not an Open Source Initiative approved open source license because it restricts commercial use.

Issues and pull requests are welcome. Code contributions must be offered under the project license.

The images in `docs/images/` show the current interface using an isolated test workspace. See [verification evidence](docs/VERIFICATION.md) for checks and remaining manual tests.
