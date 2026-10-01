import type { Status } from "./types";

/** What a task reference shows, as `get_tasks` returns it. */
export type TaskSummary = {
  id: string;
  title: string;
  status: Status;
  archived: boolean;
};

export type ReferenceLookup = {
  /** Each known board prefix, current or former, mapped to the current prefix. */
  prefixes: ReadonlyMap<string, string>;
  /** Tasks read so far by current key; null means the task does not exist. */
  tasks: ReadonlyMap<string, TaskSummary | null>;
};

/** A key in text. `task` is absent until the task has been read. */
export type TaskReference = {
  start: number;
  end: number;
  /** The current key, also when the text uses a former prefix. */
  id: string;
  task?: TaskSummary;
};

export function referencePrefixes(
  boards: readonly { prefix: string; formerPrefixes: readonly string[] }[],
) {
  const prefixes = new Map<string, string>();
  for (const board of boards) {
    for (const former of board.formerPrefixes) prefixes.set(former, board.prefix);
    prefixes.set(board.prefix, board.prefix);
  }
  return prefixes;
}

/*
 * Code spans and URLs are matched first so that a key inside them is skipped.
 * A key must stand alone: no letter, digit, "_", "-", "/", "." or "@" joined
 * to either side, so paths, file names and e-mail addresses stay text.
 */
const scanner =
  /(`+)[\s\S]*?\1(?!`)|\b[a-z][a-z\d+.-]*:\/\/\S*|\bwww\.\S*|(?<![\w/.@-])([A-Z][A-Z\d]{1,9})-([1-9]\d*)(?![\w-]|[./@]\w)/gi;

/**
 * Task keys in a run of plain Markdown text. A key counts only when its
 * prefix belongs to a board and the task has not been read as missing.
 */
export function findTaskReferences(
  text: string,
  lookup: ReferenceLookup,
): TaskReference[] {
  const found: TaskReference[] = [];
  for (const m of text.matchAll(scanner)) {
    if (!m[2] || m[2] !== m[2].toUpperCase()) continue;
    const prefix = lookup.prefixes.get(m[2]);
    if (!prefix) continue;
    const id = `${prefix}-${m[3]}`;
    const task = lookup.tasks.get(id);
    if (task === null) continue;
    const start = m.index;
    found.push({ start, end: start + m[0].length, id, ...(task && { task }) });
  }
  return found;
}
