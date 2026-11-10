import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCliHelper } from "../server/cli-helper.mjs";
const exec = promisify(execFile);

test(
  "CLI helper installs once, reports PATH, and preserves service overrides",
  { skip: process.platform === "win32" },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "tasknboard-helper-'"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const resources = join(home, "app resources");
    await mkdir(resources);
    await symlink(process.execPath, join(resources, "node"));
    await writeFile(
      join(resources, "cli.mjs"),
      "console.log(JSON.stringify({runtime:process.env.TASKNBOARD_RUNTIME_FILE,helper:process.env.TASKNBOARD_CREDENTIAL_HELPER,args:process.argv.slice(2)}))",
    );
    const runtimeFile = join(home, "runtime.json");
    const credentialHelper = join(home, "TasknBoard");
    const helper = createCliHelper({
      desktop: true,
      platform: "darwin",
      home,
      resources,
      runtimeFile,
      credentialHelper,
      searchPath: join(home, ".local/bin"),
    });
    assert.equal((await helper.status()).installed, false);
    const installed = await helper.install();
    assert.equal(installed.installed, true);
    assert.equal(installed.onPath, true);
    assert.deepEqual(await helper.install(), installed);
    const run = async (env) =>
      JSON.parse(
        (
          await exec(
            installed.path,
            ["list_tasks", '{"title":"hello world"}'],
            { env },
          )
        ).stdout,
      );
    assert.deepEqual(await run({}), {
      runtime: runtimeFile,
      helper: credentialHelper,
      args: ["list_tasks", '{"title":"hello world"}'],
    });
    assert.equal(
      (await run({ TASKNBOARD_RUNTIME_FILE: "/explicit.json" })).runtime,
      "/explicit.json",
    );
    assert.equal(
      (await run({ TASKNBOARD_CREDENTIAL_HELPER: "/explicit-helper" })).helper,
      "/explicit-helper",
    );
    const absent = createCliHelper({
      desktop: true,
      platform: "darwin",
      home,
      resources,
      runtimeFile,
      credentialHelper,
      searchPath: "/usr/bin",
    });
    assert.equal((await absent.status()).onPath, false);
    assert.match((await absent.status()).instruction, /export PATH=/);
    await writeFile(installed.path, "unrelated executable");
    await assert.rejects(helper.install(), { code: "CLI_CONFLICT" });
    assert.equal(
      await readFile(installed.path, "utf8"),
      "unrelated executable",
    );
    await rm(installed.path);
    await symlink(join(home, "missing"), installed.path);
    await assert.rejects(helper.install(), { code: "CLI_CONFLICT" });
  },
);

test("CLI helper rejects installation outside desktop mode", async () => {
  const helper = createCliHelper({ desktop: false });
  assert.deepEqual(await helper.status(), {
    supported: false,
    installed: false,
    path: null,
    onPath: false,
    instruction: null,
  });
  await assert.rejects(helper.install(), { code: "CLI_UNSUPPORTED" });
});

test(
  "desktop HTTP checks and installs the helper while rejecting foreign origins",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { createInterface } = await import("node:readline");
    const home = await mkdtemp(join(tmpdir(), "tasknboard-helper-http-"));
    await symlink(process.execPath, join(home, "node"));
    await writeFile(join(home, "cli.mjs"), "console.log('fixture')");
    const secret = "test-helper-service-secret-32-characters";
    const child = spawn(
      process.execPath,
      [new URL("../server/http.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: "0",
          TASKNBOARD_TOKENS: "{}",
          TASKNBOARD_ALLOWED_HOSTS: "",
          TASKNBOARD_DESKTOP: "1",
          TASKNBOARD_USER_HOME: home,
          TASKNBOARD_RESOURCES: home,
          TASKNBOARD_DB: join(home, "test.sqlite"),
          TASKNBOARD_LOCAL_SECRET: secret,
          TASKNBOARD_RUNTIME_FILE: join(home, "runtime.json"),
          TASKNBOARD_CREDENTIAL_HELPER: join(home, "TasknBoard"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(async () => {
      const exit = once(child, "exit");
      child.stdin.end();
      await exit;
      await rm(home, { recursive: true, force: true });
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, "line");
    const { url } = JSON.parse(line);
    const endpoint = `${url}/api/cli-helper`;
    assert.equal(
      (
        await (
          await fetch(endpoint, {
            headers: { Authorization: `Bearer ${secret}` },
          })
        ).json()
      ).installed,
      false,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Origin: "https://untrusted.example",
            Authorization: `Bearer ${secret}`,
          },
        })
      ).status,
      403,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Origin: url, Authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 200);
    const installed = await response.json();
    assert.equal(installed.installed, true);
    await writeFile(installed.path, "unrelated");
    const conflict = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).message, /already exists/);
    lines.close();
  },
);

test(
  "Windows helper runs with non-ASCII paths",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { copyFile } = await import("node:fs/promises");
    const home = await mkdtemp(join(tmpdir(), "tasknboard-é-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const resources = join(home, "app resources é");
    await mkdir(resources);
    await copyFile(process.execPath, join(resources, "node.exe"));
    await writeFile(
      join(resources, "cli.mjs"),
      "console.log(JSON.stringify({runtime:process.env.TASKNBOARD_RUNTIME_FILE,helper:process.env.TASKNBOARD_CREDENTIAL_HELPER}))",
    );
    const runtimeFile = join(home, "données.json");
    const credentialHelper = join(home, "TasknBoard.exe");
    const helper = createCliHelper({
      desktop: true,
      platform: "win32",
      home,
      resources,
      runtimeFile,
      credentialHelper,
      searchPath: join(home, ".local", "bin"),
    });
    const installed = await helper.install();
    assert.equal(installed.installed, true);
    const { stdout } = await exec(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", `""${installed.path}""`],
      {
        env: {
          ...process.env,
          TASKNBOARD_RUNTIME_FILE: "",
          TASKNBOARD_CREDENTIAL_HELPER: "",
        },
        // cmd /s /c needs the outer quotes as written; Node would escape them.
        windowsVerbatimArguments: true,
      },
    );
    assert.equal(JSON.parse(stdout.trim()).runtime, runtimeFile);
  },
);

test("a database path cannot make a legacy helper available", async () => {
  const helper = createCliHelper({
    desktop: true,
    platform: "darwin",
    home: "/tmp",
    resources: "/tmp",
    database: "/tmp/stale.sqlite",
    runtimeFile: undefined,
    credentialHelper: undefined,
  });
  assert.equal((await helper.status()).supported, false);
  await assert.rejects(helper.install(), { code: "CLI_UNSUPPORTED" });
});
