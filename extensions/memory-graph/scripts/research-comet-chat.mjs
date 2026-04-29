#!/usr/bin/env node
// Research + ask worker - Perplexity via Comet (ai.perplexity.comet).
//
// Mirrors research-perplexity-chat.mjs, but drives Comet directly through
// its Chromium AppleScript dictionary:
//   tell application id "ai.perplexity.comet"
//     tell active tab of window 1 to execute javascript ...
//   end tell
//
// This intentionally does not parameterize apex-chrome-lib.mjs yet. Comet
// needs app-bundle addressing and active-tab wrappers, and keeping that in
// this file avoids changing the established Chrome/CDP driver path.
//
// Exports:
//   researchBeat(beat, { items })
//   askCometChat({ prompt })

import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMET_APP_NAME = "Comet";
const COMET_BUNDLE_ID = "ai.perplexity.comet";
const COMET_URL_MATCH = "perplexity.ai";
const COMET_START_URL = "https://www.perplexity.ai/";
const DEFAULT_MODEL_LABEL = "perplexity-comet/web-chat";

const COMET_ANSWER_SELECTORS = [
  '[id^="answer-"]',
  '[data-testid*="answer"]',
  'main [class*="prose" i]',
  'main [class*="markdown" i]',
  "main article",
].join(", ");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escAS(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn("/usr/bin/osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    p.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    p.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || "spawn failed" });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function activateComet() {
  await new Promise((resolve) => {
    const p = spawn("/usr/bin/open", ["-b", COMET_BUNDLE_ID], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      try {
        p.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 12000);
    p.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  await runAppleScript(
    `tell application id "${escAS(COMET_BUNDLE_ID)}"
  activate
end tell`,
    { timeoutMs: 5000 },
  );
  await sleep(500);
}

async function findOrOpenCometTab({ urlMatch, createUrl } = {}) {
  if (!urlMatch) {
    throw new Error("findOrOpenCometTab: urlMatch required");
  }
  const url = createUrl ?? `https://${urlMatch}/`;
  await activateComet();
  const script = `
tell application id "${escAS(COMET_BUNDLE_ID)}"
  activate
  if (count windows) = 0 then make new window
  set found to false
  repeat with wIdx from 1 to count windows
    set tabs_ to tabs of window wIdx
    repeat with tIdx from 1 to count tabs_
      set t to item tIdx of tabs_
      try
        if URL of t contains "${escAS(urlMatch)}" then
          set index of window wIdx to 1
          set active tab index of window 1 to tIdx
          set found to true
          exit repeat
        end if
      end try
    end repeat
    if found then exit repeat
  end repeat
  if found is false then
    if (count tabs of window 1) = 0 then
      make new tab at end of tabs of window 1 with properties {URL:"${escAS(url)}"}
    else
      set URL of active tab of window 1 to "${escAS(url)}"
    end if
  end if
  return URL of active tab of window 1
end tell
`;
  const res = await runAppleScript(script, { timeoutMs: 15000 });
  if (!res.ok) {
    throw new Error(`findOrOpenCometTab: ${res.stderr.slice(0, 300) || "no output"}`);
  }
  return {
    _backend: "comet-applescript",
    url: res.stdout,
    urlMatch,
    target: "active tab of window 1",
  };
}

async function navigateComet(url) {
  await activateComet();
  const res = await runAppleScript(
    `tell application id "${escAS(COMET_BUNDLE_ID)}"
  activate
  if (count windows) = 0 then make new window
  set URL of active tab of window 1 to "${escAS(url)}"
  return URL of active tab of window 1
end tell`,
    { timeoutMs: 15000 },
  );
  if (!res.ok) {
    throw new Error(`navigateComet: ${res.stderr.slice(0, 300) || "no output"}`);
  }
  return res.stdout;
}

async function evalInComet(code, { timeoutMs = 30000 } = {}) {
  const wrapped = `(function(){ try { var __r = (function(){ ${code} })(); return JSON.stringify({ok:true, value:__r}); } catch (e) { return JSON.stringify({ok:false, error:String(e), stack:e && e.stack ? String(e.stack) : ""}); } })();`;
  const path = join(
    tmpdir(),
    `apex-comet-js-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
  );
  writeFileSync(path, wrapped, "utf8");
  try {
    const script = `
set js to read POSIX file "${escAS(path)}"
tell application id "${escAS(COMET_BUNDLE_ID)}"
  if (count windows) = 0 then make new window
  tell active tab of window 1
    set r to execute javascript js
  end tell
end tell
return r
`;
    const res = await runAppleScript(script, { timeoutMs });
    if (!res.ok) {
      const hint =
        res.stderr.includes("Allow JavaScript from Apple Events") || res.stderr.includes("-10004")
          ? " - Enable Comet's Apple Events JavaScript permission."
          : "";
      return { ok: false, error: (res.stderr.slice(0, 300) || "no output") + hint };
    }
    try {
      return JSON.parse(res.stdout || "{}");
    } catch {
      return { ok: true, value: res.stdout };
    }
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* best effort */
    }
  }
}

async function waitForPageReady({ timeoutMs = 15000, urlIncludes } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInComet(
      `return { ready: document.readyState, url: location.href, title: document.title };`,
    );
    if (r.ok) {
      const v = r.value ?? {};
      const urlOk = urlIncludes ? String(v.url ?? "").includes(urlIncludes) : true;
      if (v.ready === "complete" && urlOk) {
        return true;
      }
    }
    await sleep(500);
  }
  return false;
}

async function waitComposerReady({ timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInComet(
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
    await sleep(500);
  }
  return { ok: false, reason: "timeout" };
}

async function answerCount() {
  const r = await evalInComet(
    `return document.querySelectorAll(${JSON.stringify(COMET_ANSWER_SELECTORS)}).length;`,
  );
  return Number(r.value ?? 0);
}

async function dispatchEnter() {
  await activateComet();
  return await runAppleScript(
    `tell application "System Events" to tell process "${escAS(COMET_APP_NAME)}" to key code 36`,
    { timeoutMs: 5000 },
  );
}

async function submitPrompt(prompt) {
  const before = await answerCount();
  const insert = await evalInComet(
    `
    var prompt = ${JSON.stringify(prompt)};
    var c = document.querySelector('#ask-input')
         || document.querySelector('div[contenteditable="true"][role="textbox"]')
         || document.querySelector('textarea[placeholder*="Ask" i]')
         || document.querySelector('textarea[placeholder*="question" i]')
         || document.querySelector('textarea')
         || document.querySelector('div[contenteditable="true"]');
    if (!c) return { ok: false, error: "composer not found" };
    c.focus();
    if (c.tagName === 'TEXTAREA' || c.tagName === 'INPUT') {
      var proto = c.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value') &&
                   Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(c, prompt);
      else c.value = prompt;
      c.dispatchEvent(new Event('input', { bubbles: true }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      while (c.firstChild) c.removeChild(c.firstChild);
      if (!(document.execCommand && document.execCommand('insertText', false, prompt))) {
        c.innerText = prompt;
      }
      var evt = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt.slice(-1) || ' ' })
        : new Event('input', { bubbles: true });
      c.dispatchEvent(evt);
    }
    return { ok: true, visibleText: (c.innerText || c.value || "").slice(0, 120) };
  `,
  );
  if (!insert.ok || insert.value?.ok === false) {
    throw new Error(`comet insert: ${insert.error ?? insert.value?.error}`);
  }
  await sleep(500);
  const send = await evalInComet(
    `
    var b = document.querySelector('button[aria-label*="Submit" i]')
         || document.querySelector('button[data-testid*="submit"]')
         || document.querySelector('button[type="submit"]')
         || Array.from(document.querySelectorAll('button')).find(function(el){
           return /send|submit|ask/i.test(el.getAttribute('aria-label') || el.innerText || '');
         });
    if (!b) return { ok: false, error: "no send" };
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return { ok: false, error: "send disabled" };
    b.click();
    return { ok: true };
  `,
  );
  if (!send.ok || send.value?.ok === false) {
    const fallback = await dispatchEnter();
    if (!fallback.ok) {
      throw new Error(
        `comet send: ${send.error ?? send.value?.error}; enter fallback: ${fallback.stderr}`,
      );
    }
  }
  return { before };
}

async function readReply({ minAnswerCount = 0 } = {}) {
  const r = await evalInComet(
    `
    var minCount = ${minAnswerCount};
    var sel = ${JSON.stringify(COMET_ANSWER_SELECTORS)};
    var nodes = Array.from(document.querySelectorAll(sel)).filter(function(node) {
      return (node.innerText || node.textContent || "").trim().length > 0;
    });
    var text = "";
    if (nodes.length > 0) {
      var last = nodes[nodes.length - 1];
      text = (last.innerText || last.textContent || "").trim();
    }
    var stop = document.querySelector('button[aria-label*="Stop" i]') || document.querySelector('button[data-testid*="stop"]');
    var send = document.querySelector('button[aria-label*="Submit" i]') || document.querySelector('button[type="submit"]');
    var countReady = nodes.length > minCount;
    var streaming = !!stop || !countReady || !text || (send && send.disabled && !text);
    return { text: text, streaming: streaming, count: nodes.length };
  `,
  );
  if (!r.ok) {
    throw new Error(`comet poll-eval: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false, count: 0 };
}

async function pollUntilStable({
  read,
  timeoutMs = 300_000,
  stableTicksRequired = 2,
  tickMs = 1500,
  stabilityFallbackTicks = 6,
  minFallbackChars = 200,
  growthThreshold = 80,
} = {}) {
  if (typeof read !== "function") {
    throw new Error("pollUntilStable: read required");
  }
  const t0 = Date.now();
  let lastLen = -1;
  let stableTicks = 0;
  let fallbackTicks = 0;
  let sawStreaming = false;
  let sawGrowth = false;
  while (Date.now() - t0 < timeoutMs) {
    const v = await read();
    const len = v?.text ? String(v.text).length : 0;
    if (v?.streaming) {
      sawStreaming = true;
    }
    if (len >= growthThreshold) {
      sawGrowth = true;
    }
    if (!v?.streaming && len > 0 && len === lastLen) {
      stableTicks += 1;
      if (sawStreaming && stableTicks >= stableTicksRequired) {
        return String(v.text);
      }
      if (!sawStreaming && stableTicks >= stableTicksRequired + 1) {
        return String(v.text);
      }
    } else {
      stableTicks = 0;
    }
    if (len >= minFallbackChars && sawGrowth && len === lastLen) {
      fallbackTicks += 1;
      if (fallbackTicks >= stabilityFallbackTicks) {
        process.stderr.write(
          `[pollUntilStable:comet] fallback exit after ${fallbackTicks} stable ticks (streaming flag: ${v?.streaming ? "stuck-on" : "off"}, len=${len})\n`,
        );
        return String(v.text);
      }
    } else {
      fallbackTicks = 0;
    }
    lastLen = len;
    await sleep(tickMs);
  }
  throw new Error(`pollUntilStable timed out after ${timeoutMs}ms`);
}

export async function askCometChat({ prompt, forceFresh = true } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askCometChat: prompt required");
  }
  void forceFresh;
  await findOrOpenCometTab({ urlMatch: COMET_URL_MATCH, createUrl: COMET_START_URL });
  await navigateComet(COMET_START_URL);
  const ready = await waitForPageReady({ timeoutMs: 20000, urlIncludes: COMET_URL_MATCH });
  if (!ready) {
    throw new Error("Comet Perplexity tab did not finish loading");
  }
  const state = await waitComposerReady();
  if (!state.ok) {
    throw new Error(`comet not ready: ${state.reason} url=${state.url}`);
  }
  const { before } = await submitPrompt(String(prompt));
  const text = await pollUntilStable({
    read: async () => await readReply({ minAnswerCount: before }),
    timeoutMs: 300_000,
  });
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
    `Output format - return ONLY a JSON array, no prose before or after, no markdown fences. Each object:`,
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
    throw new Error(`research-comet-chat no array: ${raw.slice(0, 400)}`);
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

export async function researchBeat(beat, { items = 5 } = {}) {
  const prompt = buildResearchPrompt(beat, items);
  const { text, modelUsed } = await askCometChat({ prompt });
  const parsed = parseArrayResult(text);
  if (!Array.isArray(parsed)) {
    throw new Error("research-comet-chat: not array");
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
    console.error("usage: research-comet-chat.mjs [--json] [--items N] [--ask] <beat-or-prompt>");
    process.exit(2);
  }
  if (askMode) {
    const r = await askCometChat({ prompt: text });
    console.log(
      asJson ? JSON.stringify(r, null, 2) : `# Perplexity Comet - ${r.modelUsed}\n\n${r.text}`,
    );
    return;
  }
  const r = await researchBeat(text, { items });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`# Research (Perplexity via Comet): ${r.beat}`);
  console.log(`# Model: ${r.modelUsed} - ${r.items.length} items\n`);
  for (const it of r.items) {
    console.log(`## ${it.title}`);
    console.log(`${it.source} - ${it.publishedHint}`);
    console.log(it.summary);
    console.log(`-> ${it.url}\n`);
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[research-comet-chat] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
