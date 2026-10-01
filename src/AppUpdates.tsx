import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export const desktopApp = () => isTauri() && !window.tasknboardShell;

export function AppVersion() {
  const [version, setVersion] = useState(desktopApp() ? null : __APP_VERSION__);
  useEffect(() => {
    if (desktopApp()) {
      invoke<string>("app_version")
        .then(setVersion)
        .catch(() => setVersion(null));
    }
  }, []);
  return version ? (
    <div className="app-version" title={`TasknBoard ${version}`}>
      v{version}
    </div>
  ) : null;
}

export function AppUpdates() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState("");
  const [failed, setFailed] = useState(false);
  async function check() {
    setChecking(true);
    setResult("");
    setFailed(false);
    try {
      setResult(await invoke<string>("check_for_updates"));
    } catch (error) {
      setFailed(true);
      setResult(`Could not check for updates: ${String(error)}`);
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
      <div className="settings-row" aria-busy={checking}>
        <div className="settings-row-text">
          <span className="settings-row-title">Check for updates</span>
          <span className="settings-row-hint">
            TasknBoard checks automatically at startup and once a day.
            Installation requires your confirmation.
          </span>
        </div>
        <div className="settings-row-control">
          <button
            type="button"
            className="secondary small-button"
            disabled={checking}
            onClick={check}
          >
            {checking ? "Checking for updates…" : "Check for updates"}
          </button>
        </div>
      </div>
      {result && (
        <p
          className={`settings-row-note ${failed ? "inline-error" : "small"}`}
          role="status"
        >
          {result}
        </p>
      )}
    </>
  );
}
