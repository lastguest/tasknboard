import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const human = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agent = process.env.TASKNBOARD_AGENT_TOKEN!;
async function command(name: string, args: object, token = human) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  expect(response.ok, `${name}: ${JSON.stringify(body)}`).toBeTruthy();
  return body;
}
async function board() {
  return command("create_board", {
    name: `Workflow ${randomUUID()}`,
    prefix: `W${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
  });
}

test("delegated review keeps evidence and the engineer through human changes", async ({
  page,
}) => {
  const project = await board();
  let task = await command(
    "create_task",
    { boardId: project.id, title: "Delegated evidence", branch: "codex/T406" },
    agent,
  );
  task = await command(
    "claim_task",
    { id: task.id, expectedVersion: task.version },
    agent,
  );
  task = await command(
    "delegate_task",
    {
      id: task.id,
      expectedVersion: task.version,
      delegatedTo: "sonnet#browser-run",
    },
    agent,
  );
  await page.addInitScript((token) => {
    if (!sessionStorage.getItem("tasknboard-token"))
      sessionStorage.setItem("tasknboard-token", token);
  }, agent);
  await page.goto(`${baseURL}/?board=${project.id}&task=${task.id}`);
  const details = page.getByRole("region", { name: /Task details/ });
  await expect(details).toContainText("sonnet#browser-run");
  await expect(
    details.getByRole("button", { name: "Mark Done", exact: true }),
  ).toHaveCount(0);
  await details.getByText("Submit review", { exact: true }).click();
  await details
    .getByLabel("Review summary", { exact: true })
    .fill("The delegated result passed.");
  await details
    .getByLabel("Commit range", { exact: true })
    .fill("abcdef1..abcdef2");
  await details
    .getByLabel("Verified by", { exact: true })
    .fill("checker#session");
  await details
    .getByLabel("Checks", { exact: true })
    .fill("Focused workflow passed.");
  await details.getByLabel("Upload evidence", { exact: true }).setInputFiles({
    name: "checks.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"passed":true}'),
  });
  await expect(details).toContainText("Attached: checks.json");
  await details.getByLabel("Upload evidence", { exact: true }).setInputFiles({
    name: "engineer.log",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("The engineer completed the focused check."),
  });
  await expect(details).toContainText("Attached: engineer.log");
  await details
    .getByRole("button", { name: "Submit for review", exact: true })
    .click();
  await expect(details).toContainText("Verified by checker#session");
  await details.getByText("Preview checks.json", { exact: true }).click();
  await expect(details).toContainText('"passed": true');
  await details.getByText("Preview engineer.log", { exact: true }).click();
  await expect(details).toContainText(
    "The engineer completed the focused check.",
  );
  expect((await command("get_task", { id: task.id })).delegatedTo).toBe(
    "sonnet#browser-run",
  );
  await page.evaluate(
    (token) => sessionStorage.setItem("tasknboard-token", token),
    human,
  );
  await page.reload();
  await details
    .getByRole("button", { name: "Request changes", exact: true })
    .click();
  await details
    .getByLabel("Reason for changes", { exact: true })
    .fill("Add the second check.");
  await details
    .getByRole("button", { name: "Send to In progress", exact: true })
    .click();
  await expect(details).toContainText("sonnet#browser-run");
  const returned = await command("get_task", { id: task.id });
  expect(returned.role).toBe("in_progress");
  expect(returned.lease).toBeNull();
  expect(returned.delegatedTo).toBe("sonnet#browser-run");
});

test("dependencies, milestone criteria, manual order and creator undo stay visible", async ({
  page,
}) => {
  const project = await board();
  let blocker = await command("create_task", {
    boardId: project.id,
    title: "Foundation",
    priority: "low",
  });
  const goal = await command("create_task", {
    boardId: project.id,
    title: "Goal",
    priority: "high",
  });
  blocker = await command("link_task", {
    id: blocker.id,
    expectedVersion: blocker.version,
    target: goal.id,
    type: "blocks",
  });
  await page.addInitScript(
    (token) => sessionStorage.setItem("tasknboard-token", token),
    human,
  );
  await page.goto(`${baseURL}/?board=${project.id}`);
  await expect(
    page.locator("article").filter({ hasText: "Goal" }),
  ).toContainText("Blocked");
  await page
    .getByRole("button", { name: `${goal.id}: Goal`, exact: false })
    .click();
  const details = page.getByRole("region", { name: /Task details/ });
  await details
    .getByRole("button", { name: "Critical path to this task" })
    .click();
  await expect(
    details.locator('[aria-label="Dependencies and undo"]'),
  ).toContainText("Foundation");
  await details.getByRole("button", { name: `Close ${goal.id}` }).click();
  await page.getByText("Milestones (0)", { exact: true }).click();
  await page
    .getByLabel("Milestone title", { exact: true })
    .fill("First milestone");
  await page
    .getByLabel("Exit criteria (one per line)", { exact: true })
    .fill("The foundation passes.");
  await page
    .getByRole("button", { name: "Create milestone", exact: true })
    .click();
  await page
    .getByLabel("Link task to First milestone", { exact: true })
    .selectOption(goal.id);
  await page
    .getByRole("checkbox", { name: "The foundation passes.", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "The foundation passes.", exact: true }),
  ).toBeChecked();
  const milestones = (await command("list_milestones", { boardId: project.id }))
    .milestones;
  expect(milestones[0].criteria[0].checked).toBe(true);
  expect((await command("get_task", { id: goal.id })).milestone).toBe(
    milestones[0].id,
  );
  const foundationCard = page.locator(`article[aria-label^="${blocker.id}:"]`);
  const goalCard = page.locator(`article[aria-label^="${goal.id}:"]`);
  await foundationCard.dragTo(goalCard);
  await expect(page.locator(".cards > article").first()).toHaveAttribute(
    "aria-label",
    new RegExp(`^${blocker.id}:`),
  );
  await expect
    .poll(async () => (await command("get_task", { id: blocker.id })).position)
    .toBe(0);
  let edited = await command("get_task", { id: goal.id });
  edited = await command("update_task", {
    id: edited.id,
    expectedVersion: edited.version,
    patch: { title: "Goal changed" },
  });
  await goalCard
    .getByRole("button", { name: `${goal.id}: Goal changed`, exact: false })
    .click();
  await details
    .getByRole("button", { name: "Undo last action", exact: true })
    .click();
  await expect(details.getByLabel("Title", { exact: true })).toHaveValue(
    "Goal",
  );
});

test("epic completion settings allow agents while a label can require human approval", async ({
  page,
}) => {
  const project = await board();
  await page.addInitScript((token) => {
    if (!sessionStorage.getItem("tasknboard-token"))
      sessionStorage.setItem("tasknboard-token", token);
  }, human);
  await page.goto(`${baseURL}/?board=${project.id}`);
  await page
    .getByRole("group", { name: project.name, exact: true })
    .getByRole("button", { name: "Epics", exact: true })
    .click();
  await page
    .locator(".epics-page")
    .getByRole("button", { name: "New epic", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "New epic", exact: true });
  await editor.getByLabel("Name", { exact: true }).fill("Agent completion");
  await editor
    .getByLabel("Completion policy", { exact: true })
    .selectOption("any_agent");
  await editor
    .getByRole("button", { name: "Create epic", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  const epic = (await command("list_epics", { boardId: project.id })).epics[0];
  expect(epic.completionPolicy).toBe("any_agent");
  let task = await command(
    "create_task",
    { boardId: project.id, title: "Agent can complete", epic: epic.id },
    agent,
  );
  task = await command(
    "claim_task",
    { id: task.id, expectedVersion: task.version },
    agent,
  );
  task = await command(
    "update_task",
    {
      id: task.id,
      expectedVersion: task.version,
      patch: {
        lane: project.lanes.find((lane: any) => lane.role === "in_progress").id,
      },
    },
    agent,
  );
  await page.evaluate(
    (token) => sessionStorage.setItem("tasknboard-token", token),
    agent,
  );
  await page.goto(`${baseURL}/?board=${project.id}&task=${task.id}`);
  const details = page.getByRole("region", { name: /Task details/ });
  await expect(details).toContainText(`Any authorized agent · epic:${epic.id}`);
  await details.getByRole("button", { name: "Mark Done", exact: true }).click();
  await expect
    .poll(async () => (await command("get_task", { id: task.id })).role)
    .toBe("done");
  const latest = (await command("list_boards", {})).boards.find(
    (entry: any) => entry.id === project.id,
  );
  await command("update_board", {
    id: project.id,
    expectedVersion: latest.version,
    patch: {
      policy: {
        ...latest.policy,
        labelCompletionPolicies: { NeedsHuman: "human" },
      },
    },
  });
  let guarded = await command(
    "create_task",
    {
      boardId: project.id,
      title: "Human label approval",
      epic: epic.id,
      labels: ["NeedsHuman"],
    },
    agent,
  );
  guarded = await command(
    "claim_task",
    { id: guarded.id, expectedVersion: guarded.version },
    agent,
  );
  guarded = await command(
    "update_task",
    {
      id: guarded.id,
      expectedVersion: guarded.version,
      patch: {
        lane: project.lanes.find((lane: any) => lane.role === "in_progress").id,
      },
    },
    agent,
  );
  await page.goto(`${baseURL}/?board=${project.id}&task=${guarded.id}`);
  await expect(details).toContainText("Human approval · label:needshuman");
  await expect(
    details.getByRole("button", { name: "Mark Done", exact: true }),
  ).toHaveCount(0);
});
