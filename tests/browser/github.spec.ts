import { expect, test, type Locator, type Page } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;
const verificationUri = "https://github.com/login/device";

const disconnected = {
  configured: true,
  connected: false,
  source: "",
};
const connected = (login: string) => ({
  configured: true,
  connected: true,
  source: "settings",
  account: { login, name: "", avatarUrl: "" },
});
const authorization = {
  userCode: "ABCD-EFGH",
  verificationUri,
  expiresIn: 900,
  interval: 0.02,
};

async function openGitHubSettings(page: Page, status: object) {
  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
  }, humanToken);
  await page.route("**/api/github_status", (route) =>
    route.fulfill({ json: status }),
  );
  await page.route("**/api/connect_github", (route) =>
    route.fulfill({ json: authorization }),
  );
  await page.context().route(verificationUri, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>GitHub</title>",
    }),
  );

  await page.goto(baseURL);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Settings(?:\s|$)/ })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "GitHub" }).click();
  return settings;
}

async function openVerificationPage(page: Page, settings: Locator) {
  const link = settings.getByRole("link", {
    name: /Connect GitHub|Switch GitHub account/,
  });
  await expect(link).toHaveAttribute("href", verificationUri);
  await expect(link).toHaveAttribute("target", "_blank");
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(verificationUri);
  return popup;
}

test("GitHub device authorization shows pending code, honors slow_down, and keeps saved account on cancel", async ({
  page,
}) => {
  const times: number[] = [];
  let polls = 0;
  let cancellations = 0;
  let disconnects = 0;
  await page.route("**/api/poll_github_authorization", async (route) => {
    polls++;
    times.push(Date.now());
    await route.fulfill({ json: { pending: true, interval: 0.12 } });
  });
  await page.route("**/api/disconnect_github", async (route) => {
    disconnects++;
    await route.fulfill({ json: disconnected });
  });
  await page.route("**/api/cancel_github_authorization", async (route) => {
    cancellations++;
    await route.fulfill({ json: connected("saved-user") });
  });
  const settings = await openGitHubSettings(page, connected("saved-user"));

  // A connected workspace shows no new code until the person asks to switch.
  const disconnect = settings.getByRole("button", { name: "Disconnect" });
  await expect(disconnect).toHaveClass(/danger-button/);
  await expect(settings.getByText("Connected", { exact: true })).toBeVisible();
  await expect(settings.getByLabel("GitHub authorization code")).toHaveCount(0);
  await expect(settings.getByText("Authorization", { exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Switch account" }).click();
  await expect(settings.getByLabel("GitHub authorization code")).toHaveText(
    "ABCD-EFGH",
  );
  const popup = await openVerificationPage(page, settings);
  await expect(settings.getByRole("status")).toContainText(
    "Waiting for approval",
  );
  await expect.poll(() => polls).toBeGreaterThanOrEqual(2);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(80);
  await settings.getByRole("button", { name: "Cancel authorization" }).click();
  await expect(settings.getByRole("status")).toContainText(
    "current connection is unchanged",
  );
  await expect(
    settings.getByText("saved-user", { exact: false }),
  ).toBeVisible();
  const pollsAfterCancel = polls;
  await page.waitForTimeout(150);
  expect(polls).toBe(pollsAfterCancel);
  expect(cancellations).toBe(1);
  expect(disconnects).toBe(0);
  await popup.close();
});

test("GitHub device authorization updates status after approval", async ({
  page,
}) => {
  let polls = 0;
  await page.route("**/api/poll_github_authorization", async (route) => {
    polls++;
    await route.fulfill({
      json:
        polls === 1 ? { pending: true, interval: 1 } : connected("new-user"),
    });
  });
  const settings = await openGitHubSettings(page, disconnected);

  const popup = await openVerificationPage(page, settings);
  await expect(settings.getByRole("status")).toContainText(
    "Connected as @new-user",
  );
  await expect(settings.getByText("Connected", { exact: true })).toBeVisible();
  expect(polls).toBe(2);
  await popup.close();
});

test("GitHub device authorization reports a rejected or expired request", async ({
  page,
}) => {
  await page.route("**/api/poll_github_authorization", (route) =>
    route.fulfill({
      status: 410,
      json: {
        code: "GITHUB_ERROR",
        message: "The authorization code expired.",
      },
    }),
  );
  const settings = await openGitHubSettings(page, disconnected);

  await expect(settings.getByRole("alert")).toContainText(
    "The authorization code expired.",
  );
  await expect(
    settings.getByRole("link", { name: /Connect GitHub/ }),
  ).toHaveCount(0);
});

test("GitHub device authorization notices approval when GitHub was opened outside the link", async ({
  page,
}) => {
  let polls = 0;
  await page.route("**/api/poll_github_authorization", async (route) => {
    polls++;
    await route.fulfill({
      json:
        polls === 1 ? { pending: true, interval: 0.02 } : connected("new-user"),
    });
  });
  const settings = await openGitHubSettings(page, disconnected);

  // The person opens the verification page from the context menu or another
  // device, so the Connect link is never clicked.
  await expect(settings.getByRole("status")).toContainText(
    "Connected as @new-user",
  );
  await expect(settings.getByText("Connected", { exact: true })).toBeVisible();
  expect(polls).toBe(2);
});

test("GitHub settings hide authorization when the server is not configured", async ({
  page,
}) => {
  let connectCalls = 0;
  const settings = await openGitHubSettings(page, {
    configured: false,
    connected: false,
    source: "",
  });
  await page.route("**/api/connect_github", async (route) => {
    connectCalls++;
    await route.fulfill({ json: authorization });
  });

  await expect(
    settings.getByText("Unavailable", { exact: true }),
  ).toBeVisible();
  await expect(settings).toContainText("TASKNBOARD_GITHUB_CLIENT_ID");
  await expect(settings.getByLabel("GitHub authorization code")).toHaveCount(0);
  await expect(
    settings.getByRole("link", { name: /Connect GitHub/ }),
  ).toHaveCount(0);
  await expect(settings.locator('input[type="password"]')).toHaveCount(0);
  expect(connectCalls).toBe(0);
});

test("the desktop authorization link uses the native external browser opener", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: object) => {
        (window as any).externalOpen = { command, args };
      },
    };
  });
  await page.route("**/api/poll_github_authorization", (route) =>
    route.fulfill({ json: { pending: true, interval: 1 } }),
  );
  const settings = await openGitHubSettings(page, disconnected);
  await settings.getByRole("link", { name: "Connect GitHub", exact: true }).click();
  expect(await page.evaluate(() => (window as any).externalOpen)).toEqual({
    command: "open_external_url",
    args: { url: verificationUri },
  });
  await expect(settings.getByRole("status")).toContainText("Waiting for approval");
});
