import { createStore } from "./store.mjs";
import { dbPath, localActor } from "./config.mjs";
import { createChangeFeed } from "./changes.mjs";

/**
 * Connects to the workspace named by the environment. A remote server uses
 * TASKNBOARD_SERVER_URL and TASKNBOARD_TOKEN; otherwise the local SQLite file
 * runs commands as `actor`, the local human by default. Both modes return the
 * same command results.
 */
export function connect({ actor = localActor, env = process.env, database = dbPath } = {}) {
  const remote = env.TASKNBOARD_SERVER_URL;
  if (!remote) {
    const store = createStore(database);
    store.registerActors([actor]);
    const changes = createChangeFeed(store);
    return {
      mode: "local",
      target: database,
      execute: async (name, args = {}) => store.execute(name, args, actor),
      subscribe: (listener) => changes.subscribe(listener),
      close: () => { changes.stop(); store.close(); },
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
  const subscriptions = new Set();
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
        throw Object.assign(new Error(output.message), { code: output.code, details: output.details });
      return output;
    },
    subscribe(listener) {
      const controller = new AbortController();
      subscriptions.add(controller);
      void (async () => {
        let delay = 1000;
        while (!controller.signal.aborted) {
          try {
            const response = await fetch(`${base}/api/stream`, {
              headers: { Authorization: `Bearer ${env.TASKNBOARD_TOKEN}` },
              signal: controller.signal,
            });
            if (!response.ok || !response.body) throw new Error("Change stream unavailable");
            delay = 1000;
            listener();
            const decoder = new TextDecoder();
            let buffer = "";
            for await (const chunk of response.body) {
              buffer += decoder.decode(chunk, { stream: true });
              let end;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const event = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (event.includes("event: change")) listener();
              }
            }
          } catch {
            if (controller.signal.aborted) break;
          }
          await new Promise((resolve) => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, delay);
            controller.signal.addEventListener("abort", done, { once: true });
          });
          delay = Math.min(delay * 2, 30000);
        }
      })();
      return () => { controller.abort(); subscriptions.delete(controller); };
    },
    close: () => { for (const controller of subscriptions) controller.abort(); subscriptions.clear(); },
  };
}
