import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";

const human = { id: "you", kind: "human" };
const agent = { id: "claude", kind: "agent" };
const other = { id: "codex", kind: "agent" };

test("unchanged actor registration and reads do not signal workspace changes", (t) => {
  const store = fixture(t);
  const before = store.dataVersion();
  store.registerActors([human, agent, other]);
  store.execute("workspace_info", {}, human);
  store.execute("list_tasks", {}, agent);
  assert.equal(store.dataVersion(), before);
  store.registerActors([{ ...agent, role: "architect" }]);
  assert.notEqual(store.dataVersion(), before);
});

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  store.registerActors([human, agent, other]);
  return store;
}

test("human role grants survive registration and permit planning without a claim", (t) => {
  const store = fixture(t);
  const grant = store.execute("update_profile", { agentId: agent.id, role: "architect" }, human);
  assert.equal(grant.role, "architect");
  store.registerActors([agent]);
  store.registerActors([agent, other]);
  assert.equal(store.execute("workspace_info", {}, agent).actor.role, "architect");
  const epic = store.execute("create_epic", { boardId: "BOARD-1", title: "Plan" }, agent);
  const task = store.execute("create_task", { boardId: "BOARD-1", title: "Work" }, human);
  const planned = store.execute("update_task", { id: task.id, expectedVersion: task.version, patch: { epic: epic.id } }, agent);
  assert.equal(planned.epic, epic.id);
  assert.equal(planned.lease, null);
  assert.equal(store.execute("workspace_info", {}, human).actors.find((a) => a.id === agent.id).role, "architect");
  store.execute("update_profile", { agentId: agent.id, role: "worker" }, human);
  store.registerActors([agent]);
  assert.throws(() => store.execute("create_epic", { boardId: "BOARD-1", title: "Denied" }, agent), { code: "FORBIDDEN" });
  assert.throws(() => store.execute("update_task", { id: planned.id, expectedVersion: planned.version, patch: { title: "Denied" } }, agent), { code: "LEASE_REQUIRED" });
});

test("agent role grants persist across store connections", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tasknboard-roles-"));
  const path = join(directory, "board.db");
  let store = createStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.registerActors([agent]);
  store.execute("update_profile", { agentId: agent.id, role: "architect" }, human);
  store.close();
  store = createStore(path);
  store.registerActors([agent]);
  assert.equal(store.execute("workspace_info", {}, agent).actor.role, "architect");
  assert.equal(store.execute("create_epic", { boardId: "BOARD-1", title: "Saved role" }, agent).title, "Saved role");
});

test("trusted explicit identity roles override the stored grant", (t) => {
  const store = fixture(t);
  store.registerActors([{ ...agent, role: "architect" }]);
  assert.equal(store.execute("workspace_info", {}, agent).actor.role, "architect");
  store.registerActors([{ ...agent, role: "worker" }]);
  assert.throws(() => store.execute("create_epic", { boardId: "BOARD-1", title: "Denied" }, agent), { code: "FORBIDDEN" });
  store.execute("workspace_info", {}, { ...agent, role: "architect" });
  assert.equal(store.execute("workspace_info", {}, agent).actor.role, "architect");
});

test("agents cannot grant roles through profile updates, including architects", (t) => {
  const store = fixture(t);
  for (const caller of [agent, { ...other, role: "architect" }]) {
    for (const agentId of [caller.id, agent.id, other.id]) {
      assert.throws(() => store.execute("update_profile", { agentId, role: "architect" }, caller), { code: "FORBIDDEN" });
    }
    assert.throws(() => store.execute("update_profile", { role: "architect" }, caller), { code: "VALIDATION" });
    assert.throws(() => store.execute("update_profile", { name: "Agent", target: agent.id, role: "architect" }, caller), { code: "VALIDATION" });
  }
  assert.equal(store.execute("workspace_info", {}, agent).actor.role, undefined);
  assert.equal(store.execute("update_profile", { name: "Claude" }, agent).name, "Claude");
});

test("role updates target existing agents and cannot modify profile data", (t) => {
  const store = fixture(t);
  assert.throws(() => store.execute("update_profile", { agentId: human.id, role: "architect" }, human), { code: "VALIDATION" });
  assert.throws(() => store.execute("update_profile", { agentId: "unknown", role: "architect" }, human), { code: "NOT_FOUND" });
  assert.throws(() => store.execute("update_profile", { agentId: agent.id, role: "architect", name: "Changed" }, human), { code: "VALIDATION" });
  assert.throws(() => store.execute("update_profile", { agentId: agent.id }, human), { code: "VALIDATION" });
  assert.equal(store.execute("workspace_info", {}, agent).actor.name, "");
});
