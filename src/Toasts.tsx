import { useEffect, useState } from "react";
import { Icon } from "./Icons";

export type Toast = {
  id: number;
  title: string;
  body?: string;
  tone: "ok" | "error" | "info";
  actions?: { label: string; run: () => void }[];
};

const AUTO_DISMISS_MS = 6000;
const icons = { ok: "check", error: "alert", info: "info" } as const;

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  // Toasts with actions wait for the user; plain ones fade out unless hovered or focused.
  // The timer depends only on stable values, so a parent render does not restart it.
  const [held, setHeld] = useState(false);
  const sticky = Boolean(toast.actions?.length);
  const { id } = toast;
  useEffect(() => {
    if (sticky || held) return;
    const timer = setTimeout(() => onDismiss(id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [sticky, held, onDismiss, id]);
  const dismiss = () => onDismiss(id);

  return (
    <div
      className={`toast ${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="toast-icon">
        <Icon name={icons[toast.tone]} size={16} />
      </span>
      <div className="toast-content">
        <strong className="toast-title">{toast.title}</strong>
        {toast.body && <p className="toast-body">{toast.body}</p>}
        {toast.actions?.length ? (
          <div className="toast-actions">
            {toast.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="toast-action"
                onClick={() => {
                  dismiss();
                  a.run();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="icon-button toast-close"
        aria-label="Dismiss notification"
        onClick={dismiss}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
