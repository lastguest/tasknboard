import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { command, errorOf, type ApiError } from "./api";
import { Icon } from "./Icons";
import { Markdown } from "./Markdown";
import type { Task } from "./types";

export type GitHubAccount = { login: string; name: string; avatarUrl: string };
export type GitHubStatus = { configured: boolean } & (
  | { connected: false; source: "" }
  | { connected: true; source: "settings"; account: GitHubAccount }
);
type GitHubDeviceAuthorization = {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};
type GitHubAuthorizationPoll =
  { pending: true; interval: number } | GitHubStatus;
type Person = { login: string; avatarUrl: string };
type PrState = "open" | "draft" | "merged" | "closed";
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
type Check = {
  name: string;
  status: "success" | "failure" | "pending" | "neutral";
  url: string;
  description: string;
};
type Activity = {
  kind: string;
  actor: Person;
  createdAt: string;
  body: string;
  state?: string;
  sha?: string;
};
type PullDetail = PullSummary & {
  body: string;
  changedFiles: number;
  commitCount: number;
  commentCount: number;
  mergedAt: string;
  checks: { state: string; items: Check[] };
  reviewers: (Person & { state: string })[];
  activity: Activity[];
  activityTotal: number;
};
type PullFile = {
  filename: string;
  previousFilename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
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
const refOf = (pr: Pick<PullSummary, "repository" | "number">): PullRef => {
  const [owner, repo] = pr.repository.split("/");
  return { owner, repo, number: pr.number };
};
const sameRef = (a: PullRef | null, b: PullRef | null) =>
  Boolean(
    a &&
    b &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number,
  );

/** Tasks that name this pull request in their review evidence or context. */
export function linkedTasks(tasks: Task[], ref: PullRef) {
  return tasks.filter((t) =>
    [t.review?.artifactUrl ?? "", t.description].some((text) =>
      [
        ...text.matchAll(
          /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi,
        ),
      ].some((m) => sameRef(parsePullRef(m[0]), ref)),
    ),
  );
}

export function relativeTime(value: string, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(value)) / 1000);
  if (seconds < 60) return "now";
  const steps: [number, string][] = [
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.35, "w"],
    [12, "mo"],
    [Infinity, "y"],
  ];
  let n = seconds / 60;
  for (const [size, unit] of steps) {
    if (n < size) return `${Math.floor(n)}${unit}`;
    n /= size;
  }
  return "";
}
const stateTitle: Record<PrState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

function GitHubAvatar({
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

function StateIcon({ state }: { state: PrState }) {
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
        size={16}
      />
    </span>
  );
}

function Diffstat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span
      className="diffstat"
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <span className="add">+{additions.toLocaleString("en")}</span>{" "}
      <span className="del">-{deletions.toLocaleString("en")}</span>
    </span>
  );
}

const githubError = (error: ApiError) =>
  error.code === "FORBIDDEN"
    ? "Only people can use the GitHub integration; agent tokens can't."
    : error.message;

type Filter = "all" | "reviewing" | "authored";

export function PullRequestsPage({
  target,
  tasks,
  onTarget,
  onOpenTask,
  onSettings,
  settingsClosed,
}: {
  target: PullRef | null;
  tasks: Task[];
  onTarget: (ref: PullRef | null) => void;
  onOpenTask: (task: Task) => void;
  onSettings: () => void;
  settingsClosed: number;
}) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [statusError, setStatusError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [list, setList] = useState<{
    loading: boolean;
    error: ApiError | null;
    items: PullSummary[];
    total: number;
  }>({
    loading: true,
    error: null,
    items: [],
    total: 0,
  });
  const pasted = parsePullRef(query);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await command<GitHubStatus>("github_status"));
      setStatusError(null);
    } catch (e) {
      setStatusError(errorOf(e));
    }
  }, []);
  useEffect(() => void loadStatus(), [loadStatus, settingsClosed]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const requestId = useRef(0);
  const loadList = useCallback(async () => {
    const id = ++requestId.current;
    setList((l) => ({ ...l, loading: true }));
    try {
      const result = await command<{
        pullRequests: PullSummary[];
        total: number;
      }>("list_pull_requests", {
        filter,
        state,
        query: parsePullRef(debounced) ? "" : debounced,
      });
      if (id === requestId.current)
        setList({
          loading: false,
          error: null,
          items: result.pullRequests,
          total: result.total,
        });
    } catch (e) {
      if (id === requestId.current)
        setList((l) => ({ ...l, loading: false, error: errorOf(e) }));
    }
  }, [filter, state, debounced]);
  const connected = status?.connected === true;
  useEffect(() => {
    if (!connected) return;
    void loadList();
    // GitHub has a request budget; a minute is fresh enough for a review queue.
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadList();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [connected, loadList]);

  const groups = useMemo(() => {
    const order: PrState[] = ["open", "draft", "merged", "closed"];
    return order
      .map((s) => ({
        state: s,
        items: list.items.filter((pr) => pr.state === s),
      }))
      .filter((g) => g.items.length);
  }, [list.items]);

  const listRef = useRef<HTMLDivElement>(null);
  const onListKey = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "j", "k"].includes(e.key)) return;
    const items = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(".pr-row") ??
        []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      items[
        Math.min(
          items.length - 1,
          Math.max(0, at + (e.key === "ArrowDown" || e.key === "j" ? 1 : -1)),
        )
      ];
    if (next) {
      e.preventDefault();
      next.focus();
      next.click();
    }
  };

  if (!status)
    return statusError ? (
      <div className="empty-state">
        <h2>GitHub isn't available.</h2>
        <p>{githubError(statusError)}</p>
        <button
          type="button"
          className="secondary"
          onClick={() => void loadStatus()}
        >
          Retry
        </button>
      </div>
    ) : (
      <div className="empty-state" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>Checking the GitHub connection…</p>
      </div>
    );
  if (!status.connected)
    return (
      <div className="empty-state">
        <span className="pr-empty-mark" aria-hidden="true">
          <Icon name="github" size={28} />
        </span>
        <h2>Connect GitHub to review pull requests here.</h2>
        <p>
          See the pull requests you authored or were asked to review, read their
          diffs and checks, and paste any GitHub pull request link to open it
          next to your tasks.
        </p>
        <button type="button" className="primary" onClick={onSettings}>
          <Icon name="github" size={16} /> Connect GitHub
        </button>
      </div>
    );

  return (
    <div className={`pulls ${target ? "has-detail" : ""}`}>
      <section className="pulls-list" aria-label="Pull requests">
        <div className="pulls-list-head">
          <div className="tabs" role="group" aria-label="Pull request filter">
            {(
              [
                ["all", "All"],
                ["reviewing", "Reviewing"],
                ["authored", "Authored"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                className={filter === id ? "active" : ""}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="pulls-state">
            <span className="sr-only">State</span>
            <select
              value={state}
              onChange={(e) => setState(e.target.value as typeof state)}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">Any state</option>
            </select>
          </label>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh pull requests"
            title="Refresh"
            disabled={list.loading}
            onClick={() => void loadList()}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
        <form
          className="search pulls-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (pasted) {
              onTarget(pasted);
              setQuery("");
            }
          }}
        >
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label="Search pull requests, or paste a GitHub pull request link"
            placeholder="Search, or paste a pull request link"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        {pasted && (
          <button
            type="button"
            className="pr-paste-hint"
            onClick={() => {
              onTarget(pasted);
              setQuery("");
            }}
          >
            <Icon name="pull" size={15} />
            <span>
              Open{" "}
              <strong>
                {pasted.owner}/{pasted.repo}#{pasted.number}
              </strong>
            </span>
            <kbd>↵</kbd>
          </button>
        )}
        {list.error && (
          <div className="banner error-banner" role="alert">
            <Icon name="alert" size={16} />
            <span>{githubError(list.error)}</span>
            {list.error.code === "GITHUB_UNAUTHORIZED" ? (
              <button
                type="button"
                className="secondary small-button"
                onClick={onSettings}
              >
                Settings
              </button>
            ) : (
              <button
                type="button"
                className="secondary small-button"
                onClick={() => void loadList()}
              >
                Retry
              </button>
            )}
          </div>
        )}
        <div
          className="pulls-rows"
          ref={listRef}
          onKeyDown={onListKey}
          aria-busy={list.loading}
        >
          {list.loading && !list.items.length ? (
            <div className="empty-state compact" role="status">
              <span className="spinner" aria-hidden="true" /> Loading pull
              requests…
            </div>
          ) : !list.items.length && !list.error ? (
            <p className="empty-state compact">
              {debounced
                ? `No pull requests match “${debounced}”.`
                : filter === "reviewing"
                  ? "Nobody is waiting for your review."
                  : filter === "authored"
                    ? "You have no pull requests in this state."
                    : "No pull requests involve you in this state."}
            </p>
          ) : (
            groups.map((group) => (
              <div
                key={group.state}
                className="pr-group"
                role="group"
                aria-label={stateTitle[group.state]}
              >
                <h3 className="pr-group-title">
                  {stateTitle[group.state]} <small>{group.items.length}</small>
                </h3>
                {group.items.map((pr) => {
                  const ref = refOf(pr);
                  const selected = sameRef(ref, target);
                  return (
                    <button
                      key={pr.url}
                      type="button"
                      className={`pr-row ${selected ? "selected" : ""}`}
                      aria-current={selected ? "true" : undefined}
                      onClick={() => onTarget(ref)}
                    >
                      <StateIcon state={pr.state} />
                      <span className="pr-row-main">
                        <span className="pr-row-title">{pr.title}</span>
                        <span className="pr-row-meta">
                          <GitHubAvatar person={pr.author} size={16} />
                          <span className="pr-row-repo">
                            {pr.repository}#{pr.number}
                          </span>
                          <span className="pr-row-branch">{pr.headRef}</span>
                        </span>
                      </span>
                      <span className="pr-row-side">
                        <time
                          dateTime={pr.updatedAt}
                          title={new Date(pr.updatedAt).toUTCString()}
                        >
                          {relativeTime(pr.updatedAt)}
                        </time>
                        <Diffstat
                          additions={pr.additions}
                          deletions={pr.deletions}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
          {list.total > list.items.length && (
            <p className="small pulls-more">
              Showing the {list.items.length} most recently updated of{" "}
              {list.total.toLocaleString("en")}. Search to narrow the list.
            </p>
          )}
        </div>
      </section>
      <section className="pulls-detail" aria-label="Pull request details">
        {target ? (
          <PullRequestDetail
            key={pullHash(target)}
            target={target}
            tasks={tasks}
            onClose={() => onTarget(null)}
            onOpenTask={onOpenTask}
            onSettings={onSettings}
          />
        ) : (
          <div className="empty-state">
            <Icon name="pull" size={26} />
            <p>
              Select a pull request, or paste a GitHub pull request link into
              the search field.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/** GitHub bodies often carry HTML comments from bots; they are never shown. */
const cleanBody = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").trim();

function PullRequestDetail({
  target,
  tasks,
  onClose,
  onOpenTask,
  onSettings,
}: {
  target: PullRef;
  tasks: Task[];
  onClose: () => void;
  onOpenTask: (task: Task) => void;
  onSettings: () => void;
}) {
  const [tab, setTab] = useState<"summary" | "code">("summary");
  const [pr, setPr] = useState<PullDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPr(await command<PullDetail>("get_pull_request", target));
      setError(null);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setLoading(false);
    }
  }, [target]);
  useEffect(() => void load(), [load]);
  const linked = useMemo(() => linkedTasks(tasks, target), [tasks, target]);
  const label = `${target.owner}/${target.repo}#${target.number}`;

  return (
    <article className="pr-detail">
      <div className="pr-detail-bar">
        <button
          type="button"
          className="icon-button pr-back"
          aria-label="Back to the list"
          onClick={onClose}
        >
          <Icon name="back" size={16} />
        </button>
        <div className="tabs" role="tablist" aria-label="Pull request view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "summary"}
            className={tab === "summary" ? "active" : ""}
            onClick={() => setTab("summary")}
          >
            Summary
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "code"}
            className={tab === "code" ? "active" : ""}
            onClick={() => setTab("code")}
          >
            Code
            {pr && <small className="tab-count">{pr.changedFiles}</small>}
          </button>
        </div>
        <span className="pr-detail-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Reload pull request"
            title="Reload"
            disabled={loading}
            onClick={() => void load()}
          >
            <Icon name="refresh" size={15} />
          </button>
          <a
            className="icon-button"
            href={
              pr?.url ??
              `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`
            }
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open on GitHub"
            title="Open on GitHub"
          >
            <Icon name="external" size={15} />
          </a>
        </span>
      </div>
      {error ? (
        <div className="empty-state">
          <h2>Couldn't open {label}.</h2>
          <p>{githubError(error)}</p>
          <div className="review-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void load()}
            >
              Retry
            </button>
            {error.code === "GITHUB_UNAUTHORIZED" && (
              <button type="button" className="secondary" onClick={onSettings}>
                Settings
              </button>
            )}
          </div>
        </div>
      ) : !pr ? (
        <div className="empty-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p>Loading {label}…</p>
        </div>
      ) : tab === "summary" ? (
        <PullSummaryView pr={pr} linked={linked} onOpenTask={onOpenTask} />
      ) : (
        <PullCode target={target} />
      )}
    </article>
  );
}

const reviewTitle: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Requested changes",
  commented: "Commented",
  requested: "Review requested",
  dismissed: "Dismissed",
  pending: "Pending",
};

function Disclosure({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="pr-section">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {title}
          {count !== undefined && <small>{count}</small>}
          <Icon name="chevronDown" size={14} />
        </button>
      </h2>
      {open && <div className="pr-section-body">{children}</div>}
    </section>
  );
}

function checksLabel(items: Check[]) {
  if (!items.length) return "No CI checks";
  const count = (s: Check["status"]) =>
    items.filter((c) => c.status === s).length;
  const failed = count("failure"),
    pending = count("pending"),
    passed = count("success");
  if (failed) return `${failed} failing, ${passed} passing`;
  if (pending) return `${pending} running, ${passed} passing`;
  return `${passed} of ${items.length} passing`;
}

function PullSummaryView({
  pr,
  linked,
  onOpenTask,
}: {
  pr: PullDetail;
  linked: Task[];
  onOpenTask: (task: Task) => void;
}) {
  const body = cleanBody(pr.body);
  const worst = pr.checks.items.some((c) => c.status === "failure")
    ? "failure"
    : pr.checks.items.some((c) => c.status === "pending")
      ? "pending"
      : pr.checks.items.length
        ? "success"
        : "neutral";
  return (
    <div className="pr-summary">
      <header className="pr-heading">
        <h1>{pr.title}</h1>
        <p className="pr-byline">
          <GitHubAvatar person={pr.author} />
          <span>{pr.author.login}</span>
          <span aria-hidden="true">·</span>
          <time
            dateTime={pr.createdAt}
            title={new Date(pr.createdAt).toUTCString()}
          >
            opened {relativeTime(pr.createdAt)} ago
          </time>
          <span aria-hidden="true">·</span>
          <span>
            {pr.repository}#{pr.number}
          </span>
        </p>
      </header>
      <dl className="pr-props">
        <div>
          <dt>
            <Icon name="branch" size={15} /> Branch
          </dt>
          <dd>
            <code className="pr-branch">{pr.headRef}</code>
            <Icon name="chevronRight" size={13} />
            <code className="pr-branch">{pr.baseRef}</code>
            <Diffstat additions={pr.additions} deletions={pr.deletions} />
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="users" size={15} /> Reviewers
          </dt>
          <dd className="pr-reviewers">
            {pr.reviewers.length ? (
              pr.reviewers.map((r) => (
                <span
                  key={r.login}
                  className={`pr-reviewer ${r.state}`}
                  title={`${r.login}: ${reviewTitle[r.state] ?? r.state}`}
                >
                  <GitHubAvatar person={r} />
                  <span className="sr-only">
                    {r.login}: {reviewTitle[r.state] ?? r.state}
                  </span>
                </span>
              ))
            ) : (
              <span className="muted">None</span>
            )}
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="comment" size={15} /> Comments
          </dt>
          <dd>
            {pr.commentCount === 1
              ? "1 comment"
              : `${pr.commentCount} comments`}
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="check" size={15} /> Checks
          </dt>
          <dd>
            <span className={`check-dot ${worst}`} aria-hidden="true" />
            {checksLabel(pr.checks.items)}
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="pull" size={15} /> Status
          </dt>
          <dd>
            <span className={`pr-state-pill ${pr.state}`}>
              {stateTitle[pr.state]}
            </span>
            {pr.reviewDecision && pr.state === "open" && (
              <span className="muted">
                {reviewTitle[pr.reviewDecision.toLowerCase()] ?? ""}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="board" size={15} /> Tasks
          </dt>
          <dd className="pr-tasks">
            {linked.length ? (
              linked.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="chip-button"
                  onClick={() => onOpenTask(t)}
                >
                  <strong>{t.id}</strong> {t.title}
                </button>
              ))
            ) : (
              <span className="muted">
                Not linked. Add the link to a task's review or context.
              </span>
            )}
          </dd>
        </div>
      </dl>
      <Disclosure title="Description">
        {body ? (
          <Markdown source={body} className="pr-body" />
        ) : (
          <p className="muted">No description.</p>
        )}
      </Disclosure>
      <Disclosure title="Checks" count={pr.checks.items.length}>
        {pr.checks.items.length ? (
          <ul className="pr-checks">
            {pr.checks.items.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <span
                  className={`check-dot ${c.status}`}
                  aria-label={c.status}
                  role="img"
                />
                <span className="pr-check-name">{c.name}</span>
                <span className="muted pr-check-desc">{c.description}</span>
                {/^https:\/\//.test(c.url) && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="quiet-link"
                  >
                    Details
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No CI checks</p>
        )}
      </Disclosure>
      <Disclosure title="Activity" count={pr.activityTotal}>
        <Timeline pr={pr} />
      </Disclosure>
    </div>
  );
}

const activityIcon: Record<string, string> = {
  commit: "commit",
  comment: "comment",
  review: "eye",
  review_requested: "users",
  merged: "merge",
  closed: "pullClosed",
  reopened: "pull",
  ready_for_review: "pull",
  force_pushed: "commit",
};

function Timeline({ pr }: { pr: PullDetail }) {
  // Runs of commits collapse into one entry, as on GitHub.
  type Entry =
    Activity | { kind: "commits"; items: Activity[]; createdAt: string };
  const entries: Entry[] = [
    { kind: "opened", actor: pr.author, createdAt: pr.createdAt, body: "" },
  ];
  for (const item of pr.activity) {
    const last = entries[entries.length - 1];
    if (item.kind === "commit" && "items" in last) last.items.push(item);
    else if (item.kind === "commit")
      entries.push({
        kind: "commits",
        items: [item],
        createdAt: item.createdAt,
      });
    else entries.push(item);
  }
  const hidden = pr.activityTotal - pr.activity.length;
  return (
    <ol className="pr-timeline">
      {entries.map((entry, i) =>
        entry.kind === "commits" ? (
          <CommitRun key={i} items={(entry as { items: Activity[] }).items} />
        ) : (
          <TimelineItem key={i} item={entry as Activity} />
        ),
      )}
      {hidden > 0 && (
        <li className="pr-timeline-more">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="quiet-link"
          >
            {hidden} earlier {hidden === 1 ? "event" : "events"} on GitHub
          </a>
        </li>
      )}
    </ol>
  );
}

function CommitRun({ items }: { items: Activity[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="pr-event card-event">
      <button
        type="button"
        className="pr-event-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="commit" size={15} />
        <span>
          {items.length} {items.length === 1 ? "commit" : "commits"}
        </span>
        <time dateTime={items[items.length - 1].createdAt}>
          {relativeTime(items[items.length - 1].createdAt)}
        </time>
      </button>
      {open && (
        <ul className="pr-commits">
          {items.map((c) => (
            <li key={c.sha}>
              <GitHubAvatar person={c.actor} size={16} />
              <span className="pr-commit-message">{c.body}</span>
              <code>{c.sha?.slice(0, 7)}</code>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function TimelineItem({ item }: { item: Activity }) {
  const verb =
    item.kind === "opened"
      ? "opened this pull request"
      : item.kind === "comment"
        ? "commented"
        : item.kind === "review"
          ? ({
              approved: "approved these changes",
              changes_requested: "requested changes",
              commented: "reviewed",
              dismissed: "had a review dismissed",
            }[item.state ?? ""] ?? "reviewed")
          : item.kind === "review_requested"
            ? `requested a review${item.body ? ` from ${item.body}` : ""}`
            : ({
                merged: "merged this pull request",
                closed: "closed this pull request",
                reopened: "reopened this pull request",
                ready_for_review: "marked this ready for review",
                force_pushed: "force-pushed the branch",
              }[item.kind] ?? item.kind);
  const body =
    item.kind === "comment" || item.kind === "review"
      ? cleanBody(item.body)
      : "";
  return (
    <li
      className={`pr-event ${body ? "card-event" : ""} ${item.kind} ${item.state ?? ""}`}
    >
      <div className="pr-event-head">
        <Icon name={activityIcon[item.kind] ?? "pull"} size={15} />
        <GitHubAvatar person={item.actor} size={18} />
        <span>
          <strong>{item.actor.login}</strong> {verb}
        </span>
        <time
          dateTime={item.createdAt}
          title={new Date(item.createdAt).toUTCString()}
        >
          {relativeTime(item.createdAt)}
        </time>
      </div>
      {body && <Markdown source={body} className="pr-event-body" />}
    </li>
  );
}

type DiffLine = {
  kind: "add" | "del" | "ctx" | "hunk" | "note";
  text: string;
  old?: number;
  new?: number;
};

/** Parse a unified-diff patch from GitHub's files API into numbered lines. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0,
    newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+"))
      lines.push({ kind: "add", text: raw.slice(1), new: newLine++ });
    else if (raw.startsWith("-"))
      lines.push({ kind: "del", text: raw.slice(1), old: oldLine++ });
    else if (raw.startsWith("\\"))
      lines.push({ kind: "note", text: raw.slice(2) });
    else
      lines.push({
        kind: "ctx",
        text: raw.slice(1),
        old: oldLine++,
        new: newLine++,
      });
  }
  return lines;
}

/** Pair deletions with the additions that replace them, for the split view. */
export function splitRows(lines: DiffLine[]) {
  const rows: { left?: DiffLine; right?: DiffLine; hunk?: DiffLine }[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.kind === "hunk" || line.kind === "note") {
      rows.push({ hunk: line });
      i++;
    } else if (line.kind === "ctx") {
      rows.push({ left: line, right: line });
      i++;
    } else {
      const dels: DiffLine[] = [],
        adds: DiffLine[] = [];
      while (lines[i]?.kind === "del") dels.push(lines[i++]);
      while (lines[i]?.kind === "add") adds.push(lines[i++]);
      for (let j = 0; j < Math.max(dels.length, adds.length); j++)
        rows.push({ left: dels[j], right: adds[j] });
    }
  }
  return rows;
}

function PullCode({ target }: { target: PullRef }) {
  const [files, setFiles] = useState<{
    files: PullFile[];
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [split, setSplit] = useState(() => {
    try {
      return localStorage.getItem("tasknboard.diffSplit") === "1";
    } catch {
      return false;
    }
  });
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const load = useCallback(async () => {
    setError(null);
    try {
      setFiles(
        await command<{ files: PullFile[]; truncated: boolean }>(
          "get_pull_request_files",
          target,
        ),
      );
    } catch (e) {
      setError(errorOf(e));
    }
  }, [target]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    try {
      localStorage.setItem("tasknboard.diffSplit", split ? "1" : "0");
    } catch {
      // The layout choice just won't persist.
    }
  }, [split]);
  const scroller = useRef<HTMLDivElement>(null);

  if (error)
    return (
      <div className="empty-state">
        <p>{githubError(error)}</p>
        <button type="button" className="secondary" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  if (!files)
    return (
      <div className="empty-state" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>Loading changes…</p>
      </div>
    );
  const toggle = (name: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <div className="pr-code">
      <nav className="pr-files" aria-label="Changed files">
        <div className="pr-files-head">
          <span>
            {files.files.length} {files.files.length === 1 ? "file" : "files"}
          </span>
          <div className="segmented" role="group" aria-label="Diff layout">
            <button
              type="button"
              aria-pressed={!split}
              onClick={() => setSplit(false)}
            >
              Unified
            </button>
            <button
              type="button"
              aria-pressed={split}
              onClick={() => setSplit(true)}
            >
              Split
            </button>
          </div>
        </div>
        <ul>
          {files.files.map((f, i) => (
            <li key={f.filename}>
              <button
                type="button"
                title={f.filename}
                onClick={() =>
                  scroller.current
                    ?.querySelector(`[data-file-index="${i}"]`)
                    ?.scrollIntoView({ block: "start", behavior: "smooth" })
                }
              >
                <span
                  className={`file-status ${f.status}`}
                  aria-label={f.status}
                >
                  {{ added: "A", removed: "D", renamed: "R", modified: "M" }[
                    f.status
                  ] ?? "M"}
                </span>
                <span className="pr-file-name">
                  <span className="pr-file-dir">
                    {f.filename.includes("/")
                      ? f.filename.slice(0, f.filename.lastIndexOf("/") + 1)
                      : ""}
                  </span>
                  {f.filename.slice(f.filename.lastIndexOf("/") + 1)}
                </span>
                <Diffstat additions={f.additions} deletions={f.deletions} />
              </button>
            </li>
          ))}
        </ul>
        {files.truncated && (
          <p className="small">Only the first 300 files are shown.</p>
        )}
      </nav>
      <div className="pr-diffs" ref={scroller}>
        {files.files.map((f, i) => {
          const open = !collapsed.has(f.filename);
          const lines = f.patch ? parsePatch(f.patch) : [];
          return (
            <section key={f.filename} className="pr-diff" data-file-index={i}>
              <h3 className="pr-diff-head">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(f.filename)}
                >
                  <Icon
                    name={open ? "chevronDown" : "chevronRight"}
                    size={14}
                  />
                  <span className="pr-diff-name">
                    {f.previousFilename && `${f.previousFilename} → `}
                    {f.filename}
                  </span>
                  <Diffstat additions={f.additions} deletions={f.deletions} />
                </button>
              </h3>
              {open &&
                (f.patch === null ? (
                  <p className="pr-diff-empty">
                    {f.status === "renamed" && !f.additions && !f.deletions
                      ? "File renamed without changes."
                      : "This diff is binary or too large to show here."}
                  </p>
                ) : split ? (
                  <table className="diff split">
                    <colgroup>
                      <col className="ln-col" />
                      <col />
                      <col className="ln-col" />
                      <col />
                    </colgroup>
                    <tbody>
                      {splitRows(lines).map((row, j) =>
                        row.hunk ? (
                          <tr key={j} className={`diff-${row.hunk.kind}`}>
                            <td colSpan={4}>{row.hunk.text}</td>
                          </tr>
                        ) : (
                          <tr key={j}>
                            <td
                              className={`ln diff-${row.left?.kind ?? "empty"}`}
                            >
                              {row.left?.old}
                            </td>
                            <td
                              className={`code diff-${row.left?.kind ?? "empty"}`}
                            >
                              {row.left?.text}
                            </td>
                            <td
                              className={`ln diff-${row.right?.kind ?? "empty"}`}
                            >
                              {row.right?.new}
                            </td>
                            <td
                              className={`code diff-${row.right?.kind ?? "empty"}`}
                            >
                              {row.right?.text}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                ) : (
                  <table className="diff unified">
                    <colgroup>
                      <col className="ln-col" />
                      <col className="ln-col" />
                      <col />
                    </colgroup>
                    <tbody>
                      {lines.map((line, j) =>
                        line.kind === "hunk" || line.kind === "note" ? (
                          <tr key={j} className={`diff-${line.kind}`}>
                            <td colSpan={3}>{line.text}</td>
                          </tr>
                        ) : (
                          <tr key={j} className={`diff-${line.kind}`}>
                            <td className="ln">{line.old}</td>
                            <td className="ln">{line.new}</td>
                            <td className="code">
                              <span className="diff-sign" aria-hidden="true">
                                {line.kind === "add"
                                  ? "+"
                                  : line.kind === "del"
                                    ? "-"
                                    : " "}
                              </span>
                              {line.text}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function waitForAuthorizationPoll(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Authorization polling stopped."));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Authorization polling stopped."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Settings → GitHub: connect the workspace account with device authorization. */
export function GitHubSettings({
  canManage,
  Group,
  Row,
}: {
  canManage: boolean;
  Group: (p: {
    title: string;
    note?: string;
    children: React.ReactNode;
  }) => React.ReactNode;
  Row: (p: {
    title: string;
    hint?: string;
    children: React.ReactNode;
  }) => React.ReactNode;
}) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [authorization, setAuthorization] =
    useState<GitHubDeviceAuthorization | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<null | { ok: boolean; text: string }>(
    null,
  );
  const prepareController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const cancelController = useRef<AbortController | null>(null);

  const prepareAuthorization = useCallback(
    async (controller = new AbortController()) => {
      prepareController.current?.abort();
      prepareController.current = controller;
      setPreparing(true);
      setMessage(null);
      try {
        const next = await command<GitHubDeviceAuthorization>(
          "connect_github",
          {},
          controller.signal,
        );
        if (!controller.signal.aborted) setAuthorization(next);
      } catch (e) {
        if (!controller.signal.aborted)
          setMessage({ ok: false, text: githubError(errorOf(e)) });
      } finally {
        if (prepareController.current === controller) {
          setPreparing(false);
          prepareController.current = null;
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    async function load() {
      try {
        const next = await command<GitHubStatus>(
          "github_status",
          {},
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setStatus(next);
        if (next.configured) await prepareAuthorization(controller);
      } catch (e) {
        if (!controller.signal.aborted)
          setMessage({ ok: false, text: githubError(errorOf(e)) });
      }
    }
    void load();
    return () => {
      controller.abort();
      prepareController.current?.abort();
      prepareController.current = null;
      pollController.current?.abort();
      pollController.current = null;
      cancelController.current?.abort();
      cancelController.current = null;
    };
  }, [canManage, prepareAuthorization]);

  // Poll as soon as the code is shown, so approval reaches the app however the
  // person opens GitHub: this link, the context menu, or another device.
  useEffect(() => {
    if (!authorization) return;
    const currentAuthorization = authorization;
    const controller = new AbortController();
    pollController.current = controller;
    async function poll() {
      let interval = currentAuthorization.interval;
      try {
        while (!controller.signal.aborted) {
          await waitForAuthorizationPoll(interval * 1000, controller.signal);
          const next = await command<GitHubAuthorizationPoll>(
            "poll_github_authorization",
            {},
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if ("pending" in next) {
            interval = next.interval;
            continue;
          }
          if (!next.connected)
            throw new Error(
              "GitHub authorization did not return a connected account.",
            );
          if (controller.signal.aborted) return;
          setStatus(next);
          setAuthorization(null);
          setMessage({
            ok: true,
            text: `Connected as @${next.account.login}.`,
          });
          return;
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setAuthorization(null);
        setMessage({ ok: false, text: githubError(errorOf(e)) });
      }
    }
    void poll();
    return () => {
      controller.abort();
      if (pollController.current === controller) pollController.current = null;
    };
  }, [authorization]);

  useEffect(() => {
    if (!authorization) return;
    const timer = window.setTimeout(
      () => {
        pollController.current?.abort();
        pollController.current = null;
        setAuthorization(null);
        setMessage({
          ok: false,
          text: "The GitHub authorization code expired. Prepare a new code to continue.",
        });
      },
      Math.max(0, authorization.expiresIn) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [authorization]);

  async function disconnect() {
    setDisconnecting(true);
    setMessage(null);
    prepareController.current?.abort();
    setPreparing(false);
    pollController.current?.abort();
    pollController.current = null;
    setAuthorization(null);
    try {
      const next = await command<GitHubStatus>("disconnect_github");
      setStatus(next);
      setMessage({
        ok: true,
        text: "GitHub is disconnected. The saved account is removed from the workspace.",
      });
    } catch (e) {
      setMessage({ ok: false, text: githubError(errorOf(e)) });
    } finally {
      setDisconnecting(false);
    }
  }

  async function stopWaiting() {
    pollController.current?.abort();
    pollController.current = null;
    setAuthorization(null);
    setCanceling(true);
    setMessage(null);
    cancelController.current?.abort();
    const controller = new AbortController();
    cancelController.current = controller;
    try {
      const next = await command<GitHubStatus>(
        "cancel_github_authorization",
        {},
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setStatus(next);
      const text = next.connected
        ? !status?.connected || next.account.login !== status.account.login
          ? `Connected as @${next.account.login}.`
          : "Stopped waiting for GitHub. The current connection is unchanged."
        : status?.connected
          ? "Authorization stopped. GitHub is disconnected."
          : "Stopped waiting for GitHub authorization.";
      setMessage({
        ok: true,
        text,
      });
    } catch (e) {
      if (!controller.signal.aborted)
        setMessage({ ok: false, text: githubError(errorOf(e)) });
    } finally {
      if (cancelController.current === controller) {
        setCanceling(false);
        cancelController.current = null;
      }
    }
  }

  if (!canManage)
    return (
      <Group title="Status">
        <Row
          title="GitHub"
          hint="Only people can manage the GitHub integration."
        >
          <span className="settings-pill off">Unavailable</span>
        </Row>
      </Group>
    );
  return (
    <>
      <Group
        title="Status"
        note="One GitHub account serves the whole workspace. Everyone signed in sees the pull requests that account can read."
      >
        <Row
          title="GitHub"
          hint={
            !status
              ? "Checking…"
              : !status.configured
                ? "GitHub authorization is not configured on this server. Ask the operator to set TASKNBOARD_GITHUB_CLIENT_ID."
                : status.connected
                  ? `Signed in as @${status.account.login}${status.account.name ? ` (${status.account.name})` : ""}.`
                  : "Not connected."
          }
        >
          {status?.connected && (
            <GitHubAvatar person={status.account} size={24} />
          )}
          <span className={`settings-pill ${status?.connected ? "on" : "off"}`}>
            {!status
              ? "Checking…"
              : !status.configured
                ? "Unavailable"
                : status.connected
                  ? "Connected"
                  : "Off"}
          </span>
          {status?.connected && (
            <button
              type="button"
              className="secondary small-button"
              disabled={preparing || canceling || disconnecting}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          )}
        </Row>
      </Group>
      <Group
        title="Authorization"
        note="TasknBoard uses GitHub device authorization. Authorize TasknBoard in GitHub to connect or switch the workspace account."
      >
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <span className="settings-row-title">Sign in with GitHub</span>
            <span className="settings-row-hint">
              Open GitHub and enter the one-time code to approve access.
            </span>
          </div>
          {authorization && (
            <div className="settings-row-text">
              <span className="settings-row-title">One-time code</span>
              <code aria-label="GitHub authorization code">
                {authorization.userCode}
              </code>
            </div>
          )}
          {status?.configured && (
            <div className="settings-token">
              {authorization ? (
                <a
                  className="primary small-button"
                  href={authorization.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    setMessage(null);
                    if (!isTauri()) return;
                    event.preventDefault();
                    invoke("open_external_url", {
                      url: authorization.verificationUri,
                    }).catch(() =>
                      setMessage({
                        ok: false,
                        text: `Could not open your browser. Go to ${authorization.verificationUri} and enter the code.`,
                      }),
                    );
                  }}
                >
                  {status.connected
                    ? "Switch GitHub account"
                    : "Connect GitHub"}
                </a>
              ) : (
                <button
                  type="button"
                  className="primary small-button"
                  disabled={preparing || canceling || disconnecting}
                  onClick={() => void prepareAuthorization()}
                >
                  {canceling
                    ? "Canceling authorization…"
                    : disconnecting
                      ? "Disconnecting…"
                      : preparing
                        ? "Preparing authorization…"
                        : "Prepare authorization"}
                </button>
              )}
              {authorization && (
                <button
                  type="button"
                  className="secondary small-button"
                  onClick={() => void stopWaiting()}
                >
                  Cancel authorization
                </button>
              )}
              {authorization && (
                <p className="small" role="status" aria-live="polite">
                  Waiting for approval in GitHub…
                </p>
              )}
            </div>
          )}
          {message && (
            <p
              className={message.ok ? "small ok" : "inline-error"}
              role={message.ok ? "status" : "alert"}
            >
              {message.text}
            </p>
          )}
        </div>
      </Group>
    </>
  );
}
