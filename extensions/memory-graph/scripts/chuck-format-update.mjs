#!/usr/bin/env node
// chuck-format-update — pure-string formatter that turns long plain-text
// updates into Telegram-HTML with expandable blockquotes.
//
// Why: long status messages (finish-line summaries, audit reports, panel
// synthesis output) blow past Telegram's natural-reading bandwidth. With
// HTML mode we can:
//   - bold section titles
//   - collapse long sections into <blockquote expandable> by default (tap
//     to expand) so the message fits one screen
//   - render code spans + inline code
//   - keep links clickable
//
// Telegram's HTML mode supports a small whitelist of tags. We escape all
// other HTML (& < > ") in user content so a payload that happens to contain
// "<" doesn't break the message.
//
// Detection heuristics:
//   - "Sections" are split on:
//       lines matching /^[A-Z][A-Z0-9 ]+(?: — | - |: )/ (e.g. "LAYER 1 — ...")
//       lines matching /^## /  (Markdown H2)
//       lines matching /^={5,}/ (rule lines as boundaries)
//       blank lines (paragraph breaks)
//   - A section becomes <blockquote expandable> if its body > 200 chars OR
//     the document has 3+ such sections.
//   - Titles get wrapped in <b>...</b>.
//   - `inline code` becomes <code>...</code>.
//   - URLs are auto-linked unless already in <a> form.
//
// CLI:
//   echo "<text>" | node chuck-format-update.mjs format
//   echo "<text>" | node chuck-format-update.mjs probe   — prints metadata
//
// Returns from the JS API:
//   { parseMode: "HTML" | null, text: "<html string>", sections: [...] }
//
// When parseMode is null, the caller should send the original plain text.

const FORMAT_THRESHOLD_CHARS = 1500;
const SECTION_BLOCKQUOTE_THRESHOLD = 200;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// `text` is plain text. We return inline-formatted HTML where known
// patterns (backtick code, http(s) URLs) become tags. All other content
// is HTML-escaped.
function inlineFormat(text) {
  // Pre-escape, then re-introduce safe tags via tokenization.
  // Strategy: split on backticks and URLs, escape the non-token parts,
  // wrap the token parts.
  const segments = [];
  let remaining = text;

  const tokenRegex = /(`[^`\n]+`)|(\bhttps?:\/\/[^\s<>")]+)/g;
  let lastIndex = 0;
  let m;
  while ((m = tokenRegex.exec(remaining)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ kind: "text", value: remaining.slice(lastIndex, m.index) });
    }
    if (m[1]) {
      // backtick code
      segments.push({ kind: "code", value: m[1].slice(1, -1) });
    } else if (m[2]) {
      segments.push({ kind: "link", value: m[2] });
    }
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex < remaining.length) {
    segments.push({ kind: "text", value: remaining.slice(lastIndex) });
  }

  return segments
    .map((seg) => {
      if (seg.kind === "code") {
        return `<code>${escapeHtml(seg.value)}</code>`;
      }
      if (seg.kind === "link") {
        const escaped = escapeHtml(seg.value);
        return `<a href="${escaped}">${escaped}</a>`;
      }
      return escapeHtml(seg.value);
    })
    .join("");
}

// Heuristic: split a plain-text doc into [{ title?, body }] sections.
// Headings are detected by:
//   ALL-CAPS line followed by " — " or " - " or ": "  (e.g. "LAYER 1 — REACH")
//   Markdown "## " or "### " heading
//   "# " heading at start of document only
function splitSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let currentTitle = null;
  let currentBody = [];

  function flush() {
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

    // Rule lines act as boundaries but aren't sections themselves.
    if (/^[=─-]{5,}$/.test(trimmed)) {
      flush();
      continue;
    }

    // Markdown ##, ### heading
    const mdMatch = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    if (mdMatch) {
      flush();
      currentTitle = mdMatch[2].trim();
      continue;
    }

    // ALL-CAPS heading: "LAYER 1 — REACH JOSEPH" / "DONE TONIGHT" / "SECTION: foo"
    const capsMatch = /^([A-Z][A-Z0-9 ]{1,40})(?:\s+(?:[—–\-:]\s+(.*))?)?$/.exec(trimmed);
    if (capsMatch && trimmed.length <= 80 && /[A-Z]/.test(capsMatch[1].slice(0, 4))) {
      // Avoid matching short ALL-CAPS shouts inside body text by requiring
      // the next non-blank line to look like a body (not another heading)
      // OR the title line to contain a separator.
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
 * Format a long plain-text update into Telegram HTML.
 *
 * Returns:
 *   { parseMode: "HTML" | null, text: string, sections: number, formatted: boolean }
 *
 * If the input is short OR has no detectable sections, returns the
 * original text with parseMode=null (caller should send as plain).
 */
export function formatLongUpdate(text, opts = {}) {
  const threshold = opts.threshold ?? FORMAT_THRESHOLD_CHARS;
  const blockquoteThreshold = opts.blockquoteThreshold ?? SECTION_BLOCKQUOTE_THRESHOLD;

  if (typeof text !== "string" || text.length === 0) {
    return { parseMode: null, text: text ?? "", sections: 0, formatted: false };
  }
  if (text.length < threshold) {
    return { parseMode: null, text, sections: 0, formatted: false };
  }
  const sections = splitSections(text);
  if (sections.length === 0) {
    return { parseMode: null, text, sections: 0, formatted: false };
  }

  // Pre-amble: any section without a title at the top of the doc is the
  // intro and stays inline (no blockquote).
  const intro = [];
  const sectioned = [];
  let pastIntro = false;
  for (const s of sections) {
    if (!pastIntro && s.title == null) {
      intro.push(s.body);
      continue;
    }
    pastIntro = true;
    sectioned.push(s);
  }

  const useBlockquote = (s) =>
    s.title != null && (s.body.length > blockquoteThreshold || sectioned.length >= 3);

  const parts = [];

  if (intro.length > 0) {
    const introText = intro.join("\n\n");
    parts.push(inlineFormat(introText));
  }

  for (const s of sectioned) {
    if (s.title == null) {
      // Free-floating body without a title — emit inline.
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

// ─── CLI ──────────────────────────────────────────────────────────────────
async function readStdin() {
  return await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  const cmd = process.argv[2] ?? "format";
  const input = await readStdin();
  const result = formatLongUpdate(input);
  if (cmd === "format") {
    process.stdout.write(result.text);
    return;
  }
  if (cmd === "probe") {
    console.log(
      JSON.stringify(
        {
          parseMode: result.parseMode,
          sections: result.sections,
          formatted: result.formatted,
          inputLen: input.length,
          outputLen: result.text.length,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.error("usage: chuck-format-update [format|probe] < input");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
