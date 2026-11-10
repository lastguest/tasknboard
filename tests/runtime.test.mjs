import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConnection } from "../server/runtime.mjs";
import { authenticateLocal } from "../server/local-auth.mjs";

const secret = "runtime-test-local-secret-32-characters";
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tnb-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = join(directory, "helper-invoked");
  const helper = join(directory, "credential-helper");
  const runtime = join(directory, "runtime.json");
  await writeFile(
    helper,
    `#!/bin/sh\n[ "$1" = "--service-credential" ] || exit 1\nprintf invoked > '${trace}'\nprintf '%s\\n' '${secret}'\n`,
    { mode: 0o700 },
  );
  return {
    trace,
    runtime,
    env: {
      TASKNBOARD_RUNTIME_FILE: runtime,
      TASKNBOARD_CREDENTIAL_HELPER: helper,
    },
  };
}

const unused = (trace) => assert.rejects(access(trace), { code: "ENOENT" });

test("a remote endpoint without an explicit token never invokes the native helper", async (t) => {
  const { env, trace } = await fixture(t);
  await assert.rejects(
    resolveConnection({
      env: {
        ...env,
        TASKNBOARD_SERVER_URL: "https://remote.example",
      },
    }),
    { code: "CREDENTIAL_UNAVAILABLE" },
  );
  await unused(trace);
});

test("an explicit HTTPS endpoint uses only its explicit token", async (t) => {
  const { env, trace } = await fixture(t);
  const connection = await resolveConnection({
    env: {
      ...env,
      TASKNBOARD_SERVER_URL: "https://remote.example/service/",
      TASKNBOARD_TOKEN: "explicit-remote-token",
    },
  });
  assert.equal(connection.url.href, "https://remote.example/service/mcp");
  assert.equal(connection.token, "explicit-remote-token");
  await unused(trace);
});

test("missing and malformed resident descriptors fail without invoking a helper", async (t) => {
  const { env, runtime, trace } = await fixture(t);
  await assert.rejects(resolveConnection({ env }), {
    code: "SERVICE_UNAVAILABLE",
  });
  for (const content of [
    "{invalid",
    "{}",
    JSON.stringify({ mcpUrl: "not a URL" }),
  ]) {
    await writeFile(runtime, content);
    await assert.rejects(resolveConnection({ env }), {
      code: "SERVICE_UNAVAILABLE",
    });
  }
  await assert.rejects(
    resolveConnection({
      env: {
        ...env,
        TASKNBOARD_SERVER_URL: "not a URL",
        TASKNBOARD_TOKEN: "explicit-token",
      },
    }),
    { code: "SERVICE_UNAVAILABLE" },
  );
  await unused(trace);
});

test("resident descriptors require loopback HTTP even with an explicit token", async (t) => {
  const { env, runtime, trace } = await fixture(t);
  for (const mcpUrl of [
    "https://remote.example/mcp",
    "http://remote.example/mcp",
    "https://127.0.0.1:4310/mcp",
  ]) {
    await writeFile(runtime, JSON.stringify({ mcpUrl }));
    await assert.rejects(resolveConnection({ env }), {
      code: "INSECURE_CONNECTION",
    });
    await assert.rejects(
      resolveConnection({
        env: { ...env, TASKNBOARD_TOKEN: "explicit-token" },
      }),
      { code: "INSECURE_CONNECTION" },
    );
  }
  await unused(trace);
});

test(
  "the local descriptor invokes the helper and signs an agent credential",
  { skip: process.platform === "win32" },
  async (t) => {
    const { env, runtime, trace } = await fixture(t);
    await writeFile(
      runtime,
      JSON.stringify({ mcpUrl: "http://127.0.0.1:4310/mcp" }),
    );
    const actor = { id: "codex", kind: "agent" };
    const connection = await resolveConnection({ env, actor });
    assert.equal(connection.url.href, "http://127.0.0.1:4310/mcp");
    assert.equal(await readFile(trace, "utf8"), "invoked");
    assert.notEqual(connection.token, secret);
    assert.deepEqual(authenticateLocal(connection.token, secret), actor);
  },
);
