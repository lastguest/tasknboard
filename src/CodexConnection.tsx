import { useEffect, useState } from "react";
import { command, errorOf } from "./api";

type ServiceStatus = {
  resident: boolean;
  instanceId: string;
  connected: boolean;
  native: { available: boolean; platform: string };
  appPlugin: { installed: boolean; enabled: boolean; error?: string };
};
export function CodexConnection() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function refresh() {
    setError("");
    try {
      const next = await command<ServiceStatus>("service-status");
      setNotice("");
      setStatus(next);
    } catch (cause) {
      setError(errorOf(cause).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function update(action?: "restart" | "disable") {
    setBusy(true);
    setError("");
    try {
      if (action) {
        await command("service-control", { action });
        setStatus(null);
        setNotice(
          action === "restart"
            ? "Restart requested. Refresh the status after the workspace service reconnects."
            : "Disable requested. Start the TasknBoard service again to reconnect.",
        );
      } else {
        const next = await command<ServiceStatus>("service-connect");
        setNotice(
          "TasknBoard is installed in Codex. Open TasknBoard from the Codex sidebar. Restart Codex if it does not appear.",
        );
        setStatus(next);
      }
    } catch (cause) {
      setError(errorOf(cause).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="settings-row settings-row-stack"
      aria-label="Connect to Codex"
      aria-busy={busy}
    >
      <div className="settings-row-text">
        <span className="settings-row-title">Connect to Codex</span>
        <span className="settings-row-hint">
          Install TasknBoard once. Codex starts the local workspace service and
          reconnects automatically.
        </span>
      </div>
      <p className="small" role="status">
        {notice ||
          (status
            ? `Workspace service: ${status.connected ? "connected" : "disconnected"}. Codex app: ${status.appPlugin.enabled ? "enabled" : status.appPlugin.installed ? "disabled" : "not installed"}.`
            : "Checking the workspace service…")}
      </p>
      <div className="settings-row-control">
        <button
          type="button"
          className="primary small-button"
          disabled={
            busy || !status?.native.available || status.appPlugin.enabled
          }
          onClick={() => void update()}
        >
          Connect to Codex
        </button>
        <button
          type="button"
          className="secondary small-button"
          disabled={busy || !status?.native.available}
          onClick={() => void update("restart")}
        >
          Restart service
        </button>
        <button
          type="button"
          className="secondary small-button"
          disabled={busy || !status?.native.available}
          onClick={() => void update("disable")}
        >
          Disable service
        </button>
        <button
          type="button"
          className="secondary small-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh status
        </button>
      </div>
      {status && !status.native.available && (
        <p className="small">
          Connection setup requires the TasknBoard desktop service.
        </p>
      )}
      {(error || status?.appPlugin.error) && (
        <p className="inline-error" role="alert">
          {error || status?.appPlugin.error}
        </p>
      )}
    </section>
  );
}
