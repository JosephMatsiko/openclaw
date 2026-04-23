#!/usr/bin/env node
// Research + ask worker — Grok via grok.com (free tier).
//
// Drives through apex-chrome-driver. Uses Joseph's existing X/Grok
// cookies — no subscription required; rate-limited to the free tier's
// implicit daily cap.
//
// Exports: researchBeat, askGrokChat

import {
  dispatchKey,
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const GROK_URL_MATCH = "grok.com";
const GROK_START_URL = "https://grok.com/";
const MODEL_LABEL = "grok/web-free";

async function waitComposerReady(tab, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var composer = document.querySelector('textarea[placeholder*="Ask Grok" i]')
                  || document.querySelector('textarea[placeholder*="message" i]')
                  || document.querySelector('textarea')
                  || document.querySelector('div[contenteditable="true"]');
      var loginBtn = Array.from(document.querySelectorAll('button,a')).find(function(el){ return /sign ?in|log ?in/i.test(el.innerText || '') });
      var turnstile = document.title.includes("Just a moment");
      return { composer: !!composer, loginBtn: !!loginBtn, turnstile: turnstile, url: location.href };
    `,
    );
    const v = r.value ?? {};
    if (v.composer && !v.turnstile) {
      return { ok: true, ...v };
    }
    if (v.turnstile) {
      return { ok: false, reason: "turnstile", ...v };
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return { ok: false, reason: "timeout" };
}

async function submitPrompt(tab, prompt) {
  const insert = await evalInTab(
    tab,
    `
    var c = document.querySelector('textarea[placeholder*="Ask Grok" i]')
         || document.querySelector('textarea[placeholder*="message" i]')
         || document.querySelector('textarea')
         || document.querySelector('div[contenteditable="true"]');
    if (!c) return { ok: false, error: "composer missing" };
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
    throw new Error(`grok insert: ${insert.error ?? insert.value?.error}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  const send = await evalInTab(
    tab,
    `
    var b = document.querySelector('button[type="submit"]')
         || document.querySelector('button[aria-label*="send" i]')
         || document.querySelector('button[aria-label*="submit" i]')
         || Array.from(document.querySelectorAll('button')).find(function(el){ var r = el.getBoundingClientRect(); return r.bottom > window.innerHeight * 0.6; });
    if (!b) return { ok: false, error: "no send" };
    if (b.disabled) return { ok: false, error: "send disabled" };
    b.click();
    return { ok: true };
  `,
  );
  if (!send.ok || send.value?.ok === false) {
    try {
      await dispatchKey(tab, "Enter");
    } catch (e) {
      throw new Error(`grok send: ${send.value?.error}`, { cause: e });
    }
  }
}

async function readReply(tab) {
  const r = await evalInTab(
    tab,
    `
    // Grok renders answers in role=assistant divs or .message-content-like containers
    var msgs = document.querySelectorAll('[data-message-author-role="assistant"], [class*="message" i][class*="assistant" i], [class*="response" i]');
    var last = msgs[msgs.length - 1];
    var text = last ? (last.innerText || last.textContent || "") : "";
    var stop = document.querySelector('button[aria-label*="Stop" i]') || document.querySelector('button[data-testid*="stop"]');
    return { text: text.trim(), streaming: !!stop };
  `,
  );
  if (!r.ok) {
    throw new Error(`grok poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askGrokChat({ prompt } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askGrokChat: prompt required");
  }
  const tab = await findOrOpenTab({ urlMatch: GROK_URL_MATCH, createUrl: GROK_START_URL });
  if (tab.created) {
    const ready = await waitForPageReady(tab, { timeoutMs: 15000, urlIncludes: GROK_URL_MATCH });
    if (!ready) {
      throw new Error("grok.com did not load");
    }
  }
  const state = await waitComposerReady(tab);
  if (!state.ok) {
    if (state.reason === "turnstile" || state.reason === "cf-challenge-path") {
      void import("./apex-cf-signal.mjs")
        .then((m) =>
          m.emitCfSignal({ domain: "grok.com", reason: state.reason, tabUrl: state.url }),
        )
        .catch(() => {});
    }
    throw new Error(`grok not ready: ${state.reason} url=${state.url}`);
  }
  await submitPrompt(tab, String(prompt));
  const text = await pollUntilStable({ tab, read: readReply, timeoutMs: 180_000 });
  return { text: text.trim(), modelUsed: MODEL_LABEL };
}

function buildResearchPrompt(beat, n) {
  return [
    `You are pulling real cited news for a weekly magazine.`,
    ``,
    `Beat: ${beat}`,
    ``,
    `Find ${n} real items from the past 7 days. Prefer primary sources. Output ONLY a JSON array of {title, summary, source, url, publishedHint} — no prose, no fences.`,
  ].join("\n");
}

function parseArray(raw) {
  const s = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const a = s.indexOf("["),
    b = s.lastIndexOf("]");
  if (a < 0 || b < 0) {
    throw new Error(`grok: no array in ${raw.slice(0, 300)}`);
  }
  return JSON.parse(s.slice(a, b + 1));
}

export async function researchBeat(beat, { items = 5 } = {}) {
  const { text, modelUsed } = await askGrokChat({ prompt: buildResearchPrompt(beat, items) });
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
  const idx = argv.indexOf("--items");
  const n = idx >= 0 ? Number.parseInt(argv[idx + 1] ?? "5", 10) : 5;
  const text = argv
    .filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--items")
    .join(" ")
    .trim();
  if (!text) {
    console.error("usage: research-grok-chat.mjs [--ask] [--json] [--items N] <text>");
    process.exit(2);
  }
  const r = ask ? await askGrokChat({ prompt: text }) : await researchBeat(text, { items: n });
  console.log(
    asJson
      ? JSON.stringify(r, null, 2)
      : ask
        ? `# Grok — ${r.modelUsed}\n\n${r.text}`
        : JSON.stringify(r, null, 2),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[research-grok-chat] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
