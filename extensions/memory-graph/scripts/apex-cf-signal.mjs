#!/usr/bin/env node
// Apex CF Signal — reactive Cloudflare / bot-detection alarm emitter.
//
// Chrome workers call `emitCfSignal({ domain, tabUrl, reason })` the
// moment they detect a turnstile / 403 / challenge redirect. The
// signal writes to `~/.openclaw/workspace/state/apex-cf-signals.jsonl`
// and posts to the apex-event-bus so watchers (fingerprint-audit,
// fleet-coordinator) can react in real-time:
//   - rotate to next profile in multi-profile fleet
//   - re-run fingerprint-audit to check new detection vectors
//   - surface to Telegram if rate-exceeds a threshold
//
// Workers use a tiny helper: `await checkAndSignal(tab, domain)` —
// evaluates the page for turnstile + signals if found.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR = join(homedir(), ".openclaw", "workspace", "state");
const SIGNAL_LOG = join(STATE_DIR, "apex-cf-signals.jsonl");

// Lazily import event bus; it's optional — worker still reports even
// if the bus isn't wired.
let emitFn = null;
async function getEmit() {
  if (emitFn !== null) {
    return emitFn;
  }
  try {
    const mod = await import("./apex-event-bus.mjs");
    emitFn = mod.emit ?? null;
  } catch {
    emitFn = null;
  }
  return emitFn;
}

function ensureDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  const d = dirname(SIGNAL_LOG);
  if (!existsSync(d)) {
    mkdirSync(d, { recursive: true });
  }
}

export async function emitCfSignal({ domain, tabUrl, reason, profileId, extra } = {}) {
  ensureDir();
  const entry = {
    ts: new Date().toISOString(),
    domain,
    tabUrl,
    reason,
    profileId,
    extra: extra ?? null,
  };
  try {
    appendFileSync(SIGNAL_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    /* best-effort */
  }
  const emit = await getEmit();
  if (emit) {
    try {
      await emit({
        source: "apex-cf-signal",
        type: "detection",
        payload: entry,
      });
    } catch {
      /* ignore */
    }
  }
  return entry;
}

// Worker-side helper: check a tab for turnstile / challenge / login
// redirect. If found, emit a signal and return true.
export async function checkAndSignal(tab, domain, { evalInTab, profileId } = {}) {
  if (!evalInTab || !tab) {
    throw new Error("checkAndSignal: tab + evalInTab required");
  }
  const res = await evalInTab(
    tab,
    `
    var turnstile = document.title.includes("Just a moment") || !!document.querySelector("[data-testid=\\"cf-turnstile\\"]") || document.title.includes("Attention Required");
    var challenge = location.pathname.includes("challenge") || location.pathname.includes("captcha");
    var forbidden = document.body && document.body.innerText && /forbidden|access denied|blocked/i.test(document.body.innerText);
    return { turnstile: turnstile, challenge: challenge, forbidden: forbidden, url: location.href, title: document.title };
  `,
  );
  const v = res.ok ? res.value : null;
  if (!v) {
    return false;
  }
  const reason = v.turnstile
    ? "cf-turnstile"
    : v.challenge
      ? "cf-challenge-path"
      : v.forbidden
        ? "forbidden-page"
        : null;
  if (!reason) {
    return false;
  }
  await emitCfSignal({
    domain,
    tabUrl: v.url,
    reason,
    profileId,
    extra: { title: v.title },
  });
  return true;
}
