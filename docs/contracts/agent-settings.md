# Agent settings contract

The desktop app starts a coding agent's CLI when an event it is bound to
happens. Each agent identity has one configuration. Shared servers keep none
and start nothing.

## Configuration

`server/agent-config.mjs` validates every field. The settings table stores the
configuration as JSON under `agent_config.<identity>`. Exports never include
it. A plugin install records a default configuration for its CLI. An older
`agent_launcher.<identity>` key still reads as the defaults for that CLI.

| Field | Meaning |
| --- | --- |
| `enabled` | No event starts the agent when false. |
| `client` | `claude`, `codex`, `opencode`, or `pi`. |
| `command` | An absolute executable path, or empty to search PATH. |
| `model` | Passed as `--model`. Empty uses the CLI default. |
| `profile` | Claude Code and OpenCode `--agent`, Codex `--profile`, Pi `--provider`. |
| `args` | Up to 40 extra arguments, after the app's own and before the prompt. |
| `env` | Up to 40 variables added to the user's environment. `HOME`, `USERPROFILE`, and `TASKNBOARD_*` are rejected. |
| `events` | One `{ enabled, prompt? }` binding for every event below. |

Each run starts from a copy of the user's environment, not the service's.
The desktop host clears the service's environment and passes its own original
one in `TASKNBOARD_USER_ENV`. On macOS and Linux the launcher also reads the
login shell's environment once (`$SHELL -ilc env`), so an app opened from the
Dock or Finder still gets profile PATH entries and keys. Variables that describe
the service (`TASKNBOARD_*`, `HOST`, `PORT`) stay out. The CLI is found on the
copied PATH. Restart the app to read a changed profile.

The app always passes the CLI's full-auto switch, because nobody approves
prompts during a run: `--dangerously-skip-permissions` (Claude Code),
`--dangerously-bypass-approvals-and-sandbox` (Codex), `--auto` (OpenCode).
Pi gets `--print --approve`, so it trusts the project's `.pi` folder, where its
TasknBoard skill lives.

## Events

| Event | Starts when | Default |
| --- | --- | --- |
| `task_assigned` | A person creates or assigns a task for the agent. | On |
| `task_unassigned` | A person reassigns the agent's task. The run on that task stops and its queued work is dropped. It has no prompt. | On |
| `changes_requested` | A person moves the agent's task from an `in_review` lane back to an `in_progress` or `todo` lane. | On |
| `mention` | A person writes `@identity` in a comment. The agent replies with a comment; comments need no claim, so replying leaves the assignee as it is. | Off |
| `standup` | A person opens the stand-up and the agent has tasks in `in_progress` or `in_review` lanes. The prompt names each task's lane. | Off |

Task events start only when the task is still assigned to the agent, is in
a `todo` or `in_progress` lane, and has no active claim. Mentions and stand-ups start
unless another actor holds the claim. Agents never trigger events: only a
person's writes do.

A run's prompt is fixed identity and safety instructions around the binding's
prompt. Placeholders are `{{agent}}`, `{{task}}`, `{{title}}`, `{{board}}`,
and for mentions `{{author}}` and `{{comment}}`, for the stand-up `{{tasks}}`.
An empty prompt uses the default.

## Runs and logs

Each run writes its output to `~/.tasknboard/logs/<identity>/<task>-<time>.log`.
Claude Code runs with `--verbose --output-format stream-json`, so its log
fills as it works; plain `-p` printed only the final answer. A failed run's
activity entry uses the `result` message of that output.

When TasknBoard quits during a run, the run stops with it. The task records
`agent_stopped`, the agent's claim is released, and the run and the waiting
queue are saved under `agent_runs.interrupted`. When TasknBoard opens, those
runs start again, with a prompt line that tells the agent to check earlier
progress first.

Cards assigned to an agent show a logs button, and the task menu has
**Agent logs**. The dialog lists the task's runs, newest first, and shows the
chosen one as readable steps. A running log refreshes every two seconds.

## HTTP

Only people may call these. Agents receive 403.

- `POST /api/agent-configs {}` returns `mode`, `autoStart`, the clients, the
  events, the default configuration, and each configured agent with its
  configuration, current run, and queue. Shared servers return no agents.
- `POST /api/agent-config-save { identity, config }` validates and stores a
  full configuration. Shared servers reject it with `AGENTS_UNSUPPORTED`.
- `POST /api/agent-logs { taskId, identity?, file? }` returns `available`,
  the task's runs, and the newest run's log, or the named one. Only files the
  run list names can be read, at most their last 512 KB. Away from the desktop
  app it returns `{ available: false, runs: [] }`.
- `POST /api/agent-event { event: "standup" }` queues the stand-up runs and
  returns `{ started: identity[] }`. The UI sends it when the stand-up opens.
