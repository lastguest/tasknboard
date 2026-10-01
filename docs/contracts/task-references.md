# Task references contract

A task key in Markdown text, such as `ENG-12`, shows as a small chip in the
web interface. The chip shows the key and the current status of the task.
The stored text does not change. Task references inform; they are not links.

## Recognition

`findTaskReferences(text, lookup)` in `src/task-references.ts` is a pure
function. It finds each key that obeys all of these rules:

- The prefix is a current or former prefix of a board, from `list_boards` data
  that the client already has. A former prefix resolves to the current key.
- The key is in uppercase and its number has no leading zero.
- The key stands alone. No letter, digit, `_`, `-`, `/`, `.` or `@` joins
  either side, so paths, file names and e-mail addresses stay text.
- The key is not in a code span or a URL.
- The task exists. A key whose task the server did not return stays text.

The Markdown renderer gives the function only plain inline text. Code
blocks, link text, image text and autolinks never reach it.

## Reads

- `get_tasks({ ids })` takes 1–100 task keys and returns
  `{ tasks: { id, title, status, archived }[] }`.
- `id` is the current key. A former key resolves as in `get_task`.
- A key without a task is left out. The command does not fail for it.
- The command reads only. It works for people and agents, and appends no event.

The client keeps one cache of these summaries in `src/TaskReferences.tsx`.
Keys asked for in the same render go to the server as one call. After each
`refresh()` of the application, the cache reads all its keys again. The chip
has no timer of its own, so it follows the refresh cycle of the application.

## Chip

The chip is a React element. The renderer never injects HTML.

- The chip shows the key, the status icon and the status label.
  Labels and colors come from `columns` in `src/types.ts`, the source the board uses.
- An archived task shows the label `Archived`.
- The task title shows on hover and on keyboard focus.
- Click or Enter opens the task in a tab. Archived tasks open too, as from
  the **Links** list. A chip in the stand-up first leaves the presentation.
- The chip links to `#task/<key>`, so a modified click opens a new browser tab.

## Interfaces

Chips show wherever the web interface renders Markdown: task descriptions,
comments, review summaries, epic and view descriptions, and pull request text.
The editor has no key completion. The terminal CLI and MCP show task text
unchanged. MCP does not list `get_tasks`. The CLI runs it as it runs every
store command.
