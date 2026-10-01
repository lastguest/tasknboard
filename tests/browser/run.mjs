import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const forwarded = process.argv.slice(2);
const humanToken = "test-only-human-token-123456789";
const agentToken = "test-only-agent-token-123456789";

async function freePort() {
  const socket = createServer();
  await new Promise((resolveListen, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolveListen);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No free TCP port");
  await new Promise((resolveClose, reject) =>
    socket.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

const executable =
  process.env.TASKNBOARD_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
if (!executable || !existsSync(executable)) {
  console.error("Playwright Chromium is missing. Install it with: npx playwright install chromium");
  process.exitCode = 1;
} else {
  const databaseDir = mkdtempSync(join(tmpdir(), "tasknboard-ui-db-"));
  // Playwright empties its output folder when a run starts, so concurrent runs
  // sharing one would delete each other's traces. Each run gets its own.
  mkdirSync(join(root, "test-results"), { recursive: true });
  const outputDir = mkdtempSync(join(root, "test-results", "browser-"));
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server/http.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TASKNBOARD_DB: join(databaseDir, "browser.sqlite"),
      TASKNBOARD_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      TASKNBOARD_TOKENS: JSON.stringify({
        [humanToken]: { id: "reviewer", kind: "human" },
        [agentToken]: { id: "browser-agent", kind: "agent" },
      }),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverLog = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    serverLog += chunk;
    process.stderr.write(chunk);
  });
  let status = 1;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null)
        throw new Error(`HTTP server exited early. ${serverLog}`);
      try {
        const response = await fetch(baseURL);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!ready) throw new Error(`HTTP server did not start. ${serverLog}`);

    console.log(`Browser: ${executable}`);
    console.log(`Isolated database: ${join(databaseDir, "browser.sqlite")}`);
    const env = {
      ...process.env,
      TASKNBOARD_BASE_URL: baseURL,
      TASKNBOARD_HUMAN_TOKEN: humanToken,
      TASKNBOARD_AGENT_TOKEN: agentToken,
      TASKNBOARD_CHROMIUM_EXECUTABLE_PATH: executable,
    };
    const cli = resolve(root, "node_modules/@playwright/test/cli.js");
    const args = [
      cli,
      "test",
      "--config",
      "playwright.config.ts",
      "--output",
      outputDir,
    ];
    args.push(...forwarded);
    const testRun = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    status = await new Promise((resolveExit, reject) => {
      testRun.once("error", reject);
      testRun.once("exit", (code, signal) =>
        resolveExit(code ?? (signal ? 1 : 0)),
      );
    });
  } catch (error) {
    console.error(error);
    status = 1;
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolveExit) => {
      if (server.exitCode !== null) resolveExit();
      else {
        const timeout = setTimeout(() => {
          server.kill("SIGKILL");
          resolveExit();
        }, 3000);
        server.once("exit", () => {
          clearTimeout(timeout);
          resolveExit();
        });
      }
    });
    rmSync(databaseDir, { recursive: true, force: true });
    // Keep a failed run's traces for inspection; a passing run leaves nothing.
    if (status === 0) rmSync(outputDir, { recursive: true, force: true });
    else console.log(`Test output: ${outputDir}`);
  }
  process.exitCode = status;
}
