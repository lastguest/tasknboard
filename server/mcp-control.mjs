import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const validId = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const directory = (database) => `${resolve(database)}.mcp`;
const unavailable = (code, message) => Object.assign(new Error(message), {
  code, status: { MCP_CONNECTION_NOT_FOUND: 404, MCP_CONTROL_UNAVAILABLE: 503, MCP_CONTROL_UNSUPPORTED: 400 }[code],
});

// The secret stays in the local registry. The UI only receives public status.
export function startMcpControl({ database, identity, status, restart, diagnostics }) {
  const id = randomUUID(), token = randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  const recordPath = join(directory(database), `${id}.json`);
  const connection = () => ({ id, identity, ...status(), startedAt });
  let stopped = false;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.end(JSON.stringify({ connection: connection() }));
    } else if (request.method === "POST" && request.url === "/restart") {
      restart();
      response.end(JSON.stringify({ connection: connection() }));
    } else response.writeHead(404).end(JSON.stringify({ message: "Not found" }));
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  server.on("error", (error) => diagnostics?.write(`TasknBoard MCP control: ${error.message}\n`));
  server.listen(0, "127.0.0.1", () => {
    if (stopped) return;
    try {
      mkdirSync(directory(database), { recursive: true, mode: 0o700 });
      writeFileSync(recordPath, JSON.stringify({ id, token, port: server.address().port }), { mode: 0o600 });
    } catch (error) {
      diagnostics?.write(`TasknBoard MCP control: ${error.message}\n`);
      server.close();
    }
  });
  return {
    stop() {
      stopped = true;
      try { unlinkSync(recordPath); } catch (error) { if (error.code !== "ENOENT") diagnostics?.write(`TasknBoard MCP control: ${error.message}\n`); }
      server.close();
      server.closeAllConnections();
    },
  };
}

function readRecord(database, id) {
  if (!validId(id)) return null;
  try {
    const record = JSON.parse(readFileSync(join(directory(database), `${id}.json`), "utf8"));
    if (record.id !== id || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
      || typeof record.token !== "string" || !/^[0-9a-f]{64}$/.test(record.token)) return null;
    return record;
  } catch { return null; }
}

async function controlRequest(record, action) {
  const response = await fetch(`http://127.0.0.1:${record.port}/${action}`, {
    method: action === "restart" ? "POST" : "GET",
    headers: { Authorization: `Bearer ${record.token}` },
    signal: AbortSignal.timeout(1500),
    redirect: "error",
  });
  if (!response.ok) throw new Error("MCP control request failed");
  const { connection } = await response.json();
  if (connection?.id !== record.id || !["starting", "connected", "reconnecting"].includes(connection.state))
    throw new Error("Invalid MCP control status");
  return { id: connection.id, identity: connection.identity, state: connection.state,
    workerPid: connection.workerPid, startedAt: connection.startedAt };
}

export async function listMcpConnections(database) {
  if (process.env.TASKNBOARD_SERVER_URL) return { supported: false, connections: [] };
  let files;
  try { files = readdirSync(directory(database)); }
  catch (error) { if (error.code === "ENOENT") return { supported: true, connections: [] }; throw error; }
  const records = files.filter((file) => file.endsWith(".json")).map((file) => readRecord(database, file.slice(0, -5))).filter(Boolean);
  const results = await Promise.allSettled(records.map((record) => controlRequest(record, "status")));
  const connections = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  connections.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return { supported: true, connections };
}

export async function restartMcpConnection(database, id) {
  if (process.env.TASKNBOARD_SERVER_URL)
    throw unavailable("MCP_CONTROL_UNSUPPORTED", "MCP control requires a local database.");
  const record = readRecord(database, id);
  if (!record) throw unavailable("MCP_CONNECTION_NOT_FOUND", "The MCP connection does not exist.");
  try { return { connection: await controlRequest(record, "restart") }; }
  catch { throw unavailable("MCP_CONTROL_UNAVAILABLE", "The MCP connection is no longer available."); }
}
