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
    var body = document.body.innerText || "";
    var selected = body.match(/\\n(Gemini[^\\n]+)\\n(gemini-[a-z0-9_.-]+)/i);
    if (selected) return (selected[1] + " " + selected[2]).trim();
    var el = Array.from(document.querySelectorAll('button, [role="button"]')).find(function(node) {
      var text = (node.innerText || node.getAttribute('aria-label') || '').trim();
      return /^Gemini\\b/i.test(text) && /gemini-/i.test(text);
    });
    return el ? (el.innerText || el.getAttribute('aria-label') || "").trim() : "";
  `,
  );
  return (r.ok && r.value) || "gemini";
}

async function dismissBlockingBanners(tab) {
  await evalInTab(
    tab,
    `
    for (var b of Array.from(document.querySelectorAll('button'))) {
      var text = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim();
      if (/^(Dismiss|Got it|Close)$/i.test(text) && !b.disabled) {
        b.click();
      }
    }
    return true;
  `,
  );
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
  await dismissBlockingBanners(tab);
  const send = await evalInTab(
    tab,
    `
    function visible(el) {
      return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    }
    var buttons = Array.from(document.querySelectorAll('button'));
    var b = buttons.find(function(el) {
          var lines = (el.innerText || '').trim().split(/\\n+/).map(function(line) { return line.trim(); });
          return visible(el) && !el.disabled && lines.includes('Run');
        })
         || document.querySelector('run-button button:not([disabled])')
         || buttons.find(function(el) {
          var label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
          return visible(el) && !el.disabled && /\\b(Run|Send)\\b/i.test(label);
        });
    if (!b) return { ok: false, error: "no send" };
    if (b.disabled) return { ok: false, error: "disabled" };
    b.scrollIntoView({ block: 'center', inline: 'center' });
    for (var type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    b.click();
    return { ok: true, buttonText: (b.innerText || b.getAttribute('aria-label') || '').trim() };
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

async function readReply(tab, prompt = "") {
  const r = await evalInTab(
    tab,
    `
    var promptText = ${JSON.stringify(prompt)};
    function clean(raw) {
      var lines = String(raw || "").split("\\n").map(function(line) { return line.trim(); }).filter(Boolean);
      var out = [];
      var drop = [
        /^edit$/i,
        /^more_vert$/i,
        /^thumb_up$/i,
        /^thumb_down$/i,
        /^info$/i,
        /^Google AI models may make mistakes/i,
        /^Use Arrow Up and Arrow Down/i,
        /^\\d+(?:\\.\\d+)?\\s*(?:ms|s)$/i
      ];
      for (var line of lines) {
        if (drop.some(function(rx) { return rx.test(line); })) continue;
        if (/^Response ready\\.?$/i.test(line)) break;
        out.push(line);
      }
      return out.join("\\n").trim();
    }
    function isPromptEcho(text) {
      return promptText && text.replace(/\\s+/g, " ").includes(promptText.replace(/\\s+/g, " ").slice(0, 120));
    }
    function isUserTurn(text) {
      return /^User\\s+\\d{1,2}:\\d{2}/i.test(text) || isPromptEcho(text);
    }
    var turns = Array.from(document.querySelectorAll('ms-chat-turn'));
    var candidates = turns.map(function(el) {
      var raw = el.innerText || el.textContent || "";
      return {
        raw: raw,
        text: clean(raw),
        done: /\\bthumb_up\\b/i.test(raw) || /\\bthumb_down\\b/i.test(raw) || /\\b\\d+(?:\\.\\d+)?\\s*s\\b/i.test(raw)
      };
    }).filter(function(text) {
      return text.text && !/^Thoughts\\b/i.test(text.text) && !isUserTurn(text.text);
    });
    var structured = candidates.filter(function(item) {
      return /\\b(SURFACE_PROOF_OK|CLAIMS:|RISKS:|MISSING_EVIDENCE:|DEEPEN_NEEDED:)\\b/i.test(item.text);
    });
    var selected = (structured.length ? structured[structured.length - 1] : candidates[candidates.length - 1]) || { text: "", done: false };
    var body = document.body.innerText || "";
    var explicitRunning = /\\bStop\\s+Running\\.\\.\\./i.test(body) ||
      !!document.querySelector('button[aria-label*="Stop" i], [aria-label*="Running" i]');
    return { text: selected.text.trim(), streaming: explicitRunning || !selected.done };
  `,
  );
  if (!r.ok) {
    throw new Error(`aistudio poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askAiStudioChat({ prompt, forceFresh = true } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askAiStudioChat: prompt required");
  }
  const tab = await findOrOpenTab({ urlMatch: AIS_URL_MATCH, createUrl: AIS_START_URL });
  if (forceFresh && !tab.created) {
    await evalInTab(tab, `location.href = ${JSON.stringify(AIS_START_URL)};`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (tab.created || forceFresh) {
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
  await dismissBlockingBanners(tab);
  const model = await readCurrentModel(tab);
  await submitPrompt(tab, String(prompt));
  // 300s — AI Studio streams reasoning/thinking for long-prompt 2.5 Pro runs.
  const text = await pollUntilStable({
    tab,
    read: async (activeTab) => await readReply(activeTab, String(prompt)),
    timeoutMs: 300_000,
  });
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
