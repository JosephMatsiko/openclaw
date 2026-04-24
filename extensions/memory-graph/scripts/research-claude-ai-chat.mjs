#!/usr/bin/env node
// Research + ask worker — Claude.ai (second Claude voice, distinct
// from Max-plan CLI path). Useful for TRIO diversity — same model
// family, different system prompt + UI-level tuning yields a second
// vote.
//
// Drives through apex-chrome-driver. Sovereign, daemon-safe.

import {
  dispatchKey,
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const CLAUDE_AI_URL_MATCH = "claude.ai";
const CLAUDE_AI_START_URL = "https://claude.ai/new";
const MODEL_LABEL = "claude-ai/web-chat";

async function waitComposerReady(tab, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var c = document.querySelector('div[contenteditable="true"]')
           || document.querySelector('textarea[placeholder*="Claude" i]')
           || document.querySelector('textarea');
      var loginBtn = document.querySelector('a[href*="/login"]') || document.querySelector('button[type="submit"][data-testid*="login"]');
      return { composer: !!c, loginBtn: !!loginBtn, title: document.title, url: location.href };
    `,
    );
    const v = r.value ?? {};
    if (v.composer) {
      return { ok: true, ...v };
    }
    if (v.loginBtn) {
      return { ok: false, reason: "not-signed-in", ...v };
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return { ok: false, reason: "timeout" };
}

async function readCurrentModel(tab) {
  const r = await evalInTab(
    tab,
    `
    var btn = document.querySelector('[data-testid*="model"]') || document.querySelector('button[aria-haspopup="menu"]');
    return btn ? (btn.innerText || "").trim() : "";
  `,
  );
  return r.ok ? r.value || "unknown" : "unknown";
}

async function submitPrompt(tab, prompt) {
  const insert = await evalInTab(
    tab,
    `
    var c = document.querySelector('div[contenteditable="true"][translate="no"]')
         || document.querySelector('.ProseMirror')
         || document.querySelector('div[contenteditable="true"]')
         || document.querySelector('textarea');
    if (!c) return { ok: false, error: "no composer" };
    c.focus();
    if (c.tagName === 'TEXTAREA') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(c, ${JSON.stringify(prompt)});
      else c.value = ${JSON.stringify(prompt)};
      c.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      while (c.firstChild) c.removeChild(c.firstChild);
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
    }
    return { ok: true };
  `,
  );
  if (!insert.ok || insert.value?.ok === false) {
    throw new Error(`claude.ai insert: ${insert.error ?? insert.value?.error}`);
  }
  // React needs time to settle state before Send enables; scale with prompt size.
  const settleMs = Math.min(500 + Math.floor(prompt.length / 20), 5000);
  await new Promise((r) => setTimeout(r, settleMs));
  // Retry send-click up to 3 times — for long prompts the button stays
  // disabled briefly after insertText even though the content is valid.
  let clicked = false;
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    const send = await evalInTab(
      tab,
      `
      var b = document.querySelector('button[aria-label="Send message"]')
           || document.querySelector('button[aria-label*="Send" i]')
           || document.querySelector('button[data-testid*="send"]')
           || document.querySelector('button[type="submit"]');
      if (!b) return { ok: false, error: "no send btn" };
      if (b.disabled) return { ok: false, error: "disabled" };
      b.click();
      return { ok: true };
    `,
    );
    if (send.ok && send.value?.ok !== false) {
      clicked = true;
      break;
    }
    lastErr = send.value?.error ?? send.error ?? "unknown";
  }
  if (!clicked) {
    try {
      await dispatchKey(tab, "Enter");
    } catch (e) {
      throw new Error(`claude.ai send: ${lastErr}`, { cause: e });
    }
  }
}

async function readReply(tab) {
  const r = await evalInTab(
    tab,
    `
    // Primary: streaming element (present during + briefly after streaming).
    // Fallbacks exist because claude.ai has rotated these class names multiple
    // times (font-claude-message → data-is-streaming → data-testid). Include
    // all historical anchors so future drifts degrade, not break.
    var el = document.querySelector('[data-is-streaming]');
    if (!el) {
      var msgs = document.querySelectorAll(
        '[data-testid*="message"][data-testid*="assistant"], ' +
        '[data-message-author-role="assistant"], ' +
        '.font-claude-message, ' +
        '[class*="claude-response" i]'
      );
      el = msgs[msgs.length - 1];
    }
    var text = el ? (el.innerText || el.textContent || "") : "";
    var stop = document.querySelector('button[aria-label*="Stop" i]');
    return { text: text.trim(), streaming: !!stop };
  `,
  );
  if (!r.ok) {
    throw new Error(`claude.ai poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askClaudeAiChat({ prompt, forceFresh = true } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askClaudeAiChat: prompt required");
  }
  // findOrOpenTab reuses existing claude.ai tabs, which can silently append
  // to a prior conversation or return a stale assistant turn from pollUntilStable.
  // Force-navigate to /new when forceFresh so every askClaudeAiChat is a fresh thread.
  const tab = await findOrOpenTab({
    urlMatch: CLAUDE_AI_URL_MATCH,
    createUrl: CLAUDE_AI_START_URL,
  });
  if (forceFresh && !tab.created) {
    // Force-navigate via in-page JS — works across CDP + AppleScript backends
    // without depending on a driver-level navigate export.
    await evalInTab(tab, `location.href = ${JSON.stringify(CLAUDE_AI_START_URL)};`);
    await new Promise((r) => setTimeout(r, 800));
  }
  if (tab.created || forceFresh) {
    const ready = await waitForPageReady(tab, {
      timeoutMs: 15000,
      urlIncludes: CLAUDE_AI_URL_MATCH,
    });
    if (!ready) {
      throw new Error("claude.ai did not load");
    }
  }
  const state = await waitComposerReady(tab);
  if (!state.ok) {
    if (state.reason === "turnstile" || state.reason === "cf-challenge-path") {
      void import("./apex-cf-signal.mjs")
        .then((m) =>
          m.emitCfSignal({ domain: "claude.ai", reason: state.reason, tabUrl: state.url }),
        )
        .catch(() => {});
    }
    throw new Error(`claude.ai not ready: ${state.reason}`);
  }
  const model = await readCurrentModel(tab);
  await submitPrompt(tab, String(prompt));
  // Long prompts (e.g. pasted audits) can stream for several minutes,
  // especially on Opus 4.7 Adaptive / reasoning models. 300s accommodates
  // full architectural reviews; pollUntilStable returns early when the
  // stream stops anyway.
  const text = await pollUntilStable({ tab, read: readReply, timeoutMs: 300_000 });
  return { text: text.trim(), modelUsed: `${MODEL_LABEL} (${model})` };
}

function buildResearchPrompt(beat, n) {
  return `Pull ${n} cited news items from past 7 days on beat: ${beat}. Output ONLY a JSON array of {title, summary, source, url, publishedHint}.`;
}

function parseArray(raw) {
  const s = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const a = s.indexOf("["),
    b = s.lastIndexOf("]");
  if (a < 0 || b < 0) {
    throw new Error(`claude.ai: no array`);
  }
  return JSON.parse(s.slice(a, b + 1));
}

export async function researchBeat(beat, { items = 5 } = {}) {
  const { text, modelUsed } = await askClaudeAiChat({ prompt: buildResearchPrompt(beat, items) });
  const parsed = parseArray(text);
  const normalized = parsed
    .map((it) => ({
      title: String(it?.title ?? "").trim(),
      summary: String(it?.summary ?? "").trim(),
      source: String(it?.source ?? "").trim(),
      url: String(it?.url ?? "").trim(),
      publishedHint: String(it?.publishedHint ?? "").trim(),
    }))
    .filter((it) => it.title && it.summary && it.url);
  return { beat, modelUsed, items: normalized };
}

async function mainCli() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const ask = argv.includes("--ask");
  const noFresh = argv.includes("--no-fresh");
  const idx = argv.indexOf("--items");
  const n = idx >= 0 ? Number.parseInt(argv[idx + 1] ?? "5", 10) : 5;
  const text = argv
    .filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--items")
    .join(" ")
    .trim();
  if (!text) {
    console.error(
      "usage: research-claude-ai-chat.mjs [--ask] [--json] [--items N] [--no-fresh] <text>",
    );
    process.exit(2);
  }
  const r = ask
    ? await askClaudeAiChat({ prompt: text, forceFresh: !noFresh })
    : await researchBeat(text, { items: n });
  console.log(
    asJson
      ? JSON.stringify(r, null, 2)
      : ask
        ? `# Claude.ai — ${r.modelUsed}\n\n${r.text}`
        : JSON.stringify(r, null, 2),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[research-claude-ai-chat] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
