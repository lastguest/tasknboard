import { useCallback, useEffect, useState } from "react";
import { ApiError, errorOf, token } from "./api";

type CliHelperStatus = {
  supported: boolean;
  installed: boolean;
  path: string | null;
  onPath: boolean;
  instruction: string | null;
};

type CliHelperMethod = "GET" | "POST";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCliHelperStatus(value: unknown): value is CliHelperStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.supported === "boolean" &&
    typeof value.installed === "boolean" &&
    (value.path === null || typeof value.path === "string") &&
    typeof value.onPath === "boolean" &&
    (value.instruction === null || typeof value.instruction === "string")
  );
}

async function requestCliHelper(method: CliHelperMethod) {
  const bearer = token.get();
  let response: Response;
  try {
    response = await fetch("/api/cli-helper", {
      method,
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError("Can't reach the workspace service.", "NETWORK", 0);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      `The workspace service returned an unexpected response (${response.status}).`,
      "BAD_RESPONSE",
      response.status,
    );
  }

  if (!response.ok) {
    const error = isRecord(body) ? body : {};
    throw new ApiError(
      typeof error.message === "string"
        ? error.message
        : `CLI helper request failed (${response.status}).`,
      typeof error.code === "string"
        ? error.code
        : response.status === 401
          ? "UNAUTHORIZED"
          : "HTTP_ERROR",
      response.status,
    );
  }

  if (!isCliHelperStatus(body)) {
    throw new ApiError(
      "The workspace service returned an unexpected CLI helper status.",
      "BAD_RESPONSE",
      response.status,
    );
  }
  return body;
}

export function CliHelper() {
  const [status, setStatus] = useState<CliHelperStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "installing" | null>(null);
  const [error, setError] = useState("");

  const checkAvailability = useCallback(async () => {
    setBusy("checking");
    setError("");
    setStatus(null);
    try {
      setStatus(await requestCliHelper("GET"));
    } catch (e) {
      setError(errorOf(e).message);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  async function install() {
    setBusy("installing");
    setError("");
    try {
      await requestCliHelper("POST");
      setStatus(null);
      setBusy("checking");
      setStatus(await requestCliHelper("GET"));
    } catch (e) {
      setError(errorOf(e).message);
    } finally {
      setBusy(null);
    }
  }

  const statusMessage = status
    ? !status.supported
      ? "The command line helper is available only in the TasknBoard desktop app."
      : status.installed
        ? `${status.path ? `Installed at ${status.path}. ` : "Installed. "}${status.onPath ? "The command is available on PATH in the desktop app." : "The command is not on the desktop app’s PATH. Your terminal may use a different PATH."}`
        : "The command line helper is not installed."
    : "";

  return (
    <div className="settings-row settings-row-stack" aria-busy={busy !== null}>
      <div className="settings-row-text">
        <span className="settings-row-title">Command line helper</span>
        <span className="settings-row-hint">
          Use the tasknboard command in a terminal to access this workspace.
        </span>
      </div>
      {busy && (
        <p className="small" role="status">
          {busy === "installing"
            ? "Installing the CLI helper…"
            : "Checking CLI helper availability…"}
        </p>
      )}
      {status && (
        <div className="settings-row-control">
          {status.supported && (
            <span
              className={`settings-pill ${status.installed ? "on" : "off"}`}
              aria-hidden="true"
            >
              {status.installed ? "Installed" : "Not installed"}
            </span>
          )}
          <button
            type="button"
            className="secondary small-button"
            onClick={() => void checkAvailability()}
            disabled={busy !== null}
          >
            Check availability
          </button>
          {status.supported && !status.installed && (
            <button
              type="button"
              className="primary small-button"
              onClick={() => void install()}
              disabled={busy !== null}
            >
              Install CLI helper
            </button>
          )}
        </div>
      )}
      {statusMessage && !busy && (
        <p className="small settings-row-note" role="status">
          {statusMessage}
        </p>
      )}
      {status?.instruction && (
        <p className="small settings-row-note">{status.instruction}</p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!status && !busy && (
        <div className="settings-row-control">
          <button
            type="button"
            className="secondary small-button"
            onClick={() => void checkAvailability()}
          >
            Check availability
          </button>
        </div>
      )}
    </div>
  );
}
