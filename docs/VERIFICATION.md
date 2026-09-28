# TasknBoard verification

Date: 2026-09-28. Branch: `ui-workflows`.

## Scope and isolation

This record covers the UI workflows and follow-up work in `TODO.md`.
Tests use temporary SQLite databases outside `data/`. They do not seed or reset
an existing workspace. No deployment or merge is part of this work.

## Automated results

| Command | Result |
| --- | --- |
| `npm test` | 13 passed, 0 failed |
| `npm run build` | TypeScript and Vite passed |
| `npm run test:ui` | 13 passed, 0 failed |
| `git diff --check` | Passed |

Node.js: 26.8.1. Playwright: 1.63.0. Chromium: 153.0.8010.12.
Browser tests use the production bundle through `server/http.mjs`.
Desktop tests use 1280 × 720. The phone test uses 375 × 812.

The backend suite checks authorization, version conflicts, leases, rollback,
review, archives, persistence, stand-up notes, HTTP, real stdio MCP, and WebMCP.
New checks cover explicit actor kinds, kind conflicts, cross-connection roster
persistence, schema version 2 exports, token exclusion, and event-derived counts.

The browser suite checks:

- Wrong and valid Settings tokens; task creation, search, editing, comments,
  agent review, human completion, archiving, and JSON export.
- Matching Board/List/My tasks filters and counts. An unknown assignee named
  "Helpful bot" receives no agent badge. Visible comment counts agree.
- Status-menu updates and a server-rejected drag to Done.
- A stale save that keeps the draft and merges untouched fields.
- A claimed task that rejects an edit and keeps the draft.
- Stand-up participant order, arrow keys, Home, filter reset, claimed-task
  notes, fixed order after a new assignee appears, and workspace restoration.
- Escape closing the notes dialog before exiting stand-up.
- Seven injected-registry WebMCP tools and a write during an in-flight read.
  The board refreshes again and shows the new task.
- Hidden-tab polling pause and immediate refresh on visibility change.
  This test controls document visibility and the browser clock.
- No placeholder My tasks identity before the workspace response.
- No WebMCP chunk request in an unsupported browser.
- Phone bottom navigation, full-screen dialogs, and no page-wide horizontal
  scroll. Tab stays in the dialog; Escape restores focus.
- Keyboard-only access to the main views and task, notes, Settings, and help
  dialogs. This found and fixed native-dialog focus escape at the Tab boundary.
- Retained review evidence explained after Needs changes.

## Bundle results

| Asset | Before | After | After gzip |
| --- | ---: | ---: | ---: |
| Main JavaScript | 368.36 kB | 278.05 kB | 85.17 kB |
| Optional WebMCP JavaScript | Included in main | 92.65 kB | 26.73 kB |
| CSS | 24.62 kB | 24.71 kB | 6.02 kB |

The main bundle previously compressed to 111.44 kB. Ordinary browsers now avoid
the optional WebMCP validation chunk. These are build sizes, not memory metrics.

## Review

The independent source review found a missing visible Board comment count.
That issue is fixed. The review also reproduced a concurrent database write and
confirmed that task versions and comment events use one read snapshot.

## Native browser evidence and screenshots

The production app ran in Chromium 153.0.8010.12 with
`--enable-blink-features=WebMCP,WebMCPTesting`, on a secure loopback origin.
No registry was injected for this check. Native `document.modelContext.getTools()`
returned all seven tools. Native `executeTool` created a task, and the board
showed it. Chrome 153 accepted a JSON string as the tool input.

Fullscreen entry succeeded. Escape left fullscreen and stand-up. A rapid Escape
initially exposed a pending-entry race. The fix exits fullscreen when a pending
request finishes after stand-up closes. A regression test checks both paths.
The controlled race test uses the real fullscreen operation and delays its
completion notification. No JavaScript page errors appeared in the live check.

Current screenshots use an isolated workspace populated through real commands.
Desktop captures are 1440 × 900; the phone capture is 375 × 812. All five were
visually inspected. Board scrolling stays inside the phone workspace.

- [Board](images/tasknboard-board.png)
- [Task details](images/tasknboard-details.png)
- [Stand-up team](images/tasknboard-standup-team.png)
- [Stand-up participant](images/tasknboard-standup-person.png)
- [Phone](images/tasknboard-mobile.png)

## Remaining manual checks

Physical touch dragging requires a phone or tablet. Browser touch emulation
cannot establish physical device behavior. The Status menu remains the tested
alternative to dragging.

VoiceOver requires a manual screen-reader pass. DOM names, keyboard focus
checks, and live-region attributes do not establish the spoken experience.
These two checks remain open.

## Tauri desktop verification — 2026-09-28

Target: macOS on Apple Silicon. The packaged runtime is official Node 24.14.0.

- `npm test`: 14 tests passed, including the new desktop lifecycle test.
- `npm run test:ui`: all 13 Chromium browser tests passed.
- `npm run desktop:build`: produced `TasknBoard.app` in the macOS bundle directory.
- `npm run desktop:dev`: compiled the debug host and started its bundled workspace service.
- `codesign --verify --deep --strict`: the ad-hoc app signature passed verification.
- The lifecycle test also passed against the Node executable and service inside the finished app bundle.
- `otool -L` showed only Apple system libraries for the bundled Node executable.
- The app launched from `/tmp` with `PATH=/usr/bin:/bin`.
- The native interface created a task and changed its status through the status menu.
- Export opened a native Save dialog. The saved JSON contained the task, its status, and its activity events.
- A delayed Save and a cancelled Save both returned control to the app.
- After Quit and relaunch, the task retained its status.
- Quit stopped the loopback service. Killing the host also stopped the bundled Node process.
- A review artifact link opened one Safari tab. The app stayed on its task view.
- The generated smoke-test database was moved to ignored `test-results/desktop-smoke.sqlite` after the app stopped.
  The desktop workspace starts empty. Existing web workspace data was not changed.

The native drag attempts did not produce an observable task move through automation.
The status menu passed, but manual desktop drag verification remains open.
Windows, Linux, Intel macOS, public signing, and notarization are outside the packaged target.
Local builds use ad-hoc signing.

Release builds disable stripping because the macOS 27 toolchain can produce unloadable procedural-macro libraries.
See the [upstream Rust issue](https://github.com/rust-lang/rust/issues/157750).

The sections above document the earlier web verification.
