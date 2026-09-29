import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

export type MenuItem = {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Renders a radio item; undefined renders a plain command. */
  checked?: boolean;
  /** Ask once more in place before a destructive command runs. */
  confirm?: string;
};
export type MenuGroup = { label?: string; items: MenuItem[] };
export type MenuState = {
  label: string;
  x: number;
  y: number;
  groups: MenuGroup[];
  /** Receives focus again when the menu closes. */
  trigger: HTMLElement | null;
};

const focusable = "button:not(:disabled),a[href],[tabindex]";

/**
 * Menu state for a right click, a long press, or the keyboard menu key.
 * Keyboard events carry no pointer position, so the menu opens at the element.
 */
export function menuAt(
  e: React.MouseEvent<HTMLElement>,
  label: string,
  groups: MenuGroup[],
): MenuState | null {
  const target = e.target as HTMLElement;
  // Keep the browser menu for text entry, links, and selected text.
  if (
    target.closest('input,textarea,select,a[href],[contenteditable="true"]') ||
    !window.getSelection()?.isCollapsed
  )
    return null;
  e.preventDefault();
  e.stopPropagation();
  const owner = e.currentTarget;
  const rect = owner.getBoundingClientRect();
  const keyboard = e.clientX === 0 && e.clientY === 0;
  return {
    label,
    x: keyboard ? rect.left + 8 : e.clientX,
    y: keyboard ? rect.top + 8 : e.clientY,
    groups: groups.filter((g) => g.items.length),
    trigger: owner.matches(focusable)
      ? owner
      : (owner.querySelector<HTMLElement>(focusable) ??
        (document.activeElement as HTMLElement | null)),
  };
}

export function ContextMenu({
  menu,
  onClose,
}: {
  menu: MenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const [armed, setArmed] = useState("");
  const close = useRef(onClose);
  close.current = onClose;

  const items = () =>
    Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>(
        "[role^=menuitem]:not(:disabled)",
      ) ?? [],
    );
  const dismiss = (restore = true) => {
    if (restore && menu.trigger?.isConnected) menu.trigger.focus();
    close.current();
  };

  // Keep the menu inside the viewport, then move focus into it.
  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect();
    const margin = 8;
    setPosition({
      left: Math.max(
        margin,
        Math.min(menu.x, window.innerWidth - box.width - margin),
      ),
      top: Math.max(
        margin,
        Math.min(menu.y, window.innerHeight - box.height - margin),
      ),
    });
    items()[0]?.focus();
  }, [menu]);

  useLayoutEffect(() => {
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) dismiss(false);
    };
    const away = () => dismiss(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  });

  function run(item: MenuItem, key: string) {
    if (item.confirm && armed !== key) {
      setArmed(key);
      return;
    }
    dismiss();
    item.onSelect();
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={menu.label}
      style={position}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const list = items();
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        const step = (to: number) => {
          e.preventDefault();
          list[(to + list.length) % list.length]?.focus();
        };
        if (e.key === "ArrowDown") step(index + 1);
        else if (e.key === "ArrowUp") step(index - 1);
        else if (e.key === "Home") step(0);
        else if (e.key === "End") step(list.length - 1);
        else if (e.key === "Escape") {
          e.preventDefault();
          dismiss();
        } else if (e.key === "Tab") {
          e.preventDefault();
          dismiss();
        }
        // The menu owns the keyboard while it is open.
        e.stopPropagation();
      }}
    >
      {menu.groups.map((group, g) => (
        <div
          key={g}
          role="group"
          aria-label={group.label}
          className="context-menu-group"
        >
          {group.label && (
            <div className="context-menu-heading" aria-hidden="true">
              {group.label}
            </div>
          )}
          {group.items.map((item, i) => {
            const key = `${g}:${i}`;
            const confirming = armed === key && item.confirm;
            return (
              <button
                key={key}
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                tabIndex={-1}
                disabled={item.disabled}
                className={`context-menu-item${confirming ? " danger" : ""}`}
                onClick={() => run(item, key)}
              >
                <span className="context-menu-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="context-menu-label">
                  {confirming ? item.confirm : item.label}
                </span>
                {item.checked && <Icon name="check" size={14} />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
