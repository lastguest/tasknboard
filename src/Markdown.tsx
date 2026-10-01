import { Fragment, useRef, useState, type ReactNode } from "react";
import { command, errorOf, type ApiError } from "./api";
import { Icon } from "./Icons";
import { useMentions } from "./Mentions";

/*
 * Task descriptions are Markdown written by people and agents, so they are
 * untrusted. This renderer builds React elements directly: no HTML string is
 * ever injected, raw HTML in the source stays literal text, links are limited
 * to web and mail URLs, and images only load from this workspace's uploads.
 */

const uploadedImage = /^\/files\/[0-9a-f]{32}$/;

function safeHref(url: string) {
  if (uploadedImage.test(url)) return url;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? parsed.href
      : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- inline

type InlineRule = {
  re: RegExp;
  render: (m: RegExpExecArray, key: number) => ReactNode;
};

const inlineRules: InlineRule[] = [
  { re: /\\([\\`*_{}[\]()#+\-.!~|>])/y, render: (m) => m[1] },
  {
    re: /(`+)([\s\S]+?)\1(?!`)/y,
    render: (m, key) => <code key={key}>{m[2].trim() || m[2]}</code>,
  },
  {
    re: /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?\s*\)/y,
    render: (m, key) => {
      const [, alt, url, title] = m;
      if (uploadedImage.test(url))
        return (
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="md-image"
          >
            <img src={url} alt={alt} title={title} loading="lazy" />
          </a>
        );
      const href = safeHref(url);
      // Remote images are not loaded: they would leak viewers to third parties.
      return href ? (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {alt || href}
        </a>
      ) : (
        alt
      );
    },
  },
  {
    re: /\[((?:\\.|[^\]\\])+)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?\s*\)/y,
    render: (m, key) => {
      const href = safeHref(m[2]);
      const children = inline(m[1]);
      return href ? (
        <a
          key={key}
          href={href}
          title={m[3]}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      ) : (
        <Fragment key={key}>{children}</Fragment>
      );
    },
  },
  {
    re: /<((?:https?:\/\/|mailto:)[^\s<>]+)>/y,
    render: (m, key) => (
      <a
        key={key}
        href={safeHref(m[1])}
        target="_blank"
        rel="noopener noreferrer"
      >
        {m[1]}
      </a>
    ),
  },
  {
    re: /https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]/y,
    render: (m, key) => (
      <a
        key={key}
        href={safeHref(m[0])}
        target="_blank"
        rel="noopener noreferrer"
      >
        {m[0]}
      </a>
    ),
  },
  {
    re: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y,
    render: (m, key) => <strong key={key}>{inline(m[2])}</strong>,
  },
  {
    re: /~~(?=\S)([\s\S]*?\S)~~/y,
    render: (m, key) => <del key={key}>{inline(m[1])}</del>,
  },
  {
    re: /\*(?=[^\s*])([\s\S]*?[^\s*])\*|\b_(?=[^\s_])([\s\S]*?[^\s_])_\b/y,
    render: (m, key) => <em key={key}>{inline(m[1] ?? m[2])}</em>,
  },
];
// Characters that can start an inline rule; everything else is plain text.
const inlineStart = /[\\`!\[<h*_~]/g;

export function inline(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  let text = "",
    i = 0;
  const flush = () => {
    if (text) out.push(text);
    text = "";
  };
  while (i < source.length) {
    inlineStart.lastIndex = i;
    const next = inlineStart.exec(source);
    if (!next) break;
    text += source.slice(i, next.index);
    i = next.index;
    let matched = false;
    for (const rule of inlineRules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(source);
      if (!m) continue;
      flush();
      out.push(rule.render(m, out.length));
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched) text += source[i++];
  }
  text += source.slice(i);
  flush();
  return out;
}

/** Single newlines inside a paragraph are kept, as in comments on GitHub. */
function lines(source: string) {
  return source.split("\n").flatMap((line, i) => {
    const hard = line.replace(/( {2,}|\\)$/, "");
    return i === 0 ? inline(hard) : [<br key={`br${i}`} />, ...inline(hard)];
  });
}

// ----------------------------------------------------------------- blocks

const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
// macOS smart dashes turn "--" into "–" and "---" into "—" while typing, so a
// rule or table divider made of those dashes still counts.
const rule = /^ {0,3}(?:([-*_])(?:\s*\1){2,}|[-–—]*[–—][-–—]*)\s*$/;
const quote = /^ {0,3}> ?/;
const listItem = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const tableDivider =
  /^\s*\|?\s*:?[-–—]+:?\s*(\|\s*:?[-–—]+:?\s*)*\|?\s*$/;

const startsBlock = (line: string) =>
  fence.test(line) ||
  heading.test(line) ||
  rule.test(line) ||
  quote.test(line) ||
  listItem.test(line);

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));

type Toggle = (line: number) => void;

function blocks(src: string[], offset: number, toggle?: Toggle): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < src.length) {
    const line = src[i];
    const key = offset + i;
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = fence.exec(line))) {
      const marker = m[1];
      const body: string[] = [];
      i++;
      while (i < src.length && !src[i].trim().startsWith(marker))
        body.push(src[i++]);
      i++;
      out.push(
        <pre key={key} data-lang={m[2] || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if ((m = heading.exec(line))) {
      const Tag = `h${Math.min(m[1].length + 2, 6)}` as "h3";
      out.push(<Tag key={key}>{inline(m[2])}</Tag>);
      i++;
      continue;
    }
    if (rule.test(line)) {
      out.push(<hr key={key} />);
      i++;
      continue;
    }
    if (quote.test(line)) {
      const start = i;
      const body: string[] = [];
      while (
        i < src.length &&
        src[i].trim() &&
        (quote.test(src[i]) || !startsBlock(src[i]))
      )
        body.push(src[i++].replace(quote, ""));
      out.push(
        <blockquote key={key}>
          {blocks(body, offset + start, toggle)}
        </blockquote>,
      );
      continue;
    }
    if (
      line.includes("|") &&
      i + 1 < src.length &&
      tableDivider.test(src[i + 1])
    ) {
      const head = cells(line);
      const align = cells(src[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":")
          ? "center"
          : c.endsWith(":")
            ? "right"
            : c.startsWith(":")
              ? "left"
              : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < src.length && src[i].includes("|") && src[i].trim())
        rows.push(cells(src[i++]));
      out.push(
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n} style={{ textAlign: align[n] }}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, n) => (
                    <td key={n} style={{ textAlign: align[n] }}>
                      {inline(row[n] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if ((m = listItem.exec(line))) {
      const indent = m[1].length;
      const ordered = /\d/.test(m[2]);
      const items: { start: number; body: string[] }[] = [];
      while (i < src.length) {
        const item = listItem.exec(src[i]);
        if (
          item &&
          item[1].length <= indent + 1 &&
          /\d/.test(item[2]) === ordered
        ) {
          // Keep the text column so nested content can be dedented uniformly.
          items.push({ start: i, body: [item[3]] });
          i++;
          continue;
        }
        const current = items[items.length - 1];
        const continued =
          src[i].trim() &&
          (src[i].length - src[i].trimStart().length > indent ||
            !startsBlock(src[i]));
        const nextIndented =
          !src[i].trim() &&
          i + 1 < src.length &&
          src[i + 1].length - src[i + 1].trimStart().length > indent;
        if (!continued && !nextIndented) break;
        current.body.push(
          src[i].replace(new RegExp(`^ {0,${indent + 4}}`), ""),
        );
        i++;
      }
      const List = ordered ? "ol" : "ul";
      const first = ordered ? Number.parseInt(m[2], 10) : undefined;
      out.push(
        <List key={key} start={first !== 1 ? first : undefined}>
          {items.map(({ start, body }) => {
            const task = /^\[([ xX])\]\s+/.exec(body[0]);
            const content = task
              ? [body[0].slice(task[0].length), ...body.slice(1)]
              : body;
            const tight =
              content.length === 1 ||
              !content.slice(1).some((l) => startsBlock(l) || !l.trim());
            const inner = tight
              ? lines(content.join("\n"))
              : blocks(content, offset + start, toggle);
            if (!task) return <li key={start}>{inner}</li>;
            const checked = task[1] !== " ";
            return (
              <li key={start} className="md-task">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!toggle}
                  aria-label={checked ? "Mark item not done" : "Mark item done"}
                  onChange={() => toggle?.(offset + start)}
                />
                <span>{inner}</span>
              </li>
            );
          })}
        </List>,
      );
      continue;
    }
    const start = i;
    const para: string[] = [];
    while (
      i < src.length &&
      src[i].trim() &&
      (i === start || !startsBlock(src[i])) &&
      !(
        src[i].includes("|") &&
        i + 1 < src.length &&
        tableDivider.test(src[i + 1])
      )
    )
      para.push(src[i++]);
    out.push(<p key={key}>{lines(para.join("\n"))}</p>);
  }
  return out;
}

/** Toggle the `[ ]` marker of the task item on a given source line. */
export function toggleTask(source: string, line: number) {
  const all = source.split("\n");
  all[line] = all[line].replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/,
    (_, lead, mark) => `${lead}[${mark === " " ? "x" : " "}]`,
  );
  return all.join("\n");
}

export function Markdown({
  source,
  className = "",
  onToggleTask,
}: {
  source: string;
  className?: string;
  onToggleTask?: Toggle;
}) {
  const normalized = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  return (
    <div className={`markdown ${className}`}>
      {blocks(normalized.split("\n"), 0, onToggleTask)}
    </div>
  );
}

/** A short plain-text excerpt for compact places such as cards. */
export function plainText(source: string) {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/[*_~`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ----------------------------------------------------------------- editor

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const readDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Images carried as data inside pasted HTML, as some apps copy them. */
const htmlImages = (html: string) =>
  [...new DOMParser().parseFromString(html, "text/html").images].flatMap(
    (img, i) => {
      const m = img
        .getAttribute("src")
        ?.match(/^data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!m) return [];
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      const alt = img.getAttribute("alt")?.trim();
      return [new File([bytes], alt || `image-${i + 1}`, { type: m[1] })];
    },
  );

type Format = {
  id: string;
  label: string;
  icon: string;
  keys?: string;
  apply: (editor: TextEdit) => void;
};

/** Selection-aware edits that keep the browser's native undo history. */
class TextEdit {
  constructor(readonly el: HTMLTextAreaElement) {}
  get value() {
    return this.el.value;
  }
  get selected() {
    return this.value.slice(this.el.selectionStart, this.el.selectionEnd);
  }
  replace(start: number, end: number, text: string, select?: [number, number]) {
    const el = this.el;
    el.focus();
    el.setSelectionRange(start, end);
    // execCommand keeps Cmd+Z working; fall back where it is unavailable.
    if (!document.execCommand?.("insertText", false, text)) {
      el.setRangeText(text, start, end, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (select) el.setSelectionRange(start + select[0], start + select[1]);
  }
  wrap(before: string, after = before, placeholder = "text") {
    const { selectionStart: s, selectionEnd: e } = this.el;
    const inner = this.selected || placeholder;
    const outer = this.value.slice(s - before.length, e + after.length);
    if (this.selected && outer === before + inner + after) {
      this.replace(s - before.length, e + after.length, inner, [
        0,
        inner.length,
      ]);
      return;
    }
    this.replace(s, e, before + inner + after, [
      before.length,
      before.length + inner.length,
    ]);
  }
  /** Prefix every selected line, or remove the prefix when all lines have it. */
  lines(prefix: (n: number) => string, match: RegExp) {
    const v = this.value;
    const start = v.lastIndexOf("\n", this.el.selectionStart - 1) + 1;
    let end = v.indexOf("\n", this.el.selectionEnd);
    if (end < 0) end = v.length;
    const block = v.slice(start, end).split("\n");
    const all = block.every((l) => match.test(l));
    const next = block
      .map((l, n) =>
        all ? l.replace(match, "") : prefix(n) + l.replace(match, ""),
      )
      .join("\n");
    this.replace(start, end, next, [0, next.length]);
  }
  insertBlock(text: string, select?: [number, number]) {
    const { selectionStart: s, selectionEnd: e } = this.el;
    const before = this.value.slice(0, s);
    const lead =
      !before || before.endsWith("\n\n")
        ? ""
        : before.endsWith("\n")
          ? "\n"
          : "\n\n";
    const block = lead + text + "\n";
    this.replace(
      s,
      e,
      block,
      select && [lead.length + select[0], lead.length + select[1]],
    );
  }
}

const formats: Format[] = [
  {
    id: "heading",
    label: "Heading",
    icon: "mdHeading",
    apply: (t) => t.lines(() => "## ", /^#{1,6}\s+/),
  },
  {
    id: "bold",
    label: "Bold",
    icon: "mdBold",
    keys: "B",
    apply: (t) => t.wrap("**"),
  },
  {
    id: "italic",
    label: "Italic",
    icon: "mdItalic",
    keys: "I",
    apply: (t) => t.wrap("_"),
  },
  {
    id: "strike",
    label: "Strikethrough",
    icon: "mdStrike",
    keys: "⇧X",
    apply: (t) => t.wrap("~~"),
  },
  {
    id: "link",
    label: "Link",
    icon: "mdLink",
    keys: "K",
    apply: (t) => {
      const { selectionStart: s, selectionEnd: e } = t.el;
      const text = t.selected || "link text";
      const isUrl = /^https?:\/\/\S+$/.test(text);
      const md = isUrl ? `[link text](${text})` : `[${text}](https://)`;
      t.replace(s, e, md, isUrl ? [1, 10] : [text.length + 3, md.length - 1]);
    },
  },
  {
    id: "code",
    label: "Code",
    icon: "mdCode",
    keys: "E",
    apply: (t) =>
      t.selected.includes("\n")
        ? t.insertBlock("```\n" + t.selected + "\n```", [
            4,
            4 + t.selected.length,
          ])
        : t.wrap("`", "`", "code"),
  },
  {
    id: "quote",
    label: "Quote",
    icon: "mdQuote",
    apply: (t) => t.lines(() => "> ", /^>\s?/),
  },
  {
    id: "bullets",
    label: "Bulleted list",
    icon: "mdBullets",
    apply: (t) => t.lines(() => "- ", /^\s*[-*+]\s+(?!\[[ xX]\])/),
  },
  {
    id: "numbers",
    label: "Numbered list",
    icon: "mdNumbers",
    apply: (t) => t.lines((n) => `${n + 1}. `, /^\s*\d+[.)]\s+/),
  },
  {
    id: "tasks",
    label: "Checklist",
    icon: "mdTasks",
    apply: (t) => t.lines(() => "- [ ] ", /^\s*[-*+]\s+\[[ xX]\]\s+/),
  },
  {
    id: "table",
    label: "Table",
    icon: "mdTable",
    apply: (t) =>
      t.insertBlock(
        "| Column | Column |\n| --- | --- |\n| Cell | Cell |",
        [2, 8],
      ),
  },
  {
    id: "rule",
    label: "Divider",
    icon: "mdRule",
    apply: (t) => t.insertBlock("---"),
  },
];

/** Continue lists on Enter; an empty item ends the list. */
function continueList(el: HTMLTextAreaElement, edit: TextEdit) {
  const { selectionStart: s, selectionEnd: e, value } = el;
  if (s !== e) return false;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const line = value.slice(lineStart, s);
  const m = /^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/.exec(line);
  if (!m) return false;
  if (line.length === m[0].length) {
    edit.replace(lineStart, s, "");
    return true;
  }
  const marker = m[2] ?? `${Number(m[3]) + 1}${m[4]}`;
  edit.replace(s, s, `\n${m[1]}${marker} ${m[5] ? "[ ] " : ""}`);
  return true;
}

export function MarkdownEditor({
  id,
  "aria-describedby": describedBy,
  value,
  onChange,
  maxLength,
  rows = 6,
  placeholder,
  startInPreview = false,
  disabled = false,
  mentions = false,
}: {
  id?: string;
  "aria-describedby"?: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  rows?: number;
  placeholder?: string;
  startInPreview?: boolean;
  disabled?: boolean;
  /** Suggest people from the roster after "@". */
  mentions?: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const mention = useMentions(area, mentions && !disabled);
  const [preview, setPreview] = useState(
    startInPreview && Boolean(value.trim()),
  );
  const [uploads, setUploads] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const mac = /Mac|iP(hone|ad)/.test(navigator.platform);

  const write = () => {
    setPreview(false);
    requestAnimationFrame(() => area.current?.focus());
  };

  const edit = () => new TextEdit(area.current!);
  const run = (format: Format) => {
    if (disabled) return;
    setPreview(false);
    requestAnimationFrame(() => format.apply(edit()));
  };

  async function upload(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length || disabled) return;
    setError(null);
    setPreview(false);
    for (const image of images) {
      const t = edit();
      const name =
        (image.name || "image").replace(/[[\]\n]/g, "").replace(/\.\w+$/, "") ||
        "image";
      if (!IMAGE_TYPES.includes(image.type)) {
        setError(
          errorOf(
            new Error(
              `${image.name || "That file"} isn't a PNG, JPEG, WebP, or GIF.`,
            ),
          ),
        );
        continue;
      }
      if (image.size > MAX_IMAGE_BYTES) {
        setError(
          errorOf(
            new Error(`${image.name || "That image"} is larger than 5 MB.`),
          ),
        );
        continue;
      }
      // A unique placeholder marks where the image goes while it uploads.
      const token = `![Uploading ${name}… ${crypto.randomUUID().slice(0, 8)}]()`;
      const { selectionStart: s, selectionEnd: e } = t.el;
      // Images sit on their own line so they never split a sentence.
      const lead = s > 0 && t.value[s - 1] !== "\n" ? "\n" : "";
      t.replace(s, e, lead + token);
      setUploads((n) => n + 1);
      let replacement = "";
      try {
        const saved = await command<{ url: string }>("upload_image", {
          data: await readDataUrl(image),
        });
        replacement = `![${name}](${saved.url})`;
      } catch (err) {
        setError(errorOf(err));
      } finally {
        setUploads((n) => n - 1);
      }
      const el = area.current;
      if (!el) continue;
      const at = el.value.indexOf(token);
      if (at >= 0) new TextEdit(el).replace(at, at + token.length, replacement);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.onKeyDown(e)) return;
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      if (!e.nativeEvent.isComposing && continueList(e.currentTarget, edit()))
        e.preventDefault();
      return;
    }
    if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const format = formats.find(
      (f) =>
        f.keys &&
        f.keys.replace("⇧", "").toLowerCase() === key &&
        f.keys.startsWith("⇧") === e.shiftKey,
    );
    if (!format) return;
    e.preventDefault();
    // Cmd+K inside the editor makes a link rather than opening search.
    e.stopPropagation();
    format.apply(edit());
  }

  const shortcut = (keys?: string) =>
    keys ? ` (${mac ? "⌘" : "Ctrl+"}${keys})` : "";

  return (
    <div
      className={`md-editor${dragging ? " is-dragging" : ""}${disabled ? " is-disabled" : ""}`}
      onDragOver={(e) => {
        if (disabled || ![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      <div className="md-toolbar">
        <div
          className="md-tools"
          role="toolbar"
          aria-label="Formatting"
          aria-controls={id}
        >
          <button
            type="button"
            className="icon-button md-mode"
            title={preview ? "Write" : "Preview"}
            aria-label={preview ? "Write" : "Preview"}
            onClick={preview ? write : () => setPreview(true)}
          >
            <Icon name={preview ? "mdWrite" : "mdPreview"} size={15} />
          </button>
          <span className="md-sep" aria-hidden />
          {formats.map((f) => (
            <Fragment key={f.id}>
              {["link", "bullets", "table"].includes(f.id) && (
                <span className="md-sep" aria-hidden />
              )}
              <button
                type="button"
                className="icon-button"
                title={f.label + shortcut(f.keys)}
                aria-label={f.label}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(f)}
              >
                <Icon name={f.icon} size={15} />
              </button>
            </Fragment>
          ))}
          <button
            type="button"
            className="icon-button"
            title="Add image — you can also paste or drop"
            aria-label="Add image"
            disabled={disabled}
            onClick={() => file.current?.click()}
          >
            <Icon name="mdImage" size={15} />
          </button>
          <input
            ref={file}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            multiple
            hidden
            onChange={(e) => {
              void upload([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <textarea
        ref={area}
        id={id}
        aria-describedby={describedBy}
        hidden={preview}
        rows={rows}
        maxLength={maxLength}
        // Markdown syntax must survive typing: no smart quotes or dashes.
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        {...mention.textareaProps}
        onChange={(e) => {
          onChange(e.target.value);
          mention.track(e.target);
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) =>
            f.type.startsWith("image/"),
          );
          if (files.length) {
            e.preventDefault();
            void upload(files);
            return;
          }
          // Embedded images are uploaded rather than pasted as data.
          const html = e.clipboardData.getData("text/html");
          const embedded = html.includes("data:image/") ? htmlImages(html) : [];
          if (!embedded.length) return;
          e.preventDefault();
          const t = edit();
          const { selectionStart: s, selectionEnd: end } = t.el;
          t.replace(s, end, e.clipboardData.getData("text/plain").trimEnd());
          void upload(embedded);
        }}
      />
      {!preview && mention.menu}
      {preview && (
        <div
          className="md-preview"
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest("a,input")) write();
          }}
        >
          {value.trim() ? (
            <Markdown
              source={value}
              onToggleTask={
                disabled
                  ? undefined
                  : (line) => onChange(toggleTask(value, line))
              }
            />
          ) : (
            <p className="small">Nothing to preview.</p>
          )}
        </div>
      )}
      <div className="md-footer">
        <span className="small" aria-live="polite">
          {uploads
            ? `Uploading ${uploads} image${uploads > 1 ? "s" : ""}…`
            : error
              ? ""
              : "Markdown supported · paste or drop images"}
        </span>
        {error && (
          <span className="md-error" role="alert">
            {error.message}
          </span>
        )}
      </div>
    </div>
  );
}
