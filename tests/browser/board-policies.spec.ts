import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
const baseURL = process.env.TASKNBOARD_BASE_URL!;
const human = process.env.TASKNBOARD_HUMAN_TOKEN!;
const agent = process.env.TASKNBOARD_AGENT_TOKEN!;
async function post(name: string, args: object, token = human) {
  const response = await fetch(`${baseURL}/api/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  return { response, body: await response.json() };
}
test("board completion toggle controls agent completion and stays scoped", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const { body: board } = await post("create_board", {
    name: `Policy ${suffix}`,
    prefix: `P${suffix}`,
  });
  expect(board.policy.humanCompletionOnly).toBe(true);
  let { body: task } = await post("create_task", {
    boardId: board.id,
    title: "Policy check",
  });
  ({ body: task } = await post(
    "claim_task",
    { id: task.id, expectedVersion: task.version },
    agent,
  ));
  const denied = await post(
    "update_task",
    {
      id: task.id,
      expectedVersion: task.version,
      patch: { lane: board.lanes.find((lane: any) => lane.role === "done").id },
    },
    agent,
  );
  expect(denied.response.status).toBe(403);
  await page.addInitScript(
    (token) => sessionStorage.setItem("tasknboard-token", token),
    human,
  );
  await page.goto(`${baseURL}/?board=${board.id}`);
  await page.getByRole("button", { name: "Edit board", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit board" });
  const toggle = dialog.getByRole("checkbox", {
    name: "Only a human completes a task",
  });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const completed = await post(
    "update_task",
    {
      id: task.id,
      expectedVersion: task.version,
      patch: { lane: board.lanes.find((lane: any) => lane.role === "done").id },
    },
    agent,
  );
  expect(completed.response.ok, JSON.stringify(completed.body)).toBeTruthy();
  expect(completed.body.role).toBe("done");
  const { body: boards } = await post("list_boards", {});
  expect(
    boards.boards.find((item: any) => item.id === "BOARD-1").policy
      .humanCompletionOnly,
  ).toBe(true);
  await page.getByRole("button", { name: "Edit board", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await dialog
    .getByLabel("Agent completion policy", { exact: true })
    .selectOption("architect");
  await dialog.getByLabel("Policy label", { exact: true }).fill("graphics");
  await dialog
    .getByLabel("Label approval", { exact: true })
    .selectOption("human");
  await dialog
    .getByRole("button", { name: "Add label policy", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const { body: labeled } = await post("create_task", {
    boardId: board.id,
    title: "Human graphics approval",
    labels: ["graphics"],
  });
  expect(labeled.completionPolicy.mode).toBe("human");
  const { body: plumbing } = await post("create_task", {
    boardId: board.id,
    title: "Architect approval",
  });
  expect(plumbing.completionPolicy.mode).toBe("architect");
});
