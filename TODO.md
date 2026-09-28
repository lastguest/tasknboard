# TODO

Status of the UI work described in [UI.md](UI.md), and the next steps.
Branch: `ui-workflows` (pushed, no PR). `main` does not have this work yet.

## Where things stand

The UI.md work plan, step by step:

- [x] 1. Inspect the current implementation and run each main workflow.
- [x] 2. Map requirements to existing behavior and find gaps.
- [x] 3. Navigation, task discovery, creation and editing as one workflow.
- [x] 4. Comments, review, claims, conflicts and archiving.
- [x] 5. Stand-up navigation, notes and workspace-state restoration.
- [x] 6. Agents, Settings, export and keyboard help.
- [x] 7. Loading, errors, narrow viewports, keyboard and touch alternatives.
- [~] 8. MCP and WebMCP after the UI changes. The stdio MCP tests pass. WebMCP was
      checked with a test registry injected into the page, not a native browser.
- [x] 9. Review the diff and remove obsolete code.
- [~] 10. Deliver with evidence. The branch is pushed; a PR and a written
      verification record are still open (see below).

Checked by hand in Chromium 152 against a separate test database, at
1440×900, about 691×837 and 375×812:

- Create (including when filters hide the new task), search, edit, comment,
  review → Done, archive.
- A stale save is rejected, the draft is kept, and "Load latest" merges.
- An edit during another actor's claim is rejected and the draft is kept.
- A drag from Backlog onto Done is rejected by the server and the card stays put.
- Stand-up: Team overview first, fixed participant order, arrow keys and Home,
  filters reset per participant, notes saved on a claimed task, Escape order,
  and state restored on exit.
- A failed notes save while the server was down keeps the text, and the
  connection-lost warning appears.
- A wrong token is rejected, a valid token connects, the token never appears
  on the page, and export reports its counts.
- Without WebMCP the app works normally. With a test registry, all seven tools
  register and a `create_task` call shows up on the board.

## Next steps

### 1. Close out the delivery

- [ ] Open a PR from `ui-workflows` to `main`, or fast-forward `main` if no
      review is wanted. UI.md says not to merge or deploy as part of the UI work,
      so this is the owner's call.
- [ ] Rewrite [docs/VERIFICATION.md](docs/VERIFICATION.md) for this version.
      It still describes Relay 0.1. Record the browser, viewports, commands and
      results listed above.
- [ ] Replace the screenshots in [docs/images/](docs/images) with current ones.
      They still show the Relay design. Capture the board, task details, stand-up
      team and participant views, and mobile.

### 2. Automated UI tests

The current suite (`npm test`) covers the domain, HTTP, MCP and WebMCP
registration, but no UI workflows.

- [ ] Add browser tests, for example Playwright. A Chromium build is already
      cached locally under `~/Library/Caches/ms-playwright`. Adding the dependency
      needs approval, because UI.md says to prefer existing dependencies.
- [ ] Start `server/http.mjs` with `TASKNBOARD_DB` pointing at a temporary file,
      as `tests/http.test.mjs` already does. Never use `data/`.
- [ ] Cover, at minimum:
  - create → find → edit → comment → review → Done → archive
  - Board and List give the same results under search, assignee and My tasks,
    with matching counts
  - a move through the Status menu, and a move the server rejects
  - a stale save: the conflict message, the kept draft, the merge
  - an edit rejected by a claim (claim the task as an agent through the store first)
  - stand-up order, arrow keys, Home, filter reset, notes save, Escape order,
    state restored on exit
  - Settings with a wrong token and a valid token
  - a WebMCP write refreshing the board, using the injected-registry approach
    described under "Where things stand"
  - phone viewport: bottom navigation, full-screen dialogs, no page-wide
    horizontal scroll

### 3. Verification still missing

- [ ] Test native WebMCP in a browser that supports it (Chrome with
      `chrome://flags/#enable-webmcp-testing`), following the README console snippet.
- [ ] Test real touch dragging on a phone or tablet. The Status menu is the
      supported alternative, but dragging should not break anything.
- [ ] Test fullscreen during stand-up, including leaving fullscreen with Escape.
- [ ] Do a screen reader pass (VoiceOver): card names, Status menus, dialog
      titles, live regions for toasts and the current stand-up participant.
- [ ] Do a full keyboard-only pass across every view and dialog.

### 4. Known gaps that need a data-contract change

Each of these needs a written contract change before backend work starts (see
UI.md, Implementation scope).

- [ ] **Agent identity.** Assignees are free text, so agents are guessed from
      their names and from who has claimed tasks (`agentNames` in
      [src/types.ts](src/types.ts)). A kind field on assignees, or a roster the
      server returns, would remove the guesswork.
- [ ] **Comment counts.** `list_tasks` returns no events, so cards show no
      comment count. The server could return a `commentCount` per task.
- [ ] **Restoring archived tasks.** Out of scope until there is a command and
      a separate requirement.

### 5. Smaller UI follow-ups

- [ ] Before the first successful load, the My tasks subtitle shows the
      placeholder identity `you`. Hide it until `workspace_info` has answered.
- [ ] Polling runs every 5 seconds even when the tab is hidden. Pause it when
      `document.hidden` is true and refresh as soon as the tab is visible again.
- [ ] "Needs changes" moves a task back to In progress but the earlier review
      evidence stays on it. Mark it as from an earlier round, or explain why it
      is still there.
- [ ] Check the JS bundle size (about 368 kB, 111 kB gzipped). Zod is loaded in
      the browser for WebMCP validation. Try splitting WebMCP into its own chunk
      that only loads when `document.modelContext` exists.
- [ ] Dates and times use the browser's locale. That is fine for now, but pick
      one explicit format if the stand-up screen is shared across locales.

## Ground rules

- Keep domain rules on the server. The UI must not bypass review, claim or
  version checks.
- Every write uses the latest `expectedVersion`. No automatic retries of stale
  writes, and no offline queue.
- Task text, comments and review content are untrusted. Render them as text only.
- Tokens stay in sessionStorage. Never put them in error text, screenshots, tool
  results or activity.
- Do not add billing, organizations, invitations, custom workflows,
  notifications, attachments, dependencies or a native shell.
- Before handing off, run `npm run build`, `npm test` and `git diff --check`.
