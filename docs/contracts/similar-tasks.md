# Similar tasks contract

Similar tasks warn people and agents about a possible duplicate before they
create a task. The warning informs. It never blocks a create.

## Command

`find_similar_tasks({ title, context?, boardId?, excludeId?, limit? })` returns
`{ tasks: { id, title, status, score }[] }`, best score first.

- `title` is required, 1–300 characters after trimming.
- `context` is optional text, up to 20,000 characters. It is compared with
  each task's description.
- `boardId` limits the scan to one board. An unknown board fails with
  `NOT_FOUND`.
- `excludeId` leaves out one task, such as the task being checked. It accepts
  a former key. An unknown task fails with `NOT_FOUND`.
- `limit` is 1–20. The default is 5.

Archived tasks are left out. Only scores above the threshold are returned.
`status` is the stored value, unchanged. Ties keep the newest task first.
The command is a read: it changes no version and appends no event.
Humans and agents can call it.

## Score

Text is normalized first: lower case, no diacritics, no punctuation, and
single spaces. Each word gives its character trigrams, padded with one space
on each side. Words are taken separately, so word order does not change the
set. Two sets are compared with Jaccard similarity: shared trigrams divided by
all trigrams.

The score is the title similarity. When both `context` and the task's
description are present, it adds `0.1` times their similarity. Only the first
500 characters of each are compared. The score is in `[0, 1.1]`, rounded to
three decimals. Context never lowers a score.

The threshold is `0.5`. It was chosen from realistic pairs:

| Pair | Score | Result |
| --- | --- | --- |
| Fix login redirect loop / Login redirect loop fix | 1.00 | shown |
| Add dark mode toggle / Add drak mode toggle | 0.62 | shown |
| Export tasks as CSV / CSV export for tasks | 0.74 | shown |
| Show pull request state in activity log / Show PR state in the activity log | 0.58 | shown |
| Add search to the CLI / CLI search | 0.53 | shown |
| Fix bug in board / Fix bug in CLI | 0.50 | hidden |
| Export tasks as CSV / Import tasks from CSV | 0.48 | hidden |
| Login / Logout | 0.22 | hidden |

Titles that share a long template and differ in one word can pass, such as
"Write the docs for views" and "Write the docs for epics" (0.63).

## Cost

The store scans all tasks in memory. It needs no index and no migration.
With 5,000 tasks, one call takes about 65 ms on a development machine. About
half of that is the task read that `list_tasks` also does. A task's
description is compared only if it can still lift the score above the
threshold. If all 5,000 titles are close and context is sent, a call takes
about 270 ms.

## Interfaces

- HTTP: `POST /api/find_similar_tasks`, like every other command.
- MCP: the `find_similar_tasks` tool is read-only. The server instructions and
  the `create_task` description tell agents to call it first. If a task
  already covers the work, the agent uses it, and records the relation with
  `link_task` type `duplicates` instead of creating a task.
- Pi skill: the copied skill gives the same instruction.
- WebMCP: no tool. The WebMCP tools do not mirror the MCP tools one to one.
- UI: the New task dialog lists **Possible duplicates** under the title. It
  asks after 300 ms without typing, when the trimmed title has at least 4
  characters, for the dialog's board. Each row shows the key, title, and
  status. A row opens the task after the discard confirmation. A failed
  lookup shows no list.
