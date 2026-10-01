import { useEffect, useId, useMemo, useState } from "react";
import { command, errorOf } from "./api";
import { Icon } from "./Icons";
import { Assignee } from "./Board";
import { displayName, usePeople } from "./People";

export type AgentClientId = "claude" | "codex" | "opencode" | "pi";
export type AgentEventId =
  | "task_assigned"
  | "task_unassigned"
  | "changes_requested"
  | "mention"
  | "standup";
export type AgentConfig = {
  enabled: boolean;
  client: AgentClientId;
  command: string;
  model: string;
  profile: string;
  args: string[];
  env: Record<string, string>;
  events: Record<AgentEventId, { enabled: boolean; prompt?: string }>;
};
type Job = { event: AgentEventId; taskId: string };
export type AgentSettingsInfo = {
  mode: "local" | "shared";
  autoStart: boolean;
  clients: {
    id: AgentClientId;
    name: string;
    executable: string;
    model: { hint: string };
    profile: { label: string; flag: string; hint: string };
  }[];
  events: {
    id: AgentEventId;
    label: string;
    description: string;
    placeholders: string[];
    hasPrompt: boolean;
  }[];
  defaults: AgentConfig;
  agents: Record<
    string,
    { config: AgentConfig; running: Job | null; queued: Job[] }
  >;
};

/** Agent settings and run state, reloaded after each save. */
export function useAgentSettings() {
  const [info, setInfo] = useState<AgentSettingsInfo | null>(null);
  const [error, setError] = useState("");
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    command<AgentSettingsInfo>("agent-configs", {}, controller.signal)
      .then((next) => {
        setInfo(next);
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorOf(e).message);
      });
    return () => controller.abort();
  }, [reloads]);
  return { info, error, reload: () => setReloads((n) => n + 1) };
}

type EnvRow = { key: string; value: string };
const toRows = (env: Record<string, string>): EnvRow[] =>
  Object.entries(env).map(([key, value]) => ({ key, value }));

export function AgentSettings({
  identity,
  info,
  onBack,
  onSaved,
}: {
  identity: string;
  info: AgentSettingsInfo;
  onBack: () => void;
  onSaved: () => void;
}) {
  const people = usePeople();
  const id = useId();
  const saved = info.agents[identity]?.config;
  // Compared by value, so a reload with the same settings keeps the draft.
  const savedJson = JSON.stringify(saved ?? { ...info.defaults, enabled: false });
  const initial = useMemo(() => JSON.parse(savedJson) as AgentConfig, [savedJson]);
  const [config, setConfig] = useState<AgentConfig>(initial);
  const [args, setArgs] = useState(initial.args.join("\n"));
  const [env, setEnv] = useState<EnvRow[]>(toRows(initial.env));
  const [showValues, setShowValues] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setConfig(initial);
    setArgs(initial.args.join("\n"));
    setEnv(toRows(initial.env));
  }, [initial]);
  const client = info.clients.find((c) => c.id === config.client)!;
  const defaults = info.defaults.events;
  const draft: AgentConfig = {
    ...config,
    args: args
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    env: Object.fromEntries(
      env.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
    ),
  };
  const changed = JSON.stringify(draft) !== JSON.stringify(initial) || !saved;
  const duplicateKey = env.some(
    (row, i) => row.key.trim() && env.findIndex((r) => r.key.trim() === row.key.trim()) !== i,
  );
  const status = info.agents[identity];
  const update = (patch: Partial<AgentConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setNotice("");
  };
  const updateEvent = (
    event: AgentEventId,
    patch: { enabled?: boolean; prompt?: string },
  ) => {
    setConfig((c) => ({
      ...c,
      events: { ...c.events, [event]: { ...c.events[event], ...patch } },
    }));
    setNotice("");
  };
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (duplicateKey) {
      setError("Each environment variable needs a different name.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await command("agent-config-save", { identity, config: draft });
      setNotice("Settings saved. They apply to the next run.");
      onSaved();
    } catch (e) {
      setError(errorOf(e).message);
    } finally {
      setPending(false);
    }
  }
  const eventLabel = (event: AgentEventId) =>
    info.events.find((e) => e.id === event)?.label ?? event;
  return (
    <form className="agent-settings" onSubmit={save} noValidate>
      <div className="agent-settings-head">
        <button type="button" className="secondary small-button" onClick={onBack}>
          <Icon name="back" size={13} /> Agents
        </button>
        <h2 className="section-title">
          <Assignee name={identity} agent /> settings
        </h2>
        <span className="small">
          {status?.running
            ? `Running: ${eventLabel(status.running.event)} on ${status.running.taskId}`
            : "Not running"}
          {status?.queued.length ? ` · ${status.queued.length} waiting` : ""}
        </span>
      </div>
      {!info.autoStart && (
        <p className="small agent-settings-note">
          Agents start automatically only in the TasknBoard desktop app. You can
          save these settings here and the desktop app uses them.
        </p>
      )}

      <section aria-labelledby={`${id}-cli`}>
        <h3 id={`${id}-cli`}>Command line</h3>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          Start {displayName(people, identity)} automatically for the events below
        </label>
        <div className="agent-settings-grid">
          <label className="field">
            <span className="field-label">CLI</span>
            <select
              value={config.client}
              onChange={(e) =>
                update({ client: e.target.value as AgentClientId, profile: "" })
              }
            >
              {info.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="field-hint">
              The agent's MCP connection or skill must already be set up. Use
              Connect a coding agent on the Agents page.
            </span>
          </label>
          <label className="field">
            <span className="field-label">Executable</span>
            <input
              value={config.command}
              maxLength={1000}
              autoComplete="off"
              spellCheck={false}
              placeholder={client.executable}
              onChange={(e) => update({ command: e.target.value })}
            />
            <span className="field-hint">
              Optional absolute path. Leave empty to find {client.executable} on
              PATH.
            </span>
          </label>
          <label className="field">
            <span className="field-label">Model</span>
            <input
              value={config.model}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              placeholder="CLI default"
              onChange={(e) => update({ model: e.target.value })}
            />
            <span className="field-hint">Optional. {client.model.hint}</span>
          </label>
          <label className="field">
            <span className="field-label">{client.profile.label}</span>
            <input
              value={config.profile}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              placeholder="CLI default"
              onChange={(e) => update({ profile: e.target.value })}
            />
            <span className="field-hint">
              Optional. Passed as <code>{client.profile.flag}</code>.{" "}
              {client.profile.hint}
            </span>
          </label>
        </div>
        <label className="field">
          <span className="field-label">Extra arguments</span>
          <textarea
            rows={3}
            spellCheck={false}
            value={args}
            placeholder={"One argument per line"}
            onChange={(e) => {
              setArgs(e.target.value);
              setNotice("");
            }}
          />
          <span className="field-hint">
            One argument per line, added after the app's own. Runs never stop for
            approvals, so the app always passes the CLI's full-auto switch.
          </span>
        </label>
      </section>

      <section aria-labelledby={`${id}-env`}>
        <h3 id={`${id}-env`}>Environment</h3>
        <p className="small">
          Added to your own environment for each run. Values stay in this
          workspace's local settings and are never exported.
        </p>
        {env.length > 0 && (
          <ul className="env-rows">
            {env.map((row, index) => (
              <li key={index}>
                <input
                  aria-label={`Variable ${index + 1} name`}
                  value={row.key}
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="NAME"
                  onChange={(e) =>
                    setEnv(env.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
                  }
                />
                <input
                  aria-label={`Variable ${index + 1} value`}
                  type={showValues ? "text" : "password"}
                  value={row.value}
                  maxLength={4000}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="value"
                  onChange={(e) =>
                    setEnv(env.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))
                  }
                />
                <button
                  type="button"
                  className="secondary small-button"
                  aria-label={`Remove variable ${row.key || index + 1}`}
                  onClick={() => setEnv(env.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="env-actions">
          <button
            type="button"
            className="secondary small-button"
            disabled={env.length >= 40}
            onClick={() => setEnv([...env, { key: "", value: "" }])}
          >
            <Icon name="plus" size={13} /> Add variable
          </button>
          {env.length > 0 && (
            <label className="settings-check">
              <input
                type="checkbox"
                checked={showValues}
                onChange={(e) => setShowValues(e.target.checked)}
              />
              Show values
            </label>
          )}
        </div>
      </section>

      <section aria-labelledby={`${id}-events`}>
        <h3 id={`${id}-events`}>Events</h3>
        <p className="small">
          What starts a run. Each run gets the fixed identity and safety
          instructions, then the prompt below. One run per agent at a time;
          later events wait their turn.
        </p>
        <ul className="agent-events">
          {info.events.map((event) => {
            const binding = config.events[event.id];
            const fallback = defaults[event.id].prompt ?? "";
            return (
              <li key={event.id} className="agent-event">
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={binding.enabled}
                    onChange={(e) =>
                      updateEvent(event.id, { enabled: e.target.checked })
                    }
                  />
                  <strong>{event.label}</strong>
                </label>
                <p className="small">{event.description}</p>
                {event.hasPrompt && binding.enabled && (
                  <label className="field">
                    <span className="field-label">Prompt</span>
                    <textarea
                      rows={7}
                      maxLength={4000}
                      value={binding.prompt ?? fallback}
                      onChange={(e) =>
                        updateEvent(event.id, { prompt: e.target.value })
                      }
                    />
                    <span className="field-hint">
                      Placeholders:{" "}
                      {event.placeholders.map((p) => `{{${p}}}`).join(", ")}.{" "}
                      {(binding.prompt ?? fallback) !== fallback && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => updateEvent(event.id, { prompt: fallback })}
                        >
                          Restore the default prompt
                        </button>
                      )}
                    </span>
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {error && (
        <p role="alert" className="small inline-error">
          {error} Nothing was saved.
        </p>
      )}
      {notice && (
        <p role="status" className="small ok">
          {notice}
        </p>
      )}
      <div className="form-actions">
        <span className="spacer" />
        <button
          type="button"
          className="secondary"
          disabled={pending || !changed || !saved}
          onClick={() => {
            setConfig(initial);
            setArgs(initial.args.join("\n"));
            setEnv(toRows(initial.env));
            setError("");
          }}
        >
          Discard changes
        </button>
        <button type="submit" className="primary" disabled={pending || !changed}>
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
