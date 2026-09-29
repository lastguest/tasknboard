import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const goodToken = "ghp_test_only_token_0123456789abcdef";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pr = {
  number: 7,
  title: "Add ingredient merging switch",
  url: "https://github.com/acme/resolver/pull/7",
  state: "MERGED",
  isDraft: false,
  merged: true,
  createdAt: "2026-09-20T10:00:00Z",
  updatedAt: "2026-09-28T10:00:00Z",
  additions: 1252,
  deletions: 28,
  headRefName: "develop",
  baseRefName: "master",
  reviewDecision: "APPROVED",
  repository: { nameWithOwner: "acme/resolver" },
  author: {
    login: "waxmoth",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  },
};

/** A minimal stand-in for the GitHub REST and GraphQL APIs. */
function fakeGitHub() {
  const seen = [];
  const plans = [];
  const flows = new Map();
  const acceptedTokens = new Set([goodToken]);
  const userGates = new Map();
  let flowNumber = 0;
  const queueFlow = (responses = [], options = {}) =>
    plans.push({
      responses: [...responses],
      accessToken: options.accessToken || goodToken,
      interval: options.interval ?? 1,
      expiresIn: options.expiresIn ?? 900,
      verificationUri:
        options.verificationUri ?? "https://github.com/login/device",
    });
  const holdUserToken = (token) => {
    let release;
    const wait = new Promise((resolve) => (release = resolve));
    userGates.set(token, wait);
    return { release, wait };
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/login/device/code") {
      const plan = plans.shift() || {};
      const number = ++flowNumber;
      const deviceCode = `device_secret_${number}`;
      flows.set(deviceCode, {
        ...plan,
        responses: plan.responses || [],
        accessToken: plan.accessToken || goodToken,
      });
      acceptedTokens.add(plan.accessToken || goodToken);
      return send(200, {
        device_code: deviceCode,
        user_code: `CODE-${number}`,
        verification_uri:
          plan.verificationUri ?? "https://github.com/login/device",
        expires_in: plan.expiresIn ?? 900,
        interval: plan.interval ?? 1,
      });
    }
    if (req.url === "/login/oauth/access_token") {
      const form = new URLSearchParams(body);
      const flow = flows.get(form.get("device_code"));
      if (!flow) return send(200, { error: "incorrect_device_code" });
      const response = flow.responses.shift() || {
        access_token: flow.accessToken,
      };
      if (response.access_token) acceptedTokens.add(response.access_token);
      return send(200, response);
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (req.url === "/user") {
      if (!acceptedTokens.has(token))
        return send(401, { message: "Bad credentials" });
      const gate = userGates.get(token);
      if (gate) await gate;
      return send(200, {
        login: "octo",
        name: "Octo Cat",
        avatar_url: "https://avatars.githubusercontent.com/u/2",
      });
    }
    if (!acceptedTokens.has(token))
      return send(401, { message: "Bad credentials" });
    if (req.url.startsWith("/repos/acme/resolver/pulls/7/files"))
      return send(200, [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1,2 +1,3 @@\n-old\n+new\n+more\n ctx",
        },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
      ]);
    if (req.url === "/graphql") {
      const { query, variables } = JSON.parse(body);
      if (query.includes("search("))
        return send(200, {
          data: { search: { issueCount: 1, nodes: [pr, {}] } },
        });
      if (variables.number !== 7)
        return send(200, {
          data: { repository: null },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
        });
      return send(200, {
        data: {
          repository: {
            pullRequest: {
              ...pr,
              body: "<!-- bot -->Summary",
              changedFiles: 2,
              mergedAt: "2026-09-28T10:00:00Z",
              closedAt: "2026-09-28T10:00:00Z",
              mergedBy: pr.author,
              commits: {
                totalCount: 5,
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: "FAILURE",
                        contexts: {
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: "test",
                              status: "COMPLETED",
                              conclusion: "FAILURE",
                              detailsUrl: "https://ci",
                              title: "",
                            },
                            {
                              __typename: "StatusContext",
                              context: "lint",
                              state: "SUCCESS",
                              targetUrl: "",
                              description: "ok",
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
              reviewRequests: {
                nodes: [
                  {
                    requestedReviewer: {
                      __typename: "User",
                      login: "reviewer",
                      avatarUrl: "",
                    },
                  },
                ],
              },
              latestReviews: {
                nodes: [
                  {
                    state: "APPROVED",
                    author: { login: "octo", avatarUrl: "" },
                  },
                ],
              },
              comments: { totalCount: 1 },
              reviewThreads: { totalCount: 0 },
              timelineItems: {
                totalCount: 2,
                nodes: [
                  {
                    __typename: "PullRequestCommit",
                    commit: {
                      oid: "abcdef1234",
                      messageHeadline: "Start",
                      committedDate: "2026-09-21T00:00:00Z",
                      author: { user: null, name: "Wax" },
                    },
                  },
                  {
                    __typename: "MergedEvent",
                    createdAt: "2026-09-28T10:00:00Z",
                    actor: { login: "octo", avatarUrl: "" },
                  },
                ],
              },
            },
          },
        },
      });
    }
    send(404, { message: "Not Found" });
  });
  return { server, seen, queueFlow, holdUserToken };
}

test("GitHub integration keeps the token on the server and proxies pull requests", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tasknboard-github-"));
  const github = fakeGitHub();
  await new Promise((r) => github.server.listen(0, "127.0.0.1", r));
  const human = "test-only-human-token-123456789",
    otherHuman = "test-only-other-human-token-123456789",
    agent = "test-only-agent-token-123456789";
  const service = spawn(process.execPath, ["server/http.mjs"], {
    env: {
      ...process.env,
      PORT: "14331",
      TASKNBOARD_DB: join(dir, "db.sqlite"),
      TASKNBOARD_GITHUB_API: `http://127.0.0.1:${github.server.address().port}`,
      TASKNBOARD_GITHUB_OAUTH_URL: `http://127.0.0.1:${github.server.address().port}`,
      TASKNBOARD_GITHUB_CLIENT_ID: "test-client-id",
      TASKNBOARD_GITHUB_TOKEN: goodToken,
      TASKNBOARD_TOKENS: JSON.stringify({
        [human]: { id: "reviewer", kind: "human" },
        [otherHuman]: { id: "second-reviewer", kind: "human" },
        [agent]: { id: "bot", kind: "agent" },
      }),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(async () => {
    service.kill();
    await new Promise((r) =>
      service.exitCode !== null ? r() : service.once("exit", r),
    );
    github.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    service.stderr.on(
      "data",
      (c) => c.toString().includes("listening") && resolve(),
    );
    service.once("exit", () => reject(new Error("Server exited")));
  });
  const post = async (cmd, args = {}, bearer = human) => {
    const res = await fetch(`http://127.0.0.1:14331/api/${cmd}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(args),
    });
    return { status: res.status, body: await res.json() };
  };
  const waitFor = async (condition) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await pause(10);
    assert.ok(condition(), "timed out waiting for GitHub stub request");
  };
  const pollRequests = () =>
    github.seen.filter((entry) => entry.path === "/login/oauth/access_token");

  assert.deepEqual((await post("github_status")).body, {
    connected: false,
    source: "",
    configured: true,
  });
  const notConnected = await post("list_pull_requests");
  assert.equal(notConnected.body.code, "GITHUB_NOT_CONNECTED");

  // The environment PAT does not connect GitHub, and clients cannot submit a PAT.
  const rejectedPat = await post("connect_github", { token: goodToken });
  assert.equal(rejectedPat.status, 400);
  assert.equal((await post("github_status")).body.connected, false);
  assert.equal(github.seen.filter((entry) => entry.path === "/user").length, 0);

  assert.equal((await post("connect_github", {}, agent)).status, 403);
  assert.equal(
    (await post("poll_github_authorization", {}, agent)).status,
    403,
  );
  assert.equal(
    (await post("cancel_github_authorization", {}, agent)).status,
    403,
  );

  github.queueFlow([
    { error: "authorization_pending" },
    { access_token: goodToken },
  ]);
  const started = await post("connect_github");
  assert.equal(started.status, 200);
  assert.deepEqual(started.body, {
    userCode: "CODE-1",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 1,
  });
  const deviceRequest = github.seen.find(
    (entry) => entry.path === "/login/device/code",
  );
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(deviceRequest.body)),
    {
      client_id: "test-client-id",
      scope: "repo",
    },
  );
  assert.equal(deviceRequest.auth, undefined);
  const otherActorPoll = await post(
    "poll_github_authorization",
    {},
    otherHuman,
  );
  assert.equal(otherActorPoll.status, 409);
  const earlyPoll = await post("poll_github_authorization");
  assert.deepEqual(earlyPoll, {
    status: 200,
    body: { pending: true, interval: 1 },
  });
  assert.equal(pollRequests().length, 0);
  await pause(1050);
  const pendingPoll = await post("poll_github_authorization");
  assert.deepEqual(pendingPoll.body, { pending: true, interval: 1 });
  assert.equal(pollRequests().length, 1);
  assert.equal(pollRequests()[0].auth, undefined);
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(pollRequests()[0].body)),
    {
      client_id: "test-client-id",
      device_code: "device_secret_1",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  );
  const throttledPoll = await post("poll_github_authorization");
  assert.deepEqual(throttledPoll.body, { pending: true, interval: 1 });
  assert.equal(pollRequests().length, 1);
  await pause(1050);
  const connected = await post("poll_github_authorization");
  assert.equal(connected.status, 200);
  assert.deepEqual(connected.body, {
    connected: true,
    source: "settings",
    configured: true,
    account: {
      login: "octo",
      name: "Octo Cat",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
    },
  });
  for (const response of [
    started,
    earlyPoll,
    pendingPoll,
    throttledPoll,
    connected,
  ]) {
    assert.doesNotMatch(JSON.stringify(response.body), /device_secret_1/);
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(goodToken));
  }
  const status = await post("github_status");
  assert.equal(status.body.source, "settings");
  assert.equal(status.body.configured, true);
  assert.ok(!JSON.stringify(status.body).includes(goodToken));

  github.queueFlow([
    {
      error: "access_denied",
      error_description: "Denied for device_secret_2 with ghp_hidden_token",
    },
  ]);
  const deniedStart = await post("connect_github");
  assert.equal(deniedStart.status, 200);
  await pause(1050);
  const denied = await post("poll_github_authorization");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "GITHUB_AUTHORIZATION_DENIED");
  assert.doesNotMatch(JSON.stringify(denied.body), /device_secret_2/);
  assert.doesNotMatch(JSON.stringify(denied.body), /ghp_hidden_token/);
  assert.equal(
    (await post("poll_github_authorization")).body.code,
    "GITHUB_AUTHORIZATION_NOT_FOUND",
  );

  github.queueFlow([], { interval: 1, expiresIn: 1 });
  const expiresStart = await post("connect_github");
  assert.equal(expiresStart.status, 200);
  await pause(1100);
  const expiresBeforePoll = await post("poll_github_authorization");
  assert.equal(expiresBeforePoll.status, 410);
  assert.equal(expiresBeforePoll.body.code, "GITHUB_AUTHORIZATION_EXPIRED");

  github.queueFlow([{ error: "expired_token" }]);
  const expiredStart = await post("connect_github");
  assert.equal(expiredStart.status, 200);
  await pause(1050);
  const expired = await post("poll_github_authorization");
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, "GITHUB_AUTHORIZATION_EXPIRED");
  assert.doesNotMatch(JSON.stringify(expired.body), /device_secret_4/);

  github.queueFlow([{ error: "slow_down" }]);
  const slowStart = await post("connect_github");
  assert.equal(slowStart.status, 200);
  await pause(1050);
  const slowed = await post("poll_github_authorization");
  assert.deepEqual(slowed.body, { pending: true, interval: 6 });
  const heldBySlowDown = await post("poll_github_authorization");
  assert.deepEqual(heldBySlowDown.body, { pending: true, interval: 6 });
  assert.equal(
    pollRequests().filter(
      (entry) =>
        new URLSearchParams(entry.body).get("device_code") ===
        "device_secret_5",
    ).length,
    1,
  );

  github.queueFlow([], { verificationUri: "not a verification URL" });
  const malformedStart = await post("connect_github");
  assert.equal(malformedStart.status, 502);
  assert.equal(malformedStart.body.code, "GITHUB_AUTHORIZATION_FAILED");
  assert.doesNotMatch(
    JSON.stringify(malformedStart.body),
    /not a verification URL/,
  );

  // Replacing a flow while /user is in flight cannot store the old token.
  await post("disconnect_github");
  const staleToken = "gho_stale_test_token_0123456789";
  const staleGate = github.holdUserToken(staleToken);
  github.queueFlow([{ access_token: staleToken }], { accessToken: staleToken });
  const staleStart = await post("connect_github");
  assert.equal(staleStart.status, 200);
  await pause(1050);
  const stalePollPromise = post("poll_github_authorization");
  await waitFor(() =>
    github.seen.some(
      (entry) =>
        entry.path === "/user" && entry.auth === `Bearer ${staleToken}`,
    ),
  );
  github.queueFlow([{ error: "authorization_pending" }]);
  const replacement = await post("connect_github");
  assert.equal(replacement.status, 200);
  staleGate.release();
  const stalePoll = await stalePollPromise;
  assert.equal(stalePoll.status, 409);
  assert.equal(stalePoll.body.code, "GITHUB_AUTHORIZATION_REPLACED");
  assert.equal((await post("github_status")).body.connected, false);
  assert.doesNotMatch(JSON.stringify(stalePoll.body), new RegExp(staleToken));

  // Disconnect also invalidates an already-issued token while /user is in flight.
  await post("disconnect_github");
  const disconnectedToken = "gho_disconnect_test_token_0123456789";
  const disconnectGate = github.holdUserToken(disconnectedToken);
  github.queueFlow([{ access_token: disconnectedToken }], {
    accessToken: disconnectedToken,
  });
  const disconnectStart = await post("connect_github");
  assert.equal(disconnectStart.status, 200);
  await pause(1050);
  const disconnectPollPromise = post("poll_github_authorization");
  await waitFor(() =>
    github.seen.some(
      (entry) =>
        entry.path === "/user" && entry.auth === `Bearer ${disconnectedToken}`,
    ),
  );
  const disconnected = await post("disconnect_github");
  assert.deepEqual(disconnected.body, {
    connected: false,
    source: "",
    configured: true,
  });
  disconnectGate.release();
  const staleDisconnectPoll = await disconnectPollPromise;
  assert.equal(staleDisconnectPoll.status, 409);
  assert.equal(staleDisconnectPoll.body.code, "GITHUB_AUTHORIZATION_REPLACED");
  assert.equal((await post("github_status")).body.connected, false);

  github.queueFlow([{ access_token: goodToken }]);
  const reconnectStart = await post("connect_github");
  assert.equal(reconnectStart.status, 200);
  await pause(1050);
  const reconnected = await post("poll_github_authorization");
  assert.equal(reconnected.status, 200);
  assert.equal(reconnected.body.connected, true);

  github.queueFlow([{ error: "authorization_pending" }]);
  const cancelStart = await post("connect_github");
  assert.equal(cancelStart.status, 200);
  const otherActorCancel = await post(
    "cancel_github_authorization",
    {},
    otherHuman,
  );
  assert.deepEqual(otherActorCancel.body, reconnected.body);
  assert.deepEqual((await post("poll_github_authorization")).body, {
    pending: true,
    interval: 1,
  });
  const canceled = await post("cancel_github_authorization");
  assert.deepEqual(canceled.body, reconnected.body);
  assert.equal(
    (await post("poll_github_authorization")).body.code,
    "GITHUB_AUTHORIZATION_NOT_FOUND",
  );

  // Canceling during account verification also blocks the in-flight token save.
  const canceledToken = "gho_cancel_test_token_0123456789";
  const cancelGate = github.holdUserToken(canceledToken);
  github.queueFlow([{ access_token: canceledToken }], {
    accessToken: canceledToken,
  });
  const inFlightCancelStart = await post("connect_github");
  assert.equal(inFlightCancelStart.status, 200);
  await pause(1050);
  const inFlightPollPromise = post("poll_github_authorization");
  await waitFor(() =>
    github.seen.some(
      (entry) =>
        entry.path === "/user" && entry.auth === `Bearer ${canceledToken}`,
    ),
  );
  const inFlightCanceled = await post("cancel_github_authorization");
  assert.deepEqual(inFlightCanceled.body, reconnected.body);
  cancelGate.release();
  const canceledPoll = await inFlightPollPromise;
  assert.equal(canceledPoll.status, 409);
  assert.equal(canceledPoll.body.code, "GITHUB_AUTHORIZATION_REPLACED");
  assert.deepEqual((await post("github_status")).body, reconnected.body);
  assert.doesNotMatch(
    JSON.stringify(canceledPoll.body),
    new RegExp(canceledToken),
  );

  const list = await post("list_pull_requests", {
    filter: "reviewing",
    state: "all",
    query: "merging",
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.pullRequests.length, 1);
  assert.equal(list.body.pullRequests[0].state, "merged");
  assert.equal(list.body.pullRequests[0].repository, "acme/resolver");
  const search = JSON.parse(
    github.seen.findLast((r) => r.path === "/graphql").body,
  ).variables.q;
  assert.match(search, /review-requested:@me/);
  assert.match(search, /merging/);
  assert.doesNotMatch(search, /is:open/);

  const detail = await post("get_pull_request", {
    owner: "acme",
    repo: "resolver",
    number: 7,
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.commitCount, 5);
  assert.deepEqual(
    detail.body.checks.items.map((c) => c.status),
    ["failure", "success"],
  );
  assert.deepEqual(
    detail.body.reviewers.map((r) => [r.login, r.state]),
    [
      ["reviewer", "requested"],
      ["octo", "approved"],
    ],
  );
  assert.deepEqual(
    detail.body.activity.map((a) => a.kind),
    ["commit", "merged"],
  );
  assert.equal(detail.body.activity[0].actor.login, "Wax");

  assert.equal(
    (
      await post("get_pull_request", {
        owner: "acme",
        repo: "resolver",
        number: 8,
      })
    ).status,
    404,
  );
  assert.equal(
    (await post("get_pull_request", { owner: "../x", repo: "r", number: 1 }))
      .status,
    400,
  );
  assert.equal((await post("list_pull_requests", {}, agent)).status, 403);

  const files = await post("get_pull_request_files", {
    owner: "acme",
    repo: "resolver",
    number: 7,
  });
  assert.equal(files.body.files.length, 2);
  assert.equal(files.body.files[1].patch, null);

  // Exports and ordinary commands never carry the GitHub token.
  const backup = await post("export_workspace");
  assert.ok(!JSON.stringify(backup.body).includes(goodToken));

  assert.deepEqual((await post("disconnect_github")).body, {
    connected: false,
    source: "",
    configured: true,
  });
  assert.equal(
    (await post("list_pull_requests")).body.code,
    "GITHUB_NOT_CONNECTED",
  );
});
