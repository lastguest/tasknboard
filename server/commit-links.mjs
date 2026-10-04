import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const run = promisify(execFile);
const actor = { id: "tasknboard/commit-links", kind: "agent", role: "architect" };
const batchSize = 200;
const taskKeys = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]{0,9}-\d+(?![A-Za-z0-9_-])/g;

/** Scan local commits and retain deferred links until their tasks release their leases. */
export function createCommitLinks(store, { intervalMs = 30000, clock = Date.now, onError = () => {} } = {}) {
  let timer;
  let running;
  let stopped = false;
  const git = async (repository, args) => (await run("git", ["-C", repository, ...args], {
    encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })).stdout.trim();

  async function scan(repository, boardIds) {
    const key = `commit-links:${createHash("sha256").update(repository).digest("hex")}`;
    let saved;
    try { saved = JSON.parse(store.setting(key) || "{}"); } catch { saved = {}; }
    const pending = new Map((saved.pending ?? []).map((item) => [`${item.id}:${item.sha}`, item]));
    const head = await git(repository, ["rev-parse", "--verify", "HEAD"]);
    let cursor = saved.cursor;
    if (cursor && cursor !== head) {
      try { await git(repository, ["merge-base", "--is-ancestor", cursor, head]); }
      catch { cursor = undefined; }
    }
    if (cursor !== head) {
      const range = cursor ? `${cursor}..${head}` : head;
      // Read the oldest new batch. The first scan only reads recent history.
      const count = cursor ? Number(await git(repository, ["rev-list", "--count", range])) : batchSize;
      const output = await git(repository, ["log", "--reverse", `--max-count=${batchSize}`,
        `--skip=${Math.max(0, count - batchSize)}`, "--format=%H%x00%B%x00", range, "--"]);
      const fields = output.split("\0");
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const sha = fields[i].trim();
        if (!/^[a-f0-9]{40}$/.test(sha)) continue;
        cursor = sha;
        for (const id of new Set(fields[i + 1].match(taskKeys) ?? [])) {
          try {
            const task = store.execute("get_task", { id }, actor);
            if (boardIds.has(task.boardId)) pending.set(`${task.id}:${sha}`, { id: task.id, sha });
          } catch (error) {
            if (error.code !== "NOT_FOUND") throw error;
          }
        }
      }
      if (!cursor) cursor = head;
    }
    for (const [pendingKey, { id, sha }] of pending) {
      try {
        const task = store.execute("get_task", { id }, actor);
        if (!boardIds.has(task.boardId) || task.commits?.includes(sha)) {
          pending.delete(pendingKey);
          continue;
        }
        // A background link must not invalidate a worker's current task version.
        if (task.lease?.expiresAt > clock()) continue;
        store.execute("link_commits", { id: task.id, expectedVersion: task.version, commits: [sha] }, actor);
        pending.delete(pendingKey);
      } catch (error) {
        if (error.code === "NOT_FOUND" || error.code === "ARCHIVED") pending.delete(pendingKey);
        else if (!["VERSION_CONFLICT", "LEASE_CONFLICT"].includes(error.code)) throw error;
      }
    }
    store.setSettings({ [key]: JSON.stringify({ cursor, pending: [...pending.values()] }) });
  }

  async function scanAll() {
    const repositories = new Map();
    for (const board of store.boards()) {
      if (!board.repository) continue;
      const repository = resolve(board.repository);
      const pathKey = process.platform === "win32" ? repository.toLowerCase() : repository;
      const group = repositories.get(pathKey) ?? { repository, boardIds: new Set() };
      group.boardIds.add(board.id);
      repositories.set(pathKey, group);
    }
    for (const { repository, boardIds } of repositories.values()) {
      if (stopped) break;
      try { await scan(repository, boardIds); } catch (error) { onError(error, repository); }
    }
  }

  function check() {
    if (stopped) return Promise.resolve();
    if (!running) running = scanAll().catch((error) => { onError(error); }).finally(() => { running = undefined; });
    return running;
  }
  function start() {
    if (timer) return;
    stopped = false;
    void check();
    timer = setInterval(() => { void check(); }, intervalMs);
    timer.unref();
  }
  async function stop() {
    stopped = true;
    clearInterval(timer);
    timer = undefined;
    await running;
  }
  return { check, start, stop };
}
