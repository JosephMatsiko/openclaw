#!/usr/bin/env node
// Research + ask worker — Perplexity Pro via perplexity.ai chat UI.
//
// Drives through apex-chrome-driver. Retrieval-grounded with citations
// — complementary to Claude/Gemini/ChatGPT in TRIO+ dispatch.
//
// Exports:
//   researchBeat(beat, { items })
//   askPerplexityChat({ prompt })

import {
  dispatchKey,
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const PPLX_URL_MATCH = "perplexity.ai";
const PPLX_START_URL = "https://www.perplexity.ai/";
const DEFAULT_MODEL_LABEL = "perplexity-pro/web-chat";

async function waitComposerReady(tab, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var composer = document.querySelector('#ask-input')
                  || document.querySelector('div[contenteditable="true"][role="textbox"]')
                  || document.querySelector('textarea[placeholder*="Ask" i]')
                  || document.querySelector('textarea[placeholder*="question" i]')
                  || document.querySelector('textarea')
                  || document.querySelector('div[contenteditable="true"]');
      var loginBtn = Array.from(document.querySelectorAll('button,a')).find(function(el){ return /sign ?in|log ?in/i.test(el.innerText||''); });
      var turnstile = document.title.includes("Just a moment") || !!document.querySelector("[data-testid=\\"cf-turnstile\\"]");
      return { composer: !!composer, loginBtn: !!loginBtn, turnstile: turnstile, title: document.title, url: location.href };
    `,
    );
    const v = r.value ?? {};
    if (v.composer && !v.turnstile) {
      return { ok: true, ...v };
    }
    if (v.loginBtn) {
      return { ok: false, reason: "not-signed-in", ...v };
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
    var c = document.querySelector('#ask-input')
         || document.querySelector('div[contenteditable="true"][role="textbox"]')
         || document.querySelector('textarea[placeholder*="Ask" i]')
         || document.querySelector('textarea[placeholder*="question" i]')
         || document.querySelector('textarea')
         || document.querySelector('div[contenteditable="true"]');
    if (!c) return { ok: false, error: "composer not found" };
    c.focus();
    if (c.tagName === 'TEXTAREA') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value') &&
                   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      if (setter) setter.call(c, ${JSON.stringify(prompt)});
      else c.value = ${JSON.stringify(prompt)};
      c.dispatchEvent(new Event('input', { bubbles: true }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      while (c.firstChild) c.removeChild(c.firstChild);
      if (!(document.execCommand && document.execCommand('insertText', false, ${JSON.stringify(prompt)}))) {
        c.innerText = ${JSON.stringify(prompt)};
        c.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
      }
    }
    return { ok: true };
  `,
  );
  if (!insert.ok || insert.value?.ok === false) {
    throw new Error(`perplexity insert: ${insert.error ?? insert.value?.error}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  const send = await evalInTab(
    tab,
    `
    var b = document.querySelector('button[aria-label*="Submit" i]')
         || document.querySelector('button[data-testid*="submit"]')
         || document.querySelector('button[type="submit"]')
         || Array.from(document.querySelectorAll('button')).find(function(el){ return /send|submit|ask/i.test(el.getAttribute('aria-label') || ''); });
    if (!b) return { ok: false, error: "no send" };
    if (b.disabled) return { ok: false, error: "send disabled" };
    b.click();
    return { ok: true };
  `,
  );
  if (!send.ok || send.value?.ok === false) {
    try {
      await dispatchKey(tab, "Enter");
    } catch (err) {
      throw new Error(`perplexity send: ${send.error ?? send.value?.error}`, { cause: err });
    }
  }
}

async function readReply(tab) {
  const r = await evalInTab(
    tab,
    `
    var candidates = [
      document.querySelectorAll('[id^="answer-"]'),
      document.querySelectorAll('[class*="prose" i]'),
      document.querySelectorAll('article'),
      document.querySelectorAll('[data-testid*="answer"]'),
    ];
    var best = "";
    for (var i = 0; i < candidates.length; i++) {
      var list = candidates[i];
      if (!list || list.length === 0) continue;
      var last = list[list.length - 1];
      var txt = (last && (last.innerText || last.textContent)) || "";
      if (txt.length > best.length) best = txt;
    }
    var stop = document.querySelector('button[aria-label*="Stop" i]') || document.querySelector('button[data-testid*="stop"]');
    return { text: best, streaming: !!stop };
  `,
  );
  if (!r.ok) {
    throw new Error(`perplexity poll-eval: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askPerplexityChat({ prompt, forceFresh = true } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askPerplexityChat: prompt required");
  }
  // forceFresh is observed (the block below always navigates). Kept as a
  // signature option for future opt-out of fresh-thread behavior when
  // chaining follow-ups in the same conversation.
  void forceFresh;
  const tab = await findOrOpenTab({ urlMatch: PPLX_URL_MATCH, createUrl: PPLX_START_URL });
  // Always force-navigate to the chat root. Reused tabs may be parked on
  // /library, /search/:id, /collections, /settings — each a different DOM.
  if (tab._backend === "cdp") {
    const cdp = await import("./apex-chrome-cdp.mjs");
    await cdp.navigate(tab.handle, PPLX_START_URL);
  } else {
    await evalInTab(tab, `location.href = ${JSON.stringify(PPLX_START_URL)}; return true;`);
  }
  const ready = await waitForPageReady(tab, { timeoutMs: 15000, urlIncludes: PPLX_URL_MATCH });
  if (!ready) {
    throw new Error("perplexity.ai did not finish loading");
  }
  const state = await waitComposerReady(tab);
  if (!state.ok) {
    if (state.reason === "turnstile" || state.reason === "cf-challenge-path") {
      void import("./apex-cf-signal.mjs")
        .then((m) =>
          m.emitCfSignal({
            domain: "perplexity.ai",
            reason: state.reason,
            tabUrl: state.url,
          }),
        )
        .catch(() => {});
    }
    throw new Error(`perplexity not ready: ${state.reason} url=${state.url}`);
  }
  await submitPrompt(tab, String(prompt));
  // 300s — Perplexity reasoning/Pro Search takes minutes on long prompts.
  const text = await pollUntilStable({ tab, read: readReply, timeoutMs: 300_000 });
  return { text: text.trim(), modelUsed: DEFAULT_MODEL_LABEL };
}

function buildResearchPrompt(beat, itemCount) {
  return [
    `You are pulling real cited news for a weekly magazine.`,
    ``,
    `Beat: ${beat}`,
    ``,
    `Find ${itemCount} real items from the past 7 days that a thoughtful reader of this beat would want to know about. Prefer primary sources, established outlets. No duplicates. Include citations as URLs.`,
    ``,
    `Output format — return ONLY a JSON array, no prose before or after, no markdown fences. Each object:`,
    ``,
    `[`,
    `  {`,
    `    "title": "short 5-10 word headline",`,
    `    "summary": "2-3 sentence editorial summary of what happened and why it matters",`,
    `    "source": "publication name",`,
    `    "url": "canonical URL to the primary source",`,
    `    "publishedHint": "relative time or ISO date"`,
    `  }`,
    `]`,
    ``,
    `Return the JSON array now. No other text.`,
  ].join("\n");
}

function parseArrayResult(raw) {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end < 0) {
    throw new Error(`research-perplexity-chat no array: ${raw.slice(0, 400)}`);
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

export async function researchBeat(beat, { items = 5 } = {}) {
  const prompt = buildResearchPrompt(beat, items);
  const { text, modelUsed } = await askPerplexityChat({ prompt });
  const parsed = parseArrayResult(text);
  if (!Array.isArray(parsed)) {
    throw new Error("research-perplexity-chat: not array");
  }
  const normalized = parsed
    .map((it) => {
      const o = it ?? {};
      return {
        title: String(o.title ?? "").trim(),
        summary: String(o.summary ?? "").trim(),
        source: String(o.source ?? "").trim(),
        url: String(o.url ?? "").trim(),
        publishedHint: String(o.publishedHint ?? "").trim(),
      };
    })
    .filter((it) => it.title && it.summary && it.url);
  return { beat, modelUsed, items: normalized };
}

async function mainCli() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const askMode = argv.includes("--ask");
  const itemsIdx = argv.indexOf("--items");
  const items = itemsIdx >= 0 ? Number.parseInt(argv[itemsIdx + 1] ?? "5", 10) : 5;
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--items");
  const text = positional.join(" ").trim();
  if (!text) {
    console.error(
      "usage: research-perplexity-chat.mjs [--json] [--items N] [--ask] <beat-or-prompt>",
    );
    process.exit(2);
  }
  if (askMode) {
    const r = await askPerplexityChat({ prompt: text });
    console.log(
      asJson ? JSON.stringify(r, null, 2) : `# Perplexity Pro — ${r.modelUsed}\n\n${r.text}`,
    );
    return;
  }
  const r = await researchBeat(text, { items });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`# Research (Perplexity Pro via chat): ${r.beat}`);
  console.log(`# Model: ${r.modelUsed} · ${r.items.length} items\n`);
  for (const it of r.items) {
    console.log(`## ${it.title}`);
    console.log(`${it.source} · ${it.publishedHint}`);
    console.log(it.summary);
    console.log(`→ ${it.url}\n`);
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(
      `[research-perplexity-chat] fatal: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exitCode = 1;
  });
}
