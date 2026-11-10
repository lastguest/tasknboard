import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { command, errorOf } from "./api";
import { GitHubAvatar, githubError, type GitHubStatus } from "./PullRequests";

type GitHubDeviceAuthorization = {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};
type GitHubAuthorizationPoll =
  { pending: true; interval: number } | GitHubStatus;
function waitForAuthorizationPoll(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Authorization polling stopped."));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Authorization polling stopped."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Settings → GitHub: connect the workspace account with device authorization. */
export function GitHubSettings({
  canManage,
  Group,
  Row,
}: {
  canManage: boolean;
  Group: (p: {
    title: string;
    note?: string;
    children: React.ReactNode;
  }) => React.ReactNode;
  Row: (p: {
    title: string;
    hint?: string;
    children: React.ReactNode;
  }) => React.ReactNode;
}) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [authorization, setAuthorization] =
    useState<GitHubDeviceAuthorization | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<null | { ok: boolean; text: string }>(
    null,
  );
  const prepareController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const cancelController = useRef<AbortController | null>(null);

  const prepareAuthorization = useCallback(
    async (controller = new AbortController()) => {
      prepareController.current?.abort();
      prepareController.current = controller;
      setPreparing(true);
      setMessage(null);
      try {
        const next = await command<GitHubDeviceAuthorization>(
          "connect_github",
          {},
          controller.signal,
        );
        if (!controller.signal.aborted) setAuthorization(next);
      } catch (e) {
        if (!controller.signal.aborted)
          setMessage({ ok: false, text: githubError(errorOf(e)) });
      } finally {
        if (prepareController.current === controller) {
          setPreparing(false);
          prepareController.current = null;
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    async function load() {
      try {
        const next = await command<GitHubStatus>(
          "github_status",
          {},
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setStatus(next);
        // A connected workspace needs no new code; switching accounts is an
        // explicit action from the Status card.
        if (next.configured && !next.connected)
          await prepareAuthorization(controller);
      } catch (e) {
        if (!controller.signal.aborted)
          setMessage({ ok: false, text: githubError(errorOf(e)) });
      }
    }
    void load();
    return () => {
      controller.abort();
      prepareController.current?.abort();
      prepareController.current = null;
      pollController.current?.abort();
      pollController.current = null;
      cancelController.current?.abort();
      cancelController.current = null;
    };
  }, [canManage, prepareAuthorization]);

  // Poll as soon as the code is shown, so approval reaches the app however the
  // person opens GitHub: this link, the context menu, or another device.
  useEffect(() => {
    if (!authorization) return;
    const currentAuthorization = authorization;
    const controller = new AbortController();
    pollController.current = controller;
    async function poll() {
      let interval = currentAuthorization.interval;
      try {
        while (!controller.signal.aborted) {
          await waitForAuthorizationPoll(interval * 1000, controller.signal);
          const next = await command<GitHubAuthorizationPoll>(
            "poll_github_authorization",
            {},
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if ("pending" in next) {
            interval = next.interval;
            continue;
          }
          if (!next.connected)
            throw new Error(
              "GitHub authorization did not return a connected account.",
            );
          if (controller.signal.aborted) return;
          setStatus(next);
          setAuthorization(null);
          setMessage({
            ok: true,
            text: `Connected as @${next.account.login}.`,
          });
          return;
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setAuthorization(null);
        setMessage({ ok: false, text: githubError(errorOf(e)) });
      }
    }
    void poll();
    return () => {
      controller.abort();
      if (pollController.current === controller) pollController.current = null;
    };
  }, [authorization]);

  useEffect(() => {
    if (!authorization) return;
    const timer = window.setTimeout(
      () => {
        pollController.current?.abort();
        pollController.current = null;
        setAuthorization(null);
        setMessage({
          ok: false,
          text: "The GitHub authorization code expired. Prepare a new code to continue.",
        });
      },
      Math.max(0, authorization.expiresIn) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [authorization]);

  async function disconnect() {
    setDisconnecting(true);
    setMessage(null);
    prepareController.current?.abort();
    setPreparing(false);
    pollController.current?.abort();
    pollController.current = null;
    setAuthorization(null);
    try {
      const next = await command<GitHubStatus>("disconnect_github");
      setStatus(next);
      setMessage({
        ok: true,
        text: "GitHub is disconnected. The saved account is removed from the workspace.",
      });
    } catch (e) {
      setMessage({ ok: false, text: githubError(errorOf(e)) });
    } finally {
      setDisconnecting(false);
    }
  }

  async function stopWaiting() {
    pollController.current?.abort();
    pollController.current = null;
    setAuthorization(null);
    setCanceling(true);
    setMessage(null);
    cancelController.current?.abort();
    const controller = new AbortController();
    cancelController.current = controller;
    try {
      const next = await command<GitHubStatus>(
        "cancel_github_authorization",
        {},
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setStatus(next);
      const text = next.connected
        ? !status?.connected || next.account.login !== status.account.login
          ? `Connected as @${next.account.login}.`
          : "Stopped waiting for GitHub. The current connection is unchanged."
        : status?.connected
          ? "Authorization stopped. GitHub is disconnected."
          : "Stopped waiting for GitHub authorization.";
      setMessage({
        ok: true,
        text,
      });
    } catch (e) {
      if (!controller.signal.aborted)
        setMessage({ ok: false, text: githubError(errorOf(e)) });
    } finally {
      if (cancelController.current === controller) {
        setCanceling(false);
        cancelController.current = null;
      }
    }
  }

  if (!canManage)
    return (
      <Group title="Status">
        <Row
          title="GitHub"
          hint="Only people can manage the GitHub integration."
        >
          <span className="settings-pill off">Unavailable</span>
        </Row>
      </Group>
    );
  const busy = preparing || canceling || disconnecting;
  return (
    <Group
      title="Status"
      note="One GitHub account serves the whole workspace. Everyone signed in sees the pull requests that account can read. TasknBoard connects with GitHub device authorization."
    >
      <Row
        title="GitHub"
        hint={
          !status
            ? "Checking…"
            : !status.configured
              ? "GitHub authorization is not configured on this server. Ask the operator to set TASKNBOARD_GITHUB_CLIENT_ID."
              : status.connected
                ? `Signed in as @${status.account.login}${status.account.name ? ` (${status.account.name})` : ""}.`
                : "Not connected."
        }
      >
        {status?.connected && (
          <GitHubAvatar person={status.account} size={24} />
        )}
        <span className={`settings-pill ${status?.connected ? "on" : "off"}`}>
          {!status
            ? "Checking…"
            : !status.configured
              ? "Unavailable"
              : status.connected
                ? "Connected"
                : "Off"}
        </span>
        {status?.connected && !authorization && (
          <button
            type="button"
            className="secondary small-button"
            disabled={busy}
            onClick={() => void prepareAuthorization()}
          >
            {preparing ? "Preparing…" : "Switch account"}
          </button>
        )}
        {status?.connected && (
          <button
            type="button"
            className="danger-button small-button"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
        )}
      </Row>
      {status?.configured && (authorization || !status.connected) && (
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <span className="settings-row-title">
              {authorization ? (
                <>
                  One-time code{" "}
                  <code aria-label="GitHub authorization code">
                    {authorization.userCode}
                  </code>
                </>
              ) : (
                "Sign in with GitHub"
              )}
            </span>
            <span className="settings-row-hint">
              Open GitHub and enter the one-time code to approve access.
            </span>
          </div>
          <div className="settings-token">
            {authorization ? (
              <a
                className="primary small-button"
                href={authorization.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  setMessage(null);
                  if (!isTauri()) return;
                  event.preventDefault();
                  invoke("open_external_url", {
                    url: authorization.verificationUri,
                  }).catch(() =>
                    setMessage({
                      ok: false,
                      text: `Could not open your browser. Go to ${authorization.verificationUri} and enter the code.`,
                    }),
                  );
                }}
              >
                {status.connected ? "Switch GitHub account" : "Connect GitHub"}
              </a>
            ) : (
              <button
                type="button"
                className="primary small-button"
                disabled={busy}
                onClick={() => void prepareAuthorization()}
              >
                {canceling
                  ? "Canceling authorization…"
                  : disconnecting
                    ? "Disconnecting…"
                    : preparing
                      ? "Preparing authorization…"
                      : "Prepare authorization"}
              </button>
            )}
            {authorization && (
              <button
                type="button"
                className="secondary small-button"
                onClick={() => void stopWaiting()}
              >
                Cancel authorization
              </button>
            )}
            {authorization && (
              <p className="small" role="status" aria-live="polite">
                Waiting for approval in GitHub…
              </p>
            )}
          </div>
        </div>
      )}
      {message && (
        <div className="settings-row">
          <p
            className={message.ok ? "small ok" : "inline-error"}
            role={message.ok ? "status" : "alert"}
          >
            {message.text}
          </p>
        </div>
      )}
    </Group>
  );
}
