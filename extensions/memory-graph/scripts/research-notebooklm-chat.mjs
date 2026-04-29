#!/usr/bin/env node
// Research + ask worker — NotebookLM (notebooklm.google.com).
//
// Drives through apex-chrome-driver. Targets a designated "scratch"
// notebook configured via env CHUCK_NOTEBOOKLM_NOTEBOOK (a notebook URL
// or notebook ID). When unset, defaults to the FIRST notebook found on
// the home page. Joseph has 10 existing notebooks + Pro tier.
//
// Distinctive vs gemini-web/aistudio-web:
//   - Source-grounded: every answer cites Joseph's uploaded sources
//   - Multi-doc synthesis (across 445+ sources in some of his notebooks)
//   - Audio Overview generation (Gemini-voice podcast from notebook)
//
// Exports: askNotebookLm({ prompt, notebookUrl?, generateAudio? })
//
// Live-DOM verified 2026-04-28:
//   - Composer: textarea[placeholder="Start typing..."]
//   - Submit: button[aria-label="Submit"] with mat-icon "arrow_forward"
//   - Answer rendering: streaming markdown into a chat-message container
//
// Audio Overview is a separate flow (not the chat input) — Joseph clicks
// "Audio Overview" in the studio panel. We expose generateAudio param
// for future wiring; current driver focuses on chat-style queries.

import {
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const NLM_URL_MATCH = "notebooklm.google.com";
const NLM_HOME_URL = "https://notebooklm.google.com/";
const MODEL_LABEL = "notebooklm/notebook-chat";

async function navigateToNotebook(tab, notebookUrl) {
  // If notebookUrl is a full URL, use it. If it's just an ID, build URL.
  let url = notebookUrl;
  if (url && !url.startsWith("http")) {
    url = `https://notebooklm.google.com/notebook/${url}`;
  }
  // If no URL specified, fall back to the most recent notebook on the home page.
  if (!url) {
    const home = await evalInTab(
      tab,
      `
      if (!location.href.includes('notebooklm.google.com')) {
        location.href = 'https://notebooklm.google.com/';
        return { redirecting: true };
      }
      var first = document.querySelector('a[href*="/notebook/"]');
      return { href: first ? first.href : null };
    `,
    );
    if (home.value?.redirecting) {
      await new Promise((r) => setTimeout(r, 2500));
      const retry = await evalInTab(
        tab,
        `
        var first = document.querySelector('a[href*="/notebook/"]');
        return { href: first ? first.href : null };
      `,
      );
      url = retry.value?.href ?? null;
    } else {
      url = home.value?.href ?? null;
    }
  }
  if (!url) {
    throw new Error("notebooklm: no notebook URL provided and no notebooks found on home");
  }
  await evalInTab(tab, `location.href = ${JSON.stringify(url)};`);
  await new Promise((r) => setTimeout(r, 2500));
  return url;
}

async function waitComposerReady(tab, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var composer = document.querySelector('textarea[placeholder="Start typing..." i]')
                  || document.querySelector('textarea');
      var sendBtn = document.querySelector('button[aria-label="Submit"]');
      var loading = document.querySelector('[class*="loading" i]');
      return {
        composer: !!composer,
        sendBtn: !!sendBtn,
        loading: !!loading,
        url: location.href,
        title: document.title.slice(0, 80)
      };
    `,
    );
    const v = r.value ?? {};
    if (v.composer && v.sendBtn) {
      return { ok: true, ...v };
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return { ok: false, reason: "timeout" };
}

async function readActiveModel(_tab) {
  // NotebookLM doesn't expose a model selector — Pro tier uses Gemini
  // 3.1 Pro under the hood. Return the static label.
  return MODEL_LABEL;
}

// Live-DOM verified 2026-04-28: NotebookLM uses Angular Material cards.
// User messages: mat-card.from-user-message-card-content
// Assistant messages: mat-card.to-user-message-card-content
// Both nest inside .chat-message-pair containers.
async function answerCount(tab) {
  const r = await evalInTab(
    tab,
    `
    var nodes = document.querySelectorAll('mat-card.to-user-message-card-content');
    return nodes.length;
  `,
  );
  return Number(r.value ?? 0);
}

async function submitPrompt(tab, prompt) {
  const before = await answerCount(tab);
  const insert = await evalInTab(
    tab,
    `
    var c = document.querySelector('textarea[placeholder="Start typing..." i]')
         || document.querySelector('textarea');
    if (!c) return { ok: false, error: "composer missing" };
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
    throw new Error(`notebooklm insert: ${insert.error ?? insert.value?.error}`);
  }
  // Settle so React re-renders the Submit button as enabled.
  const settleMs = Math.min(800 + Math.floor(prompt.length / 20), 5000);
  await new Promise((r) => setTimeout(r, settleMs));
  let clicked = false;
  for (let attempt = 0; attempt < 5 && !clicked; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 800));
    }
    const send = await evalInTab(
      tab,
      `
      var b = document.querySelector('button[aria-label="Submit"]');
      if (!b) return { ok: false, error: "no submit btn" };
      if (b.disabled) return { ok: false, error: "submit disabled" };
      b.click();
      return { ok: true };
    `,
    );
    if (send.ok && send.value?.ok !== false) {
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    throw new Error("notebooklm submit click failed after 5 attempts");
  }
  return { before };
}

async function readReply(tab, { minAnswerCount = 0 } = {}) {
  const r = await evalInTab(
    tab,
    `
    var minCount = ${minAnswerCount};
    var nodes = document.querySelectorAll('mat-card.to-user-message-card-content');
    var text = "";
    if (nodes.length > 0) {
      var last = nodes[nodes.length - 1];
      text = (last.innerText || last.textContent || "").trim();
    }
    var stop = document.querySelector('button[aria-label*="Stop" i]');
    var loading = document.querySelector('[class*="loading-indicator" i], [class*="generating" i], [class*="thinking" i]');
    var countReady = nodes.length > minCount;
    var streaming = !!stop || !!loading || !countReady || !text;
    return { text: text, streaming: streaming };
  `,
  );
  if (!r.ok) {
    throw new Error(`notebooklm poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askNotebookLm({
  prompt,
  notebookUrl = process.env.CHUCK_NOTEBOOKLM_NOTEBOOK ?? null,
  forceFresh = false,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askNotebookLm: prompt required");
  }
  const tab = await findOrOpenTab({ urlMatch: NLM_URL_MATCH, createUrl: NLM_HOME_URL });
  await waitForPageReady(tab, { timeoutMs: 20000, urlIncludes: NLM_URL_MATCH });
  // Navigate to the target notebook (env-configured or first available).
  // Skip if forceFresh=false AND we're already on a notebook page (reuse).
  const currentUrl = (await evalInTab(tab, `return location.href;`)).value ?? "";
  if (forceFresh || !currentUrl.includes("/notebook/")) {
    const targetUrl = await navigateToNotebook(tab, notebookUrl);
    process.stderr.write(`[notebooklm] using notebook: ${targetUrl}\n`);
  }
  const state = await waitComposerReady(tab);
  if (!state.ok) {
    throw new Error(`notebooklm not ready: ${state.reason}`);
  }
  const model = await readActiveModel(tab);
  const { before } = await submitPrompt(tab, String(prompt));
  // 600s — NotebookLM does multi-doc retrieval + synthesis; can take
  // several minutes on notebooks with many sources.
  const text = await pollUntilStable({
    tab,
    read: async (activeTab) => await readReply(activeTab, { minAnswerCount: before }),
    timeoutMs: 600_000,
  });
  return {
    text: text.trim(),
    modelUsed: model,
  };
}

async function mainCli() {
  const args = process.argv.slice(2);
  let prompt = null;
  let notebookUrl = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt") {
      prompt = args[++i];
    } else if (args[i] === "--notebook") {
      notebookUrl = args[++i];
    }
  }
  if (!prompt) {
    process.stderr.write(
      "usage: research-notebooklm-chat.mjs --prompt '...' [--notebook <id-or-url>]\n",
    );
    process.exit(1);
  }
  const r = await askNotebookLm({ prompt, notebookUrl });
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    process.stderr.write(`[research-notebooklm-chat] fatal: ${e.stack ?? e}\n`);
    process.exit(1);
  });
}
