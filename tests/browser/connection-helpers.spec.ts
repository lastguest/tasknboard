import { expect, test } from "@playwright/test";

test("client helpers switch formats, copy current identity, and report clipboard failures", async ({
  page,
}) => {
  await page.addInitScript((token) => {
    sessionStorage.setItem("tasknboard-token", token);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          if ((window as any).failCopy) throw new Error("Clipboard denied");
          (window as any).copiedHelper = text;
        },
      },
    });
  }, process.env.TASKNBOARD_HUMAN_TOKEN!);
  await page.route("**/api/mcp-config", (route) =>
    route.fulfill({
      json: {
        mode: "local",
        platform: "darwin",
        config: {
          mcpServers: {
            tasknboard: {
              command: "/Applications/TasknBoard/node",
              args: ["/Applications/TasknBoard/mcp.mjs"],
              env: { TASKNBOARD_DB: "/Workspace/My tasks.sqlite" },
            },
          },
        },
        cli: {
          command: "/Applications/TasknBoard/node",
          args: ["/Applications/TasknBoard/cli.mjs"],
          env: { TASKNBOARD_DB: "/Workspace/My tasks.sqlite" },
        },
      },
    }),
  );
  await page.goto(process.env.TASKNBOARD_BASE_URL!);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  const section = page.getByRole("region", {
    name: "Connect a coding agent",
    exact: true,
  });
  // Each CLI is a tile; Claude Code is chosen first.
  const clients = section.getByRole("group", { name: "Client" });
  await expect(clients.getByRole("radio")).toHaveCount(4);
  await expect(clients.getByRole("radio", { name: /Claude Code/ })).toBeChecked();
  await clients.getByRole("radio", { name: /Codex/ }).check();
  await expect(section.getByRole("heading", { name: "Connect Codex" })).toBeVisible();
  await expect(section.getByRole("listitem").first()).toContainText("codex");
  await expect(section.getByLabel("codex connection helper")).toHaveCount(0);
  await section.getByLabel("Agent identity").fill("codex-2");
  let identity = "";
  await page.route("**/api/codex-plugin", async (route) => {
    identity = route.request().postDataJSON().identity;
    await route.fulfill({ json: { installed: true, identity } });
  });
  await section
    .getByRole("button", { name: "Install Codex plugin", exact: true })
    .click();
  await expect(section.getByRole("status")).toContainText("plugin installed");
  expect(identity).toBe("codex-2");
  await page.route("**/api/codex-plugin", (route) =>
    route.fulfill({
      status: 400,
      json: { message: "Install the Codex CLI and add it to PATH." },
    }),
  );
  await section
    .getByRole("button", { name: "Install Codex plugin", exact: true })
    .click();
  await expect(section.getByRole("alert")).toContainText(
    "Install the Codex CLI",
  );
  await section.getByLabel("Agent identity").fill("");
  await expect(
    section.getByRole("button", { name: "Install Codex plugin", exact: true }),
  ).toBeDisabled();
  await clients.getByRole("radio", { name: /^Claude Code/ }).check();
  await expect(section.getByRole("status")).toHaveCount(0);
  await expect(section.getByLabel("Agent identity")).toHaveValue("claude");
  await expect(section.getByLabel("claude connection helper")).toHaveCount(0);
  await section.getByLabel("Agent identity").fill("claude-2");
  await page.route("**/api/claude-plugin", async (route) => {
    identity = route.request().postDataJSON().identity;
    await route.fulfill({ json: { installed: true, identity } });
  });
  await section
    .getByRole("button", { name: "Install Claude plugin", exact: true })
    .click();
  await expect(section.getByRole("status")).toContainText(
    "Restart Claude Code",
  );
  expect(identity).toBe("claude-2");
  await page.route("**/api/claude-plugin", (route) =>
    route.fulfill({
      status: 400,
      json: { message: "Install the Claude Code CLI and add it to PATH." },
    }),
  );
  await section
    .getByRole("button", { name: "Install Claude plugin", exact: true })
    .click();
  await expect(section.getByRole("alert")).toContainText(
    "Install the Claude Code CLI",
  );
  await clients.getByRole("radio", { name: /^OpenCode/ }).check();
  await section.getByRole("button", { name: "Copy configuration" }).click();
  const config = JSON.parse(
    await page.evaluate(() => (window as any).copiedHelper),
  );
  expect(config.mcp.tasknboard.environment.TASKNBOARD_AGENT_ID).toBe(
    "opencode",
  );
  await clients.getByRole("radio", { name: /^Pi/ }).check();
  await expect(section.getByLabel("pi connection helper")).toContainText(
    "/Applications/TasknBoard/cli.mjs",
  );
  const downloadPromise = page.waitForEvent("download");
  await section.getByRole("button", { name: "Download skill" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("SKILL.md");
  await page.evaluate(() => {
    (window as any).failCopy = true;
  });
  await section
    .getByRole("button", { name: "Copy skill", exact: true })
    .click();
  await expect(section.getByRole("alert")).toContainText("copy it manually");
  await section.getByLabel("Agent identity").fill("");
  await expect(
    section.getByRole("button", { name: "Copy skill", exact: true }),
  ).toBeDisabled();
  await expect(section.getByLabel("pi connection helper")).toHaveCount(0);
});
