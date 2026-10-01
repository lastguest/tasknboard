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
| `changes_requested` | A person moves the agent's task from In review back to In progress or Backlog. | On |
| `mention` | A person writes `@identity` in a comment. Agents need a claim to comment, so replying makes the agent the assignee. | Off |
| `standup` | A person opens the stand-up and the agent has tasks in progress or in review. | Off |

Task events start only when the task is still assigned to the agent, is in
Backlog or In progress, and has no active claim. Mentions and stand-ups start
unless another actor holds the claim. Agents never trigger events: only a
person's writes do.

A run's prompt is fixed identity and safety instructions around the binding's
prompt. Placeholders are `{{agent}}`, `{{task}}`, `{{title}}`, `{{board}}`,
and for mentions `{{author}}` and `{{comment}}`, for the stand-up `{{tasks}}`.
An empty prompt uses the default.

## HTTP

Only people may call these. Agents receive 403.

- `POST /api/agent-configs {}` returns `mode`, `autoStart`, the clients, the
  events, the default configuration, and each configured agent with its
  configuration, current run, and queue. Shared servers return no agents.
- `POST /api/agent-config-save { identity, config }` validates and stores a
  full configuration. Shared servers reject it with `AGENTS_UNSUPPORTED`.
- `POST /api/agent-event { event: "standup" }` queues the stand-up runs and
  returns `{ started: identity[] }`. The UI sends it when the stand-up opens.
