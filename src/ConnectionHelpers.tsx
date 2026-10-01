import { useState } from "react";
import { command, errorOf } from "./api";
import {
  connectionHelper,
  type AgentClient,
  type LocalConnection,
} from "./connection-helpers";

export function ConnectionHelpers({
  runtime,
  onInstalled,
}: {
  runtime: LocalConnection;
  /** Called after a plugin install records the agent's settings. */
  onInstalled?: () => void;
}) {
  const [client, setClient] = useState<AgentClient>("codex");
  const [identity, setIdentity] = useState("codex");
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const [installing, setInstalling] = useState(false);
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(identity);
  const helper = connectionHelper(client, runtime, identity);
  function resetFeedback() {
    setCopied("");
    setCopyError("");
  }
  async function copy() {
    resetFeedback();
    try {
      await navigator.clipboard.writeText(helper.text);
      setCopied("Copied.");
    } catch {
      setCopyError(
        "Could not copy. Select the text below and copy it manually.",
      );
    }
  }
  async function install() {
    resetFeedback();
    setInstalling(true);
    try {
      await command(`${client}-plugin`, { identity }, undefined, 60000);
      onInstalled?.();
      setCopied(
        `TasknBoard plugin installed. Restart ${client === "claude" ? "Claude Code" : "Codex"} to use it. Tasks you assign to ${identity} on a board with a repository folder now start it automatically. Change how it starts under Settings on its row above.`,
      );
    } catch (error) {
      setCopyError(errorOf(error).message);
    } finally {
      setInstalling(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([helper.text], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "SKILL.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="connection-helper">
      <div className="connection-helper-controls">
        <div className="connection-helper-field">
          <label htmlFor="connection-client">Client</label>
          <select
            id="connection-client"
            value={client}
            disabled={installing}
            onChange={(event) => {
              const next = event.target.value as AgentClient;
              setClient(next);
              setIdentity(next);
              resetFeedback();
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
            <option value="opencode">OpenCode</option>
            <option value="pi">Pi</option>
          </select>
        </div>
        <div className="connection-helper-field">
          <label htmlFor="connection-identity">Agent identity</label>
          <input
            id="connection-identity"
            value={identity}
            disabled={installing}
            maxLength={80}
            aria-invalid={!valid}
            aria-describedby="agent-identity-help"
            onChange={(event) => {
              setIdentity(event.target.value);
              resetFeedback();
            }}
          />
        </div>
        <div className="connection-helper-actions">
          <button
            type="button"
            className="secondary"
            disabled={!valid || installing}
            onClick={() =>
              void (client === "codex" || client === "claude"
                ? install()
                : copy())
            }
          >
            {installing ? "Installing plugin…" : helper.label}
          </button>
          {client === "pi" && (
            <button
              type="button"
              className="secondary"
              disabled={!valid}
              onClick={download}
            >
              Download skill
            </button>
          )}
        </div>
      </div>
      <p id="agent-identity-help" className="small">
        {valid
          ? "Use a unique identity for each concurrent agent."
          : "Enter 1–80 letters, numbers, dots, underscores, or hyphens. Start with a letter or number."}
      </p>
      {valid && helper.text && (
        <pre tabIndex={0} aria-label={`${client} connection helper`}>
          {helper.text}
        </pre>
      )}
      <p className="small">{helper.instruction}</p>
      {installing && (
        <p role="status" className="small">
          Installing the TasknBoard plugin…
        </p>
      )}
      {copied && (
        <p role="status" className="small ok">
          {copied}
        </p>
      )}
      {copyError && (
        <p role="alert" className="small">
          {copyError}
        </p>
      )}
    </div>
  );
}
