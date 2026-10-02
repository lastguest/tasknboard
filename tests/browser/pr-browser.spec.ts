import { expect, test } from "@playwright/test";

test("the PR browser button uses the native opener and reports failures", async ({
  page,
}) => {
  await page.addInitScript((token) => {
    sessionStorage.setItem("tasknboard-token", token);
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: object) => {
        (window as any).externalOpen = { command, args };
        throw new Error("Browser unavailable");
      },
    };
  }, process.env.TASKNBOARD_HUMAN_TOKEN!);
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
  await page.route("**/api/get_pull_request", (route) =>
    route.fulfill({
      status: 500,
      json: { code: "unavailable", message: "PR unavailable" },
    }),
  );
  await page.goto(`${process.env.TASKNBOARD_BASE_URL}/#pulls/acme/api/412`);
  await expect(page.getByText("PR unavailable", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open on GitHub", exact: true }).click();
  expect(await page.evaluate(() => (window as any).externalOpen)).toEqual({
    command: "open_external_url",
    args: { url: "https://github.com/acme/api/pull/412" },
  });
  await expect(
    page.getByText("Browser unavailable", { exact: true }),
  ).toBeVisible();
});
