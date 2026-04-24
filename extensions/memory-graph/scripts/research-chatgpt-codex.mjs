#!/usr/bin/env node
// Ask worker — ChatGPT Codex (chatgpt.com/codex) for CODE-LANE tasks.
//
// Sovereignty gate: Codex executes in OpenAI's cloud. Prompts that
// reference local file paths, secret-shaped material, or ring-classified
// private content are REJECTED before dispatch. The gate is conservative
// by design — a false reject is recoverable; a false accept is leakage.
//
// Usage: route code-specific intents (review, refactor, debug, write)
// to this worker in parallel with Claude Code (local, full fidelity) +
// Gemini CLI — 3-way code review. Never for ask/research/magazine.

import {
  dispatchKey,
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const CODEX_URL_MATCH = "chatgpt.com/codex";
const CODEX_START_URL = "https://chatgpt.com/codex";
const MODEL_LABEL = "chatgpt-codex/web-chat";

// ---- Sovereignty gate -------------------------------------------------

// Reject patterns that strongly imply local / private material. Gate
// is conservative; caller gets a structured reason to surface.
const BANNED_PATH_PATTERNS = [
  /~\/Projects\//,
  /\/Users\/josephmatsiko\//i,
  /\.openclaw\//,
  /steward/i, // Joseph's personal-finance project
  /auth-profiles\.json/,
  /\.env\b/,
];

const BANNED_SECRET_PATTERNS = [
  /sk-[a-z0-9]{16,}/i,
  /AIza[A-Za-z0-9_-]{20,}/, // Google API keys
  /ya29\.[A-Za-z0-9_-]+/, // Google OAuth tokens
  /ghp_[A-Za-z0-9]{30,}/, // GitHub PATs
  /\bbearer\s+[a-z0-9._-]{20,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bplaid[_-]?(?:secret|client)/i,
];

export function sovereigntyGateCheck(prompt) {
  const reasons = [];
  for (const re of BANNED_PATH_PATTERNS) {
    if (re.test(prompt)) {
      reasons.push({ kind: "local-path", pattern: String(re) });
    }
  }
  for (const re of BANNED_SECRET_PATTERNS) {
    if (re.test(prompt)) {
      reasons.push({ kind: "secret", pattern: String(re) });
    }
  }
  // Heuristic: prompts over 20KB that contain filesystem-shaped strings
  // should be surfaced for explicit review rather than auto-dispatched.
  if (prompt.length > 20000 && /\/[a-z0-9_.-]+\/[a-z0-9_.-]+/i.test(prompt)) {
    reasons.push({ kind: "large-with-paths" });
  }
  return { ok: reasons.length === 0, reasons };
}

// ---- UI drive ---------------------------------------------------------

async function waitComposerReady(tab, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var c = document.querySelector("#prompt-textarea") || document.querySelector("div[contenteditable=\\"true\\"]") || document.querySelector("textarea");
      var loginBtn = document.querySelector("a[href*=\\"/auth/login\\"]");
      return { composer: !!c, loginBtn: !!loginBtn, title: document.title, url: location.href };
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

async function submitPrompt(tab, prompt) {
  const insert = await evalInTab(
    tab,
    `
    var c = document.querySelector("#prompt-textarea") || document.querySelector("div[contenteditable=\\"true\\"]") || document.querySelector("textarea");
    if (!c) return { ok: false, error: "no composer" };
    c.focus();
    if (c.tagName === 'TEXTAREA') {
      c.value = ${JSON.stringify(prompt)};
      c.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      while (c.firstChild) c.removeChild(c.firstChild);
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
    }
    return { ok: true };
  `,
  );
  if (!insert.ok || insert.value?.ok === false) {
    throw new Error(`codex insert: ${insert.error ?? insert.value?.error}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  const send = await evalInTab(
    tab,
    `
    var b = document.querySelector("button[data-testid=\\"send-button\\"]") || document.querySelector("button[aria-label*=\\"Send\\" i]") || document.querySelector("button[aria-label*=\\"Run\\" i]");
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
      throw new Error(`codex send: ${send.value?.error}`, { cause: e });
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
    var text = (md && (md.innerText || md.textContent)) || (last && (last.textContent || "")) || "";
    var stop = document.querySelector("button[data-testid=\\"stop-button\\"]") || document.querySelector("button[aria-label*=\\"Stop\\" i]");
    return { text: text.trim(), streaming: !!stop };
  `,
  );
  if (!r.ok) {
    throw new Error(`codex poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askCodex({ prompt, allowSensitive = false } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askCodex: prompt required");
  }
  if (!allowSensitive) {
    const gate = sovereigntyGateCheck(String(prompt));
    if (!gate.ok) {
      const err = new Error(
        `codex rejected by sovereignty gate: ${gate.reasons.map((r) => r.kind).join(", ")}`,
      );
      err.gate = gate;
      throw err;
    }
  }
  const tab = await findOrOpenTab({ urlMatch: CODEX_URL_MATCH, createUrl: CODEX_START_URL });
  if (!tab.created) {
    // Force-navigate to the codex canonical URL. Reused chatgpt.com tabs
    // parked on /c/<id> or /g/<id> would otherwise append turns into a
    // prior conversation and confuse the codex lane's model / system prompt.
    await evalInTab(tab, `location.href = ${JSON.stringify(CODEX_START_URL)};`);
    await new Promise((r) => setTimeout(r, 800));
  }
  const ready = await waitForPageReady(tab, { timeoutMs: 15000, urlIncludes: "chatgpt.com" });
  if (!ready) {
    throw new Error("codex did not load");
  }
  const state = await waitComposerReady(tab);
  if (!state.ok) {
    if (state.reason === "turnstile" || state.reason === "cf-challenge-path") {
      void import("./apex-cf-signal.mjs")
        .then((m) =>
          m.emitCfSignal({ domain: "chatgpt.com", reason: state.reason, tabUrl: state.url }),
        )
        .catch(() => {});
    }
    throw new Error(`codex not ready: ${state.reason}`);
  }
  await submitPrompt(tab, String(prompt));
  // 300s — align with the rest of the Chrome worker fleet; codex
  // reasoning streams can run longer than Instant chat.
  const text = await pollUntilStable({ tab, read: readReply, timeoutMs: 300_000 });
  return { text: text.trim(), modelUsed: MODEL_LABEL };
}

async function mainCli() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const allowSensitive = argv.includes("--allow-sensitive");
  const text = argv
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!text) {
    console.error("usage: research-chatgpt-codex.mjs [--json] [--allow-sensitive] <code-task>");
    process.exit(2);
  }
  const r = await askCodex({ prompt: text, allowSensitive });
  console.log(asJson ? JSON.stringify(r, null, 2) : `# Codex — ${r.modelUsed}\n\n${r.text}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[research-chatgpt-codex] fatal: ${e.stack ?? e.message ?? e}`);
    process.exitCode = 1;
  });
}
