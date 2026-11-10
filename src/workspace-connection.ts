import { command, errorOf, nativeWorkspace, token, type ApiError } from "./api";
import { embeddedApp, workspaceChanged } from "./embedded";

/**
 * Follows the server's change stream until `signal` aborts. Calls `onChange`
 * when the stream opens, on each change event, and when an open stream is
 * lost: each time the loaded data may be stale. Reconnects with a backoff
 * from 1 s to 30 s. EventSource cannot send the bearer header, so this reads
 * the stream with fetch.
 */
export async function subscribeChanges(
  onChange: () => void,
  signal: AbortSignal,
  onError: (error: ApiError) => void,
) {
  if (signal.aborted) return;
  const desktop = nativeWorkspace();
  if (embeddedApp() || desktop) {
    let revision = "";
    let checking = false;
    let disconnected = false;
    const poll = async () => {
      if (checking || signal.aborted || (!desktop && document.visibilityState === "hidden")) return;
      checking = true;
      try {
        const value = await command<{ instanceId: string; revision: string }>("workspace-revision", {}, signal);
        const next = JSON.stringify(value);
        if (!signal.aborted && (disconnected || next !== revision)) {
          revision = next;
          disconnected = false;
          onChange();
        }
      } catch (error) {
        if (!signal.aborted) {
          disconnected = true;
          onError(errorOf(error));
        }
      }
      finally { checking = false; }
    };
    const changed = () => { if (!signal.aborted) onChange(); };
    const timer = window.setInterval(() => void poll(), 3000);
    workspaceChanged.addEventListener("change", changed);
    void poll();
    await new Promise<void>(resolve => {
      signal.addEventListener("abort", () => {
        window.clearInterval(timer);
        workspaceChanged.removeEventListener("change", changed);
        resolve();
      }, { once: true });
    });
    return;
  }
  let delay = 1000;
  while (!signal.aborted) {
    // The server pings every 25 s; silence means a dead connection.
    const idle = new AbortController();
    let timer = 0;
    const alive = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => idle.abort(), 60000);
    };
    let opened = false;
    try {
      const bearer = token.get();
      alive();
      const res = await fetch("/api/stream", {
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
        signal: AbortSignal.any([signal, idle.signal]),
      });
      if (res.ok && res.body) {
        opened = true;
        delay = 1000;
        onChange();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          alive();
          buffer += value;
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          if (blocks.some((b) => b.split("\n").includes("event: change")))
            onChange();
        }
      }
    } catch {
      // A failed or dropped stream reconnects below.
    } finally {
      window.clearTimeout(timer);
    }
    if (signal.aborted) return;
    if (opened) onChange();
    await new Promise<void>((resolve) => {
      const wait = window.setTimeout(resolve, delay);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(wait);
          resolve();
        },
        { once: true },
      );
    });
    delay = Math.min(delay * 2, 30000);
  }
}
