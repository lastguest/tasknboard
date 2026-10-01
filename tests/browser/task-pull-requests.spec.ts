import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;

async function command<T = any>(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${humanToken}`,
    },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`${name} returned ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}

const titles: Record<number, string> = {
  412: "Add token bucket limiter",
  415: "Return Retry-After on 429",
};
const pull = (owner: string, repo: string, number: number) => ({
  repository: `${owner}/${repo}`,
  number,
  title: titles[number] ?? "Untitled",
  url: `https://github.com/${owner}/${repo}/pull/${number}`,
  state: number === 415 ? "merged" : "open",
  author: { login: "ada", avatarUrl: "" },
  headRef: "limiter",
  baseRef: "main",
  additions: 10,
  deletions: 2,
  reviewDecision: "",
  createdAt: "2026-10-01T09:00:00Z",
  updatedAt: "2026-10-01T09:30:00Z",
  body: "",
  changedFiles: 1,
  commitCount: 1,
  commentCount: 0,
  mergedAt: "",
  checks: { state: "", items: [] },
  reviewers: [],
  activity: [],
  activityTotal: 0,
});

test("tasks link pull requests, mark the card, and open them in Pull requests", async ({
  page,
}) => {
  const task = await command("create_task", {
    boardId: "BOARD-1",
    title: `Rate limiting ${Date.now()}`,
  });
  await command("link_pull_requests", {
    id: task.id,
    expectedVersion: task.version,
    pullRequests: ["https://github.com/acme/api/pull/412"],
  });

  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
  }, humanToken);
  await page.route("**/api/github_status", (route) =>
    route.fulfill({
      json: {
        configured: true,
        connected: true,
        source: "settings",
        account: { login: "ada", name: "", avatarUrl: "" },
      },
    }),
  );
  await page.route("**/api/get_pull_request", (route) => {
    const { owner, repo, number } = route.request().postDataJSON();
    return route.fulfill({ json: pull(owner, repo, number) });
  });

  await page.goto(baseURL);
  const card = page.getByRole("article", { name: new RegExp(`^${task.id}:`) });
  await expect(card.locator(".pr-count")).toHaveText("1 pull request");

  await card.getByRole("button", { name: new RegExp(`^${task.id}:`) }).click();
  const section = page.getByRole("region", { name: "Pull requests" });
  await expect(section.getByRole("link")).toHaveText(/Add token bucket limiter\s*api#412/);

  // Several links at once, in either form.
  await section.getByRole("button", { name: "Link pull requests" }).click();
  await section
    .getByRole("textbox", { name: "Pull request links" })
    .fill("acme/api#415 https://github.com/acme/api/pull/412");
  await section.getByRole("button", { name: "Link", exact: true }).click();
  await expect(section.getByRole("link")).toHaveCount(2);
  await expect(section.getByRole("img", { name: "Merged" })).toBeVisible();

  await section.getByRole("link", { name: /Add token bucket limiter/ }).click();
  await expect(page).toHaveURL(/#pulls\/acme\/api\/412$/);
  await expect(page.getByRole("heading", { name: /Add token bucket limiter/ })).toBeVisible();

  await page.goto(`${baseURL}/#task/${task.id}`);
  await section.getByRole("button", { name: "Remove pull request acme/api#415" }).click();
  await expect(section.getByRole("link")).toHaveCount(1);
});

test("My tasks marks tasks that link pull requests", async ({ page }) => {
  const task = await command("create_task", {
    boardId: "BOARD-1",
    title: `Mine with pull requests ${Date.now()}`,
    assignee: "reviewer",
  });
  await command("link_pull_requests", {
    id: task.id,
    expectedVersion: task.version,
    pullRequests: ["acme/api#501", "acme/api#502"],
  });
  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
  }, humanToken);
  await page.goto(baseURL);
  await page.locator(".sidebar").getByRole("button", { name: /^My tasks/ }).click();
  const card = page.getByRole("article", { name: new RegExp(`^${task.id}:`) });
  await expect(card.locator(".pr-count")).toHaveAttribute("title", "2 pull requests");
  await page.getByRole("button", { name: "List", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: task.id });
  await expect(row.locator(".pr-count")).toHaveAttribute("title", "2 pull requests");
});

test("card marks take the colour of their pull requests' state", async ({ page }) => {
  const stamp = Date.now();
  const mixed = await command("create_task", { boardId: "BOARD-1", title: `Mixed ${stamp}` });
  const merged = await command("create_task", { boardId: "BOARD-1", title: `Merged ${stamp}` });
  await command("link_pull_requests", {
    id: mixed.id,
    expectedVersion: mixed.version,
    pullRequests: ["acme/api#600", "acme/api#601"],
  });
  await command("link_pull_requests", {
    id: merged.id,
    expectedVersion: merged.version,
    pullRequests: ["acme/api#601"],
  });
  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
  }, humanToken);
  await page.route("**/api/github_status", (route) =>
    route.fulfill({
      json: {
        configured: true,
        connected: true,
        source: "settings",
        account: { login: "ada", name: "", avatarUrl: "" },
      },
    }),
  );
  const batches: { number: number }[][] = [];
  await page.route("**/api/get_pull_request_states", (route) => {
    const { pullRequests } = route.request().postDataJSON();
    batches.push(pullRequests);
    return route.fulfill({
      json: {
        pullRequests: pullRequests.map((pr: { owner: string; repo: string; number: number }) => ({
          repository: `${pr.owner}/${pr.repo}`,
          number: pr.number,
          title: "",
          state: pr.number === 601 ? "merged" : "open",
        })),
      },
    });
  });

  await page.goto(baseURL);
  const mark = (id: string) =>
    page.getByRole("article", { name: new RegExp(`^${id}:`) }).locator(".pr-count");
  await expect(mark(mixed.id)).toHaveClass(/\bopen\b/);
  await expect(mark(mixed.id)).toHaveAttribute("title", "2 pull requests: 1 open, 1 merged");
  await expect(mark(merged.id)).toHaveClass(/\bmerged\b/);
  await expect(mark(merged.id)).toHaveAttribute("title", "1 pull request: 1 merged");
  // Every card on the board is read in one request, each pull request once.
  expect(batches[0].map((pr) => pr.number).filter((n) => n >= 600).sort()).toEqual([600, 601]);
});
