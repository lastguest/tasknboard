import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const run = promisify(execFile);
const actor = { id: "tasknboard/commit-links", kind: "agent", role: "architect" };
const batchSize = 200;
const taskKeys = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]{0,9}-\d+(?![A-Za-z0-9_-])/g;
const git = async (repository, args) => (await run("git", ["-C", repository, ...args], {
  encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
})).stdout;

/** Only the configured origin HEAD identifies the default branch. Uncertain evidence fails closed. */
export function areTaskCommitsOnDefaultBranch(repository, commits) {
  if (typeof repository !== "string" || !repository || !Array.isArray(commits) || !commits.length || commits.length > 20
    || commits.some(sha => typeof sha !== "string" || !/^[a-f0-9]{7,40}$/i.test(sha))) return false;
  const read = (args, input) => execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"], input,
  }).trim();
  try {
    const configured = read(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (!configured.startsWith("refs/remotes/origin/") || configured === "refs/remotes/origin/HEAD") return false;
    const local = `refs/heads/${configured.slice("refs/remotes/origin/".length)}`;
    const refs = new Map(read(["for-each-ref", "--format=%(refname) %(objectname)", local, configured])
      .split("\n").map(line => line.split(" ")));
    const target = refs.get(local) ?? refs.get(configured);
    if (!target) return false;
    const unique = [...new Set(commits)];
    if (read(["cat-file", "--batch-check=%(objecttype)"], `${unique.join("\n")}\n`)
      .split(/\r?\n/).some(type => type !== "commit")) return false;
    return read(["rev-list", "--max-count=1", ...unique, "--not", target, "--"]) === "";
  } catch { return false; }
}

/** Read Git records as data. A missing commit stays visible in unavailable. */
export async function readTaskCommitSummary(repository, commits = []) {
  const result = { commits: [], filesChanged: [], unavailable: [] };
  const files = new Map();
  for (const sha of [...new Set(commits)]) {
    if (typeof sha !== "string" || !/^[a-f0-9]{7,40}$/i.test(sha)) {
      throw Object.assign(new Error("A commit must be a hexadecimal SHA."), { code: "VALIDATION" });
    }
    let output;
    try { output = await git(repository, ["show", "--format=%H%x00%s%x00", "--numstat", "-z", "--no-renames", "--diff-merges=first-parent", sha, "--"]); }
    catch { result.unavailable.push(sha); continue; }
    const [resolvedSha, subject, ...records] = output.split("\0");
    const commit = { sha: resolvedSha.trim(), subject, files: [] };
    for (const record of records) {
      const match = /^\s*(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
      if (!match) continue;
      const binary = match[1] === "-" || match[2] === "-";
      const file = { path: match[3], additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary };
      commit.files.push(file);
      const total = files.get(file.path) ?? { path: file.path, additions: 0, deletions: 0, binary: false };
      total.additions += file.additions; total.deletions += file.deletions; total.binary ||= binary;
      files.set(file.path, total);
    }
    result.commits.push(commit);
  }
  result.filesChanged = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

/** Scan local commits and retain deferred links until their tasks release their leases. */
export function createCommitLinks(store, { intervalMs = 30000, clock = Date.now, onError = () => {} } = {}) {
  let timer;
  let running;
  let stopped = false;
  const readGit = async (repository, args) => (await git(repository, args)).trim();

  async function scan(repository, boardIds) {
    const key = `commit-links:${createHash("sha256").update(repository).digest("hex")}`;
    let saved;
    try { saved = JSON.parse(store.setting(key) || "{}"); } catch { saved = {}; }
    const pending = new Map((saved.pending ?? []).map((item) => [`${item.id}:${item.sha}`, item]));
    const head = await readGit(repository, ["rev-parse", "--verify", "HEAD"]);
    let cursor = saved.cursor;
    if (cursor && cursor !== head) {
      try { await readGit(repository, ["merge-base", "--is-ancestor", cursor, head]); }
      catch { cursor = undefined; }
    }
    if (cursor !== head) {
      const range = cursor ? `${cursor}..${head}` : head;
      // Read the oldest new batch. The first scan only reads recent history.
      const branchTasks = [];
      for (const boardId of boardIds) {
        for (let offset = 0; ; offset += 100) {
          const page = store.execute("list_tasks", { boardId, offset, limit: 100 }, actor).tasks;
          branchTasks.push(...page.filter(task => task.branch));
          if (page.length < 100) break;
        }
      }
      const count = cursor ? Number(await readGit(repository, ["rev-list", "--count", range])) : batchSize;
      const output = await readGit(repository, ["log", "--reverse", `--max-count=${batchSize}`,
        `--skip=${Math.max(0, count - batchSize)}`, "--format=%H%x00%P%x00%B%x00", range, "--"]);
      const fields = output.split("\0");
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const sha = fields[i].trim();
        if (!/^[a-f0-9]{40}$/.test(sha)) continue;
        cursor = sha;
        const message = fields[i + 2];
        const ids = new Set(message.match(taskKeys) ?? []);
        if (fields[i + 1].trim().split(/\s+/).length > 1) {
          for (const task of branchTasks) {
            const escaped = task.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (new RegExp(`(?<![A-Za-z0-9_./-])${escaped}(?![A-Za-z0-9_./-])`).test(message)) ids.add(task.id);
          }
        }
        for (const id of ids) {
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
      try {
        await scan(repository, boardIds);
        store.completeEvidenceTasks(boardIds, actor);
      } catch (error) { onError(error, repository); }
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
