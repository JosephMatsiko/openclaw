#!/usr/bin/env node
// Research + ask worker — ChatGPT Plus via chatgpt.com chat UI.
//
// Drives through apex-chrome-driver (auto-picks CDP against Apex
// Chrome; falls back to AppleScript against main Chrome). Zero
// third-party extension dependency. Daemon-safe.
//
// Exports:
//   researchBeat(beat, { items })  → { beat, modelUsed, items }
//   askChatGPTChat({ prompt })     → { text, modelUsed }

import {
  dispatchKey,
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const CHATGPT_URL_MATCH = "chatgpt.com";
const CHATGPT_START_URL = "https://chatgpt.com/";
const DEFAULT_MODEL_LABEL = "chatgpt-plus/web-chat";

async function waitComposerReady(tab, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var c = document.querySelector("#prompt-textarea") || document.querySelector("div[contenteditable=\\"true\\"]");
      var loginBtn = document.querySelector("a[href*=\\"/auth/login\\"]") || document.querySelector("button[data-testid=\\"login-button\\"]");
      var turnstile = document.title.includes("Just a moment") || !!document.querySelector("[data-testid=\\"cf-turnstile\\"]");
      return { composer: !!c, loginBtn: !!loginBtn, turnstile: turnstile, title: document.title, url: location.href };
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

async function readCurrentModel(tab) {
  const r = await evalInTab(
    tab,
    `
    var btn = document.querySelector("[data-testid=\\"model-switcher-dropdown-button\\"]")
           || document.querySelector("button[aria-haspopup=\\"menu\\"]");
    return btn ? (btn.innerText || btn.textContent || "").trim() : "";
  `,
  );
  return (r.ok && r.value) || "unknown";
}

async function submitPrompt(tab, prompt) {
  const insert = await evalInTab(
    tab,
    `
    var c = document.querySelector("#prompt-textarea") || document.querySelector("div[contenteditable=\\"true\\"]") || document.querySelector("textarea");
    if (!c) return { ok: false, error: "composer not found" };
    c.focus();
    if (c.tagName === 'TEXTAREA') {
      c.value = ${JSON.stringify(prompt)};
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
    throw new Error(`chatgpt insert: ${insert.error ?? insert.value?.error}`);
  }
  await new Promise((r) => setTimeout(r, 600));
  const send = await evalInTab(
    tab,
    `
    var b = document.querySelector("button[data-testid=\\"send-button\\"]") || document.querySelector("button[aria-label*=\\"Send\\" i]");
    if (!b) return { ok: false, error: "no send button" };
    if (b.disabled) return { ok: false, error: "send disabled" };
    b.click();
    return { ok: true };
  `,
  );
  if (!send.ok || send.value?.ok === false) {
    try {
      await dispatchKey(tab, "Enter");
    } catch (err) {
      throw new Error(`chatgpt send failed: ${send.error ?? send.value?.error}`, { cause: err });
    }
  }
}

async function readReply(tab) {
  const r = await evalInTab(
    tab,
    `
    var msgs = document.querySelectorAll("[data-message-author-role=\\"assistant\\"]");
    var last = msgs[msgs.length - 1];
    var md = last ? last.querySelector(".markdown") : null;
    var text = (md && (md.innerText || md.textContent)) || (last && (last.textContent || last.innerText)) || "";
    var stop = document.querySelector("button[data-testid=\\"stop-button\\"]") || document.querySelector("button[aria-label*=\\"Stop\\" i]");
    return { text: text, streaming: !!stop };
  `,
  );
  if (!r.ok) {
    throw new Error(`chatgpt poll-eval: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askChatGPTChat({ prompt } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askChatGPTChat: prompt required");
  }
  const tab = await findOrOpenTab({ urlMatch: CHATGPT_URL_MATCH, createUrl: CHATGPT_START_URL });
  if (tab.created) {
    const ready = await waitForPageReady(tab, { timeoutMs: 15000, urlIncludes: CHATGPT_URL_MATCH });
    if (!ready) {
      throw new Error("chatgpt.com did not finish loading");
    }
  }
  const composerState = await waitComposerReady(tab);
  if (!composerState.ok) {
    throw new Error(`chatgpt not ready: reason=${composerState.reason} url=${composerState.url}`);
  }
  const model = await readCurrentModel(tab);
  await submitPrompt(tab, String(prompt));
  const text = await pollUntilStable({ tab, read: readReply, timeoutMs: 180_000 });
  return { text: text.trim(), modelUsed: `${DEFAULT_MODEL_LABEL} (${model})` };
}

function buildResearchPrompt(beat, itemCount) {
  return [
    `You are pulling real cited news for a weekly magazine.`,
    ``,
    `Beat: ${beat}`,
    ``,
    `Find ${itemCount} real items from the past 7 days that a thoughtful reader of this beat would want to know about. Prefer primary sources, established outlets. No duplicates.`,
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
    throw new Error(`research-chatgpt-chat output missing JSON array: ${raw.slice(0, 400)}`);
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

export async function researchBeat(beat, { items = 5 } = {}) {
  const prompt = buildResearchPrompt(beat, items);
  const { text, modelUsed } = await askChatGPTChat({ prompt });
  const parsed = parseArrayResult(text);
  if (!Array.isArray(parsed)) {
    throw new Error("research-chatgpt-chat: not array");
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
    console.error("usage: research-chatgpt-chat.mjs [--json] [--items N] [--ask] <beat-or-prompt>");
    process.exit(2);
  }
  if (askMode) {
    const r = await askChatGPTChat({ prompt: text });
    console.log(
      asJson ? JSON.stringify(r, null, 2) : `# ChatGPT Plus — ${r.modelUsed}\n\n${r.text}`,
    );
    return;
  }
  const r = await researchBeat(text, { items });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`# Research (ChatGPT Plus via chat): ${r.beat}`);
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
      `[research-chatgpt-chat] fatal: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exitCode = 1;
  });
}
