import { useId, useMemo, useState, type ReactNode, type RefObject } from "react";
import { Avatar, displayName, usePeople } from "./People";
import type { Actor } from "./types";

/*
 * Suggests people from the roster while an @-mention is being typed in a
 * textarea. The textarea's offset parent anchors the list, so it needs
 * `position: relative` (see .mention-anchor and .md-editor).
 */

// Matches the server's mention syntax (mentionedIdentities in agent-config).
const mentionable = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/;
const beforeCaret = /(^|[^\w@./-])@([a-zA-Z0-9._/-]{0,79})$/;
const LIMIT = 8;
const WIDTH = 280;
const HEIGHT = LIMIT * 32 + 10;

/** Roster entries for an @-query: ID prefix, then name prefix, then anywhere. */
export function mentionCandidates(
  people: ReadonlyMap<string, Actor>,
  query: string,
) {
  const q = query.toLowerCase();
  const rank = (actor: Actor) => {
    const id = actor.id.toLowerCase();
    const name = actor.name?.trim().toLowerCase() ?? "";
    if (id.startsWith(q)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(q))) return 1;
    if (id.includes(q) || name.includes(q)) return 2;
    return -1;
  };
  return [...people.values()]
    .filter((actor) => mentionable.test(actor.id) && !actor.id.endsWith("."))
    .map((actor) => ({ actor, rank: rank(actor) }))
    .filter((c) => c.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        displayName(people, a.actor.id).localeCompare(
          displayName(people, b.actor.id),
        ),
    )
    .slice(0, LIMIT)
    .map((c) => c.actor);
}

const mirrored = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
  "tabSize",
] as const;

/** Where the list goes for a character, relative to the textarea's offset parent. */
function placeAt(el: HTMLTextAreaElement, at: number) {
  const mirror = document.createElement("div");
  const style = getComputedStyle(el);
  for (const name of mirrored) mirror.style[name] = style[name];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-9999px",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  mirror.textContent = el.value.slice(0, at);
  const marker = document.createElement("span");
  marker.textContent = "@";
  mirror.append(marker);
  document.body.append(mirror);
  const lineTop = el.offsetTop + marker.offsetTop - el.scrollTop;
  const lineHeight = marker.offsetHeight;
  const left = el.offsetLeft + marker.offsetLeft - el.scrollLeft;
  mirror.remove();
  // Near the bottom of the window the list opens above the line instead.
  const viewportTop = el.getBoundingClientRect().top - el.offsetTop + lineTop;
  const above =
    viewportTop + lineHeight + HEIGHT > window.innerHeight &&
    viewportTop > HEIGHT;
  return {
    top: above ? lineTop - 4 : lineTop + lineHeight + 4,
    left: Math.max(0, Math.min(left, el.offsetLeft + el.clientWidth - WIDTH)),
    above,
  };
}

type Query = {
  /** Index of the "@" in the text. */
  start: number;
  query: string;
  top: number;
  left: number;
  above: boolean;
};

export function useMentions(
  area: RefObject<HTMLTextAreaElement | null>,
  enabled = true,
) {
  const people = usePeople();
  const [mention, setMention] = useState<Query | null>(null);
  const [active, setActive] = useState(0);
  const list = useId();
  const candidates = useMemo(
    () => (mention ? mentionCandidates(people, mention.query) : []),
    [people, mention?.query],
  );
  const open = Boolean(enabled && mention && candidates.length);

  /** Opens, follows, or closes the list as the text and caret change. */
  function track(el: HTMLTextAreaElement, reposition = false) {
    const { selectionStart: s, selectionEnd: e, value } = el;
    const m = enabled && s === e ? beforeCaret.exec(value.slice(0, s)) : null;
    if (!m) {
      setMention(null);
      return;
    }
    const start = s - m[2].length - 1;
    const same = mention?.start === start && mention.query === m[2];
    if (same && !reposition) return;
    if (!same) setActive(0);
    setMention({ start, query: m[2], ...placeAt(el, start) });
  }

  function pick(actor: Actor) {
    const el = area.current;
    if (!el || !mention) return;
    const end = el.selectionStart;
    const spaced = /\s/.test(el.value[end] ?? "");
    const text = `@${actor.id}${spaced ? "" : " "}`;
    el.focus();
    el.setSelectionRange(mention.start, end);
    // execCommand keeps Cmd+Z working; fall back where it is unavailable.
    if (!document.execCommand?.("insertText", false, text)) {
      el.setRangeText(text, mention.start, end, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (spaced) el.setSelectionRange(el.selectionStart + 1, el.selectionStart + 1);
    setMention(null);
  }

  /** Handles list keys; true when the key was used and should go no further. */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || e.nativeEvent.isComposing) return false;
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (step) setActive((i) => (i + step + candidates.length) % candidates.length);
    else if ((e.key === "Enter" || e.key === "Tab") && plain)
      pick(candidates[Math.min(active, candidates.length - 1)]);
    // Escape closes the list, not the dialog around the editor.
    else if (e.key === "Escape") setMention(null);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  /** Spread onto the textarea, after its own onChange and onKeyDown. */
  const textareaProps = {
    "aria-autocomplete": enabled ? ("list" as const) : undefined,
    "aria-controls": open ? list : undefined,
    "aria-activedescendant": open ? `${list}-${active}` : undefined,
    onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) =>
      track(e.currentTarget),
    onBlur: () => setMention(null),
    onScroll: (e: React.UIEvent<HTMLTextAreaElement>) => {
      if (mention) track(e.currentTarget, true);
    },
  };

  const menu: ReactNode = open && (
    <ul
      id={list}
      className={`mention-menu${mention!.above ? " above" : ""}`}
      role="listbox"
      aria-label="Mention someone"
      style={{ top: mention!.top, left: mention!.left }}
    >
      {candidates.map((actor, i) => {
        const name = displayName(people, actor.id);
        return (
          <li
            key={actor.id}
            id={`${list}-${i}`}
            role="option"
            aria-selected={i === active}
            className="mention-option"
            // Keep focus, and the caret, in the textarea.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(actor)}
          >
            <Avatar name={actor.id} agent={actor.kind === "agent"} />
            <span className="mention-name">{name}</span>
            {name !== actor.id && (
              <span className="mention-id">@{actor.id}</span>
            )}
            {actor.kind === "agent" && (
              <span className="mention-kind">Agent</span>
            )}
          </li>
        );
      })}
    </ul>
  );

  return { track, onKeyDown, textareaProps, menu, close: () => setMention(null) };
}
