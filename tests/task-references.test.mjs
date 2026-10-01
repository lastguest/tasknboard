import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import {
  findTaskReferences,
  referencePrefixes,
} from "../src/task-references.ts";

const human = { id: "you", kind: "human" };
const summary = (id) => ({ id, title: `Task ${id}`, status: "backlog", archived: false });
const lookup = {
  // ENG was renamed from DEV; OPS is a second board.
  prefixes: referencePrefixes([
    { prefix: "ENG", formerPrefixes: ["DEV"] },
    { prefix: "OPS", formerPrefixes: [] },
  ]),
  tasks: new Map([
    ["ENG-12", summary("ENG-12")],
    ["OPS-3", summary("OPS-3")],
    ["ENG-99", null],
  ]),
};
const ids = (text) => findTaskReferences(text, lookup).map((r) => r.id);

test("task references match keys with a known prefix or alias", () => {
  const [ref] = findTaskReferences("See ENG-12.", lookup);
  assert.deepEqual(ref, { start: 4, end: 10, id: "ENG-12", task: summary("ENG-12") });
  // A former prefix resolves to the task's current key.
  assert.deepEqual(ids("Was DEV-12, now (OPS-3)"), ["ENG-12", "OPS-3"]);
  // A task not read yet is a reference without a task.
  assert.deepEqual(findTaskReferences("ENG-5", lookup), [{ start: 0, end: 5, id: "ENG-5" }]);
});

test("task references skip unknown prefixes, missing tasks, code spans and URLs", () => {
  assert.deepEqual(ids("ABC-12 and UTF-8"), []);
  assert.deepEqual(ids("ENG-99 does not exist"), []);
  assert.deepEqual(ids("run `ENG-12` or ``x ENG-12 y``"), []);
  assert.deepEqual(
    ids("https://x.test/browse/ENG-12 www.x.test/ENG-12 a/ENG-12 eng-12 ENG-12x ENG-12-2 me@ENG-12.io"),
    [],
  );
});

test("get_tasks reads summaries by key, alias included, and leaves out missing keys", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const [board] = store.execute("list_boards", {}, human).boards;
  const first = store.execute("create_task", { boardId: board.id, title: "First" }, human);
  const second = store.execute("create_task", { boardId: board.id, title: "Second" }, human);
  store.execute("archive_task", { id: second.id, expectedVersion: second.version }, human);
  store.execute(
    "update_board",
    { id: board.id, expectedVersion: board.version, patch: { prefix: "NEW" } },
    human,
  );

  assert.deepEqual(
    store.execute("get_tasks", { ids: [first.id, "NEW-2", "NEW-404"] }, human),
    {
      tasks: [
        { id: "NEW-1", title: "First", status: "backlog", archived: false },
        { id: "NEW-2", title: "Second", status: "backlog", archived: true },
      ],
    },
  );
  assert.throws(() => store.execute("get_tasks", { ids: [] }, human), {
    code: "VALIDATION",
  });
});
