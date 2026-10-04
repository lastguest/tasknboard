import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const failure = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
const limit = 256 * 1024;

/** Read only the two task files inside the board's repository. */
export async function readTaskFiles(repository, task) {
  if (!task.briefPath && !task.resultPath) return { brief: null, result: null };
  if (!repository)
    throw failure(
      "REPOSITORY_REQUIRED",
      "Set the board repository before reading task files.",
    );
  let root;
  try {
    root = await realpath(repository);
  } catch {
    throw failure(
      "REPOSITORY_REQUIRED",
      "The board repository does not exist.",
    );
  }
  async function read(path) {
    if (!path) return null;
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path))
      throw failure(
        "FILE_OUTSIDE_REPOSITORY",
        "Task file paths must be relative to the board repository.",
      );
    const target = await realpath(resolve(root, path));
    const scoped = relative(root, target);
    if (scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped))
      throw failure(
        "FILE_OUTSIDE_REPOSITORY",
        "The task file is outside the board repository.",
      );
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > limit)
      throw failure(
        "TASK_FILE_TOO_LARGE",
        "Task files must be text files of 256 KiB or less.",
      );
    const bytes = await readFile(target);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw failure("TASK_FILE_ENCODING", "Task files must use UTF-8 text.");
    }
    if (content.includes("\0"))
      throw failure("TASK_FILE_ENCODING", "Task files must contain text.");
    return { path, content };
  }
  try {
    const [brief, result] = await Promise.all([
      read(task.briefPath),
      read(task.resultPath),
    ]);
    return { brief, result };
  } catch (error) {
    if (error.code === "ENOENT")
      throw failure(
        "TASK_FILE_NOT_FOUND",
        "A linked task file does not exist.",
        404,
      );
    throw error;
  }
}

/** Replace store permalinks with the caller's origin on a shared server. */
export function responseUrls(value, origin) {
  if (Array.isArray(value))
    return value.map((item) => responseUrls(item, origin));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "url" && typeof item === "string" && item.startsWith("?")
        ? new URL(`/${item}`, origin).href
        : responseUrls(item, origin),
    ]),
  );
}
