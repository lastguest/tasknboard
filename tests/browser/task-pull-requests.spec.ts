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
