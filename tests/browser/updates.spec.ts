import { expect, test } from "@playwright/test";

const baseURL = process.env.TASKNBOARD_BASE_URL!;
const humanToken = process.env.TASKNBOARD_HUMAN_TOKEN!;

test("desktop settings checks updates and reports failures", async ({ page }) => {
  await page.addInitScript((token) => {
    sessionStorage.setItem("tasknboard-token", token);
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === "app_version") return "2.3.4";
          if (command === "check_for_updates") {
            await new Promise(resolve => setTimeout(resolve, 300));
            const state = window as unknown as { checked?: boolean };
            if (state.checked) throw "Network unavailable";
            state.checked = true;
            return "You have the latest version.";
          }
          throw `Unexpected command: ${command}`;
        },
      },
    });
  }, humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".sidebar .app-version")).toHaveText("v2.3.4");
  await page.locator(".sidebar").getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.locator(".app-version")).toHaveText("v2.3.4");
  await dialog.getByLabel("Search settings").fill("update");
  await dialog.getByRole("button", { name: "Updates", exact: true }).click();
  await dialog.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Checking for updates…" })).toBeDisabled();
  await expect(dialog.getByRole("status")).toHaveText("You have the latest version.");
  await dialog.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Could not check for updates: Network unavailable");
  await expect(dialog.getByRole("button", { name: "Check for updates", exact: true })).toBeEnabled();
});

test("browser shows the build version without desktop update controls", async ({ page }) => {
  await page.addInitScript((token) => sessionStorage.setItem("tasknboard-token", token), humanToken);
  await page.goto(baseURL);
  await expect(page.locator(".sidebar .app-version")).toHaveText(/^v\d+\.\d+\.\d+/);
  await page.locator(".sidebar").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Updates", exact: true })).toHaveCount(0);
});
