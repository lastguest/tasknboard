import type { Key } from "ink";

export type Line = { text: string; cursor: number };

export const emptyLine: Line = { text: "", cursor: 0 };

/**
 * Applies one key press to a single-line prompt.
 * Returns null when the key does not edit text.
 */
export function editLine(line: Line, input: string, key: Key): Line | null {
  const { text, cursor } = line;
  const at = (next: string, position: number) => ({
    text: next,
    cursor: position,
  });
  if (key.leftArrow) return at(text, Math.max(0, cursor - 1));
  if (key.rightArrow) return at(text, Math.min(text.length, cursor + 1));
  if (key.home || (key.ctrl && input === "a")) return at(text, 0);
  if (key.end || (key.ctrl && input === "e")) return at(text, text.length);
  if (key.ctrl && input === "u") return at(text.slice(cursor), 0);
  if (key.ctrl && input === "w") {
    const start = text.slice(0, cursor).replace(/\S+\s*$/, "").length;
    return at(text.slice(0, start) + text.slice(cursor), start);
  }
  // Terminals send DEL for Backspace, which Ink reports as `delete`.
  if (key.backspace || key.delete) {
    if (cursor === 0) return line;
    return at(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
  }
  if (key.ctrl || key.meta || key.escape || key.return || key.tab) return null;
  if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) return null;
  return insert(line, input);
}

/** Inserts typed or pasted text. Line breaks become spaces. */
export function insert(line: Line, input: string): Line {
  const value = input.replace(/\r?\n|\r/g, " ");
  if (!value) return line;
  return {
    text:
      line.text.slice(0, line.cursor) + value + line.text.slice(line.cursor),
    cursor: line.cursor + value.length,
  };
}
