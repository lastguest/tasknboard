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
  await expect(section.getByLabel("codex connection helper")).toContainText(
    "codex mcp add",
  );
  await section.getByLabel("Agent identity").fill("codex-2");
  await section
    .getByRole("button", { name: "Copy command", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).copiedHelper)).toContain(
    "TASKNBOARD_AGENT_ID=codex-2",
  );
  await expect(section.getByRole("status")).toContainText("Copied.");
  await section.getByLabel("Client", { exact: true }).selectOption("claude");
  await expect(section.getByRole("status")).toHaveCount(0);
  await expect(section.getByLabel("Agent identity")).toHaveValue("claude");
  await expect(section.getByLabel("claude connection helper")).toContainText(
    "claude mcp add tasknboard --transport stdio --scope user",
  );
  await section.getByLabel("Client", { exact: true }).selectOption("opencode");
  await section.getByRole("button", { name: "Copy configuration" }).click();
  const config = JSON.parse(
    await page.evaluate(() => (window as any).copiedHelper),
  );
  expect(config.mcp.tasknboard.environment.TASKNBOARD_AGENT_ID).toBe(
    "opencode",
  );
  await section.getByLabel("Client", { exact: true }).selectOption("pi");
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
