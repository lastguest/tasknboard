# Lanes contract

A lane is a column of a board. Each board owns an ordered list of lanes. Each
task is in exactly one lane of its own board. Lanes replace the four fixed
statuses `backlog`, `in_progress`, `in_review`, and `done`.

## Roles

Each lane has one role. The role gives the lane its meaning in the agent and
review workflow. The four roles are fixed:

| Role | Meaning | Lane name after the upgrade |
|---|---|---|
| `todo` | Work that nobody does yet. New tasks start here. | Backlog |
| `in_progress` | Claimed or active work. | In progress |
| `in_review` | Work that waits for a human decision. | In review |
| `done` | Work that a human approved. | Done |

Every board has at least one lane of each role. A board can have more lanes
of one role, for example `Inbox` and `Ready` with role `todo`. The interface
gives each role one colour and one icon. Lanes of the same role share them.

The "first lane" of a role is the lane of that role with the lowest position
on the board. The server uses it when a command moves a task to a role.

## Records

```ts
type LaneRole = "todo" | "in_progress" | "in_review" | "done";
type Lane = {
  id: `LANE-${number}`;
  name: string;
  role: LaneRole;
};
type Board = {
  // ...existing fields
  /** In board order. The first entry is the leftmost column. */
  lanes: Lane[];
  /** Non-archived tasks in lanes with role in_progress. */
  inProgress: number;
};
type Task = {
  // ...existing fields, without `status`
  lane: `LANE-${number}`;
  /** The role of the task's lane. Derived on every read, never stored or accepted. */
  role: LaneRole;
};
```

Lane IDs are workspace-unique, allocated in creation order, and never reused.
Names are trimmed, contain 1–40 characters, and are unique on their board
without regard to case. A board has at most 12 lanes. The role of a lane does
not change after creation. To change it, create a lane with the new role,
then delete the old lane into it.

## Commands

Lane writes are board writes. They require a human actor (`FORBIDDEN`
otherwise) and the board's current version (`VERSION_CONFLICT` otherwise).
Each lane write increments the board version, appends an event under the
board ID, and returns the board.

- `create_lane({ boardId, expectedVersion, name, role, position? })` adds a
  lane. `position` is a zero-based index. Without it the lane goes last.
- `update_lane({ id, expectedVersion, patch: { name?, position? } })` renames
  or moves a lane. `expectedVersion` is the version of the lane's board.
- `delete_lane({ id, expectedVersion, moveTo })` removes a lane. `moveTo` is
  another lane on the same board with the same role (`VALIDATION`
  otherwise). Every task in the lane, archived tasks included, moves to
  `moveTo`. So the last lane of a role cannot be deleted.

`create_board` creates four lanes: Backlog, In progress, In review, and Done,
with the four roles in that order.

### Lane deletion and tasks

The moved tasks keep their role, so the review gate and claims stay valid.
Each moved task gets a new version and an event `delete_lane` with the body
`{ from, to }`. An active claim does not block the move and stays on the task.
The agent that holds it reads a version conflict on its next write and reads
the task again, as after `rename_label`. Saved views follow the deletion:
`lane` condition values that name the deleted lane change to `moveTo`.

## Task workflow

`create_task({ lane? })` puts the task in `lane`, or in the first `todo` lane
of the board. `lane` must be a `todo` lane of that board.

`update_task({ patch: { lane } })` moves a task. The lane must be on the
task's board (`VALIDATION` otherwise). The existing lease and version rules
apply first. Then:

- An agent can move its claimed task only to a lane with role
  `in_progress` (`FORBIDDEN` otherwise).
- A human can move a task to a `done` lane only from a lane with role
  `in_review` or `done` (`INVALID_TRANSITION` otherwise).
- A move to a lane with role `in_review` or `done` releases the claim.

`claim_task` accepts a task in a `todo` or `in_progress` lane
(`INVALID_TRANSITION` otherwise). A task in a `todo` lane moves to the first
`in_progress` lane. A task in an `in_progress` lane stays in its lane.

`submit_review` accepts a task in an `in_progress` lane
(`INVALID_TRANSITION` otherwise). The task moves to the first `in_review`
lane, and the claim ends.

Agents cannot put a task in an `in_review` lane except through
`submit_review`. Agents can never put a task in a `done` lane.

In the task page, **Mark Done** moves a task to the first `done` lane. **Needs
changes** moves it to the first `in_progress` lane.

## Reads and filters

- `list_tasks` accepts `role` and `lane` filters. They replace `status`.
- `list_boards`, `workspace_info`, and every board result carry `lanes`.
- Epic `counts` maps each role to the number of non-archived tasks:
  `{ todo, in_progress, in_review, done }`. `archive_epic` fails with
  `EPIC_NOT_EMPTY` while a non-archived task of the epic is not in a `done`
  lane.
- View conditions use the fields `role` and `lane`. They replace `status`.
  `role` values are role IDs. `lane` values are lane IDs of any board.
- The view `groupBy` value `lane` replaces `status` and is the default. The
  board layout always shows the lanes of the selected board as columns.

## Agent events

The agent launcher uses roles:

- `task_assigned` and `changes_requested` start only for a task in a `todo` or
  `in_progress` lane without an active claim.
- `changes_requested` starts when a person moves a task from an `in_review`
  lane to a `todo` or `in_progress` lane.
- `standup` starts for agents with tasks in `in_progress` or `in_review` lanes.
  The prompt names each task's lane.

## MCP and CLI

MCP keeps its current agent tools and adds no lane tools. Agents read lanes
from `list_boards` and `workspace_info`, and each task carries `lane` and
`role`. Agents find work with `list_tasks({ role: "todo" })`. WebMCP keeps its
current tools.

The CLI groups tasks by the lanes of each task's board. `/move <lane>` takes a
lane name, or a unique start of one, on the task's board. `/done` moves a
reviewed task to the first `done` lane.

## Interface

The board shows one column per lane, in board order. The column count follows
the board. A board wider than the window scrolls sideways. Every `todo`
column has a **New task** button. The status menus list the lanes of the
task's board. A `done` lane is unavailable until the task is in review.

The board settings dialog has a Lanes section. A person adds a lane with a
name and a role, renames a lane, moves it up or down, and deletes it. Delete
asks for the lane of the same role that receives its tasks.

## Storage and upgrade

Migration 17 adds a `lanes(number, board_id, position, name, role)` table. For
each board it creates Backlog, In progress, In review, and Done lanes. It
then rewrites stored data in the same transaction:

- Each task's `status` becomes `lane`, the ID of the matching lane on its
  board. The `status` field is removed. Versions do not change.
- Each `update_task` event body with `status` names the matching `lane`
  instead.
- Each view condition on `status` becomes a condition on `role`, with
  `backlog` mapped to `todo`. Each view `groupBy: "status"` becomes `lane`.

`workspace_info` and `export_workspace` report `schemaVersion: 17`. The export
includes every board with its lanes.

## Acceptance criteria

1. After the upgrade, every task is in the lane that matches its former
   status, and its version and activity order are unchanged.
2. A person can add, rename, reorder, and delete lanes. An agent receives
   `FORBIDDEN` for each lane command.
3. A board without a lane of each role cannot exist.
4. Deleting a lane moves all its tasks to a lane of the same role. Views that
   named the lane name the target lane.
5. An agent can claim, heartbeat, release, move between `in_progress` lanes,
   and submit for review. A claim expires after 15 minutes.
6. No agent command puts a task in a `done` lane. No command puts a task in a
   `done` lane from a `todo` or `in_progress` lane.
7. The board, list, views, epics, stand-up, CLI, and agent launcher show and
   use the lanes of each board. No code path uses the old status IDs.
8. Existing tests pass after updates for the new model. New tests cover the
   migration, the lane commands, and the role rules.
9. A browser test creates a lane, moves a task through it, and deletes it.

Not implemented: lanes shared across boards, moving tasks between boards,
work-in-progress limits, and changes to a lane's role.
