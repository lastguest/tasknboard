import { useEffect, useState, useSyncExternalStore } from "react";
import { command, type ApiError } from "./api";
import { Icon } from "./Icons";
import type { TaskPullRequest } from "./types";

export type GitHubAccount = { login: string; name: string; avatarUrl: string };
export type GitHubStatus = { configured: boolean } & (
  | { connected: false; source: "" }
  | { connected: true; source: "settings"; account: GitHubAccount }
);
export type Person = { login: string; avatarUrl: string };
export type PrState = "open" | "draft" | "merged" | "closed";
export type PullSummary = {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  author: Person;
  headRef: string;
  baseRef: string;
  additions: number;
  deletions: number;
  reviewDecision: string;
  createdAt: string;
  updatedAt: string;
};
/** A pull request address: `owner/repo` and its number. */
export type PullRef = { owner: string; repo: string; number: number };

/**
 * Read a GitHub pull request from a pasted URL, `owner/repo#123`, or the
 * `#pulls/owner/repo/123` and `#github.com/owner/repo/pull/123` app links.
 */
export function parsePullRef(value: string): PullRef | null {
  const text = value.trim().replace(/^#/, "");
  const match =
    text.match(
      /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pulls?\/(\d+)(?:[/?#].*)?$/i,
    ) ??
    text.match(/^pulls\/([\w.-]+)\/([\w.-]+)\/(\d+)$/) ??
    text.match(/^([\w-]+)\/([\w.-]+)#(\d+)$/);
  return match
    ? { owner: match[1], repo: match[2], number: Number(match[3]) }
    : null;
}
export const pullHash = (ref: PullRef) =>
  `#pulls/${ref.owner}/${ref.repo}/${ref.number}`;
export const githubError = (error: ApiError) =>
  error.code === "FORBIDDEN"
    ? "Only people can use the GitHub integration; agent tokens can't."
    : error.message;

export const stateTitle: Record<PrState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export function GitHubAvatar({
  person,
  size = 20,
}: {
  person: Person;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const src = /^https:\/\/avatars\.githubusercontent\.com\//.test(
    person.avatarUrl,
  )
    ? person.avatarUrl
    : "";
  return src && !failed ? (
    <img
      className="gh-avatar"
      src={src.includes("?") ? `${src}&s=${size * 2}` : `${src}?s=${size * 2}`}
      width={size}
      height={size}
      alt=""
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className="gh-avatar gh-avatar-fallback"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {person.login.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function StateIcon({ state, size = 16 }: { state: PrState; size?: number }) {
  return (
    <span
      className={`pr-state-icon ${state}`}
      aria-label={stateTitle[state]}
      role="img"
    >
      <Icon
        name={
          state === "merged"
            ? "merge"
            : state === "closed"
              ? "pullClosed"
              : "pull"
        }
        size={size}
      />
    </span>
  );
}

/** Whether GitHub is connected, read again after a minute. */
let connection: { at: number; value: Promise<boolean> } | null = null;
function githubConnected() {
  if (!connection || Date.now() - connection.at >= 60_000)
    connection = {
      at: Date.now(),
      value: command<GitHubStatus>("github_status").then(
        (status) => status.connected,
        () => false,
      ),
    };
  return connection.value;
}
/**
 * Pull request titles and states for task cards and details. Each asks for
 * what it shows; requests made in the same render go to GitHub as one
 * `get_pull_request_states` call, and each is read again after a minute.
 * Without a GitHub connection every state stays unknown.
 */
type PullInfo = { title: string; state: PrState };
const pullStates = new Map<string, { at: number; info: PullInfo | null }>();
const stateListeners = new Set<() => void>();
let stateVersion = 0;
let wanted = new Map<string, TaskPullRequest>();
let flushQueued = false;
const stateKey = (pr: { repository: string; number: number }) =>
  `${pr.repository.toLowerCase()}#${pr.number}`;
function wantStates(prs: TaskPullRequest[]) {
  for (const pr of prs) {
    const key = stateKey(pr);
    const entry = pullStates.get(key);
    if (entry && Date.now() - entry.at < 60_000) continue;
    // The last state stays on the card while it is read again.
    pullStates.set(key, { at: Date.now(), info: entry?.info ?? null });
    wanted.set(key, pr);
  }
  if (!wanted.size || flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => void flushStates());
}
async function flushStates() {
  flushQueued = false;
  const batch = [...wanted.values()];
  wanted = new Map();
  if (!(await githubConnected())) return;
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100);
    try {
      const { pullRequests } = await command<{
        pullRequests: { repository: string; number: number; title: string; state: PrState }[];
      }>("get_pull_request_states", {
        pullRequests: chunk.map((pr) => {
          const [owner, repo] = pr.repository.split("/");
          return { owner, repo, number: pr.number };
        }),
      });
      const found = new Map(
        pullRequests.map((pr) => [stateKey(pr), { title: pr.title, state: pr.state }]),
      );
      for (const pr of chunk)
        pullStates.set(stateKey(pr), {
          at: Date.now(),
          info: found.get(stateKey(pr)) ?? null,
        });
    } catch {
      // The cards keep a neutral mark; the next read tries again.
    }
  }
  stateVersion++;
  for (const listener of stateListeners) listener();
}
const subscribeStates = (listener: () => void) => {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
};
/** Each pull request's title and state, or null while unknown. */
function usePullInfo(prs: TaskPullRequest[]) {
  useSyncExternalStore(subscribeStates, () => stateVersion);
  useEffect(() => wantStates(prs));
  return prs.map((pr) => pullStates.get(stateKey(pr))?.info ?? null);
}
/** Each pull request's state, or null while unknown. */
export const usePullStates = (prs: TaskPullRequest[]) =>
  usePullInfo(prs).map((info) => info?.state ?? null);

/**
 * Pull request references in text such as the activity log: each links to
 * its page and carries its state icon once GitHub reports it.
 */
export function PullRefs({ urls }: { urls: string[] }) {
  const prs = urls.flatMap((url): TaskPullRequest[] => {
    const ref = parsePullRef(url);
    return ref
      ? [{ repository: `${ref.owner}/${ref.repo}`, number: ref.number, url }]
      : [];
  });
  const states = usePullStates(prs);
  return (
    <span className="pr-refs">
      {prs.map((pr, i) => {
        const [owner, repo] = pr.repository.split("/");
        const state = states[i];
        return (
          <a
            key={pr.url}
            className="pr-ref"
            href={pullHash({ owner, repo, number: pr.number })}
          >
            {state ? (
              <StateIcon state={state} size={13} />
            ) : (
              <span className="pr-state-icon unknown" aria-hidden="true">
                <Icon name="pull" size={13} />
              </span>
            )}
            {pr.repository}#{pr.number}
          </a>
        );
      })}
    </span>
  );
}

function TaskPullRequestRow({
  pr,
  busy,
  onRemove,
}: {
  pr: TaskPullRequest;
  busy: boolean;
  onRemove: () => void;
}) {
  // The same batched read as the card marks, so both show the same state.
  const [summary] = usePullInfo([pr]);
  const [owner, repo] = pr.repository.split("/");
  return (
    <li>
      <a
        href={pullHash({ owner, repo, number: pr.number })}
        title={summary ? `${summary.title} · ${pr.repository}#${pr.number}` : pr.url}
      >
        {summary ? (
          <StateIcon state={summary.state} size={14} />
        ) : (
          <span className="pr-state-icon unknown" aria-hidden="true">
            <Icon name="pull" size={14} />
          </span>
        )}
        <span className="task-link-title">{summary?.title || pr.repository}</span>
        <span className="task-pr-ref">
          {summary ? `${repo}#${pr.number}` : `#${pr.number}`}
        </span>
      </a>
      <button
        type="button"
        className="icon-button compact"
        aria-label={`Remove pull request ${pr.repository}#${pr.number}`}
        title="Remove pull request"
        disabled={busy}
        onClick={onRemove}
      >
        <Icon name="close" size={12} />
      </button>
    </li>
  );
}

/** The task details list of linked pull requests, with a paste field to add more. */
export function TaskPullRequests({
  pullRequests,
  busy,
  onLink,
  onUnlink,
}: {
  pullRequests: TaskPullRequest[];
  busy: boolean;
  /** Resolves true when the pull requests were saved. */
  onLink: (values: string[]) => Promise<boolean>;
  onUnlink: (url: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState("");
  const close = () => {
    setAdding(false);
    setValue("");
    setInvalid("");
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const values = value.split(/[\s,]+/).filter(Boolean);
    if (!values.length) return;
    const bad = values.find((v) => !parsePullRef(v));
    if (bad) {
      setInvalid(`“${bad}” is not a GitHub pull request link.`);
      return;
    }
    if (await onLink(values)) close();
  }
  return (
    <section className="side-block" aria-label="Pull requests">
      <div className="side-block-head">
        <h3>
          <Icon name="pull" size={14} /> Pull requests
        </h3>
        <button
          type="button"
          className="icon-button compact"
          aria-label="Link pull requests"
          title="Link pull requests"
          aria-expanded={adding}
          disabled={busy}
          onClick={() => (adding ? close() : setAdding(true))}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {pullRequests.length > 0 && (
        <ul className="task-links task-prs">
          {pullRequests.map((pr) => (
            <TaskPullRequestRow
              key={pr.url}
              pr={pr}
              busy={busy}
              onRemove={() => onUnlink(pr.url)}
            />
          ))}
        </ul>
      )}
      {!pullRequests.length && !adding && (
        <p className="small">No pull requests.</p>
      )}
      {adding && (
        <form className="task-pr-add" onSubmit={submit}>
          <input
            autoFocus
            aria-label="Pull request links"
            placeholder="Paste GitHub pull request links"
            value={value}
            disabled={busy}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid("");
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Close the field, not the task panel.
              e.stopPropagation();
              close();
            }}
          />
          <button type="submit" disabled={busy || !value.trim()}>
            Link
          </button>
        </form>
      )}
      {invalid && <p className="small warn">{invalid}</p>}
    </section>
  );
}
