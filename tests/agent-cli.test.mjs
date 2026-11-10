import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createCliHelper } from "../server/cli-helper.mjs";
import { credentialFor } from "../server/local-auth.mjs";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = resolve(projectRoot, "dist-cli/tasknboard.mjs");
const secret = "test-resident-service-secret-32-characters";

test(
  "installed CLI uses the resident MCP service and never falls back to SQLite",
  { skip: process.platform === "win32" },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "tasknboard-agent-cli-'"));
    const runtimeFile = join(home, "runtime.json");
    const credentialHelper = join(home, "TasknBoard");
    const resources = join(home, "resources");
    await mkdir(resources);
    await symlink(process.execPath, join(resources, "node"));
    await symlink(cliEntry, join(resources, "cli.mjs"));
    await writeFile(
      credentialHelper,
      `#!/bin/sh\n[ "$1" = "--service-credential" ] || exit 1\nprintf '%s\\n' '${secret}'\n`,
      { mode: 0o700 },
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("TASKNBOARD_"),
      ),
    );
    const service = spawn(process.execPath, ["server/http.mjs"], {
      cwd: projectRoot,
      env: {
        ...env,
        HOST: "127.0.0.1",
        PORT: "0",
        TASKNBOARD_DB: join(home, "workspace.sqlite"),
        TASKNBOARD_LOCAL_SECRET: secret,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    t.after(async () => {
      if (service.exitCode === null) {
        const exited = new Promise((done) => service.once("exit", done));
        service.kill();
        await exited;
      }
      await rm(home, { recursive: true, force: true });
    });
    const origin = await new Promise((done, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error(`Server startup timeout. ${output}`)),
        10000,
      );
      service.stderr.setEncoding("utf8");
      service.stderr.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/TasknBoard listening on (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timeout);
          done(match[1]);
        }
      });
      service.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server startup failed (${code}). ${output}`));
      });
    });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        url: origin,
        mcpUrl: `${origin}/mcp`,
        instanceId: "test",
        pid: service.pid,
        credentialHelper,
      }),
    );
    const helper = createCliHelper({
      desktop: true,
      platform: "darwin",
      home,
      resources,
      runtimeFile,
      credentialHelper,
    });
    const installed = await helper.install();
    const agentEnv = {
      ...env,
      TASKNBOARD_AGENT_ID: "pi",
      TASKNBOARD_DB: join(home, "stale.sqlite"),
    };
    const command = async (name, args = {}, extra = {}) =>
      JSON.parse(
        (
          await run(installed.path, [name, JSON.stringify(args)], {
            env: { ...agentEnv, ...extra },
          })
        ).stdout,
      );
    const info = await command("workspace_info");
    assert.equal(info.actor.id, "pi");
    assert.equal(info.actor.kind, "agent");
    const explicit = await command(
      "workspace_info",
      {},
      {
        TASKNBOARD_SERVER_URL: origin,
        TASKNBOARD_TOKEN: credentialFor(secret, { id: "codex", kind: "agent" }),
        TASKNBOARD_RUNTIME_FILE: join(home, "missing.json"),
        TASKNBOARD_CREDENTIAL_HELPER: join(home, "missing-helper"),
      },
    );
    assert.equal(explicit.actor.id, "codex");
    assert.equal(explicit.actor.kind, "agent");
    const boards = await command("list_boards");
    const created = await command("create_task", {
      boardId: boards.boards[0].id,
      title: "Resident MCP task",
    });
    const task = created.task ?? created;
    const claimed = await command("claim_task", {
      id: task.id,
      expectedVersion: task.version,
    });
    assert.equal((claimed.task ?? claimed).lease.actor, "pi");
    await assert.rejects(
      run(installed.path, [], { env: agentEnv }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /one-shot commands as an agent/);
        return true;
      },
    );
    await rm(runtimeFile);
    await assert.rejects(command("workspace_info"), (error) => {
      assert.equal(JSON.parse(error.stderr).code, "SERVICE_UNAVAILABLE");
      return true;
    });
    await assert.rejects(access(agentEnv.TASKNBOARD_DB), { code: "ENOENT" });
    assert.doesNotMatch(
      await readFile(installed.path, "utf8"),
      /TASKNBOARD_DB|tnb1\./,
    );
  },
);
