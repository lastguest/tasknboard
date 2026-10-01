import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../server/store.mjs";

const token = "test-only-human-token-123456789";
const human = { id: "reviewer", kind: "human" };

/** Reads an event stream and resolves `next()` on each `change` event. */
async function openStream(base, signal) {
  const res = await fetch(`${base}/api/stream`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return async function next(timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const expired = new Promise((_, reject) =>
      timeout.addEventListener("abort", () => reject(new Error("No change event"))),
    );
    expired.catch(() => {});
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.split("\n").includes("event: change")) return block;
        continue;
      }
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) throw new Error("Stream ended");
      buffer += value;
    }
  };
}

test("the event stream reports HTTP writes and writes from another store on the same file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-live-"));
  const dbPath = join(dir, "db.sqlite");
  const service = spawn(process.execPath, ["server/http.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      TASKNBOARD_DB: dbPath,
      TASKNBOARD_TOKENS: JSON.stringify({ [token]: human }),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const streams = new AbortController();
  t.after(async () => {
    streams.abort();
    service.kill();
    await new Promise((r) => (service.exitCode !== null ? r() : service.once("exit", r)));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let log = "";
    service.stderr.on("data", (c) => {
      log += c;
      const found = log.match(/listening on (http:\/\/\S+)/);
      if (found) resolve(found[1]);
    });
    service.once("exit", () => reject(new Error(`Server exited: ${log}`)));
  });

  assert.equal((await fetch(`${base}/api/stream`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/stream`, {
        headers: { Authorization: "Bearer wrong-token-wrong-token-1234" },
      })
    ).status,
    401,
  );

  const next = await openStream(base, streams.signal);
  const post = async (name, args) => {
    const res = await fetch(`${base}/api/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  const info = await post("workspace_info", {});
  await post("create_task", { boardId: info.boards[0].id, title: "From HTTP" });
  assert.match(await next(2000), /^event: change\ndata: \{\}$/);

  // A local MCP or CLI process opens its own store on the same file.
  const other = createStore(dbPath);
  try {
    other.execute("create_task", { boardId: info.boards[0].id, title: "From MCP" }, human);
  } finally {
    other.close();
  }
  await next(2000);
});
