import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveConnection } from "./runtime.mjs";

/** Every CLI operation reaches the resident service. This module never opens SQLite. */
export function connect({ actor, env = process.env } = {}) {
  let connection;
  let closed = false;
  const initialize = () =>
    (connection ??= (async () => {
      const resolved = await resolveConnection({ actor, env });
      const client = new Client({ name: "tasknboard-cli", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(resolved.url, {
        requestInit: { headers: { Authorization: `Bearer ${resolved.token}` } },
        reconnectionOptions: { maxRetries: 0 },
      });
      try {
        await client.connect(transport);
      } catch {
        await client.close();
        throw Object.assign(
          new Error(
            "Cannot connect to the TasknBoard MCP service. Check service status and credentials.",
          ),
          { code: "SERVICE_UNAVAILABLE" },
        );
      }
      return { client, transport };
    })());
  return {
    mode: env.TASKNBOARD_SERVER_URL ? "remote" : "local",
    target: env.TASKNBOARD_SERVER_URL || "resident service",
    async execute(name, args = {}) {
      if (closed)
        throw Object.assign(new Error("The MCP connection is closed."), {
          code: "CONNECTION_CLOSED",
        });
      const attempt = initialize();
      const { client } = await attempt.catch(error => {
        if (connection === attempt) connection = undefined;
        throw error;
      });
      let result;
      try {
        result = await client.callTool({ name, arguments: args });
      } catch (error) {
        if (connection === attempt) {
          connection = undefined;
          await client.close().catch(() => {});
        }
        throw Object.assign(
          new Error(
            `The MCP request failed: ${error.message}. A write may have completed; read its state before retrying.`,
          ),
          { code: "NETWORK" },
        );
      }
      if (result.isError) {
        let error;
        try {
          error = JSON.parse(
            result.content?.find((item) => item.type === "text")?.text || "{}",
          );
        } catch {
          error = {};
        }
        throw Object.assign(
          new Error(error.message || "The MCP command failed."),
          { code: error.code || "ERROR", status: error.status, details: error.details },
        );
      }
      return (
        result.structuredContent ??
        JSON.parse(result.content.find((item) => item.type === "text").text)
      );
    },
    async close() {
      closed = true;
      if (!connection) return;
      const active = await connection.catch(() => null);
      if (!active) return;
      const { client, transport } = active;
      if (transport.sessionId)
        await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}
