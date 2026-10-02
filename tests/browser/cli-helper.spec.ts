import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;

type CliHelperStatus = {
  supported: boolean;
  installed: boolean;
  path: string | null;
  onPath: boolean;
  instruction: string | null;
};

async function openCliHelper(page: Page) {
  await page.addInitScript((value) => {
    sessionStorage.setItem("tasknboard-token", value);
  }, humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".workspace-status .identity")).toContainText("reviewer");

  await page.locator(".sidebar").getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Search settings").fill("terminal");
  await settings.getByRole("button", { name: "Command line" }).click();
  await expect(settings.getByRole("heading", { name: "Command line" })).toBeVisible();
  return settings;
}

const reply = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

test("CLI helper installs from Settings and rechecks availability", async ({ page }) => {
  let installed = false;
  let postCount = 0;
  let postBody: string | null | undefined;
  const getAuthorization: string[] = [];

  await page.route("**/api/cli-helper", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      getAuthorization.push(request.headers().authorization ?? "");
      const status: CliHelperStatus = {
        supported: true,
        installed,
        path: installed ? "/usr/local/bin/tasknboard" : null,
        onPath: installed,
        instruction: installed ? "The CLI helper is ready to use." : null,
      };
      await route.fulfill(reply(200, status));
      return;
    }

    postCount++;
    postBody = request.postData();
    installed = true;
    await route.fulfill(
      reply(200, {
        supported: true,
        installed: true,
        path: "/usr/local/bin/tasknboard",
        onPath: true,
        instruction: null,
      } satisfies CliHelperStatus),
    );
  });

  const settings = await openCliHelper(page);
  const status = settings.locator(".settings-row-note[role='status']");
  await expect(status).toContainText(
    "The command line helper is not installed.",
  );
  await settings.getByRole("button", { name: "Install CLI helper" }).click();
  await expect(status).toContainText(
    "Installed at /usr/local/bin/tasknboard.",
  );
  await expect(status).toContainText("available on PATH");

  expect(postCount).toBe(1);
  expect(postBody).toBeNull();
  expect(getAuthorization.length).toBeGreaterThanOrEqual(2);
  expect(getAuthorization.every((value) => value === `Bearer ${humanToken}`)).toBe(true);
});

test("CLI helper reports flat GET and install errors accessibly", async ({ page }) => {
  let allowCheck = false;
  await page.route("**/api/cli-helper", async (route) => {
    if (route.request().method() === "GET") {
      if (!allowCheck) {
        await route.fulfill(
          reply(503, {
            code: "CLI_CHECK_FAILED",
            message: "Could not check CLI helper availability.",
          }),
        );
        return;
      }
      await route.fulfill(
        reply(200, {
          supported: true,
          installed: false,
          path: null,
          onPath: false,
          instruction: null,
        } satisfies CliHelperStatus),
      );
      return;
    }

    await route.fulfill(
      reply(500, {
        code: "CLI_INSTALL_FAILED",
        message: "The CLI helper installation failed.",
      }),
    );
  });

  const settings = await openCliHelper(page);
  await expect(settings.getByRole("alert")).toContainText(
    "Could not check CLI helper availability.",
  );

  allowCheck = true;
  await settings.getByRole("button", { name: "Check availability" }).click();
  await expect(settings.getByRole("status")).toContainText("not installed");
  await settings.getByRole("button", { name: "Install CLI helper" }).click();
  await expect(settings.getByRole("alert")).toContainText(
    "The CLI helper installation failed.",
  );
});

test("web Settings explains that the CLI helper is desktop-only", async ({ page }) => {
  const settings = await openCliHelper(page);
  await expect(settings.getByRole("status")).toContainText(
    "available only in the TasknBoard desktop app",
  );
  await expect(
    settings.getByRole("button", { name: "Install CLI helper" }),
  ).toHaveCount(0);
});
