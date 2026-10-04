# Agent workflow

Task assignment, lease ownership, and external delegation are separate fields.
`claim_task` sets the lease holder and keeps the assignee.
Assignment sets the owner and does not start an agent process.
The human **Run agent** action sends `agent-event` with `event: "task_assigned"` and `taskId`.
Configured mentions, review changes, and stand-up events keep their existing dispatch rules.
Repeating an active claim as its holder returns the current task, even with an old version.
That repeat does not renew the lease, change the version, or add an event.
Use `heartbeat` with the current version to renew a lease.
Use `release_task({id, expectedVersion})` to release an active claim as its holder or an architect.
Release keeps the task lane, assignee, and delegation.
Task details show a Release claim action for the claim holder and an architect.
Expired claims need a new claim with the current version for ordinary edits.
A lane-only move can renew the same actor's expired claim on an open task.
Workers can move their claimed task to a todo lane without changing its assignee.
That move parks the task and clears its lease.
Lease errors include the holder, expiry, server time, remaining milliseconds, and active state in `details.lease`.
Negative remaining milliseconds mean the lease expired.
`delegate_task({id, expectedVersion, delegatedTo})` records external work and moves the task to `in_progress`.
Delegated work needs no heartbeat. Automatic task runs skip active leases and delegated tasks.
Agents can delegate directly when no active claim exists.
An expired claim does not block delegation.
Workers cannot delegate tasks with another worker's active claim.
Architects can delegate without a claim, including tasks with an active claim.
Delegation clears the lease and keeps the assignee.
The delegator and delegate can update progress, link commits, and submit review without a claim.
Review changes keep the delegate. The notification reaches the delegate and delegator.

An architect uses `{id, kind: "agent", role: "architect"}`.
For local MCP, set `TASKNBOARD_AGENT_ROLE=architect` in its environment.
For remote MCP, set the role in the actor record for its access token.
Humans can select Worker or Architect for an agent on the desktop Agents page.
Humans can also use `update_profile({agentId, role})` to change an existing agent's role.
Agents cannot grant or revoke roles.
An omitted role keeps the saved role. An explicit role in trusted configuration overrides the saved role.
The server gets the role from authentication, never from a tool argument.
An architect can manage boards, lanes, epics, labels, dependencies, and task lanes without a claim.
Create a lane named `Blocked` with role `in_progress` to separate blocked work.

The task creator and an architect can submit review without a claim.
The task creator and an architect can also link commits without a claim.
Commit links keep the current lease, assignee, and delegation.
Anyone can add comments without a claim.
Comments, commit links, and reviews accept `via` to identify the engineer session.
Reviews accept `artifacts`, `commitRange`, and `verifiedBy` for structured evidence.
Read `get_task.completionPolicy` before approval. It gives the effective mode and its source.
Matching label policies override the epic policy. The epic policy overrides the board default.
For multiple matching labels, the most restrictive mode wins.
The order is `human`, `any_agent_other_than_author`, `architect`, `auto_on_evidence`, then `any_agent`.
The board uses `human` when `humanCompletionOnly` is true. Otherwise it uses `completionMode`.
An epic with `completionPolicy: "inherit"` uses the board default.
The board's `labelCompletionPolicies` maps label names to modes.

| Mode | Approval rule |
|---|---|
| `human` | A human approves the review. |
| `any_agent` | An authorized agent can complete the task. |
| `architect` | An architect can complete the task. |
| `any_agent_other_than_author` | Another agent approves the review. The review records the delegate as its author. |
| `auto_on_evidence` | The server completes the task after it verifies artifact evidence and linked commits. |

A human can approve a reviewed task in every mode.
Automatic completion requires `origin/HEAD` to identify the default branch.
The check uses the corresponding local branch when it exists, otherwise the configured remote branch.
Every linked commit must exist on that branch. An unknown branch or commit keeps the task in review.
Read `autoCompletion.reason` for the refusal reason.
The commit scanner checks review evidence after each successful scan, including a later merge without a task reference.
Automatic completion adds an audit event and clears the lease and delegation.

Humans and architects can archive tasks with `archive_task({id, expectedVersion})`.
Workers can archive only tasks they created, without an active claim from another actor.
Archiving clears the lease and delegation and hides the task from active lists.
The task data and activity remain in the database.
Use `restore_task({id, expectedVersion})` to return an archived task to its saved lane.
Humans and architects can restore any archived task. Workers can restore only tasks they created and archived themselves.
A worker can restore its own archive within ten minutes, or while nobody else has touched the task.
A worker cannot reverse another actor's archive or rejection. Restore clears the lease and delegation and records an event.
Task details show an Archive task action and ask for confirmation.
`request_changes({id, expectedVersion, reason})` returns a review task to `in_progress` and saves the reason.
Only a human or an architect can request changes.
`reject_task({id, expectedVersion, reason?})` archives a task and keeps its lane.
Only a human or an architect can reject a task.
The task must not already be archived.
Rejection clears the lease and delegation and keeps the assignee.
The optional reason stays in the task activity.
Rejected tasks leave active lists. Task links retain their archived state.
Use `restore_task` to return a rejected task to its saved lane.
Use `/reject [reason]` in the interactive CLI, or `reject_task` with JSON input.
`undo_task({id, expectedVersion})` reverses your most recent action on a task you created.
The undo stays available for ten minutes, or while nobody else has changed the task.
Read `get_task.undo` for the current access decision. Every undo adds an audit event.

`create_task` accepts an initial lane and `blockedBy` task IDs.
`bulk_create_tasks({tasks})` and `bulk_move_tasks({tasks: [{id, expectedVersion}], lane})` use one transaction.
`claim_tasks({tasks})`, `add_comments({comments})`, and `submit_reviews({reviews})` also use one transaction.
A failed item cancels the whole batch.
Comments need no `expectedVersion`.
`list_tasks` accepts label, lane, role, owner, assignee, and board filters.
Use `delegated: true` to list delegated tasks.
Use `fields: ["id", "title", "role", "lane", "epic", "version"]` to select task fields.
Use `compact: true` for small task rows.
`find_similar_tasks` searches archived or done tasks when `includeArchived` or `includeDone` is true.

MCP task mutations return `{id, version, lane, url}` by default.
Active claims include the lease and its remaining seconds. Delegated tasks include the delegate.
MCP task lists return compact rows. Pass `verbose: true` to get full data.
Selected `fields` remain intact in MCP results.
`get_task` always returns full task context. Browser commands keep full responses.

Sub-actor IDs such as `claude/architect` and `codex/cli` identify separate sessions.
Set `TASKNBOARD_AGENT_ID` to the session ID for local MCP.
Set `TASKNBOARD_AGENT_ID` for CLI calls from scripts or agents.
Non-interactive CLI writes fail without that ID. Non-interactive reads remain available.
Set `TASKNBOARD_AGENT_ROLE=architect` or `worker` to give the CLI an explicit role.
Omit that variable to use the saved role.
CLI task commands accept `taskId` or `id`; both values must match if present.
Each task in `bulk_move_tasks` accepts the same names.
Run `tasknboard help <command>` for required fields and an example.
Versioned writes still require the current `expectedVersion`.
Use `<command> --file <path>` or `<command> --stdin` for JSON with Windows shell characters.
These modes read JSON as data and keep it out of the batch command line.
Installed plugin identities use flat names because those names also identify files.

Review artifacts accept HTTP(S) URLs, repository paths, and commit SHAs.
`link_commits({id, expectedVersion, commits})` saves commit SHAs without a pull request.
The local server scans each board repository for commit messages that contain task IDs.
It links matching commit SHAs to tasks on that board.
For merge commits, it also matches branch references against each task's `branch` field.
The branch reference must match the complete branch name.
The task commit summary lists changed files and line counts from linked commits.
Merge file counts use the first parent. Binary files have a separate flag.
Missing commits appear in the summary's `unavailable` list.
The scanner keeps a cursor and skips commit SHAs that already link to the task.
The first scan reads 200 recent commits. Later scans read new commits in batches of 200.
The server scans every 30 seconds and defers links while a task has an active lease.
Pass `boardId` to `create_epic` and `list_epics` to keep epics on one board.

`list_notifications({after, limit})` returns durable human comments, changes requests, and completion events.
The result contains `items` and a sequence `cursor`.
Subscribe to the MCP resource `tasknboard://notifications` to get change notifications.
Read that resource or call `list_notifications` after a notification.
Task changes, review requests, review rejections, and unblocked tasks also produce events.
The remote change stream reconnects after connection loss.

Each board has `agentReasoning` and `agentSandbox` settings for Codex runs.
The default sandbox is `workspace-write`.
Every task run receives the task ID, title, description, and acceptance criteria.
Plugin installation removes the old standalone Codex registration after the plugin succeeds.
The MCP supervisor keeps the host connection open if its worker fails.
It also retries initialization if the first worker stops before the connection succeeds.
It restarts the worker and restores initialization and resource subscriptions.
It does not retry calls that were in flight. Read the task before retrying a change.
The MCP client must keep its stdio connection open for this recovery.
