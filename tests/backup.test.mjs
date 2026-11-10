import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createStore } from "../server/store.mjs";

test("SQLite backup restores tasks, images, links, and activity to an isolated workspace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-backup-"));
  const source = join(directory, "workspace.sqlite");
  const snapshot = join(directory, "restored.sqlite");
  const store = createStore(source);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const actor = { id: "reviewer", kind: "human" };
  const command = (name, args) => store.execute(name, args, actor);
  const image = command("upload_image", { data: "data:image/png;base64,iVBORw0KGgo=" });
  const first = command("create_task", {
    boardId: "BOARD-1", title: "First", description: `![Proof](${image.url})`,
  });
  const second = command("create_task", { boardId: "BOARD-1", title: "Second" });
  const linked = command("link_task", {
    id: first.id, target: second.id, expectedVersion: first.version, type: "blocks",
  });
  command("add_comment", { id: linked.id, expectedVersion: linked.version, body: "Recovery proof" });
  const expected = command("export_workspace", {});

  const reader = new DatabaseSync(source, { readOnly: true });
  try { await backup(reader, snapshot); } finally { reader.close(); }
  const check = new DatabaseSync(snapshot, { readOnly: true });
  try {
    assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { check.close(); }
  const restored = createStore(snapshot);
  try {
    const actual = restored.execute("export_workspace", {}, actor);
    for (const key of ["tasks", "images", "taskLinks", "events"])
      assert.deepEqual(actual[key], expected[key], key);
  } finally { restored.close(); }
});
