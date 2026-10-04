import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskFiles, responseUrls } from "../server/task-files.mjs";

test("task briefs read current files and reject paths outside the repository", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "brief.md"), "# Current brief\n");
  await writeFile(join(directory, "private.md"), "Private");
  assert.deepEqual(await readTaskFiles(repository, { briefPath: "brief.md" }), {
    brief: { path: "brief.md", content: "# Current brief\n" },
    result: null,
  });
  await writeFile(join(repository, "brief.md"), "Updated");
  assert.equal(
    (await readTaskFiles(repository, { briefPath: "brief.md" })).brief.content,
    "Updated",
  );
  await assert.rejects(
    readTaskFiles(repository, { resultPath: "../private.md" }),
    { code: "FILE_OUTSIDE_REPOSITORY" },
  );
  await assert.rejects(
    readTaskFiles(repository, { briefPath: join(directory, "private.md") }),
    { code: "FILE_OUTSIDE_REPOSITORY" },
  );
  await assert.rejects(readTaskFiles(repository, { briefPath: "missing.md" }), {
    code: "TASK_FILE_NOT_FOUND",
  });
});

test("task files reject binary text and links outside the repository", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tasknboard-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "binary"), Buffer.from([0xff, 0x00]));
  await assert.rejects(readTaskFiles(repository, { briefPath: "binary" }), {
    code: "TASK_FILE_ENCODING",
  });
  await writeFile(join(directory, "outside.md"), "Outside");
  try {
    await symlink(join(directory, "outside.md"), join(repository, "link.md"));
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(readTaskFiles(repository, { briefPath: "link.md" }), {
    code: "FILE_OUTSIDE_REPOSITORY",
  });
});

test("response URLs preserve external artifacts and resolve task links", () => {
  assert.deepEqual(
    responseUrls(
      {
        task: { url: "?board=BOARD-1&task=TN-1" },
        artifacts: [{ url: "https://example.com/log" }],
      },
      "http://localhost:4321",
    ),
    {
      task: { url: "http://localhost:4321/?board=BOARD-1&task=TN-1" },
      artifacts: [{ url: "https://example.com/log" }],
    },
  );
});
