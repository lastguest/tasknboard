import { createStore } from "./store.mjs";
import { dbPath, localActor } from "./config.mjs";

/**
 * Connects to the workspace named by the environment. A remote server uses
 * TASKNBOARD_SERVER_URL and TASKNBOARD_TOKEN; otherwise the local SQLite file
 * runs commands as `actor`, the local human by default. Both modes return the
 * same command results.
 */
export function connect({ actor = localActor, env = process.env } = {}) {
  const remote = env.TASKNBOARD_SERVER_URL;
  if (!remote) {
    const store = createStore(dbPath);
    store.registerActors([actor]);
    return {
      mode: "local",
      target: dbPath,
      execute: async (name, args = {}) => store.execute(name, args, actor),
      close: () => store.close(),
    };
  }
  const url = new URL(remote);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    throw new Error(
      "Remote credentials require HTTPS (HTTP allowed only on loopback)",
    );
  if (!env.TASKNBOARD_TOKEN)
    throw new Error("A remote server requires TASKNBOARD_TOKEN");
  const base = remote.replace(/\/$/, "");
  return {
    mode: "remote",
    target: base,
    async execute(name, args = {}) {
      let res;
      try {
        res = await fetch(`${base}/api/${name}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.TASKNBOARD_TOKEN}`,
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        throw Object.assign(
          new Error(`Can't reach ${base}: ${error.message}`),
          { code: "NETWORK" },
        );
      }
      const output = await res.json();
      if (!res.ok)
        throw Object.assign(new Error(output.message), { code: output.code });
      return output;
    },
    close: () => {},
  };
}
