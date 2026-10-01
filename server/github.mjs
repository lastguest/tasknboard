import { z } from "zod";
import { fail } from "./domain.mjs";

/**
 * GitHub pull requests, read through the workspace's GitHub connection.
 * The token stays on the server: commands return only the connected account.
 * `TASKNBOARD_GITHUB_API` points at another API root (GitHub Enterprise, tests).
 */
const api = (
  process.env.TASKNBOARD_GITHUB_API || "https://api.github.com"
).replace(/\/$/, "");
const oauth = (
  process.env.TASKNBOARD_GITHUB_OAUTH_URL || "https://github.com"
).replace(/\/$/, "");
const githubClientId = () =>
  process.env.TASKNBOARD_GITHUB_CLIENT_ID?.trim() || "";
const owner = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "GitHub owner required");
const repo = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, "GitHub repository required");
const pull = z
  .object({ owner, repo, number: z.number().int().positive() })
  .strict();
export const githubSchemas = {
  github_status: z.object({}).strict(),
  connect_github: z.object({}).strict(),
  poll_github_authorization: z.object({}).strict(),
  cancel_github_authorization: z.object({}).strict(),
  disconnect_github: z.object({}).strict(),
  list_pull_requests: z
    .object({
      filter: z.enum(["all", "reviewing", "authored"]).default("all"),
      query: z.string().trim().max(200).default(""),
      state: z.enum(["open", "closed", "all"]).default("open"),
    })
    .strict(),
  get_pull_request: pull,
  get_pull_request_files: pull,
  get_pull_request_states: z
    .object({ pullRequests: z.array(pull).min(1).max(100) })
    .strict(),
};

async function request(token, path, init = {}) {
  let res;
  try {
    res = await fetch(api + path, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "TasknBoard",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    fail(
      "GITHUB_UNREACHABLE",
      "Can't reach GitHub. Check the server's internet connection.",
      502,
    );
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401)
    fail(
      "GITHUB_UNAUTHORIZED",
      "GitHub rejected the token. Reconnect GitHub in Settings.",
      502,
    );
  if (res.status === 403 || res.status === 429)
    fail(
      "GITHUB_RATE_LIMITED",
      res.headers.get("x-ratelimit-remaining") === "0"
        ? "GitHub's rate limit is reached. Try again in a few minutes."
        : "GitHub denied access. The token may lack repository access.",
      502,
    );
  if (res.status === 404)
    fail(
      "NOT_FOUND",
      "Pull request not found, or the token can't access it.",
      404,
    );
  if (!res.ok)
    fail("GITHUB_ERROR", `GitHub returned an error (${res.status}).`, 502);
  return body;
}

async function oauthRequest(path, fields) {
  let res;
  try {
    res = await fetch(oauth + path, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "TasknBoard",
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    fail(
      "GITHUB_UNREACHABLE",
      "Can't reach GitHub to authorize the integration. Try again.",
      502,
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body !== "object")
    fail(
      "GITHUB_AUTHORIZATION_FAILED",
      "GitHub authorization failed. Try again.",
      502,
    );
  return body;
}

async function graphql(token, query, variables) {
  const body = await request(token, "/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  if (body?.errors?.length) {
    if (body.errors.some((e) => e.type === "NOT_FOUND"))
      fail(
        "NOT_FOUND",
        "Pull request not found, or the token can't access it.",
        404,
      );
    fail("GITHUB_ERROR", body.errors[0].message || "GitHub query failed.", 502);
  }
  return body.data;
}

const person = (a) =>
  a
    ? { login: a.login, avatarUrl: a.avatarUrl || "" }
    : { login: "ghost", avatarUrl: "" };
const stateOf = (pr) =>
  pr.merged
    ? "merged"
    : pr.state === "CLOSED"
      ? "closed"
      : pr.isDraft
        ? "draft"
        : "open";
const summaryFields = `number title url state isDraft merged createdAt updatedAt additions deletions
  headRefName baseRefName reviewDecision repository { nameWithOwner } author { login avatarUrl }`;
const summary = (pr) => ({
  repository: pr.repository.nameWithOwner,
  number: pr.number,
  title: pr.title,
  url: pr.url,
  state: stateOf(pr),
  author: person(pr.author),
  headRef: pr.headRefName,
  baseRef: pr.baseRefName,
  additions: pr.additions,
  deletions: pr.deletions,
  reviewDecision: pr.reviewDecision || "",
  createdAt: pr.createdAt,
  updatedAt: pr.updatedAt,
});

/** Overall result of a check rollup context: CheckRun or StatusContext. */
function check(c) {
  if (c.__typename === "StatusContext")
    return {
      name: c.context,
      status:
        {
          SUCCESS: "success",
          FAILURE: "failure",
          ERROR: "failure",
          PENDING: "pending",
          EXPECTED: "pending",
        }[c.state] || "neutral",
      url: c.targetUrl || "",
      description: c.description || "",
    };
  const conclusion = (c.conclusion || "").toLowerCase();
  return {
    name: c.name,
    status:
      c.status !== "COMPLETED"
        ? "pending"
        : conclusion === "success"
          ? "success"
          : [
                "failure",
                "timed_out",
                "startup_failure",
                "action_required",
              ].includes(conclusion)
            ? "failure"
            : "neutral",
    url: c.detailsUrl || "",
    description: c.title || conclusion.replace(/_/g, " "),
  };
}

export function createGitHub(store) {
  const attempts = new Map();
  let generation = 0;
  const current = (attempt) =>
    generation === attempt.generation &&
    attempts.get(attempt.actorId) === attempt;
  const forget = (attempt) => {
    if (current(attempt)) attempts.delete(attempt.actorId);
  };
  const pending = (attempt) => ({
    pending: true,
    interval: Math.max(
      attempt.interval,
      Math.ceil(Math.max(0, attempt.nextPollAt - Date.now()) / 1000),
    ),
  });
  const token = () => store.setting("github.token") || "";
  const humanOnly = (identity) => {
    if (identity.kind !== "human")
      fail("FORBIDDEN", "Only humans use the GitHub integration", 403);
  };
  const required = () => {
    const value = token();
    if (!value)
      fail(
        "GITHUB_NOT_CONNECTED",
        "Connect GitHub in Settings to see pull requests.",
        409,
      );
    return value;
  };
  const account = (user) => ({
    login: user.login,
    name: user.name || "",
    avatarUrl: user.avatar_url || "",
  });
  const status = async () => {
    const stored = store.setting("github.token");
    const configured = Boolean(githubClientId());
    if (!stored) return { connected: false, source: "", configured };
    const cached = store.setting("github.account");
    return {
      connected: true,
      source: "settings",
      configured,
      account: cached
        ? JSON.parse(cached)
        : account(await request(stored, "/user")),
    };
  };
  const handlers = {
    async github_status() {
      return status();
    },
    async connect_github(_, identity) {
      const clientId = githubClientId();
      if (!clientId)
        fail(
          "GITHUB_NOT_CONFIGURED",
          "GitHub authorization is not configured on this server.",
          409,
        );
      const attempt = {
        actorId: identity.id,
        generation,
        clientId,
        deviceCode: "",
        interval: 1,
        expiresAt: 0,
        nextPollAt: 0,
        inFlight: false,
      };
      attempts.set(identity.id, attempt);
      try {
        const body = await oauthRequest("/login/device/code", {
          client_id: clientId,
          scope: "repo",
        });
        if (!current(attempt))
          fail(
            "GITHUB_AUTHORIZATION_REPLACED",
            "This GitHub authorization attempt was replaced. Start again.",
            409,
          );
        const expiresIn = Number(body.expires_in);
        const interval = Math.max(1, Number(body.interval));
        let uri;
        try {
          uri = new URL(body.verification_uri || "");
        } catch {
          fail(
            "GITHUB_AUTHORIZATION_FAILED",
            "GitHub authorization could not be started. Try again.",
            502,
          );
        }
        if (
          body.error ||
          typeof body.device_code !== "string" ||
          !body.device_code ||
          typeof body.user_code !== "string" ||
          !body.user_code ||
          !Number.isSafeInteger(expiresIn) ||
          expiresIn <= 0 ||
          !Number.isSafeInteger(interval) ||
          uri.origin !== "https://github.com" ||
          uri.pathname !== "/login/device"
        )
          fail(
            "GITHUB_AUTHORIZATION_FAILED",
            "GitHub authorization could not be started. Try again.",
            502,
          );
        attempt.deviceCode = body.device_code;
        attempt.interval = interval;
        attempt.expiresAt = Date.now() + expiresIn * 1000;
        attempt.nextPollAt = Date.now() + interval * 1000;
        return {
          userCode: body.user_code,
          verificationUri: "https://github.com/login/device",
          expiresIn,
          interval,
        };
      } catch (error) {
        forget(attempt);
        throw error;
      }
    },
    async poll_github_authorization(_, identity) {
      const attempt = attempts.get(identity.id);
      if (!attempt)
        fail(
          "GITHUB_AUTHORIZATION_NOT_FOUND",
          "No GitHub authorization attempt is active. Start again.",
          409,
        );
      if (!attempt.deviceCode || attempt.inFlight) return pending(attempt);
      if (Date.now() >= attempt.expiresAt) {
        forget(attempt);
        fail(
          "GITHUB_AUTHORIZATION_EXPIRED",
          "The GitHub authorization code expired. Start again.",
          410,
        );
      }
      if (Date.now() < attempt.nextPollAt) return pending(attempt);

      const pollStartedAt = Date.now();
      attempt.nextPollAt = pollStartedAt + attempt.interval * 1000;
      attempt.inFlight = true;
      let tokenIssued = false;
      try {
        const body = await oauthRequest("/login/oauth/access_token", {
          client_id: attempt.clientId,
          device_code: attempt.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        if (!current(attempt))
          fail(
            "GITHUB_AUTHORIZATION_REPLACED",
            "This GitHub authorization attempt was replaced. Start again.",
            409,
          );
        if (Date.now() >= attempt.expiresAt) {
          forget(attempt);
          fail(
            "GITHUB_AUTHORIZATION_EXPIRED",
            "The GitHub authorization code expired. Start again.",
            410,
          );
        }
        if (body.error === "authorization_pending") return pending(attempt);
        if (body.error === "slow_down") {
          attempt.interval += 5;
          attempt.nextPollAt = Date.now() + attempt.interval * 1000;
          return pending(attempt);
        }
        if (body.error === "access_denied") {
          forget(attempt);
          fail(
            "GITHUB_AUTHORIZATION_DENIED",
            "GitHub authorization was denied.",
            403,
          );
        }
        if (body.error === "expired_token" || body.error === "token_expired") {
          forget(attempt);
          fail(
            "GITHUB_AUTHORIZATION_EXPIRED",
            "The GitHub authorization code expired. Start again.",
            410,
          );
        }
        if (body.error || typeof body.access_token !== "string") {
          forget(attempt);
          fail(
            "GITHUB_AUTHORIZATION_FAILED",
            "GitHub authorization failed. Start a new connection attempt.",
            502,
          );
        }
        tokenIssued = true;
        const user = account(await request(body.access_token, "/user"));
        if (!current(attempt))
          fail(
            "GITHUB_AUTHORIZATION_REPLACED",
            "This GitHub authorization attempt was replaced. Start again.",
            409,
          );
        if (Date.now() >= attempt.expiresAt) {
          forget(attempt);
          fail(
            "GITHUB_AUTHORIZATION_EXPIRED",
            "The GitHub authorization code expired. Start again.",
            410,
          );
        }
        store.setSettings({
          "github.token": body.access_token,
          "github.account": JSON.stringify(user),
        });
        generation++;
        attempts.clear();
        return status();
      } catch (error) {
        if (tokenIssued) forget(attempt);
        throw error;
      } finally {
        attempt.inFlight = false;
      }
    },
    async cancel_github_authorization(_, identity) {
      const attempt = attempts.get(identity.id);
      if (attempt) forget(attempt);
      return status();
    },
    async disconnect_github() {
      generation++;
      attempts.clear();
      store.setSettings({ "github.token": "", "github.account": "" });
      return status();
    },
    async list_pull_requests({ filter, query, state }) {
      const involvement = {
        all: "involves:@me",
        reviewing: "review-requested:@me",
        authored: "author:@me",
      }[filter];
      const search = [
        "is:pr",
        "archived:false",
        involvement,
        state === "all" ? "" : `is:${state}`,
        query.replace(/[^\p{L}\p{N}\s:/_.#@-]/gu, " "),
        "sort:updated-desc",
      ]
        .filter(Boolean)
        .join(" ");
      const data = await graphql(
        required(),
        `query($q: String!) { search(query: $q, type: ISSUE, first: 50) {
          issueCount nodes { ... on PullRequest { ${summaryFields} } } } }`,
        { q: search },
      );
      return {
        total: data.search.issueCount,
        pullRequests: data.search.nodes.filter((n) => n?.number).map(summary),
      };
    },
    /**
     * Title and state of many pull requests in one query, for task cards.
     * Pull requests the token can't see are left out instead of failing all.
     */
    async get_pull_request_states({ pullRequests }) {
      const variables = {};
      const fields = pullRequests.map((pr, i) => {
        Object.assign(variables, {
          [`o${i}`]: pr.owner,
          [`r${i}`]: pr.repo,
          [`n${i}`]: pr.number,
        });
        return `p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { number title state isDraft merged repository { nameWithOwner } } }`;
      });
      const params = pullRequests
        .map((_, i) => `$o${i}: String!, $r${i}: String!, $n${i}: Int!`)
        .join(", ");
      const body = await request(required(), "/graphql", {
        method: "POST",
        body: JSON.stringify({
          query: `query(${params}) { ${fields.join(" ")} }`,
          variables,
        }),
      });
      if (!body?.data)
        fail("GITHUB_ERROR", body?.errors?.[0]?.message || "GitHub query failed.", 502);
      return {
        pullRequests: pullRequests.flatMap((_, i) => {
          const pr = body.data[`p${i}`]?.pullRequest;
          return pr
            ? [
                {
                  repository: pr.repository.nameWithOwner,
                  number: pr.number,
                  title: pr.title,
                  state: stateOf(pr),
                },
              ]
            : [];
        }),
      };
    },
    async get_pull_request({ owner, repo, number }) {
      const data = await graphql(
        required(),
        `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) { ${summaryFields} body changedFiles mergedAt closedAt
            mergedBy { login avatarUrl }
            commits(last: 1) { totalCount nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
              __typename ... on CheckRun { name status conclusion detailsUrl title }
              ... on StatusContext { context state targetUrl description } } } } } } }
            reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } ... on Team { name slug } } } }
            latestReviews(first: 20) { nodes { state author { login avatarUrl } } }
            comments { totalCount }
            reviewThreads { totalCount }
            timelineItems(last: 60, itemTypes: [PULL_REQUEST_COMMIT, ISSUE_COMMENT, PULL_REQUEST_REVIEW, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, REVIEW_REQUESTED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) {
              totalCount nodes { __typename
                ... on PullRequestCommit { commit { oid messageHeadline committedDate author { user { login avatarUrl } name } } }
                ... on IssueComment { createdAt body author { login avatarUrl } }
                ... on PullRequestReview { createdAt state body author { login avatarUrl } }
                ... on MergedEvent { createdAt actor { login avatarUrl } }
                ... on ClosedEvent { createdAt actor { login avatarUrl } }
                ... on ReopenedEvent { createdAt actor { login avatarUrl } }
                ... on ReadyForReviewEvent { createdAt actor { login avatarUrl } }
                ... on ReviewRequestedEvent { createdAt actor { login avatarUrl } requestedReviewer { ... on User { login } ... on Team { name } } }
                ... on HeadRefForcePushedEvent { createdAt actor { login avatarUrl } } } } } } }`,
        { owner, repo, number },
      );
      const pr = data.repository?.pullRequest;
      if (!pr)
        fail(
          "NOT_FOUND",
          "Pull request not found, or the token can't access it.",
          404,
        );
      const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
      const reviewers = new Map();
      for (const { requestedReviewer: r } of pr.reviewRequests.nodes)
        if (r)
          reviewers.set(r.login || r.slug, {
            login: r.login || `@${r.slug}`,
            avatarUrl: r.avatarUrl || "",
            state: "requested",
          });
      for (const review of pr.latestReviews.nodes)
        if (review.author)
          reviewers.set(review.author.login, {
            ...person(review.author),
            state: review.state.toLowerCase(),
          });
      const activity = pr.timelineItems.nodes.flatMap((n) => {
        switch (n.__typename) {
          case "PullRequestCommit": {
            const c = n.commit;
            return [
              {
                kind: "commit",
                actor: c.author.user
                  ? person(c.author.user)
                  : { login: c.author.name || "unknown", avatarUrl: "" },
                createdAt: c.committedDate,
                body: c.messageHeadline,
                sha: c.oid,
              },
            ];
          }
          case "IssueComment":
            return [
              {
                kind: "comment",
                actor: person(n.author),
                createdAt: n.createdAt,
                body: n.body,
              },
            ];
          case "PullRequestReview":
            return [
              {
                kind: "review",
                actor: person(n.author),
                createdAt: n.createdAt,
                body: n.body,
                state: n.state.toLowerCase(),
              },
            ];
          case "ReviewRequestedEvent":
            return [
              {
                kind: "review_requested",
                actor: person(n.actor),
                createdAt: n.createdAt,
                body:
                  n.requestedReviewer?.login || n.requestedReviewer?.name || "",
              },
            ];
          default: {
            const kind = {
              MergedEvent: "merged",
              ClosedEvent: "closed",
              ReopenedEvent: "reopened",
              ReadyForReviewEvent: "ready_for_review",
              HeadRefForcePushedEvent: "force_pushed",
            }[n.__typename];
            return kind
              ? [
                  {
                    kind,
                    actor: person(n.actor),
                    createdAt: n.createdAt,
                    body: "",
                  },
                ]
              : [];
          }
        }
      });
      return {
        ...summary(pr),
        body: pr.body || "",
        changedFiles: pr.changedFiles,
        commitCount: pr.commits.totalCount,
        commentCount: pr.comments.totalCount + pr.reviewThreads.totalCount,
        mergedAt: pr.mergedAt || "",
        closedAt: pr.closedAt || "",
        checks: {
          state: (rollup?.state || "").toLowerCase(),
          items: (rollup?.contexts.nodes || []).map(check),
        },
        reviewers: [...reviewers.values()],
        activity,
        activityTotal: pr.timelineItems.totalCount,
      };
    },
    async get_pull_request_files({ owner, repo, number }) {
      const files = [];
      // GitHub lists at most 3,000 files; stop at 300 to keep the page usable.
      for (let page = 1; page <= 3; page++) {
        const batch = await request(
          required(),
          `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
        );
        files.push(...batch);
        if (batch.length < 100) break;
      }
      return {
        truncated: files.length >= 300,
        files: files.map((f) => ({
          filename: f.filename,
          previousFilename: f.previous_filename || "",
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
        })),
      };
    },
  };

  /** Run a GitHub command, or return undefined when the name isn't one. */
  async function execute(command, input, identity) {
    if (!Object.hasOwn(handlers, command)) return undefined;
    humanOnly(identity);
    const parsed = githubSchemas[command].safeParse(input);
    if (!parsed.success)
      fail(
        "VALIDATION",
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
        400,
      );
    return handlers[command](parsed.data, identity);
  }
  return { execute };
}
