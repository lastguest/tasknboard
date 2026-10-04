import { useEffect, useState } from "react";
import { command, errorOf } from "./api";
import { Markdown } from "./Markdown";
import { safeUrl, type Actor, type Task } from "./types";

const artifactHref = (url: string) =>
  /^\/files\/[0-9a-f]{32}$/.test(url) ? url : safeUrl(url);

function ArtifactPreview({
  artifact,
}: {
  artifact: { title: string; url: string; mime?: string };
}) {
  const href = artifactHref(artifact.url);
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const text =
    artifact.mime === "text/plain" ||
    artifact.mime === "application/json" ||
    /\.(log|txt|json)(\?|$)/i.test(href);
  useEffect(() => {
    if (!open || !text || !href) return;
    const controller = new AbortController();
    void fetch(href, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Preview failed (${response.status}).`);
        const reader = response.body?.getReader();
        if (!reader) return;
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < 262144) {
          const { value, done } = await reader.read();
          if (done) break;
          const remaining = 262144 - total;
          chunks.push(value.slice(0, remaining));
          total += Math.min(value.length, remaining);
        }
        await reader.cancel();
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const source = new TextDecoder().decode(bytes);
        let formatted = source;
        if (artifact.mime === "application/json")
          try {
            formatted = JSON.stringify(JSON.parse(source), null, 2);
          } catch {
            /* Plain text is still useful. */
          }
        setContent(
          formatted + (total === 262144 ? "\n[Preview stops at 256 KiB.]" : ""),
        );
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorOf(failure).message);
      });
    return () => controller.abort();
  }, [open, text, href, artifact.mime]);
  if (!href)
    return (
      <p>
        {artifact.title}: {artifact.url}
      </p>
    );
  return (
    <figure>
      {(artifact.mime?.startsWith("image/") ||
        /\.(png|jpe?g|webp|gif)(\?|$)/i.test(href)) && (
        <a href={href} target="_blank" rel="noopener noreferrer">
          <img className="review-image" src={href} alt={artifact.title} />
        </a>
      )}
      <figcaption>
        <a href={href} target="_blank" rel="noopener noreferrer">
          {artifact.title}
        </a>
      </figcaption>
      {text && (
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>Preview {artifact.title}</summary>
          {error ? (
            <p role="alert">{error}</p>
          ) : (
            <pre>{content || "Loading evidence…"}</pre>
          )}
        </details>
      )}
    </figure>
  );
}

export function ReviewEvidence({ task }: { task: Task }) {
  const review = task.review;
  if (!review) return null;
  return (
    <div className="workflow-evidence">
      {review.author && <p className="small">Author: {review.author}</p>}
      {review.via && <p className="small">Via {review.via}</p>}
      {review.commitRange && (
        <p className="small">
          Commit range: <code>{review.commitRange}</code>
        </p>
      )}
      {review.verifiedBy?.map((check, index) => (
        <p key={index} className="small">
          Verified by <strong>{check.agent}</strong>: {check.checks}
        </p>
      ))}
      {review.artifacts?.map((artifact, index) => (
        <ArtifactPreview key={`${artifact.url}-${index}`} artifact={artifact} />
      ))}
    </div>
  );
}

export function SubmitReview({
  task,
  actor,
  onSaved,
}: {
  task: Task;
  actor: Actor;
  onSaved: (task: Task) => void;
}) {
  const [summary, setSummary] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [range, setRange] = useState("");
  const [verifier, setVerifier] = useState("");
  const [checks, setChecks] = useState("");
  const [via, setVia] = useState("");
  const [uploads, setUploads] = useState<
    { title: string; url: string; mime: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (task.archived || actor.kind !== "agent" || task.role !== "in_progress")
    return null;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const entries = artifacts
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const separator = line.indexOf("|");
          return separator < 0
            ? { title: line.trim(), url: line.trim() }
            : {
                title: line.slice(0, separator).trim(),
                url: line.slice(separator + 1).trim(),
              };
        });
      onSaved(
        await command<Task>("submit_review", {
          id: task.id,
          expectedVersion: task.version,
          summary,
          artifacts: [...entries, ...uploads],
          commitRange: range,
          verifiedBy: verifier ? [{ agent: verifier, checks }] : [],
          via,
        }),
      );
      setSummary("");
    } catch (failure) {
      setError(errorOf(failure).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const supported = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "text/plain",
        "application/json",
      ];
      const extensions: Record<string, string> = {
        log: "text/plain",
        txt: "text/plain",
        json: "application/json",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
      };
      const mime = supported.includes(file.type)
        ? file.type
        : extensions[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
      if (!mime)
        throw new Error(
          "Upload a supported image, log, text file, or JSON file.",
        );
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file.slice(0, file.size, mime));
      });
      const saved = await command<{ title: string; url: string; mime: string }>(
        "upload_artifact",
        { title: file.name, dataUrl },
      );
      setUploads((value) => [
        ...value,
        { title: saved.title, url: saved.url, mime: saved.mime },
      ]);
    } catch (failure) {
      setError(errorOf(failure).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="workflow-panel">
      <summary>Submit review</summary>
      <form onSubmit={submit}>
        <label>
          Review summary
          <textarea
            required
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <label>
          Artifacts (title | URL, one per line)
          <textarea
            value={artifacts}
            onChange={(event) => setArtifacts(event.target.value)}
          />
        </label>
        <label>
          Upload evidence
          <input
            type="file"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
        {uploads.map((upload) => (
          <p key={upload.url} className="small">
            Attached: {upload.title}{" "}
            <button
              type="button"
              className="quiet"
              onClick={() =>
                setUploads((value) =>
                  value.filter((entry) => entry.url !== upload.url),
                )
              }
            >
              Remove
            </button>
          </p>
        ))}
        <label>
          Commit range
          <input
            value={range}
            onChange={(event) => setRange(event.target.value)}
            placeholder="base..head"
          />
        </label>
        <label>
          Verified by
          <input
            value={verifier}
            onChange={(event) => setVerifier(event.target.value)}
          />
        </label>
        <label>
          Checks
          <textarea
            value={checks}
            onChange={(event) => setChecks(event.target.value)}
          />
        </label>
        <label>
          Via
          <input
            value={via}
            onChange={(event) => setVia(event.target.value)}
            placeholder="sonnet#run-id"
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy || !summary.trim()}>
          Submit for review
        </button>
      </form>
    </details>
  );
}

type TaskFiles = {
  brief: { path: string; content: string } | null;
  result: { path: string; content: string } | null;
};
type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
};
type CommitSummary = {
  commits: { sha: string; subject: string; files: ChangedFile[] }[];
  filesChanged: ChangedFile[];
  unavailable: string[];
};

export function TaskTraceability({ task }: { task: Task }) {
  const [files, setFiles] = useState<TaskFiles | null>(null);
  const [commits, setCommits] = useState<CommitSummary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setFiles(null);
    setCommits(null);
    if (task.briefPath || task.resultPath)
      void command<TaskFiles>("task-files", { id: task.id }, controller.signal)
        .then(setFiles)
        .catch((failure) => {
          if (!controller.signal.aborted) setError(errorOf(failure).message);
        });
    if (task.commits?.length)
      void command<CommitSummary>(
        "task-commits",
        { id: task.id },
        controller.signal,
      )
        .then(setCommits)
        .catch((failure) => {
          if (!controller.signal.aborted) setError(errorOf(failure).message);
        });
    return () => controller.abort();
  }, [task.id, task.version, task.briefPath, task.resultPath]);
  return (
    <section className="workflow-panel" aria-label="Task files and commits">
      {task.url && <a href={task.url}>Task permalink</a>}
      {files &&
        (["brief", "result"] as const).map(
          (kind) =>
            files[kind] && (
              <details key={kind}>
                <summary>
                  {kind === "brief" ? "Brief" : "Result"}: {files[kind]!.path}
                </summary>
                <Markdown source={files[kind]!.content} />
              </details>
            ),
        )}
      {commits && (
        <details>
          <summary>Files changed ({commits.filesChanged.length})</summary>
          <ul>
            {commits.filesChanged.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>{" "}
                {file.binary
                  ? "binary"
                  : `+${file.additions} −${file.deletions}`}
              </li>
            ))}
          </ul>
          {commits.commits.map((commit) => (
            <p key={commit.sha}>
              <code>{commit.sha.slice(0, 10)}</code> {commit.subject}
            </p>
          ))}
          {commits.unavailable.length > 0 && (
            <p className="small">
              Commits unavailable: {commits.unavailable.join(", ")}
            </p>
          )}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function TaskPlanning({
  task,
  onSaved,
  onOpen,
  canUndo = true,
}: {
  task: Task;
  onSaved: (task: Task) => void;
  onOpen: (id: string) => void;
  canUndo?: boolean;
}) {
  const [path, setPath] = useState<{
    goal: string;
    tasks: Task[];
    edges: { from: string; to: string }[];
    cycles: string[][];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(undo: boolean) {
    setBusy(true);
    setError("");
    try {
      if (undo)
        onSaved(
          await command<Task>("undo_task", {
            id: task.id,
            expectedVersion: task.version,
          }),
        );
      else setPath(await command("critical_path", { id: task.id }));
    } catch (failure) {
      setError(errorOf(failure).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workflow-panel" aria-label="Dependencies and undo">
      {task.blocked && (
        <p className="task-signal blocker">
          <strong>Blocked</strong>{" "}
          {task.blockers?.map((blocker) => (
            <button
              key={blocker.id}
              type="button"
              className="quiet"
              onClick={() => onOpen(blocker.id)}
            >
              {blocker.id}: {blocker.title}
            </button>
          ))}
        </p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void run(false)}
      >
        Critical path to this task
      </button>
      {path && (
        <div>
          <ul>
            {path.tasks.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => onOpen(entry.id)}
                >
                  {entry.id}: {entry.title}
                </button>{" "}
                ({entry.role})
              </li>
            ))}
          </ul>
          {path.edges.map((edge) => (
            <p key={`${edge.from}-${edge.to}`} className="small">
              {edge.from} → {edge.to}
            </p>
          ))}
          {path.cycles.length > 0 && (
            <p role="alert">
              Dependency cycle:{" "}
              {path.cycles.map((cycle) => cycle.join(" → ")).join("; ")}
            </p>
          )}
        </div>
      )}
      {task.undo?.eligible && (
        <button
          type="button"
          className="secondary"
          disabled={busy || !canUndo}
          title={
            !canUndo ? "Save or discard your draft before undo." : undefined
          }
          onClick={() => void run(true)}
        >
          Undo last action
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
