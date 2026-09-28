# TODO

Follow-up implementation for [UI.md](UI.md). Branch: `ui-workflows`.
Delivery instruction: push this branch without a PR, merge, or deployment.
See [verification evidence](docs/VERIFICATION.md) for commands and results.

## Implemented

- [x] Document the actor roster and comment-count contract before backend work.
- [x] Persist explicit actor kinds across HTTP and local MCP connections.
      Reject conflicting kinds. Unknown free-text assignees remain neutral.
- [x] Return event-derived comment counts and display them on Board and List.
- [x] Hide the placeholder My tasks identity until the workspace loads.
- [x] Pause polling in hidden tabs and refresh immediately when visible.
- [x] Explain retained review evidence after Needs changes.
- [x] Load WebMCP validation only when `document.modelContext` exists.
- [x] Use explicit UTC timestamps across the shared interface.
- [x] Keep Tab and Shift+Tab inside dialogs and restore focus on close.
- [x] Leave fullscreen even when Escape precedes completion of fullscreen entry.
- [x] Add Playwright with isolated temporary databases outside `data/`.
- [x] Cover create, find, edit, comment, review, Done, archive, and export.
- [x] Cover Board/List/My tasks filters and matching counts.
- [x] Cover status changes, rejected moves, stale drafts, merges, and claims.
- [x] Cover stand-up order, navigation, notes, filters, Escape, and restoration.
- [x] Cover wrong and valid Settings tokens without displaying credentials.
- [x] Cover injected WebMCP writes during an in-flight refresh.
- [x] Cover hidden-tab polling, initial identity, and optional chunk loading.
- [x] Cover phone navigation, full-screen dialogs, and horizontal overflow.
- [x] Run keyboard-only checks across the main views and dialogs.
- [x] Replace the obsolete verification record with current evidence.
- [x] Run the production build, backend tests, browser tests, and diff check.

## Live evidence

- [x] Record native WebMCP discovery and a write in a supporting browser.
- [x] Record fullscreen entry and Escape behavior during stand-up.
- [x] Replace the old screenshots with Board, details, stand-up team,
      participant, and mobile captures.

## Manual checks still required

- [ ] Test physical touch dragging on a phone or tablet. The Status menu is
      the supported alternative and has automated browser coverage.
- [ ] Run VoiceOver through card names, Status menus, dialog titles, toasts,
      and the current stand-up participant. Keyboard tests do not replace this.

## Explicitly deferred

- Restoring archived tasks needs a separate requirement and server command.
- PR creation, merging, and deployment are outside this delivery request.

## Ground rules

Keep domain rules on the server. Every write retains version and lease checks.
Do not retry stale writes automatically or add an offline queue.
Render task text, comments, and review evidence as untrusted text.
Keep tokens in sessionStorage. Exclude them from screenshots and diagnostic output.
Do not add billing, organizations, invitations, custom workflows, notifications,
attachments, dependencies between tasks, or a native shell.
