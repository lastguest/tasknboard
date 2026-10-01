# Task pull requests contract

A task links the GitHub pull requests that carry its work, like Linear's
pull request attachments and Jira's development panel. Links inform people and
agents. They do not change a task's lane.

## Commands

- `link_pull_requests({ id, expectedVersion, pullRequests })` links one or
  more pull requests to task `id`. Each value is a pull request URL
  (`https://github.com/owner/repo/pull/123`, extra path, query or fragment
  allowed) or `owner/repo#123`. Values already linked, or repeated in the
  call, are skipped; the match ignores case in `owner/repo`. If none is new
  the command fails with `LINK_EXISTS`. A task links at most 20 pull requests
  (`VALIDATION`).
- `unlink_pull_request({ id, expectedVersion, pullRequest })` removes one
  pull request, given in either form. A pull request that is not linked
  fails with `NOT_FOUND`.

Both are task writes. They need the current version and follow the normal
lease rules: an agent needs its own active claim, and another actor's active
claim blocks a human. Each appends one event, `link_pull_requests` or
`unlink_pull_request`, with body `{ pullRequests: url[] }` listing the URLs
added or removed. TasknBoard does not call GitHub to link a pull request,
so the commands work without a GitHub connection.

## Reads

Tasks carry `pullRequests: { repository, number, url }[]` in link order, on
`list_tasks`, `get_task`, write results and `export_workspace`.
`repository` is `owner/repo` as first written, and `url` is the canonical
pull request URL. The field is absent on tasks that never linked one.
The data lives in the task record, so no migration is needed.

## Interfaces

MCP, WebMCP and the HTTP API expose both commands. The CLI adds
`/pr <url…>` and `/unpr <url>`, and lists pull requests in the task detail.

Board cards and list rows show a pull request mark, with the count past one.
With GitHub connected, the mark takes the colour and icon of the most active
state among the task's pull requests: open (green), then draft (grey), merged
(purple), closed (red). Its tooltip counts each state. The board reads every
visible pull request in one `get_pull_request_states` call and again after a
minute. Without a connection the mark stays grey.
The task details panel lists them under **Pull requests**; the **+** button
takes one or more pasted links. Each row opens the pull request in the
**Pull requests** section (`#pulls/<owner>/<repo>/<number>`). With GitHub
connected, rows show the title and an open, draft, merged or closed icon in
the same colours as the card mark, from the same batched
`get_pull_request_states` read; otherwise they show `owner/repo` and the
number. A pull request lists the tasks that link it.
