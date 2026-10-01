/**
 * One change feed per server. It reads the store's data version on a timer,
 * so writes from other processes on the same SQLite file are seen too.
 * Subscribers get at most one signal per `gapMs`.
 */
export function createChangeFeed(store, { pollMs = 500, gapMs = 250 } = {}) {
  const listeners = new Set();
  let version = store.dataVersion();
  let last = 0;
  let pending = null;
  const emit = () => {
    pending = null;
    last = Date.now();
    for (const listener of listeners) listener();
  };
  /** Signals subscribers if the database changed since the last check. */
  const check = () => {
    const next = store.dataVersion();
    if (next === version) return;
    version = next;
    if (pending) return;
    const wait = last + gapMs - Date.now();
    if (wait <= 0) emit();
    else pending = setTimeout(emit, wait);
  };
  const timer = setInterval(check, pollMs);
  timer.unref();
  return {
    check,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      clearInterval(timer);
      clearTimeout(pending);
      listeners.clear();
    },
  };
}
