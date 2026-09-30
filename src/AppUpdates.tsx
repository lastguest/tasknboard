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
      <p className="small">
        TasknBoard checks automatically at startup and once a day. Installation
        requires your confirmation.
      </p>
      <button
        type="button"
        className="button"
        disabled={checking}
        onClick={check}
      >
        {checking ? "Checking for updates…" : "Check for updates"}
      </button>
      <p className={failed ? "form-error" : "small"} role="status">
        {result}
      </p>
    </>
  );
}
