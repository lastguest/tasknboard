import { useEffect, useRef, useState } from "react";
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
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // Toasts with actions wait for the user; plain ones fade out unless hovered or focused.
  const [held, setHeld] = useState(false);
  const sticky = Boolean(toast.actions?.length);
  // The parent passes a new onDismiss on every render, so a ref keeps the timer running.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (sticky || held) return;
    const timer = setTimeout(() => dismiss.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [sticky, held]);

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
                  onDismiss();
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
        onClick={onDismiss}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
