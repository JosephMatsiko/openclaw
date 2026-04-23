#!/usr/bin/env node
// Research + ask worker — Google AI Studio (aistudio.google.com).
//
// AI Studio exposes Gemini models with its own quota pool, separate
// from the CLI OAuth tier. Useful in TRIO+ as a second Gemini voice or
// a cascade target when CLI Pro quota exhausts.
//
// Drives through apex-chrome-driver. Sovereign.

import {
  dispatchKey,
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const AIS_URL_MATCH = "aistudio.google.com";
const AIS_START_URL = "https://aistudio.google.com/prompts/new_chat";
const MODEL_LABEL = "aistudio/web-chat";

async function waitComposerReady(tab, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var composer = document.querySelector('textarea[aria-label*="prompt" i]')
                  || document.querySelector('textarea[aria-label*="type" i]')
                  || document.querySelector('textarea[placeholder*="type" i]')
                  || document.querySelector('ms-autosize-textarea textarea')
                  || document.querySelector('textarea');
      var loginBtn = document.querySelector('a[href*="accounts.google"]');
      return { composer: !!composer, loginBtn: !!loginBtn, title: document.title, url: location.href };
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
    var el = document.querySelector('[aria-label*="model" i]') || document.querySelector('button[aria-haspopup]');
    return el ? (el.innerText || el.getAttribute('aria-label') || "").trim() : "";
  `,
  );
  return (r.ok && r.value) || "gemini";
}

async function submitPrompt(tab, prompt) {
  const insert = await evalInTab(
    tab,
    `
    var c = document.querySelector('ms-autosize-textarea textarea')
         || document.querySelector('textarea[aria-label*="prompt" i]')
         || document.querySelector('textarea');
    if (!c) return { ok: false, error: "no composer" };
    c.focus();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(c, ${JSON.stringify(prompt)});
    else c.value = ${JSON.stringify(prompt)};
    c.dispatchEvent(new Event('input', { bubbles: true }));
    c.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  `,
  );
  if (!insert.ok || insert.value?.ok === false) {
    throw new Error(`aistudio insert: ${insert.error ?? insert.value?.error}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  const send = await evalInTab(
    tab,
    `
    var b = document.querySelector('button[aria-label*="Run" i]')
         || document.querySelector('button[aria-label*="Send" i]')
         || document.querySelector('run-button button')
         || Array.from(document.querySelectorAll('button')).find(function(el){ return /run|send/i.test(el.innerText || el.getAttribute('aria-label') || '') });
    if (!b) return { ok: false, error: "no send" };
    if (b.disabled) return { ok: false, error: "disabled" };
    b.click();
    return { ok: true };
  `,
  );
  if (!send.ok || send.value?.ok === false) {
    try {
      await dispatchKey(tab, "Enter");
    } catch (e) {
      throw new Error(`aistudio send: ${send.value?.error}`, { cause: e });
    }
  }
}

async function readReply(tab) {
  const r = await evalInTab(
    tab,
    `
    var candidates = document.querySelectorAll('ms-chat-turn[_ngcontent-ng], [class*="response" i], [role="article"]');
    var last = candidates[candidates.length - 1];
    var text = last ? (last.innerText || last.textContent || "") : "";
    var running = document.querySelector('[aria-label*="Running" i]') || document.querySelector('button[aria-label*="Stop" i]');
    return { text: text.trim(), streaming: !!running };
  `,
  );
  if (!r.ok) {
    throw new Error(`aistudio poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askAiStudioChat({ prompt } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askAiStudioChat: prompt required");
  }
  const tab = await findOrOpenTab({ urlMatch: AIS_URL_MATCH, createUrl: AIS_START_URL });
  if (tab.created) {
    const ready = await waitForPageReady(tab, { timeoutMs: 20000, urlIncludes: AIS_URL_MATCH });
    if (!ready) {
      throw new Error("aistudio did not load");
    }
  }
  const state = await waitComposerReady(tab);
  if (!state.ok) {
    if (state.reason === "turnstile" || state.reason === "cf-challenge-path") {
      void import("./apex-cf-signal.mjs")
        .then((m) =>
          m.emitCfSignal({
            domain: "aistudio.google.com",
            reason: state.reason,
            tabUrl: state.url,
          }),
        )
        .catch(() => {});
    }
    throw new Error(`aistudio not ready: ${state.reason}`);
  }
  const model = await readCurrentModel(tab);
  await submitPrompt(tab, String(prompt));
  const text = await pollUntilStable({ tab, read: readReply, timeoutMs: 180_000 });
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
    throw new Error(`aistudio: no array`);
  }
  return JSON.parse(s.slice(a, b + 1));
}

export async function researchBeat(beat, { items = 5 } = {}) {
  const { text, modelUsed } = await askAiStudioChat({ prompt: buildResearchPrompt(beat, items) });
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
    console.error("usage: research-aistudio-chat.mjs [--ask] [--json] [--items N] <text>");
    process.exit(2);
  }
  const r = ask ? await askAiStudioChat({ prompt: text }) : await researchBeat(text, { items: n });
  console.log(
    asJson
      ? JSON.stringify(r, null, 2)
      : ask
        ? `# AI Studio — ${r.modelUsed}\n\n${r.text}`
        : JSON.stringify(r, null, 2),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[research-aistudio-chat] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
