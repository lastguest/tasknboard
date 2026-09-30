import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = resolve(projectRoot, "dist-cli/tasknboard.mjs");

test(
  "local CLI config exposes the built command and the CLI honors agent identity",
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tasknboard-agent-cli-"));
    const database = join(directory, "workspace.sqlite");
    const env = { ...process.env, PORT: "0", TASKNBOARD_DB: database };
    delete env.TASKNBOARD_TOKENS;
    delete env.TASKNBOARD_DESKTOP;
    delete env.TASKNBOARD_RESOURCES;
    delete env.TASKNBOARD_SERVER_URL;
    delete env.TASKNBOARD_TOKEN;

    const service = spawn(process.execPath, ["server/http.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let serviceOutput = "";
    let origin;
    const ready = new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => rejectReady(new Error(`Server startup timeout. ${serviceOutput}`)),
        10000,
      );
      service.stderr.setEncoding("utf8");
      service.stderr.on("data", (chunk) => {
        serviceOutput += chunk;
        const match = serviceOutput.match(
          /TasknBoard listening on (http:\/\/\S+)/,
        );
        if (match) {
          clearTimeout(timeout);
          origin = match[1];
          resolveReady();
        }
      });
      service.once("exit", (code) => {
        clearTimeout(timeout);
        rejectReady(
          new Error(`Server exited during startup (${code}). ${serviceOutput}`),
        );
      });
    });
    t.after(async () => {
      if (service.exitCode === null) {
        service.kill();
        await new Promise((resolveExit) => service.once("exit", resolveExit));
      }
      await rm(directory, { recursive: true, force: true });
    });
    await ready;

    const configResponse = await fetch(`${origin}/api/mcp-config`);
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.equal(config.mode, "local");
    assert.equal(config.platform, process.platform);
    assert.deepEqual(config.cli, {
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", cliEntry],
      env: { TASKNBOARD_DB: database, TASKNBOARD_AGENT_ID: "pi" },
    });
    assert.deepEqual(config.config.mcpServers.tasknboard, {
      command: process.execPath,
      args: [resolve(projectRoot, "server/mcp.mjs")],
      env: { TASKNBOARD_DB: database, TASKNBOARD_AGENT_ID: "codex" },
    });

    const agentEnv = { ...env, TASKNBOARD_AGENT_ID: "pi" };
    const info = JSON.parse(
      (
        await run(config.cli.command, [...config.cli.args, "workspace_info"], {
          env: agentEnv,
        })
      ).stdout,
    );
    assert.equal(info.actor.id, "pi");
    assert.equal(info.actor.kind, "agent");

    await assert.rejects(
      run(
        config.cli.command,
        [
          ...config.cli.args,
          "create_board",
          '{"name":"Engineering","prefix":"ENG"}',
        ],
        { env: agentEnv },
      ),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "FORBIDDEN");
        return true;
      },
    );

    await assert.rejects(
      run(config.cli.command, config.cli.args, { env: agentEnv }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /one-shot commands as an agent/);
        return true;
      },
    );
  },
);
