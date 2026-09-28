# Verification — TasknBoard 0.1

The original Relay 0.1 package supplied the checks below. The final section records the GitHub import and name change.

## Automated checks

`npm run build` passes (TypeScript and Vite).
`npm test`: **9 passed, 0 failed**.

Covered: exclusive claims; actor ownership; renewal and review lifecycle;
lease expiration/takeover; stale versions; rollback/event consistency;
input validation and unsafe artifact URLs; archive/export rules;
persistence across connections and reopen; real MCP SDK initialization,
discovery and tool calls; authenticated HTTP, origin rejection,
remote MCP bridge and human completion.

UI production build: 248.19 kB JavaScript, 76.80 kB gzip;
20.00 kB CSS, 5.24 kB gzip. These are build output sizes, not memory benchmarks.

## Browser checks

The integrated cloud browser could not access localhost (`ERR_BLOCKED_BY_CLIENT`).
Used local Playwright with Chromium distributed through @sparticuz/chromium.
The ordinary Playwright browser download failed; no authentication or network
policy was bypassed. Browser and service ran in the same isolated test process
network environment.

Desktop 1536 × 1024 and mobile 390 × 844. Verified real create → edit status →
comment → reload persistence → search → list → archive flow, and mobile task
dialog access. No JavaScript runtime errors observed. Mobile New task clipping
was found and fixed by wrapping the toolbar. A test's exact label selector was
corrected to match the native select's accessible name.

## Visual comparison

Concept inspected with view_image:
`generated_images/exec-6551cf39-e8ce-4a72-a8d7-bde0e69987c7.png`
(in the conversation workspace, also shown in the conversation).
Latest actual screenshots inspected with view_image: `relay-desktop.png`,
`relay-detail.png` and `relay-mobile.png`.

Five checked relationships:

1. Dark sidebar, light active navigation and lower workspace settings.
2. Four-column kanban anatomy and open lower canvas.
3. Task identifier/title/label/assignee hierarchy.
4. Charcoal surfaces, quiet borders, mint primary action and status colors.
5. Product heading, board/list tabs, assignee filter and toolbar spacing.

Increased desktop card typography, avatar size and card height after comparison.
Main heading, subtitle, navigation and column labels preserve the concept copy.
Intentional differences: simplified geometric brand mark; no fake macOS window
controls; added Studio workspace identity; real connection status instead of a
hardcoded local-mode claim; real demo actor names; no invented comment counts;
column creation buttons instead of inert ellipses. Native select treatment and
system font rendering differ from the raster concept. Mobile uses horizontal
kanban scrolling and a two-row toolbar.

The implementation was compared directly with the concept and preserves its
core layout and visual direction. It is not a pixel-identical reproduction,
and the concept has not been separately approved by the user.

## Limits of verification

No production load/latency benchmark, accessibility audit, penetration test,
third-party desktop MCP host test, deployment or native shell test was performed.
The shared-server tests used loopback and disposable credentials; external TLS
termination remains deployment configuration. Drag/drop uses native HTML DnD;
the tested keyboard-accessible status select provides the same server command.

## Stand-up mode verification

Production build tested at http://127.0.0.1:14320 with a disposable SQLite
workspace, on Chromium/Playwright at 1536×960 and 390×844. The integrated browser
localhost blocker from the original verification still determines the local
fallback. No new browser dependency was installed for this change.

Verified: entry ignores prior search and opens the whole team; sidebar, search,
footer and creation buttons are absent; drag/drop is disabled; participant
navigation filters tasks; highlight/blocker filters reset on turn change;
notes save and survive reload; stale notes are rejected without losing the
newer server version; arrows and Home navigate; Escape closes a dialog before
exiting; exit restores prior board filters; mobile exit/navigation stay visible;
connection loss shows a stale-data warning. No JavaScript runtime errors observed.

Screenshots inspected: relay-standup-team.png, relay-standup-person.png, and
relay-standup-mobile.png (delivered separately from source). Native textarea
accessible names were made explicit after the first browser check.

Domain tests cover note validation, clearing, audit events, preserving agent
claims, stale writes, and agent authorization. The real MCP client test includes
set_standup_notes and discovery of all 11 tools.

Google Meet screen capture and browser fullscreen behavior were not exercised
in an actual meeting. No meeting synchronization is implemented.

## GitHub import and name change

The source package was imported into `lastguest/tasknboard` without its generated `dist/` files. The supplied concept, desktop, and stand-up images are in `docs/images/`. Active product names, environment variables, storage keys, and new task IDs use TasknBoard and `TNB-`.

On 2026-09-28, `npm ci` found no vulnerabilities. `npm test` passed all 9 tests. `npm run build` passed. A local production server served the renamed board from a disposable SQLite database. In Safari, the board showed all 7 seeded tasks, stand-up opened the team overview, the next button selected Alex, and exit returned to the normal board.
