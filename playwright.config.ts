import { defineConfig } from "@playwright/test";

const executablePath = process.env.TASKNBOARD_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  timeout: 45_000,
  expect: { timeout: 7_000 },
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: process.env.TASKNBOARD_BASE_URL,
    browserName: "chromium",
    headless: true,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
    },
    screenshot: "off",
    trace: "off",
  },
});
