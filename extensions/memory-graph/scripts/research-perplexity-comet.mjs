#!/usr/bin/env node
// Research + ask worker - Perplexity Comet (ai.perplexity.comet).
//
// Comet is the shared Perplexity Max browser/account route on this Mac.
// It is not Joseph's personal Chrome Perplexity profile. This driver keeps
// the browser open, uses DOM automation before coordinates/OCR, and emits
// split prompt-delivery / answer-attribution proofs so the Kernel can decide
// whether Comet is currently load-bearing.

import { execFile, spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createWorkstationLease, restoreWorkstation } from "./chuck-surface-control.mjs";

const execFileP = promisify(execFile);

const APP_BUNDLE_ID = "ai.perplexity.comet";
const PPLX_START_URL = "https://www.perplexity.ai/";
const SURFACE = "perplexity/comet";
const MODEL_LABEL = "perplexity/comet-shared-max";
const AUTH_PROFILE_SHARED_MAX_VISIBLE = "perplexity-shared-max-comet-visible";
const AUTH_PROFILE_SHARED_MAX_UNVERIFIED = "perplexity-shared-max-comet-unverified";

const ANSWER_SELECTORS = [
  '[id^="answer-"]',
  '[data-testid*="answer"]',
  'main [class*="prose" i]',
  'main [class*="markdown" i]',
  "main article",
].join(", ");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function osa(script, { timeoutMs = 15_000 } = {}) {
  const { stdout } = await execFileP("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function runCommand(command, args, { input = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
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
    if (input !== null) {
      child.stdin.end(String(input));
    }
  });
}

async function pbpaste() {
  return await runCommand("pbpaste", [], { timeoutMs: 5_000 });
}

async function pbcopy(text) {
  await runCommand("pbcopy", [], { input: String(text), timeoutMs: 5_000 });
}

async function osaFile(lines, { timeoutMs = 15_000 } = {}) {
  const args = [];
  for (const line of lines) {
    args.push("-e", line);
  }
  const { stdout } = await execFileP("osascript", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

async function evalInComet(js, { timeoutMs = 20_000 } = {}) {
  const path = join(tmpdir(), `chuck-comet-js-${process.pid}-${Date.now()}.js`);
  writeFileSync(path, String(js), "utf8");
  try {
    const raw = await osaFile(
      [
        `set js to read POSIX file ${JSON.stringify(path)}`,
        `tell application id ${JSON.stringify(APP_BUNDLE_ID)}`,
        "  if (count of windows) = 0 then make new window",
        "  tell active tab of front window to execute javascript js",
        "end tell",
      ],
      { timeoutMs },
    );
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* best effort */
    }
  }
}

async function activateComet() {
  await execFileP("open", ["-b", APP_BUNDLE_ID], {
    encoding: "utf8",
    timeout: 12_000,
    killSignal: "SIGTERM",
  }).catch(async () => {
    await osa(`tell application id ${JSON.stringify(APP_BUNDLE_ID)} to reopen`).catch(() => {});
  });
  await osa(`tell application id ${JSON.stringify(APP_BUNDLE_ID)} to activate`).catch(() => {});
  await sleep(600);
}

async function ensureCometTab() {
  await activateComet();
  await osaFile([
    `tell application id ${JSON.stringify(APP_BUNDLE_ID)}`,
    "  if (count of windows) = 0 then make new window",
    "  tell front window",
    "    set foundRootTab to false",
    "    repeat with i from 1 to (count of tabs)",
    "      set tabUrl to URL of tab i as text",
    `      if tabUrl is ${JSON.stringify(PPLX_START_URL)} or tabUrl starts with ${JSON.stringify(`${PPLX_START_URL}?`)} then`,
    "        set active tab index to i",
    "        set foundRootTab to true",
    "        exit repeat",
    "      end if",
    "    end repeat",
    "    if foundRootTab is false then",
    `      make new tab at end of tabs with properties {URL:${JSON.stringify(PPLX_START_URL)}}`,
    "      set active tab index to (count of tabs)",
    "    end if",
    `    set URL of active tab to ${JSON.stringify(PPLX_START_URL)}`,
    "  end tell",
    "end tell",
  ]);
  await sleep(800);
}

async function pageSnapshot() {
  return await evalInComet(
    `
    JSON.stringify({
      ready: document.readyState,
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText || "").slice(0, 5000),
      hasComposer: !!(document.querySelector('#ask-input')
        || document.querySelector('div[contenteditable="true"][role="textbox"]')
        || document.querySelector('textarea[placeholder*="Ask" i]')
        || document.querySelector('textarea[placeholder*="question" i]')
        || document.querySelector('textarea')
        || document.querySelector('div[contenteditable="true"]'))
    })
  `,
  );
}

async function waitPageReady({ timeoutMs = 20_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const snapshot = await pageSnapshot();
    if (
      snapshot?.ready === "complete" &&
      String(snapshot.url ?? "").includes("perplexity.ai") &&
      snapshot.hasComposer
    ) {
      return snapshot;
    }
    await sleep(500);
  }
  throw new Error("Comet Perplexity tab did not reach a ready composer state");
}

function detectAuthProfileFromText(text) {
  const haystack = String(text ?? "");
  if (/\b(therivende85730|Perplexity Max|Subscribed|max)\b/i.test(haystack)) {
    return AUTH_PROFILE_SHARED_MAX_VISIBLE;
  }
  return AUTH_PROFILE_SHARED_MAX_UNVERIFIED;
}

async function ensureIncognitoIntent() {
  const before = await pageSnapshot();
  if (/\bExpires in\b/i.test(String(before?.text ?? ""))) {
    return { status: "already-visible", proof: "expires-banner-visible" };
  }
  const result = await evalInComet(
    `
    (function() {
    var buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    var target = buttons.find(function(el) {
      var label = [
        el.getAttribute('aria-label') || '',
        el.innerText || '',
        el.textContent || ''
      ].join(' ');
      return /use incognito|incognito mode/i.test(label);
    });
    if (!target) return JSON.stringify({ clicked: false, reason: 'incognito-control-not-found' });
    target.click();
    return JSON.stringify({ clicked: true, label: (target.getAttribute('aria-label') || target.innerText || target.textContent || '').trim().slice(0, 180) });
    })()
  `,
  );
  await sleep(800);
  const after = await pageSnapshot();
  return {
    status: result?.clicked ? "clicked" : "not-found",
    proof: result?.label ?? result?.reason ?? "",
    expiresVisible: /\bExpires in\b/i.test(String(after?.text ?? "")),
  };
}

async function answerCount() {
  const result = await evalInComet(
    `
    var nodes = Array.from(document.querySelectorAll(${JSON.stringify(ANSWER_SELECTORS)}));
    var visible = nodes.filter(function(node) {
      var text = (node.innerText || node.textContent || '').trim();
      return text.length > 0;
    });
    JSON.stringify({ count: visible.length });
  `,
  );
  return Number(result?.count ?? 0);
}

async function submitPrompt(prompt) {
  const before = await answerCount();
  const focus = await evalInComet(
    `
    (function() {
    var c = document.querySelector('#ask-input')
         || document.querySelector('div[contenteditable="true"][role="textbox"]')
         || document.querySelector('textarea[placeholder*="Ask" i]')
         || document.querySelector('textarea[placeholder*="question" i]')
         || document.querySelector('textarea')
         || document.querySelector('div[contenteditable="true"]');
    if (!c) return JSON.stringify({ ok: false, error: "composer not found" });
    var rect = c.getBoundingClientRect();
    c.focus();
    c.click();
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    c.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return JSON.stringify({ ok: true, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
    })()
  `,
  );
  if (!focus?.ok) {
    throw new Error(`comet focus failed: ${focus?.error ?? "unknown"}`);
  }
  const savedClipboard = await pbpaste().catch(() => "");
  try {
    await pbcopy(prompt);
    await osa('tell application "System Events" to keystroke "a" using {command down}', {
      timeoutMs: 5_000,
    });
    await osa('tell application "System Events" to keystroke "v" using {command down}', {
      timeoutMs: 5_000,
    });
    await sleep(Math.min(800 + Math.floor(String(prompt).length / 25), 5000));
    const send = await evalInComet(
      `
    (function() {
    var buttons = Array.from(document.querySelectorAll('button'));
    var b = document.querySelector('button[aria-label*="Submit" i]')
         || document.querySelector('button[data-testid*="submit"]')
         || document.querySelector('button[type="submit"]')
         || buttons.find(function(el) {
           var label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
           return /send|submit|ask/i.test(label);
         });
    if (!b) return JSON.stringify({ ok: false, error: "no send" });
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return JSON.stringify({ ok: false, error: "send disabled" });
    b.click();
    return JSON.stringify({ ok: true });
    })()
  `,
    );
    if (!send?.ok) {
      await osa('tell application "System Events" to key code 36', { timeoutMs: 5_000 });
    }
  } finally {
    await pbcopy(savedClipboard).catch(() => {});
  }
  return { before };
}

async function readReply({ minAnswerCount = 0 } = {}) {
  const result = await evalInComet(
    `
    var minCount = ${minAnswerCount};
    function clean(raw) {
      var lines = String(raw || '').split('\\n').map(function(line) { return line.trim(); }).filter(Boolean);
      var drop = [
        /^copy$/i, /^share$/i, /^like$/i, /^dislike$/i, /^sources?$/i,
        /^related$/i, /^rewrite$/i, /^search$/i, /^computer$/i, /^model$/i
      ];
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        if (drop.some(function(rx) { return rx.test(lines[i]); })) {
          if (out.length > 0) break;
          continue;
        }
        out.push(lines[i]);
      }
      return out.join('\\n').trim();
    }
    var nodes = Array.from(document.querySelectorAll(${JSON.stringify(ANSWER_SELECTORS)}))
      .filter(function(node) { return (node.innerText || node.textContent || '').trim().length > 0; });
    var text = '';
    if (nodes.length > 0) {
      text = clean(nodes[nodes.length - 1].innerText || nodes[nodes.length - 1].textContent || '');
    }
    var stop = document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop"]');
    var send = document.querySelector('button[aria-label*="Submit" i], button[type="submit"]');
    var proofTokenPresent = /\\bSURFACE_PROOF_OK\\b/.test(text);
    var countReady = nodes.length > minCount || (proofTokenPresent && nodes.length >= minCount);
    JSON.stringify({
      text: text,
      count: nodes.length,
      countReady: countReady,
      streaming: !!stop || !countReady || !text || (send && send.disabled && !text)
    });
  `,
  );
  return result ?? { text: "", count: 0, countReady: false, streaming: true };
}

async function pollReply({ prompt, minAnswerCount, timeoutMs = 300_000, tickMs = 2500 }) {
  const surfaceProofRequested = /\bSURFACE_PROOF_OK\b/.test(String(prompt));
  const t0 = Date.now();
  let lastText = "";
  let stableTicks = 0;
  while (Date.now() - t0 < timeoutMs) {
    const state = await readReply({ minAnswerCount });
    const text = String(state.text ?? "").trim();
    process.stderr.write(
      `[perplexity-comet] tick: count=${state.count} ready=${state.countReady} len=${text.length} streaming=${state.streaming}\n`,
    );
    if (surfaceProofRequested && text && !/\bSURFACE_PROOF_OK\b/.test(text)) {
      stableTicks = 0;
      lastText = text;
      await sleep(tickMs);
      continue;
    }
    const proofToken = /\b(?:SURFACE_PROOF_OK|APEXOK[A-Z0-9]+)\b/.test(text);
    if (!state.streaming && text && text === lastText && (text.length >= 60 || proofToken)) {
      stableTicks += 1;
      if (stableTicks >= 2) {
        return { text, count: state.count };
      }
    } else {
      stableTicks = 0;
      lastText = text;
    }
    await sleep(tickMs);
  }
  throw new Error("Comet Perplexity reply timed out before stable answer attribution");
}

function nowIso() {
  return new Date().toISOString();
}

function proof(verdict, method, evidence, caveats = []) {
  return {
    verdict,
    method,
    evidence,
    caveats,
    checkedAt: nowIso(),
  };
}

function transportProofs({
  authProfileId,
  snapshot,
  incognito,
  promptDelivered,
  answerAttributed,
  extractionMethod,
  workstation,
  workstationReturned,
  workstationReturnResult,
}) {
  const checkedAt = nowIso();
  return [
    {
      surface: SURFACE,
      criterion: "open-target",
      verdict: String(snapshot?.url ?? "").includes("perplexity.ai") ? "proved" : "failed",
      method: "comet-bundle-tab-js",
      evidence: `bundle=${APP_BUNDLE_ID}; url=${snapshot?.url ?? "unknown"}; authProfileId=${authProfileId}; lease=${workstation?.leaseId ?? "unknown"}`,
      checkedAt,
      caveats: [
        "Comet is a shared Perplexity Max child surface; it never adds an independent family vote beyond Perplexity.",
      ],
    },
    {
      surface: SURFACE,
      criterion: "mode-switch",
      verdict: incognito?.expiresVisible || incognito?.status === "clicked" ? "proved" : "missing",
      method: "comet-dom-incognito-control",
      evidence: `status=${incognito?.status ?? "unknown"}; proof=${incognito?.proof ?? ""}; expiresVisible=${Boolean(incognito?.expiresVisible)}`,
      checkedAt,
      caveats: ["Incognito is an account-history control, not answer attribution proof."],
    },
    {
      surface: SURFACE,
      criterion: "prompt-delivery",
      verdict: promptDelivered ? "proved" : "failed",
      method: "comet-dom-composer-submit",
      evidence: promptDelivered
        ? "composer accepted prompt and submit path fired"
        : "submit path did not prove delivery",
      checkedAt,
      caveats: [],
    },
    {
      surface: SURFACE,
      criterion: "answer-attribution",
      verdict: answerAttributed ? "proved" : "failed",
      method: "comet-dom-latest-answer-after-submit",
      evidence: answerAttributed
        ? "latest answer node/proof token attributed after submit"
        : "no new attributed answer node",
      checkedAt,
      caveats: [],
    },
    {
      surface: SURFACE,
      criterion: "result-extraction",
      verdict: extractionMethod === "driver-json" ? "proved" : "missing",
      method: "comet-execute-javascript-json",
      evidence: `extractionMethod=${extractionMethod}`,
      checkedAt,
      caveats: [],
    },
    {
      surface: SURFACE,
      criterion: "workstation-return",
      verdict: workstationReturned ? "proved" : "failed",
      method: "chuck-workstation-lease",
      evidence: `returnTarget=${workstationReturnEvidence({
        workstation,
        workstationReturnResult,
      })}`,
      checkedAt,
      caveats: workstationReturned
        ? []
        : ["restoreWorkstation did not complete before receipt emission"],
    },
  ];
}

function workstationReturnEvidence({ workstation, workstationReturnResult }) {
  if (workstationReturnResult) {
    return JSON.stringify({
      ok: Boolean(workstationReturnResult.ok),
      app: workstationReturnResult.app ?? null,
      restored: workstationReturnResult.restored ?? null,
      verification: workstationReturnResult.verification ?? null,
    });
  }
  return workstation?.workstation?.app ?? workstation?.workstation?.bundleId ?? "unknown";
}

export async function askPerplexityComet({
  prompt,
  timeoutMs = Number(process.env.CHUCK_PERPLEXITY_COMET_TIMEOUT_MS ?? 300_000),
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askPerplexityComet: prompt required");
  }
  const workstation = await createWorkstationLease({ reason: SURFACE });
  let workstationReturned = false;
  let workstationReturnResult = null;
  let snapshot = null;
  let authProfileId = AUTH_PROFILE_SHARED_MAX_UNVERIFIED;
  let incognito = null;
  let promptDelivered = false;
  let answerAttributed = false;
  let extractionMethod = "unknown";
  try {
    await ensureCometTab();
    snapshot = await waitPageReady();
    authProfileId = detectAuthProfileFromText(snapshot.text);
    incognito = await ensureIncognitoIntent();
    const { before } = await submitPrompt(String(prompt));
    promptDelivered = true;
    const answer = await pollReply({
      prompt,
      minAnswerCount: before,
      timeoutMs,
    });
    answerAttributed =
      (answer.count > before || /\bSURFACE_PROOF_OK\b/.test(String(answer.text))) &&
      Boolean(answer.text);
    extractionMethod = "driver-json";
    try {
      workstationReturnResult = await restoreWorkstation(workstation);
      workstationReturned = Boolean(workstationReturnResult?.ok);
    } catch (error) {
      process.stderr.write(
        `[perplexity-comet] workstation return failed before receipt: ${error?.message ?? error}\n`,
      );
    }
    return {
      text: answer.text,
      modelUsed: MODEL_LABEL,
      authProfileId,
      promptDeliveryProof: proof(
        promptDelivered ? "proved" : "failed",
        "comet-dom-composer-submit",
        "prompt inserted into Comet composer and submit path fired",
      ),
      answerAttributionProof: proof(
        answerAttributed ? "proved" : "failed",
        "comet-dom-latest-answer-after-submit",
        `answerCount advanced from ${before} to ${answer.count}; proofToken=${/\bSURFACE_PROOF_OK\b/.test(String(answer.text))}`,
      ),
      extractionMethod,
      transportProofs: transportProofs({
        authProfileId,
        snapshot,
        incognito,
        promptDelivered,
        answerAttributed,
        extractionMethod,
        workstation,
        workstationReturned,
        workstationReturnResult,
      }),
    };
  } finally {
    if (!workstationReturned) {
      await restoreWorkstation(workstation).catch(() => {});
    }
  }
}

async function mainCli() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const promptIdx = argv.indexOf("--prompt");
  const positional = argv.filter(
    (arg, index) =>
      !arg.startsWith("--") && argv[index - 1] !== "--prompt" && argv[index - 1] !== "--timeout-ms",
  );
  const timeoutIdx = argv.indexOf("--timeout-ms");
  const timeoutMs =
    timeoutIdx >= 0 ? Number.parseInt(argv[timeoutIdx + 1] ?? "300000", 10) : undefined;
  const prompt =
    promptIdx >= 0 ? String(argv[promptIdx + 1] ?? "").trim() : positional.join(" ").trim();
  if (!prompt) {
    console.error(
      "usage: research-perplexity-comet.mjs [--ask] [--json] [--timeout-ms N] [--prompt TEXT] <prompt>",
    );
    process.exit(2);
  }
  const result = await askPerplexityComet({ prompt, timeoutMs });
  console.log(
    asJson
      ? JSON.stringify(result, null, 2)
      : `# Perplexity Comet - ${result.modelUsed}\n\n${result.text}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((error) => {
    process.stderr.write(
      `[research-perplexity-comet] fatal: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
