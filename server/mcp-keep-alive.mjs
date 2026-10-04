const taskOperations = new Set([
  "get_task", "get_tasks", "update_task", "set_standup_notes", "claim_task", "heartbeat", "release_task",
  "delegate_task", "request_changes", "reject_task", "link_commits", "add_comment", "submit_review", "archive_task",
  "restore_task", "link_task", "unlink_task", "link_pull_requests", "unlink_pull_request", "bulk_move_tasks",
  "claim_tasks", "add_comments", "submit_reviews", "undo_task", "reorder_task", "critical_path",
]);

/** Only explicit task arguments can keep a claim active. */
export function taskCallIds(name, args = {}) {
  if (!taskOperations.has(name) || !args || typeof args !== "object") return [];
  const values = [args.id, ...(Array.isArray(args.ids) ? args.ids : [])];
  for (const field of ["tasks", "comments", "reviews"])
    if (Array.isArray(args[field])) values.push(...args[field].map(item => item?.id));
  return [...new Set(values.filter(id => typeof id === "string" && /^[A-Z][A-Z0-9]{0,9}-\d+$/.test(id)
    && !/^(BOARD|EPIC|VIEW)-/.test(id)))].slice(0, 100);
}

/** The supervisor owns the timer, so a blocked adapter cannot stop renewal. */
export function createTaskKeepAlive({ execute, close = () => {}, onError = () => {}, intervalMs = 30000,
  schedule = setInterval, cancel = clearInterval }) {
  const calls = new Map();
  let timer, stopped = false, queue = Promise.resolve(), stopping, ticking = false;
  const ids = () => [...new Set([...calls.values()].flat())];
  function refresh(requestIds) {
    queue = queue.then(async () => {
      if (stopped) return;
      const active = new Set(ids());
      const scoped = requestIds.filter(id => active.has(id));
      for (let offset = 0; offset < scoped.length && !stopped; offset += 100) {
        try { await execute("keep_alive", { ids: scoped.slice(offset, offset + 100) }); }
        catch (error) { onError(error); }
      }
    });
    return queue;
  }
  function finish(requestId) {
    calls.delete(requestId);
    if (!calls.size && timer !== undefined) { cancel(timer); timer = undefined; }
  }
  return {
    async start(requestId, name, args) {
      const scoped = taskCallIds(name, args);
      if (!scoped.length || stopped) return;
      calls.set(requestId, scoped);
      if (timer === undefined) {
        timer = schedule(() => {
          if (ticking) return;
          ticking = true;
          void refresh(ids()).finally(() => { ticking = false; });
        }, intervalMs);
        timer?.unref?.();
      }
      await refresh(scoped);
    },
    finish,
    cancelAll() { for (const requestId of calls.keys()) finish(requestId); },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      for (const requestId of calls.keys()) finish(requestId);
      stopping = queue.then(close);
      return stopping;
    },
  };
}
