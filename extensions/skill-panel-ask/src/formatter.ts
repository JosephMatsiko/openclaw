// Long-update formatter — Telegram-HTML with collapsible blockquotes.
//
// Salvaged from chuck-format-update.mjs (2026-05-01 Unit 3 — folded into
// skill-panel-ask because the dominant producer of "long" output is panel
// synthesis itself; placing the formatter next to runPanelAsk minimizes
// the import graph for callers that use both).
//
// Pure-string transform: no I/O, no side effects. Detection heuristic:
//   - Sections split on ALL-CAPS headings, Markdown ## / ### headings,
//     and rule lines (=====, -----, ─────).
//   - A titled section with body > 200 chars (or a doc with 3+ such
//     sections) becomes <blockquote expandable>.
//   - Inline `code spans` become <code>...</code>; http(s) URLs auto-link.
//   - All non-token text is HTML-escaped (& < >) so payloads with stray
//     "<" don't break Telegram parsing.

const FORMAT_THRESHOLD_CHARS = 1500;
const SECTION_BLOCKQUOTE_THRESHOLD = 200;

export interface FormatLongUpdateResult {
  /** "HTML" when formatting was applied; null when input is short or unsectioned. */
  parseMode: "HTML" | null;
  /** Either the formatted HTML string or the original plain text. */
  text: string;
  /** Number of titled sections detected (0 when no formatting applied). */
  sections: number;
  /** True when the formatter actually ran (length-threshold + section detection). */
  formatted: boolean;
}

export interface FormatLongUpdateOptions {
  /** Minimum input length before formatting kicks in. Default 1500 chars. */
  threshold?: number;
  /** Section body length above which a section gets blockquote-expandable. Default 200. */
  blockquoteThreshold?: number;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineFormat(text: string): string {
  const segments: Array<{ kind: "text" | "code" | "link"; value: string }> = [];
  const tokenRegex = /(`[^`\n]+`)|(\bhttps?:\/\/[^\s<>")]+)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, m.index) });
    }
    if (m[1]) {
      segments.push({ kind: "code", value: m[1].slice(1, -1) });
    } else if (m[2]) {
      segments.push({ kind: "link", value: m[2] });
    }
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return segments
    .map((seg) => {
      if (seg.kind === "code") return `<code>${escapeHtml(seg.value)}</code>`;
      if (seg.kind === "link") {
        const escaped = escapeHtml(seg.value);
        return `<a href="${escaped}">${escaped}</a>`;
      }
      return escapeHtml(seg.value);
    })
    .join("");
}

interface Section {
  title: string | null;
  body: string;
}

function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentTitle: string | null = null;
  let currentBody: string[] = [];

  function flush(): void {
    if (currentTitle != null || currentBody.length > 0) {
      const body = currentBody.join("\n").replace(/^\s+|\s+$/g, "");
      if (body.length > 0 || currentTitle) {
        sections.push({ title: currentTitle, body });
      }
    }
    currentTitle = null;
    currentBody = [];
  }

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    if (/^[=─-]{5,}$/.test(trimmed)) {
      flush();
      continue;
    }

    const mdMatch = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    if (mdMatch) {
      flush();
      currentTitle = mdMatch[2].trim();
      continue;
    }

    const capsMatch = /^([A-Z][A-Z0-9 ]{1,40})(?:\s+(?:[—–\-:]\s+(.*))?)?$/.exec(trimmed);
    if (capsMatch && trimmed.length <= 80 && /[A-Z]/.test(capsMatch[1].slice(0, 4))) {
      if (capsMatch[2] || trimmed.endsWith(":")) {
        flush();
        const fullTitle = capsMatch[2]
          ? `${capsMatch[1].trim()} — ${capsMatch[2]}`
          : capsMatch[1].trim();
        currentTitle = fullTitle;
        continue;
      }
    }

    currentBody.push(line);
  }
  flush();

  return sections;
}

/**
 * Format a long plain-text update into Telegram HTML with expandable
 * blockquotes per section. Input under the threshold returns unchanged
 * (parseMode=null).
 */
export function formatLongUpdate(
  text: string,
  opts: FormatLongUpdateOptions = {},
): FormatLongUpdateResult {
  const threshold = opts.threshold ?? FORMAT_THRESHOLD_CHARS;
  const blockquoteThreshold = opts.blockquoteThreshold ?? SECTION_BLOCKQUOTE_THRESHOLD;

  if (typeof text !== "string" || text.length === 0) {
    return { parseMode: null, text: text ?? "", sections: 0, formatted: false };
  }
  if (text.length < threshold) {
    return { parseMode: null, text, sections: 0, formatted: false };
  }
  const sections = splitSections(text);
  // No titled sections → unstructured blob; not worth formatting (the
  // user-visible win of HTML mode is the expandable per-section
  // blockquote — without titled sections, there's nothing to collapse).
  // splitSections returns ≥1 entry for any non-empty input (a single
  // title-null entry is the all-body case), so we check for at least
  // one non-null title rather than length === 0.
  const hasTitledSection = sections.some((s) => s.title != null);
  if (!hasTitledSection) {
    return { parseMode: null, text, sections: 0, formatted: false };
  }

  const intro: string[] = [];
  const sectioned: Section[] = [];
  let pastIntro = false;
  for (const s of sections) {
    if (!pastIntro && s.title == null) {
      intro.push(s.body);
      continue;
    }
    pastIntro = true;
    sectioned.push(s);
  }

  const useBlockquote = (s: Section): boolean =>
    s.title != null && (s.body.length > blockquoteThreshold || sectioned.length >= 3);

  const parts: string[] = [];

  if (intro.length > 0) {
    const introText = intro.join("\n\n");
    parts.push(inlineFormat(introText));
  }

  for (const s of sectioned) {
    if (s.title == null) {
      parts.push(inlineFormat(s.body));
      continue;
    }
    const titleHtml = `<b>${escapeHtml(s.title)}</b>`;
    const bodyHtml = inlineFormat(s.body);
    if (useBlockquote(s)) {
      parts.push(`<blockquote expandable>${titleHtml}\n${bodyHtml}</blockquote>`);
    } else {
      parts.push(`${titleHtml}\n${bodyHtml}`);
    }
  }

  return {
    parseMode: "HTML",
    text: parts.join("\n\n"),
    sections: sectioned.length,
    formatted: true,
  };
}
