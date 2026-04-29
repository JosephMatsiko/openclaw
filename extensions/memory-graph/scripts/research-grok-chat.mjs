#!/usr/bin/env node
// Research + ask worker — Grok via grok.com (free tier).
//
// Drives through apex-chrome-driver. Uses Joseph's existing X/Grok
// cookies — no subscription required; rate-limited to the free tier's
// implicit daily cap.
//
// Exports: researchBeat, askGrokChat

import { spawn } from "node:child_process";
import {
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

async function dismissCookieConsent(tab) {
  const r = await evalInTab(
    tab,
    `
    var labels = [/reject all/i, /confirm my choices/i, /save choices/i, /accept necessary/i];
    var elements = Array.from(document.querySelectorAll('button,a,[role="button"]'));
    var target = elements.find(function(el) {
      var text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
      return labels.some(function(rx) { return rx.test(text); });
    });
    if (!target) return { clicked: false };
    target.click();
    return { clicked: true, label: (target.innerText || target.textContent || target.getAttribute('aria-label') || '').trim() };
  `,
  );
  if (r.ok && r.value?.clicked) {
    await new Promise((res) => setTimeout(res, 800));
  }
  return r.value ?? { clicked: false };
}

function runCommandWithStdin(command, args, input, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve();
    });
    child.stdin.end(input);
  });
}

function runCommand(command, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function pbpaste() {
  return await runCommand("pbpaste", [], { timeoutMs: 5000 });
}

async function pbcopy(text) {
  await runCommandWithStdin("pbcopy", [], String(text), { timeoutMs: 5000 });
}

async function osascript(script, { timeoutMs = 5000 } = {}) {
  await runCommand("/usr/bin/osascript", ["-e", script], { timeoutMs });
}

async function realKeyboardSubmit(tab, prompt) {
  const savedClipboard = await pbpaste().catch(() => "");
  try {
    await evalInTab(
      tab,
      `
      var c = document.querySelector('textarea[placeholder*="Ask Grok" i]')
           || document.querySelector('textarea[placeholder*="message" i]')
           || document.querySelector('textarea')
           || document.querySelector('div[contenteditable="true"]');
      if (c) {
        c.focus();
        if (c.select) c.select();
      }
      return { focused: !!c };
    `,
    );
    await pbcopy(prompt);
    await osascript('tell application "System Events" to keystroke "a" using {command down}');
    await osascript('tell application "System Events" to keystroke "v" using {command down}');
    await new Promise((res) => setTimeout(res, 700));
    await osascript('tell application "System Events" to key code 36');
  } finally {
    await pbcopy(savedClipboard).catch(() => {});
  }
}

// Live-DOM verified 2026-04-28: Grok uses `.response-content-markdown`
// for BOTH user AND assistant message content. The differentiator is
// the alignment wrapper (4 ancestors up): `items-start` = assistant,
// `items-end` = user. No data-message-author-role attribute exists.
// Earlier selector list (data-message-author-role, article, etc.)
// returned 0 matches — Grok's DOM doesn't use those patterns.
async function assistantCount(tab) {
  const r = await evalInTab(
    tab,
    `
    var nodes = document.querySelectorAll('.response-content-markdown');
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var p = nodes[i];
      for (var j = 0; j < 6 && p; j++) {
        var cls = (p.className && p.className.toString) ? p.className.toString() : '';
        if (cls.indexOf('items-start') >= 0) { count++; break; }
        if (cls.indexOf('items-end') >= 0) break;
        p = p.parentElement;
      }
    }
    return count;
  `,
  );
  return Number(r.value ?? 0);
}

async function submitPrompt(tab, prompt) {
  await dismissCookieConsent(tab);
  const before = await assistantCount(tab);
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
      c.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
      c.dispatchEvent(new Event('input', { bubbles: true }));
      c.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt.slice(-1) || " ")} }));
      // Grok's React guard on Submit requires a keyup event; 'input'
      // alone leaves the button stuck in disabled state even though the
      // controlled-value path registered. Proven empirically 2026-04-23.
      c.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
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
  // Scale settle with prompt length; 36KB briefs take >2s for Grok's
  // React-reconciliation cycle to mark Submit enabled.
  const settleMs = Math.min(500 + Math.floor(prompt.length / 20), 5000);
  await new Promise((r) => setTimeout(r, settleMs));
  let clicked = false;
  for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      await dismissCookieConsent(tab);
    }
    const send = await evalInTab(
      tab,
      `
      var b = document.querySelector('button[aria-label="Submit"][type="submit"]')
           || document.querySelector('button[type="submit"]')
           || document.querySelector('button[aria-label*="send" i]')
           || document.querySelector('button[aria-label*="submit" i]');
      if (!b) return { ok: false, error: "no send" };
      if (b.disabled) return { ok: false, error: "send disabled" };
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
    await realKeyboardSubmit(tab, prompt);
  }
  return { before };
}

async function readReply(tab, { prompt: _prompt = "", minAssistantCount = 0 } = {}) {
  const r = await evalInTab(
    tab,
    `
    var minCount = ${minAssistantCount};
    function clean(raw) {
      var lines = String(raw || "").split("\\n").map(function(line) { return line.trim(); }).filter(Boolean);
      var out = [];
      var drop = [
        /^\\d+(?:\\.\\d+)?\\s*(?:ms|s)$/i,
        /^edit$/i,
        /^copy$/i,
        /^like$/i,
        /^dislike$/i,
        /^share$/i,
        /^try supergrok/i,
        /^upgrade to supergrok/i,
        /^you.ve reached your full speed limit/i
      ];
      for (var line of lines) {
        var isChrome = drop.some(function(rx) { return rx.test(line); });
        if (isChrome && out.length === 0) continue;
        if (isChrome && out.length > 0) break;
        out.push(line);
      }
      return out.join("\\n").trim();
    }
    // Find assistant turns: .response-content-markdown elements whose
    // alignment ancestor (within 6 levels up) has 'items-start' class.
    var allNodes = document.querySelectorAll('.response-content-markdown');
    var assistantNodes = [];
    for (var i = 0; i < allNodes.length; i++) {
      var p = allNodes[i];
      var role = '';
      for (var j = 0; j < 6 && p; j++) {
        var cls = (p.className && p.className.toString) ? p.className.toString() : '';
        if (cls.indexOf('items-start') >= 0) { role = 'assistant'; break; }
        if (cls.indexOf('items-end') >= 0) { role = 'user'; break; }
        p = p.parentElement;
      }
      if (role === 'assistant') assistantNodes.push(allNodes[i]);
    }
    var text = "";
    if (assistantNodes.length > 0) {
      var last = assistantNodes[assistantNodes.length - 1];
      text = clean(last.innerText || last.textContent || "");
    }
    var stop = document.querySelector('button[aria-label*="Stop" i]') || document.querySelector('button[data-testid*="stop"]');
    var send = document.querySelector('button[aria-label="Submit"][type="submit"]') || document.querySelector('button[type="submit"]');
    var countReady = assistantNodes.length > minCount;
    var streaming = !!stop || !countReady || !text || (send && send.disabled && !text);
    return { text: text.trim(), streaming: streaming };
  `,
  );
  if (!r.ok) {
    throw new Error(`grok poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askGrokChat({ prompt, forceFresh = true } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askGrokChat: prompt required");
  }
  const tab = await findOrOpenTab({ urlMatch: GROK_URL_MATCH, createUrl: GROK_START_URL });
  if (forceFresh && !tab.created) {
    await evalInTab(tab, `location.href = ${JSON.stringify(GROK_START_URL)};`);
    await new Promise((r) => setTimeout(r, 800));
  }
  if (tab.created || forceFresh) {
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
  const { before } = await submitPrompt(tab, String(prompt));
  const text = await pollUntilStable({
    tab,
    read: async (activeTab) =>
      await readReply(activeTab, { prompt: String(prompt), minAssistantCount: before }),
    timeoutMs: 300_000,
  });
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
