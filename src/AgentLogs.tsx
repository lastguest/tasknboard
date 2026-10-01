import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { command, errorOf } from "./api";
import { Dialog } from "./Dialogs";
import { formatUtcTimestamp } from "./formatting";
import { displayName, usePeople } from "./People";

type Run = {
  identity: string;
  file: string;
  startedAt: string;
  bytes: number;
  running: boolean;
};
type Logs = {
  available: boolean;
  runs: Run[];
  log: (Run & { text: string; truncated: boolean }) | null;
};

/** Agent runs on a task, newest first, with the chosen run's log. */
export function AgentLogs({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const people = usePeople();
  const [logs, setLogs] = useState<Logs | null>(null);
  const [chosen, setChosen] = useState<{
    identity: string;
    file: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [refreshes, setRefreshes] = useState(0);
  const output = useRef<HTMLPreElement>(null);
  /** Follow the end of a running log unless the person scrolled up. */
  const following = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    command<Logs>(
      "agent-logs",
      { taskId, ...(chosen ?? {}) },
      controller.signal,
    )
      .then((next) => {
        setLogs(next);
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorOf(e).message);
      });
    return () => controller.abort();
  }, [taskId, chosen, refreshes]);
  const running = Boolean(logs?.log?.running);
  // A running log refreshes every two seconds.
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setRefreshes((n) => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [running, logs]);
  useLayoutEffect(() => {
    const pre = output.current;
    if (pre && following.current) pre.scrollTop = pre.scrollHeight;
  }, [logs?.log?.text]);
  const label = (run: Run) =>
    `${displayName(people, run.identity)} · ${formatUtcTimestamp(run.startedAt)}${run.running ? " · running" : ""}`;
  return (
    <Dialog
      title={`Agent logs · ${taskId}`}
      onClose={onClose}
      wide
      className="agent-logs"
    >
      <div className="agent-logs-body">
        {error && (
          <p role="alert" className="small inline-error">
            {error}
          </p>
        )}
        {!logs && !error && (
          <p role="status" className="small">
            Loading logs…
          </p>
        )}
        {logs && !logs.available && (
          <p className="small">
            Agent logs are kept by the TasknBoard desktop app that runs the
            agents.
          </p>
        )}
        {logs?.available && !logs.runs.length && (
          <p className="small">No agent has run on {taskId} yet.</p>
        )}
        {logs?.log && (
          <>
            <div className="agent-logs-bar">
              <label className="field">
                <span className="field-label">Run</span>
                <select
                  value={`${logs.log.identity}/${logs.log.file}`}
                  onChange={(e) => {
                    const [identity, file] = e.target.value.split("/");
                    following.current = true;
                    setChosen({ identity, file });
                  }}
                >
                  {logs.runs.map((run) => (
                    <option
                      key={`${run.identity}/${run.file}`}
                      value={`${run.identity}/${run.file}`}
                    >
                      {label(run)}
                    </option>
                  ))}
                </select>
              </label>
              <span className="small" role="status">
                {running ? "Running · updates every 2 seconds" : "Finished"}
              </span>
            </div>
            {logs.log.truncated && (
              <p className="small">Showing the newest part of a long log.</p>
            )}
            <pre
              ref={output}
              className="agent-log-output"
              tabIndex={0}
              aria-label={`Log of ${label(logs.log)}`}
              onScroll={(e) => {
                const pre = e.currentTarget;
                following.current =
                  pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
              }}
            >
              {logs.log.text ||
                (running ? "No output yet." : "The run wrote no output.")}
            </pre>
            <p className="small agent-log-path">
              ~/.tasknboard/logs/{logs.log.identity}/{logs.log.file}
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
