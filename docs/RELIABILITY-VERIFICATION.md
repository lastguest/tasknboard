# Reliability verification

Run the checks from the repository root. The test fixtures create temporary workspaces.

```sh
npm test
npm run build
npm run test:ui
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
```

The shared CI job runs the Node and browser checks before either desktop build can publish.
Each desktop job runs the Rust tests and exercises its bundled Node service.
The Windows job also installs and launches the installer.

## Verify a packaged desktop build

Use a separate test account or virtual machine on each supported platform.
Use a disposable workspace and an agent identity with automatic launch disabled.

1. Open the packaged app and create a task.
2. Assign the task to the test agent.
3. Claim the task, comment, and link a PR through MCP or the CLI.
4. Submit the task for review.
5. Open another task and edit its title without saving.
6. Restart the resident service from **Settings → Connect to Codex**.
7. Close Settings and wait for the same window to reconnect.
8. Check the draft and save it.
9. Open the task in review and move it to Done.
10. Confirm the comment and PR link still appear.

Run this check on macOS and Windows before a release.
The browser harness verifies draft retention using a simulated native adapter.
The Rust test verifies authenticated requests on two loopback ports.
Neither substitutes for the packaged window check.

On 2026-11-10, the signed macOS bundle passed the live restart and draft check.
The window kept the same process while the resident restarted on a different port.
The draft remained open. The database kept version 1 until **Save changes** wrote version 2.
The test used a disposable workspace and Keychain.
The Windows restart check remains pending.

## Verify database recovery

Run `node --test tests/backup.test.mjs` for the isolated recovery drill.
The test creates a SQLite snapshot while the source connection stays open.
It checks the snapshot's integrity and compares restored tasks, images, links, and events.

To rehearse recovery with a real workspace:

1. Close the app and stop the resident service before copying the database.
2. Keep the original database and backup intact.
3. Copy the backup to a separate test directory.
4. Start a test service with `TASKNBOARD_DB` set to the copy and a separate loopback port.
5. Check a known task, image, link, and activity entry against the source.
6. Stop the test service after the check.

Use SQLite's online backup API if the source service must stay running.
Do not copy only the database file while SQLite writes to the WAL.
JSON export provides inspection data and has no import path.

## Measure task pagination

Run `node scripts/benchmark-task-pages.mjs`.
The script reads every 100-task page at 1,000 and 10,000 tasks.
It measures store time in a temporary database and reports the median of three runs.

| Tasks | Before | After |
| --- | ---: | ---: |
| 1,000 | 7.1 ms | 1.7 ms |
| 10,000 | 711.4 ms | 43.9 ms |

The measurements use Node 26 on a local Apple Silicon Mac.
They exclude transport, rendering, and saved-view filters.
