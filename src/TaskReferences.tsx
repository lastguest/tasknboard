import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import { command } from "./api";
import { RoleIcon } from "./Board";
import { roleTitle } from "./types";
import type { ReferenceLookup, TaskSummary } from "./task-references";

/*
 * Task keys in rendered Markdown become chips (docs/contracts/task-references.md).
 * Each Markdown block asks for the keys it shows; requests made in the same
 * render go to the server as one `get_tasks` call. Every app refresh reads
 * all known keys again, so a chip follows its task without its own timer.
 */

/** Known prefixes and how to open a task; without it Markdown shows no chips. */
export const TaskReferenceContext = createContext<{
  prefixes: ReadonlyMap<string, string>;
  /** Lane names by lane ID, across every board. */
  laneNames: ReadonlyMap<string, string>;
  open: (id: string) => void;
} | null>(null);

const summaries = new Map<string, TaskSummary | null>();
/** Every key asked for, so a refresh also retries the ones that failed. */
const requested = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let wanted = new Set<string>();
let flushQueued = false;
/** Orders reads, so an older response never replaces a newer one. */
let readSequence = 0;
const readAt = new Map<string, number>();

function want(ids: Iterable<string>) {
  for (const id of ids) {
    if (requested.has(id)) continue;
    requested.add(id);
    wanted.add(id);
  }
  if (!wanted.size || flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => void flush());
}

async function flush() {
  flushQueued = false;
  const batch = [...wanted];
  wanted = new Set();
  let changed = false;
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100);
    const sequence = ++readSequence;
    try {
      const { tasks } = await command<{ tasks: TaskSummary[] }>("get_tasks", {
        ids: chunk,
      });
      const found = new Map(tasks.map((task) => [task.id, task]));
      for (const id of chunk) {
        if ((readAt.get(id) ?? 0) > sequence) continue;
        readAt.set(id, sequence);
        summaries.set(id, found.get(id) ?? null);
        changed = true;
      }
    } catch {
      // Chips keep their last state; the next refresh reads them again.
    }
  }
  if (!changed) return;
  version++;
  for (const listener of listeners) listener();
}

/** Called after each app refresh: read every shown task again. */
export function refreshTaskReferences() {
  if (!requested.size) return;
  for (const id of requested) wanted.add(id);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => void flush());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The lookup for one Markdown render, or null outside the app. Rendering adds
 * unread keys to `wanted`; they are read after the render commits.
 */
export function useTaskReferences():
  | (ReferenceLookup & { wanted: Set<string> })
  | null {
  const context = useContext(TaskReferenceContext);
  useSyncExternalStore(subscribe, () => version);
  const lookup = context && {
    prefixes: context.prefixes,
    tasks: summaries,
    wanted: new Set<string>(),
  };
  useEffect(() => {
    if (lookup?.wanted.size) want(lookup.wanted);
  });
  return lookup;
}

export function TaskChip({ task }: { task: TaskSummary }) {
  const context = useContext(TaskReferenceContext);
  const state = task.archived
    ? "Archived"
    : (context?.laneNames.get(task.lane) ?? roleTitle(task.role));
  return (
    <a
      className={`task-ref${task.archived ? " is-archived" : ""}`}
      href={`#task/${task.id}`}
      aria-label={`${task.id} ${task.title}, ${state}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        context?.open(task.id);
      }}
    >
      <RoleIcon role={task.role} size={12} />
      <span className="task-ref-id">{task.id}</span>
      <span className="task-ref-state">{state}</span>
      <span className="task-ref-title" aria-hidden="true">
        {task.title}
      </span>
    </a>
  );
}
