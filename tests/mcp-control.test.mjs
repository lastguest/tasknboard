import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listMcpConnections, restartMcpConnection, startMcpControl } from "../server/mcp-control.mjs";

test("MCP control requires its secret and excludes stale registry records", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-control-auth-")), database = join(dir, "test.sqlite");
  let restarts = 0;
  const control = startMcpControl({ database, identity: "local-agent",
    status: () => ({ state: "connected", workerPid: 12345 }), restart: () => { restarts++; } });
  t.after(() => { control.stop(); rmSync(dir, { recursive: true, force: true }); });
  let record;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const files = readdirSync(`${database}.mcp`);
      if (files.length) { record = JSON.parse(readFileSync(join(`${database}.mcp`, files[0]), "utf8")); break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(record);
  const url = `http://127.0.0.1:${record.port}/restart`;
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal(restarts, 0);
  const listed = await listMcpConnections(database);
  assert.equal(listed.connections.length, 1);
  assert.equal(listed.connections[0].identity, "local-agent");
  assert.equal(JSON.stringify(listed).includes(record.token), false);
  await restartMcpConnection(database, record.id);
  assert.equal(restarts, 1);
  await assert.rejects(restartMcpConnection(database, "../../outside"), { code: "MCP_CONNECTION_NOT_FOUND", status: 404 });
  control.stop();
  writeFileSync(join(`${database}.mcp`, `${record.id}.json`), JSON.stringify(record));
  assert.deepEqual(await listMcpConnections(database), { supported: true, connections: [] });
  await assert.rejects(restartMcpConnection(database, record.id), { code: "MCP_CONTROL_UNAVAILABLE", status: 503 });
  assert.equal(restarts, 1);
});

test("remote MCP control reports that local restart is unsupported", async (t) => {
  const previous = process.env.TASKNBOARD_SERVER_URL;
  process.env.TASKNBOARD_SERVER_URL = "https://example.invalid";
  t.after(() => {
    if (previous === undefined) delete process.env.TASKNBOARD_SERVER_URL;
    else process.env.TASKNBOARD_SERVER_URL = previous;
  });
  assert.deepEqual(await listMcpConnections("unused.sqlite"), { supported: false, connections: [] });
  await assert.rejects(restartMcpConnection("unused.sqlite", "unused"), { code: "MCP_CONTROL_UNSUPPORTED", status: 400 });
});
