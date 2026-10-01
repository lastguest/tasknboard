import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { identityPattern } from "./agent-config.mjs";

/** The newest part of a log a reader gets; older output is cut. */
export const logReadLimit = 512 * 1024;
const taskPattern = /^[A-Z][A-Z0-9]{0,9}-\d+$/;
/** `<task>-<ISO time with : as ->.log`, as the launcher names them. */
const filePattern = /^([A-Z][A-Z0-9]{0,9}-\d+)-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)\.log$/;
const failure = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });

const oneLine = (value, max = 200) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
/** The part of a tool call a person needs to follow along. */
function toolSummary(input = {}) {
  for (const key of ["description", "command", "file_path", "pattern", "url", "query", "prompt"])
    if (typeof input[key] === "string" && input[key]) return oneLine(input[key]);
  return oneLine(JSON.stringify(input));
}
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part) => (part?.type === "text" ? part.text : "")).join(" ");
  return "";
}

/**
 * Claude Code's stream-json output as readable lines: its text, each tool
 * call, a short result, and how the run ended. Other lines stay as written,
 * so Codex, OpenCode, and Pi logs read as they are.
 */
export function readableLog(text) {
  const out = [];
  for (const line of text.split("\n")) {
    let event;
    try {
      event = line.startsWith("{") ? JSON.parse(line) : null;
    } catch {
      event = null;
    }
    if (!event || typeof event.type !== "string") {
      if (line.trim()) out.push(line);
      continue;
    }
    if (event.type === "system" && event.subtype === "init")
      out.push(`▸ Session started${event.model ? ` with ${event.model}` : ""}`);
    else if (event.type === "assistant")
      for (const part of event.message?.content ?? []) {
        if (part.type === "text" && part.text?.trim()) out.push("", part.text.trim(), "");
        else if (part.type === "tool_use")
          out.push(`→ ${String(part.name).replace(/^mcp__[^_]+__/, "")}: ${toolSummary(part.input)}`);
      }
    else if (event.type === "user")
      for (const part of event.message?.content ?? []) {
        if (part.type !== "tool_result") continue;
        const result = oneLine(resultText(part.content), 160);
        if (result) out.push(`  ${part.is_error ? "✗" : "←"} ${result}`);
      }
    else if (event.type === "result")
      out.push(
        "",
        `■ ${event.is_error ? "Failed" : "Finished"}${event.result ? `: ${oneLine(event.result, 400)}` : ""}`,
      );
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The agent run logs under `<home>/.tasknboard/logs`, per task. */
export function createAgentLogs({ home, running = () => new Set() }) {
  const root = home ? join(home, ".tasknboard", "logs") : "";
  /** Every run of a task, newest first. */
  async function list(taskId) {
    if (!root) return [];
    if (!taskPattern.test(taskId)) throw failure("VALIDATION", "taskId: Key like ABC-12 required");
    let identities = [];
    try {
      identities = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && identityPattern.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const live = running();
    const runs = [];
    for (const identity of identities) {
      let files = [];
      try {
        files = await readdir(join(root, identity));
      } catch {
        continue;
      }
      for (const file of files) {
        const match = filePattern.exec(file);
        if (!match || match[1] !== taskId) continue;
        const path = join(root, identity, file);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) continue;
        runs.push({
          identity,
          file,
          startedAt: match[2].replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3"),
          bytes: info.size,
          running: live.has(path),
        });
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  /** One run's log, readable, from a run that `list` returned. */
  async function read(taskId, identity, file) {
    const run = (await list(taskId)).find((r) => r.identity === identity && r.file === file);
    if (!run) throw failure("NOT_FOUND", "That run log does not exist.", 404);
    const handle = await open(join(root, identity, file), "r");
    try {
      const start = Math.max(0, run.bytes - logReadLimit);
      const buffer = Buffer.alloc(run.bytes - start);
      await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.toString("utf8");
      // A cut log starts at the next whole line.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return { ...run, truncated: start > 0, text: readableLog(text) };
    } finally {
      await handle.close();
    }
  }
  return { list, read, root };
}
