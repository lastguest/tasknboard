import { useEffect, useState } from "react";
import { command, errorOf, token } from "./api";
import { displayName, usePeople } from "./People";

type Connection = {
  id: string;
  identity: string;
  state: "starting" | "connected" | "reconnecting";
};
type Status = { supported: boolean; connections: Connection[] };

export function McpConnections() {
  const people = usePeople();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [restartError, setRestartError] = useState("");
  const [pending, setPending] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const bearer = token.get();
        const response = await fetch("/api/mcp-status", {
          headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || "The MCP status request failed.");
        if (!body || typeof body.supported !== "boolean" || !Array.isArray(body.connections) ||
          !body.connections.every((connection: Connection) => connection &&
            typeof connection.id === "string" && typeof connection.identity === "string" &&
            ["starting", "connected", "reconnecting"].includes(connection.state)))
          throw new Error("The service returned an invalid MCP status.");
        if (!controller.signal.aborted) {
          setStatus(body);
          setError("");
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorOf(failure).message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);

  async function restart(id: string) {
    setPending(id);
    setRestartError("");
    try {
      await command("mcp-restart", { id });
      setRevision((value) => value + 1);
    } catch (failure) {
      setRestartError(errorOf(failure).message);
    } finally {
      setPending("");
    }
  }

  return (
    <section className="integration" aria-labelledby="mcp-status-title">
      <h2 id="mcp-status-title" className="section-title">MCP status</h2>
      {!status && !error && <p className="small" role="status">Loading MCP status…</p>}
      {error && <p className="small" role="alert">{error} The connection status is unavailable.</p>}
      {restartError && <p className="small" role="alert">{restartError}</p>}
      {status && !error && (status.supported ? (
        status.connections.length ? <>
          <p className="small">Restart the MCP connection if the agent cannot use its tools. The agent session stays open.</p>
          <ul className="agents-table">
            {status.connections.map((connection) => (
              <li className="agent-row mcp-connection-row" key={connection.id}>
                <span>{displayName(people, connection.identity)}</span>
                <span role="status">{pending === connection.id ? "Restarting…" : {
                  starting: "Starting", connected: "Connected", reconnecting: "Reconnecting",
                }[connection.state]}</span>
                <span className="agent-row-actions">
                  <button type="button" className="secondary small-button"
                    disabled={!!pending || connection.state === "reconnecting"}
                    aria-label={`Restart MCP for ${displayName(people, connection.identity)}`}
                    onClick={() => void restart(connection.id)}>Restart MCP</button>
                </span>
              </li>
            ))}
          </ul>
        </> : <p className="small" role="status">No active MCP connections. Start an agent with the TasknBoard MCP connection.</p>
      ) : <p className="small">View and restart MCP connections on the local agent host.</p>)}
    </section>
  );
}
