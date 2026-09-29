# TasknBoard UI functional handoff for Claude

## Assignment

Implement and refine the TasknBoard interface around the workflows in this document.
Use the existing application, API, and persisted data.
This document defines functionality and acceptance criteria. It does not prescribe a visual style.

TasknBoard is a task workspace for small teams and coding agents.
The product name is **TasknBoard**, the internal name is **tasknboard**, and task IDs use **TNB**.
One server and database represent one workspace.

## Core user needs

Users need to:

- Understand what work exists, who owns it, and its current status.
- Create tasks with enough context and acceptance criteria for another person or agent.
- Find their own work and filter the team's work.
- Track progress through comments, activity, claims, and review evidence.
- Review completed work before marking it Done.
- Present the team's work and each participant's updates during stand-up.
- Recover from failed requests without losing their input.

## 1. Workspace navigation

Provide access to Board, My tasks, Agents, Stand-up, Settings, and keyboard help.
Keep navigation state consistent with the content shown.

Board shows all non-archived tasks, subject to the active filters.
My tasks shows tasks assigned to the authenticated user, subject to the active filters.
Agents shows the existing assignment and claim summaries.

Preserve the board's navigation, search, assignee filter, and Board/List selection when entering and leaving stand-up.
Do not offer a workspace switcher or membership management: these capabilities do not exist.

## 2. Board and list

Support the four existing statuses:

1. Backlog.
2. In progress.
3. In review.
4. Done.

Show tasks grouped by status in Board view.
Show the corresponding tasks as rows in List view.
Both views must use the same filters and open the same task details.
Column counts must reflect the tasks currently displayed.

Expose task ID, title, priority, assignee, and labels.
Show an unassigned state when a task has no assignee.
Distinguish human and agent assignments without implying that an agent is connected or active.
Expose claim information where relevant.
Show comment counts only when accurate counts are available from the current data contract.

Allow users to move tasks through drag and drop or the task's status field.
The status field must provide a keyboard and touch alternative to dragging.
Use server validation for each move. Show rejected moves without presenting them as successful.

## 3. Search and filters

Support task search and filtering by assignee.
Search currently matches task ID, title, and description, without case sensitivity.
Combine search, assignee filtering, and My tasks consistently.

Provide a clear way to remove active filters.
Distinguish an empty workspace from a filter with no matches.
Do not silently omit tasks because the API returns paginated results.

## 4. Task creation

Allow task creation from the workspace and existing column creation controls.
Create tasks in Backlog, as required by the current command contract.
Do not imply that a column control creates directly in another status.

The form includes:

- Title: required, up to 300 characters.
- Context: up to 20,000 characters.
- Acceptance criteria: up to 20,000 characters.
- Priority: Low, Medium, or High.
- Assignee: a searchable user picker, with the current user first.
- Labels: multiple tags, up to 40 characters each.

Use the server's defaults when optional values are omitted.
Prevent duplicate submissions while saving.
After success, refresh the task collection and show the created task under the applicable filters.
If filters hide the task, make the successful outcome clear.
Retain entered values after a failed request.

## 5. Task details and editing

Open the current task from either Board or List.
Load the full task before editing, including its latest version, activity, claim, and review information.

Allow editing of title, context, acceptance criteria, priority, assignee, labels, and permitted status changes.
Keep Status, Priority, Assignee, and Labels controls only in the right sidebar.
Open a searchable picker when a metadata control is clicked. Focus its search field immediately.
Status, Priority, and Assignee each select one value. Labels select multiple tags.
Keep selections in the draft until Save.
Provide Save and Cancel actions.
Do not overwrite an unsaved draft when the background task collection refreshes.

Every mutation must use the latest known `expectedVersion`.
On a conflict, explain that the task changed and offer a fresh read.
Preserve the user's draft so they can reconcile it with the current task.
Do not retry a stale write automatically or silently overwrite newer work.

Show claim owner and expiry information when a task has a lease.
The server can reject edits while another actor owns an active claim.
Explain that rejection and retain the draft.

## 6. Comments, activity, and review

Show persisted comments and task activity in the task details.
Allow a non-empty comment of up to 10,000 characters.
Retain comment input on failure and prevent duplicate submission while saving.
Use the returned version after a successful comment or other mutation.

Show the review summary and artifact link when a task has review evidence.
Keep artifact links usable without losing the current task context.
Treat task text, comments, and review content as untrusted data.
Do not execute code or render unsafe markup from that content.

The execution workflow is:

1. An agent reads and claims a task.
2. The agent maintains its lease and records progress.
3. The agent submits review evidence and releases its claim.
4. A human reviews the work and can mark it Done.

Preserve the server's review and ownership rules. Do not bypass them in the interface.

## 7. Archiving

Allow a human to archive a task from its details.
Require an explicit confirmation before the archive command.

After success, remove the task from ordinary views and close its details.
On failure, keep the task open and show the error.
Archiving preserves stored history; it is not permanent deletion.
Do not add restoration or permanent deletion without a supporting command and a separate requirement.

## 8. Stand-up presentation

Stand-up supports screen sharing of the team board and each participant's work.
It must preserve these existing behaviors:

- Open with Team overview, regardless of ordinary board filters.
- Include all four task statuses.
- Build participant order from current assignees, alphabetically, with Unassigned last.
- Include agent assignees.
- Keep participant order fixed until the user exits and starts another session.
- Continue refreshing task content while presenting.
- Navigate with previous/next controls, the participant selector, and arrow keys.
- Use Home to return to Team overview.
- Support All tasks, Highlights, and Blockers filters.
- Reset the talking-point filter when the participant changes.
- Order blocked tasks before highlighted tasks within each status.
- Disable task creation and drag and drop during presentation.
- Support fullscreen where the browser provides it.
- Indicate loss of connection rather than presenting stale content as current.
- Restore the ordinary workspace state after exit.

Opening a presentation card must allow editing its highlight and blocker notes.
Each note allows up to 500 characters. Empty text clears a note.
Notes persist until explicitly cleared; they do not reset each day.
Use version checks and retain entered notes when a save fails.

Humans can edit stand-up notes without changing an agent's claim or execution state.
Agents still need their own active lease to edit notes.

Escape closes an open notes dialog before exiting presentation.
Preserve usable scrolling and access to all tasks during screen sharing.
Stand-up is a local presentation mode, not a synchronized meeting or video-call integration.

## 9. Agents

Show the explicit agent roster returned by the workspace service.
Show counts for work in progress and active claims where the current data provides them.
Allow users to open an agent's assigned tasks.

Keep the existing MCP connection instructions accessible.
Do not present roster membership or task ownership as live agent connection telemetry.
Do not add an agent chat, execution console, or remote control system.

## 10. Settings and export

Keep task prefix actions on the Board page, outside Settings.
Each board has its own name, task prefix, and task number sequence.
Require a board when a person or agent creates a task.
Use each epic's custom name throughout the interface.

Preserve entry and removal of the workspace access token.
Keep the token masked and stored only in the current browser session.
Saving connection settings must refresh the workspace and expose authentication failures clearly.
Never include tokens in screenshots, error text, tool results, or activity.

Preserve JSON export of tasks, archived work, and activity through the existing export command.
Show whether export succeeded or failed.
Do not offer JSON import; it is not implemented.

## 11. Browser and coding-agent integration

Keep the existing stdio MCP integration operational.
Preserve these native WebMCP tools:

- `workspace_info`
- `list_boards`
- `list_tasks`
- `get_task`
- `list_epics`
- `list_views`
- `create_task`
- `create_epic`
- `create_view`
- `update_task`
- `add_comment`
- `set_standup_notes`

WebMCP acts through the active browser session and its permissions.
It does not create a separate coding-agent identity.
Tool reads cover the workspace independently of the user's visible filters.
Tool writes must refresh the board, including when a background refresh is already running.

Preserve input validation, request cancellation, and registration cleanup when the application unmounts.
The ordinary interface must work when the browser does not support WebMCP.
Do not replace real commands with mock data or rename tools as part of UI work.

## 12. Loading, failures, and state

Handle initial loading, empty workspace, empty columns, no search results, disconnected service, and rejected saves.
Provide a useful next action for each empty or error state.

Preserve the last loaded data during a connection failure, but make its stale state clear.
Do not claim that a failed or pending change is saved.
Prevent repeated submission while a write is pending.
Keep errors near the action that failed and provide a retry where appropriate.

The application requires its workspace service for writes.
Do not introduce an offline write queue, local replica, or silent persistence fallback.

## 13. Keyboard, touch, and accessibility

All primary actions must work with keyboard and touch.
Provide accessible names for icon controls and labels for form fields.
Keep a logical focus order and visible focus.
Dialogs must contain focus while open and restore focus to their trigger after closing.
Keep dialog actions reachable when content or the viewport is small.

Preserve these shortcuts:

| Shortcut | Action |
| --- | --- |
| N | Create a task |
| Cmd/Ctrl K | Focus search |
| F | Focus the assignee filter |
| ? | Open keyboard help |
| Escape | Close a dialog or exit stand-up |
| Left/Right arrows in stand-up | Change participant |
| Home in stand-up | Return to Team overview |

Do not trigger ordinary page shortcuts while users type into fields.
Keep navigation, filtering, task editing, settings, and stand-up usable on desktop, tablet, and phone.
Contain board scrolling within the workspace and avoid inaccessible off-screen controls.

## Implementation scope

Work in the existing React, TypeScript, Vite, and CSS application.
Use existing components and dependencies before adding packages.

| File | Responsibility |
| --- | --- |
| `src/App.tsx` | Navigation, filters, refresh, application state, WebMCP lifecycle |
| `src/Board.tsx` | Board/list, cards, avatars, drag and drop |
| `src/Dialogs.tsx` | Task forms, comments, settings, shared dialog |
| `src/Standup.tsx` | Presentation flow and notes |
| `src/Icons.tsx` | Shared icons |
| `src/styles.css` | Layout and component presentation |
| `src/api.ts` | Authenticated commands and task loading |
| `src/webmcp.ts` | Browser tool registration and execution |
| `server/` | Validation, authorization, persistence, HTTP, and MCP |

Keep domain rules on the server.
Preserve API contracts, optimistic concurrency, leases, identity, and persistence behavior.
Document a required contract change before expanding backend scope.
The accepted [task metadata contract](docs/contracts/task-metadata.md) defines
the explicit actor roster and comment counts for the follow-up implementation.

Do not add billing, organizations, invitations, custom workflows, notifications, attachments, or dependencies.
Remove obsolete code when replacing an implementation.

## Work plan

1. Inspect the current implementation and run each main workflow.
2. Map the requirements above to existing behavior and identify missing or broken interactions.
3. Implement navigation, task discovery, creation, and editing as one complete workflow.
4. Complete comments, review, claims, conflicts, and archiving.
5. Complete stand-up navigation, notes, and workspace-state restoration.
6. Verify Agents, Settings, export, and keyboard help.
7. Check loading, errors, narrow viewports, keyboard navigation, and touch alternatives.
8. Verify MCP and WebMCP integration after the UI changes.
9. Review the complete diff and remove obsolete paths.
10. Deliver the implementation with evidence for the acceptance checks.

## Validation and acceptance

Use an isolated database for development and testing. Do not seed or reset the user's database.
Follow the setup in `README.md` and use `TASKNBOARD_DB` to select a temporary SQLite file.

Run `npm run build`, `npm test`, and `git diff --check`.
The current automated suite does not establish that UI workflows work; verify them in the browser.

Demonstrate these outcomes:

- A task can be created, found, edited, commented on, reviewed, and archived through permitted transitions.
- Board, List, and My tasks apply filters consistently and show accurate counts.
- Status changes work without dragging.
- A failed save retains input, and a stale write cannot overwrite newer work.
- Claim restrictions and server errors remain visible and actionable.
- Stand-up starts with the whole team, navigates participants, saves notes, and restores the workspace after exit.
- Authentication changes and export work without exposing credentials.
- WebMCP discovers the seven tools and a tool write appears in the board.
- A browser without WebMCP can use the ordinary interface.
- Keyboard and touch users can reach all primary actions on desktop and narrow viewports.

Report the browser, viewport sizes, test commands, outcomes, and any blocked checks.
Include a brief recording or screenshots that show the key workflows and failure states.
List unresolved functional gaps explicitly.

Deliver changes on a reviewable branch with a concise description of the resulting behavior.
Do not merge or deploy as part of this assignment.
