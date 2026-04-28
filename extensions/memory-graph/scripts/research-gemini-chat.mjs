#!/usr/bin/env node
// Research + ask worker — Gemini web UI (gemini.google.com).
//
// This is a same-family Google child surface, distinct from Gemini CLI
// and AI Studio. It is useful as a browser UX/pro-subscription proof and
// fallback, but it never counts as an independent family beside other
// Google surfaces.

import {
  dispatchKey,
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const GEMINI_URL_MATCH = "gemini.google.com";
const GEMINI_START_URL = "https://gemini.google.com/app";
const MODEL_LABEL = "gemini/web-chat";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startFreshGeminiChat(tab) {
  await evalInTab(
    tab,
    `
    if (!location.href.includes("/app")) {
      location.href = ${JSON.stringify(GEMINI_START_URL)};
    }
    return { url: location.href };
  `,
  );
  const ready = await waitForPageReady(tab, { timeoutMs: 20000, urlIncludes: GEMINI_URL_MATCH });
  if (!ready) {
    throw new Error("gemini did not load");
  }
  await sleep(900);
  const opened = await evalInTab(
    tab,
    `
    function visible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      var s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    }
    var targets = Array.from(document.querySelectorAll('a, button')).filter(visible);
    var newChat = targets.find(function(el) {
      var label = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.innerText || '',
        el.textContent || '',
        el.getAttribute('href') || ''
      ].join(' ');
      return /\\bnew chat\\b/i.test(label) || /\\/app$/i.test(label);
    });
    if (!newChat) {
      history.pushState({}, "", "/app");
      window.dispatchEvent(new PopStateEvent("popstate"));
      return { ok: true, method: "pushstate", url: location.href };
    }
    newChat.scrollIntoView({ block: "center", inline: "center" });
    for (var type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      newChat.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return { ok: true, method: "click", text: (newChat.innerText || newChat.getAttribute('aria-label') || '').trim(), url: location.href };
  `,
  );
  if (!opened.ok || opened.value?.ok === false) {
    throw new Error(
      `gemini fresh chat failed: ${opened.error ?? opened.value?.error ?? "unknown"}`,
    );
  }
  await sleep(1200);
}

async function waitComposerReady(tab, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var composer = document.querySelector('[role="textbox"][aria-label*="prompt" i]')
        || document.querySelector('div[role="textbox"]')
        || document.querySelector('rich-textarea .ql-editor')
        || document.querySelector('rich-textarea');
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, reason: "timeout" };
}

async function readCurrentModel(tab) {
  const r = await evalInTab(
    tab,
    `
    var mode = Array.from(document.querySelectorAll('button')).find(function(b) {
      return /\\b(Pro|Flash|Advanced|Deep Research)\\b/i.test((b.innerText || '').trim())
        || /mode picker/i.test(b.getAttribute('aria-label') || '');
    });
    return mode ? (mode.innerText || mode.getAttribute('aria-label') || '').trim() : "";
  `,
  );
  return (r.ok && r.value) || "gemini";
}

async function submitPrompt(tab, prompt) {
  const before = await assistantCount(tab);
  const insert = await evalInTab(
    tab,
    `
    var c = document.querySelector('[role="textbox"][aria-label*="prompt" i]')
      || document.querySelector('div[role="textbox"]')
      || document.querySelector('rich-textarea .ql-editor');
    if (!c) return { ok: false, error: "no composer" };
    c.focus();
    while (c.firstChild) c.removeChild(c.firstChild);
    if (!(document.execCommand && document.execCommand('insertText', false, ${JSON.stringify(prompt)}))) {
      c.innerText = ${JSON.stringify(prompt)};
      c.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
    }
    c.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  `,
  );
  if (!insert.ok || insert.value?.ok === false) {
    throw new Error(`gemini insert: ${insert.error ?? insert.value?.error}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  const send = await evalInTab(
    tab,
    `
    var b = document.querySelector('button[aria-label*="Send message" i]')
      || document.querySelector('button[aria-label*="Send" i]')
      || Array.from(document.querySelectorAll('button')).find(function(el) {
        return /send/i.test(el.getAttribute('aria-label') || el.innerText || '');
      });
    if (!b) return { ok: false, error: "no send" };
    if (b.disabled) return { ok: false, error: "disabled" };
    b.scrollIntoView({ block: 'center', inline: 'center' });
    for (var type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    b.click();
    return { ok: true };
  `,
  );
  if (!send.ok || send.value?.ok === false) {
    try {
      await dispatchKey(tab, "Enter");
    } catch (error) {
      throw new Error(`gemini send: ${send.value?.error ?? send.error}`, { cause: error });
    }
  }
  return { before };
}

async function assistantCount(tab) {
  const r = await evalInTab(
    tab,
    `
    return document.querySelectorAll('model-response message-content, model-response structured-content-container, response-container message-content').length;
  `,
  );
  return Number(r.value ?? 0);
}

async function readReply(tab, { prompt = "", minAssistantCount = 0 } = {}) {
  const r = await evalInTab(
    tab,
    `
    var promptText = ${JSON.stringify(String(prompt))};
    var minCount = ${Number(minAssistantCount)};
    function clean(raw) {
      var lines = String(raw || "").split("\\n").map(function(line) { return line.trim(); }).filter(Boolean);
      var out = [];
      var drop = [
        /^Show thinking$/i,
        /^Gemini said$/i,
        /^Good response$/i,
        /^Bad response$/i,
        /^Copy$/i,
        /^Redo$/i,
        /^Listen$/i,
        /^Gemini is AI and can make mistakes/i
      ];
      for (var line of lines) {
        if (drop.some(function(rx) { return rx.test(line); })) continue;
        out.push(line);
      }
      return out.join("\\n").trim();
    }
    function isPromptEcho(text) {
      return promptText && text.replace(/\\s+/g, " ").includes(promptText.replace(/\\s+/g, " ").slice(0, 120));
    }
    var nodes = Array.from(document.querySelectorAll('model-response message-content, model-response structured-content-container, response-container message-content'));
    var candidates = nodes.map(function(el) { return clean(el.innerText || el.textContent || ""); })
      .filter(function(text) { return text && !isPromptEcho(text); });
    var text = candidates[candidates.length - 1] || "";
    var stop = document.querySelector('button[aria-label*="Stop" i]') || document.querySelector('[aria-label*="Stop generating" i]');
    var send = document.querySelector('button[aria-label*="Send message" i]');
    var countReady = nodes.length > minCount;
    return { text: text, streaming: !!stop || !countReady || !text || (send && send.disabled && !text) };
  `,
  );
  if (!r.ok) {
    throw new Error(`gemini poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askGeminiChat({ prompt, forceFresh = false } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askGeminiChat: prompt required");
  }
  const tab = await findOrOpenTab({ urlMatch: GEMINI_URL_MATCH, createUrl: GEMINI_START_URL });
  if (forceFresh) {
    await startFreshGeminiChat(tab);
  } else {
    const ready = await waitForPageReady(tab, { timeoutMs: 20000, urlIncludes: GEMINI_URL_MATCH });
    if (!ready) {
      throw new Error("gemini did not load");
    }
  }
  const state = await waitComposerReady(tab);
  if (!state.ok) {
    throw new Error(`gemini not ready: ${state.reason} url=${state.url}`);
  }
  const model = await readCurrentModel(tab);
  const { before } = await submitPrompt(tab, String(prompt));
  const text = await pollUntilStable({
    tab,
    read: async (activeTab) =>
      await readReply(activeTab, { prompt: String(prompt), minAssistantCount: before }),
    timeoutMs: 300_000,
  });
  return { text: text.trim(), modelUsed: `${MODEL_LABEL} (${model})` };
}

function buildResearchPrompt(beat, n) {
  return `Pull ${n} cited news items from past 7 days on beat: ${beat}. Output ONLY a JSON array of {title, summary, source, url, publishedHint}.`;
}

function parseArray(raw) {
  const text = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  if (a < 0 || b < 0) {
    throw new Error("gemini: no array");
  }
  return JSON.parse(text.slice(a, b + 1));
}

export async function researchBeat(beat, { items = 5 } = {}) {
  const { text, modelUsed } = await askGeminiChat({ prompt: buildResearchPrompt(beat, items) });
  const parsed = parseArray(text);
  return {
    beat,
    modelUsed,
    items: parsed
      .map((item) => ({
        title: String(item?.title ?? "").trim(),
        summary: String(item?.summary ?? "").trim(),
        source: String(item?.source ?? "").trim(),
        url: String(item?.url ?? "").trim(),
        publishedHint: String(item?.publishedHint ?? "").trim(),
      }))
      .filter((item) => item.title && item.summary && item.url),
  };
}

async function mainCli() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const ask = argv.includes("--ask");
  const idx = argv.indexOf("--items");
  const n = idx >= 0 ? Number.parseInt(argv[idx + 1] ?? "5", 10) : 5;
  const forceFresh = !argv.includes("--reuse");
  const text = argv
    .filter((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--items")
    .join(" ")
    .trim();
  if (!text) {
    console.error("usage: research-gemini-chat.mjs [--ask] [--json] [--items N] <text>");
    process.exit(2);
  }
  const result = ask
    ? await askGeminiChat({ prompt: text, forceFresh })
    : await researchBeat(text, { items: n });
  console.log(
    asJson
      ? JSON.stringify(result, null, 2)
      : ask
        ? `# Gemini Web — ${result.modelUsed}\n\n${result.text}`
        : JSON.stringify(result, null, 2),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((error) => {
    console.error(`[research-gemini-chat] fatal: ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
