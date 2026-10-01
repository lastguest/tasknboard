import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import {
  normalize,
  similarityScorer,
  similarityThreshold,
} from "../server/similarity.mjs";
const human = { id: "you", kind: "human" };
const score = (a, b, context, description) =>
  similarityScorer(a, context)({ title: b, description: description ?? "" });

test("normalize drops case, diacritics, punctuation and extra spaces", () => {
  assert.equal(normalize("  Modalità   SCURA: on/off! "), "modalita scura on off");
});

test("similarity scores realistic title pairs around the threshold", () => {
  assert.equal(score("Add dark mode toggle", "add dark-mode toggle!"), 1);
  assert.equal(score("Fix login redirect loop", "Login redirect loop fix"), 1);
  // A typo stays above the threshold.
  assert.ok(score("Add dark mode toggle", "Add drak mode toggle") > similarityThreshold);
  assert.ok(score("Export tasks as CSV", "CSV export for tasks") > similarityThreshold);
  // Unrelated titles, and titles that share only a template, stay below it.
  assert.equal(score("Add dark mode toggle", "Fix login redirect loop"), 0);
  assert.ok(score("Export tasks as CSV", "Import tasks from CSV") <= similarityThreshold);
  assert.ok(score("Fix bug in board", "Fix bug in CLI") <= similarityThreshold);
  // Short titles: identical ones match, near ones do not.
  assert.equal(score("Login", "login"), 1);
  assert.ok(score("Login", "Logout") <= similarityThreshold);
  assert.ok(score("UI", "UI polish") <= similarityThreshold);
});

test("context adds a small weight only when both sides have it", () => {
  const title = score("Add dark mode toggle", "Add a dark mode toggle");
  const same = "Settings page switch between light and dark theme";
  assert.equal(score("Add dark mode toggle", "Add a dark mode toggle", same), title);
  assert.equal(
    score("Add dark mode toggle", "Add a dark mode toggle", same, same),
    title + 0.1,
  );
  assert.ok(score("x", "y", same, same) <= 0.1);
});

test("find_similar_tasks reads non-archived tasks, by board, best first", (t) => {
  const s = createStore(":memory:");
  t.after(() => s.close());
  const other = s.execute("create_board", { name: "Ops", prefix: "OPS" }, human);
  const make = (title, boardId = "BOARD-1", description = "") =>
    s.execute("create_task", { boardId, title, description }, human);
  const exact = make("Add dark mode toggle");
  const typo = make("Add drak mode toggle");
  const archived = make("Add dark mode toggles");
  s.execute("archive_task", { id: archived.id, expectedVersion: 1 }, human);
  make("Fix login redirect loop");
  const elsewhere = make("Add dark mode toggle", other.id);
  const find = (args) =>
    s.execute("find_similar_tasks", { title: "Add dark mode toggle", ...args }, human);

  const all = find({});
  assert.deepEqual(
    all.tasks.map((task) => task.id),
    [elsewhere.id, exact.id, typo.id],
  );
  assert.deepEqual(Object.keys(all.tasks[0]), ["id", "title", "status", "score"]);
  assert.equal(all.tasks[0].status, "backlog");
  assert.equal(all.tasks[0].score, 1);
  assert.deepEqual(
    find({ boardId: "BOARD-1" }).tasks.map((task) => task.id),
    [exact.id, typo.id],
  );
  assert.deepEqual(
    find({ boardId: "BOARD-1", excludeId: exact.id }).tasks.map((task) => task.id),
    [typo.id],
  );
  assert.equal(find({ limit: 1 }).tasks.length, 1);
  assert.deepEqual(find({ title: "Write release notes" }).tasks, []);
  // A read: no new version or event.
  assert.equal(s.execute("get_task", { id: exact.id }, human).version, 1);
  assert.throws(() => find({ boardId: "BOARD-99" }), { code: "NOT_FOUND" });
  assert.throws(() => find({ excludeId: "TNB-999" }), { code: "NOT_FOUND" });
  assert.throws(() => find({ limit: 21 }), { code: "VALIDATION" });
});
