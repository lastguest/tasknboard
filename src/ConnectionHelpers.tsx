import { useId, useState } from "react";
import { command, errorOf } from "./api";
import { useAgentSettings } from "./AgentSettings";
import { BrandLogo } from "./BrandLogos";
import {
  agentClients,
  connectionHelper,
  type AgentClient,
  type LocalConnection,
} from "./connection-helpers";

/** A step's text, with `backticked` parts shown as code. */
function StepText({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
    </>
  );
}

export function ConnectionHelpers({
  runtime,
  onInstalled,
}: {
  runtime: LocalConnection;
  /** Called after a plugin install records the agent's settings. */
  onInstalled?: () => void;
}) {
  const id = useId();
  const settings = useAgentSettings();
  const [client, setClient] = useState<AgentClient>("claude");
  const [identity, setIdentity] = useState("claude");
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const [installing, setInstalling] = useState(false);
  const helper = connectionHelper(client, runtime, identity);
  const chosen = agentClients.find((c) => c.id === client)!;
  const plugin = client === "codex" || client === "claude";
  const valid = (plugin
    ? /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/
    : /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/).test(identity);
  /** Identities already set up with each CLI. */
  const inUse = (clientId: AgentClient) =>
    Object.entries(settings.info?.agents ?? {})
      .filter(([, agent]) => agent.config.client === clientId)
      .map(([name]) => name);
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
      setCopied(
        `TasknBoard plugin installed. Restart ${chosen.name} to use it. Tasks you assign to ${identity} on a board with a repository folder now start it automatically. Change how it starts under Settings on its row above.`,
      );
      settings.reload();
      onInstalled?.();
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
      <fieldset className="client-grid" disabled={installing}>
        <legend className="sr-only">Client</legend>
        {agentClients.map((c) => {
          const agents = inUse(c.id);
          return (
            <label key={c.id} className={`client-tile client-${c.id}`}>
              <input
                type="radio"
                name={`${id}-client`}
                value={c.id}
                checked={client === c.id}
                onChange={() => {
                  setClient(c.id);
                  setIdentity(c.id);
                  resetFeedback();
                }}
              />
              <span className="client-logo">
                <BrandLogo client={c.id} size={22} />
              </span>
              <span className="client-text">
                <span className="client-name">{c.name}</span>
                <span className="client-method">{c.method}</span>
              </span>
              {agents.length > 0 && (
                <span
                  className="client-badge"
                  title={`Set up for ${agents.join(", ")}`}
                >
                  {agents.length === 1 ? agents[0] : `${agents.length} agents`}
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      <section className="client-setup" aria-labelledby={`${id}-setup`}>
        <h3 id={`${id}-setup`} className="client-setup-title">
          <span className={`client-logo small client-${client}`}>
            <BrandLogo client={client} size={16} />
          </span>
          Connect {chosen.name}
        </h3>
        <div className="connection-helper-controls">
          <div className="connection-helper-field">
            <label htmlFor="connection-identity">Agent identity</label>
            <input
              id="connection-identity"
              value={identity}
              disabled={installing}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
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
              className={plugin ? "primary" : "secondary"}
              disabled={!valid || installing}
              onClick={() => void (plugin ? install() : copy())}
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
            ? "Use a unique identity for each agent that runs at the same time."
            : plugin
              ? "Enter 1–80 letters, numbers, dots, underscores, or hyphens. Plugin identities cannot contain slashes."
              : "Enter 1–80 letters, numbers, dots, underscores, slashes, or hyphens. Start with a letter or number."}
        </p>
        <ol className="client-steps">
          {helper.steps.map((step) => (
            <li key={step}>
              <StepText text={step} />
            </li>
          ))}
        </ol>
        {helper.note && <p className="small">{helper.note}</p>}
        {valid && helper.text && (
          <pre tabIndex={0} aria-label={`${client} connection helper`}>
            {helper.text}
          </pre>
        )}
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
      </section>
    </div>
  );
}
