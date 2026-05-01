#!/usr/bin/env node
// chuck-comms-cascade — runtime enforcer for comms-policy v1.
//
// The policy doc declares cascade orders ("PWA → Telegram → apex-apple-bridge
// → iMessage"); this script makes the cascade real. Single entry point
// `notify(payload)`: resolve tier → cascade order → channel filter (enabled in
// openclaw.json) → walk attempters in order → first ok stops, all-fail still
// records to digest. Every cascade run lands in the notification ledger and
// emits bus events.
//
// Channels:
//   apex-apple-bridge → osascript display notification (severity-aware sound)
//   telegram          → curl Bot API sendMessage
//   imessage          → osascript Messages send (matches tonight's working path)
//   voice             → /usr/bin/say -v Samantha (kicked off async)
//   digest            → write JSON record to today's morning-digest pending queue
//
// Quiet hours = 23:00–08:00 America/Chicago: skip apex-apple-bridge + voice
// unless severity=critical; telegram + imessage stay (silent on Joseph's
// device is his OS choice); digest always included.
//
// Anti-spam: identical (subject + body + severity) hash within 30s is squelched
// (in-memory cache during the same process; ledger consult on cold start).
//
// CLI:
//   chuck-comms-cascade notify "<subject>" [--body=...] [--severity=...] [--tier=...] [--dry-run] [--no-apple-bridge]
//   chuck-comms-cascade status
//   chuck-comms-cascade replay <ledgerEntryId>

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatLongUpdate } from "./chuck-format-update.mjs";
import {
  rankChannels as rankReachChannels,
  recordFailure as recordReachFailure,
  recordSuccess as recordReachSuccess,
} from "./chuck-reach-ledger.mjs";
import { send as sendViaSmsBridge } from "./chuck-sms-bridge.mjs";
import { listSubscriptions as listWebPushSubscriptions, sendWebPush } from "./chuck-web-push.mjs";

const HOME = homedir();
const WORKSPACE_STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(WORKSPACE_STATE, "chuck-v3");
const POLICY_PATH = join(CHUCK_V3, "policies", "comms-policy.json");
const LEDGER_DIR = join(CHUCK_V3, "notification-ledger");
const DIGEST_PENDING_DIR = join(CHUCK_V3, "morning-digest", "pending");
const EVENTS_PATH = join(WORKSPACE_STATE, "apex-events.jsonl");
const OPENCLAW_CONFIG = join(HOME, ".openclaw", "openclaw.json");

const SOURCE = "chuck-comms-cascade";
const TELEGRAM_CHAT_ID = "8630163522";
const IMESSAGE_BUDDY = "+14044517063";
const DISCORD_TARGET_PATH = `${homedir()}/.openclaw/credentials/discord-target.json`;

const TIMEOUT_APPLE_BRIDGE_MS = 5_000;
const TIMEOUT_TELEGRAM_MS = 10_000;
const TIMEOUT_IMESSAGE_MS = 10_000;
const TIMEOUT_DISCORD_MS = 10_000;
const TIMEOUT_VOICE_MS = 30_000;
const ANTISPAM_WINDOW_MS = 30_000;
// openclaw-native send is the preferred path for telegram + discord: gateway-routed,
// observable in the openclaw event ledger, single source of truth for channel
// auth + delivery policy. CLI cold-start (plugin warmup + gateway connect) can
// run 5-25s on a healthy Mac; allow 30s before we fall back to raw API curl.
const OPENCLAW_NATIVE_TIMEOUT_MS = 30_000;
const OPENCLAW_CLI = "/Users/josephmatsiko/Projects/openclaw/dist/index.js";

const DEFAULT_CASCADE = {
  // 2026-04-30: web-push prepended as TRUE first leg. Lands directly on the
  // PWA-installed device (iPad/iPhone Safari + macOS Chrome PWA) without
  // routing through Telegram. Falls through to apex-apple-bridge when no
  // subscriptions are registered (empty PWA install state).
  // 2026-05-01: sms-bridge added as the last live channel before voice/digest
  // (panel #1 failure-mode mitigation). Uses Apple Continuity SMS via
  // Messages.app — when iMessage routing fails, Apple falls back to SMS over
  // the iPhone's LTE link, a separate carrier from the Mac's Wi-Fi.
  immediate: [
    "web-push",
    "apex-apple-bridge",
    "telegram",
    "discord",
    "imessage",
    "sms-bridge",
    "voice",
    "digest",
  ],
  "immediate-low-friction": [
    "web-push",
    "apex-apple-bridge",
    "telegram",
    "discord",
    "sms-bridge",
    "digest",
  ],
  digest: ["digest"],
};

// In-process anti-spam cache: hash → ts(ms)
const ANTISPAM_CACHE = new Map();

// ─── helpers ───────────────────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [LEDGER_DIR, DIGEST_PENDING_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function ledgerId() {
  return `notif-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function shellEscapeSingle(s) {
  return String(s).replace(/'/g, `'\\''`);
}

function osascriptEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function todayYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function emitEvent(type, payload) {
  const ev = {
    id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    ts: new Date().toISOString(),
    actor: "chuck",
    source: SOURCE,
    type,
    payload,
  };
  try {
    appendFileSync(EVENTS_PATH, JSON.stringify(ev) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

// Returns hour-of-day in America/Chicago as integer 0–23 using Intl.
function chicagoHour() {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(new Date());
    const hour = parts.find((p) => p.type === "hour");
    return hour ? parseInt(hour.value, 10) : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

function isQuietHours() {
  const h = chicagoHour();
  return h >= 23 || h < 8;
}

function antispamHash(payload) {
  const key = `${payload.subject || ""}::${payload.body || ""}::${payload.severity || "info"}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function antispamHit(hash) {
  const now = Date.now();
  const seen = ANTISPAM_CACHE.get(hash);
  // Prune stale entries opportunistically.
  for (const [k, ts] of ANTISPAM_CACHE) {
    if (now - ts > ANTISPAM_WINDOW_MS) ANTISPAM_CACHE.delete(k);
  }
  if (seen && now - seen < ANTISPAM_WINDOW_MS) return true;
  // Cold-start consult: check ledger for recent identical hash.
  if (existsSync(LEDGER_DIR)) {
    const cutoff = now - ANTISPAM_WINDOW_MS;
    try {
      const recent = readdirSync(LEDGER_DIR)
        .filter((n) => n.startsWith("notif-") && n.endsWith(".json"))
        .filter((n) => {
          const m = n.match(/^notif-(\d+)-/);
          return m && parseInt(m[1], 10) >= cutoff;
        });
      for (const f of recent) {
        const entry = readJson(join(LEDGER_DIR, f), null);
        if (entry && entry.antispamHash === hash) return true;
      }
    } catch {
      /* ignore */
    }
  }
  ANTISPAM_CACHE.set(hash, now);
  return false;
}

// ─── openclaw-native send (preferred path; falls back to raw API on failure) ──
//
// Subprocess-spawns the openclaw CLI with `message send --json`. Parses the
// final JSON payload from stdout (CLI prints config warnings + plugin chatter
// before the result, so we slice from the last "\n{" to end of stream).
//
// Return shape matches per-channel attempter contract used downstream:
//   { ok, durationMs, messageId?, transport?, error? }
async function sendViaOpenclaw({ channel, target, text, silent = true }) {
  const start = Date.now();
  const args = [
    OPENCLAW_CLI,
    "message",
    "send",
    "--channel",
    channel,
    "--target",
    target,
    "--message",
    text,
    "--json",
  ];
  if (silent) args.push("--silent");
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({
        ok: false,
        durationMs: Date.now() - start,
        error: `openclaw native timed out after ${OPENCLAW_NATIVE_TIMEOUT_MS}ms`,
      });
    }, OPENCLAW_NATIVE_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (code !== 0) {
        resolve({
          ok: false,
          durationMs,
          error: `openclaw native exit ${code}: ${stderr.slice(-300).trim()}`,
        });
        return;
      }
      try {
        const lastBrace = stdout.lastIndexOf("\n{");
        const payloadJson = lastBrace >= 0 ? stdout.slice(lastBrace).trim() : stdout.trim();
        const payload = JSON.parse(payloadJson);
        const ok = payload?.payload?.ok === true || payload?.action === "send";
        const messageId =
          payload?.payload?.messageId ??
          payload?.payload?.payload?.messageId ??
          payload?.payload?.id ??
          null;
        if (ok) {
          resolve({ ok: true, durationMs, messageId, transport: "openclaw-native" });
        } else {
          resolve({
            ok: false,
            durationMs,
            error: `openclaw native payload not-ok: ${payloadJson.slice(0, 200)}`,
          });
        }
      } catch (err) {
        resolve({
          ok: false,
          durationMs,
          error: `openclaw native parse failed: ${err?.message ?? err}`,
        });
      }
    });
  });
}

// ─── attempters (each: (payload, opts) → {ok, error?, durationMs}) ────────
async function attemptWebPush(payload) {
  const start = Date.now();
  let subs;
  try {
    subs = await listWebPushSubscriptions();
  } catch (err) {
    return {
      ok: false,
      error: `listSubscriptions failed: ${err?.message || err}`,
      durationMs: Date.now() - start,
    };
  }
  if (!subs || subs.length === 0) {
    return { ok: false, error: "no subscriptions registered", durationMs: Date.now() - start };
  }
  const wpPayload = {
    title: payload.subject || "Chuck",
    body: payload.body || "",
    tag: payload.origin?.kind || "chuck-default",
    severity: payload.severity || "info",
    data: {
      origin: payload.origin || null,
      tier: payload.tier || null,
      severity: payload.severity || "info",
      ts: new Date().toISOString(),
    },
  };
  const results = await Promise.all(
    subs.map((s) => sendWebPush({ subscription: s, payload: wpPayload })),
  );
  const okCount = results.filter((r) => r.ok).length;
  const failures = results
    .filter((r) => !r.ok)
    .map((r) => r.error)
    .filter(Boolean);
  return {
    ok: okCount > 0,
    error: okCount === 0 ? failures.join("; ") || "all subscriptions failed" : undefined,
    durationMs: Date.now() - start,
    detail: { subscriptionCount: subs.length, successCount: okCount },
  };
}

function attemptAppleBridge(payload) {
  const start = Date.now();
  const subject = payload.subject || "Chuck notification";
  const body = payload.body || "";
  const sound = payload.severity === "critical" ? "Sosumi" : "default";
  const subj = osascriptEscape(subject);
  const text = osascriptEscape(body || subject);
  const script =
    sound === "default"
      ? `display notification "${text}" with title "${subj}"`
      : `display notification "${text}" with title "${subj}" sound name "${sound}"`;
  try {
    const res = spawnSync("/usr/bin/osascript", ["-e", script], {
      timeout: TIMEOUT_APPLE_BRIDGE_MS,
      encoding: "utf8",
    });
    const durationMs = Date.now() - start;
    if (res.error) return { ok: false, error: res.error.message, durationMs };
    if (res.status !== 0)
      return { ok: false, error: (res.stderr || "").trim() || `exit ${res.status}`, durationMs };
    return { ok: true, durationMs };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), durationMs: Date.now() - start };
  }
}

function buildSignedText(payload) {
  const ymd = new Date().toISOString().slice(0, 10);
  const head = payload.body ? `${payload.subject}\n\n${payload.body}` : payload.subject;
  return `${head}\n\n— Chuck — for Joseph — ${ymd}`;
}

// Raw Bot API send with parse_mode=HTML — used for long-form formatted
// updates. Records to the reach-ledger via the same channel name as the
// plain-text path so per-channel last_proven_at stays consistent.
async function sendTelegramHtmlRaw(htmlText) {
  const start = Date.now();
  const cfg = readJson(OPENCLAW_CONFIG, {});
  const token = cfg?.channels?.telegram?.botToken;
  if (!token) {
    return { ok: false, durationMs: 0, error: "no telegram botToken in openclaw.json" };
  }
  return await new Promise((resolve) => {
    const res = spawnSync(
      "/usr/bin/curl",
      [
        "-sS",
        "--max-time",
        "10",
        "-X",
        "POST",
        `https://api.telegram.org/bot${token}/sendMessage`,
        "--data-urlencode",
        `chat_id=${TELEGRAM_CHAT_ID}`,
        "--data-urlencode",
        "parse_mode=HTML",
        "--data-urlencode",
        `text=${htmlText}`,
      ],
      { timeout: TIMEOUT_TELEGRAM_MS, encoding: "utf8" },
    );
    const durationMs = Date.now() - start;
    if (res.error) {
      resolve({ ok: false, durationMs, error: res.error.message });
      return;
    }
    if (res.status !== 0) {
      resolve({
        ok: false,
        durationMs,
        error: (res.stderr || "").trim() || `curl exit ${res.status}`,
      });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      resolve({ ok: false, durationMs, error: `non-JSON response: ${res.stdout.slice(0, 120)}` });
      return;
    }
    if (parsed?.ok) {
      resolve({
        ok: true,
        durationMs,
        messageId: String(parsed?.result?.message_id ?? ""),
        transport: "raw-bot-api-html",
      });
      return;
    }
    resolve({
      ok: false,
      durationMs,
      error: parsed?.description || "telegram api returned not-ok (HTML mode)",
    });
  });
}

async function attemptTelegram(payload) {
  const text = buildSignedText(payload);
  // Auto-format long updates: split into sections, wrap titled sections in
  // <blockquote expandable>, escape HTML in user content. Returns
  // {parseMode, text, formatted}. parseMode is null for short content
  // (passthrough plain text).
  const formatted = formatLongUpdate(text);

  // Long-form HTML goes through raw Bot API directly because the openclaw
  // native message send doesn't expose parse_mode through the public CLI
  // flag set today (the underlying telegram channel SUPPORTS parse_mode —
  // see extensions/telegram/src/draft-stream.test.ts:281 — but the seam
  // is via presentation.renderText, not a plain CLI flag). Once that
  // surface lands publicly, this path collapses back into sendViaOpenclaw.
  if (formatted.parseMode === "HTML") {
    return await sendTelegramHtmlRaw(formatted.text);
  }

  // Preferred path: openclaw message send. Falls back to raw Bot API curl
  // if the gateway is unreachable so cascade delivery remains resilient.
  const native = await sendViaOpenclaw({ channel: "telegram", target: TELEGRAM_CHAT_ID, text });
  if (native.ok) return native;

  const fallbackStart = Date.now();
  const cfg = readJson(OPENCLAW_CONFIG, {});
  const token = cfg?.channels?.telegram?.botToken;
  if (!token) {
    return {
      ok: false,
      durationMs: native.durationMs,
      error: `${native.error}; raw fallback skipped (no telegram botToken)`,
    };
  }
  try {
    const res = spawnSync(
      "/usr/bin/curl",
      [
        "-sS",
        "--max-time",
        "10",
        "-X",
        "POST",
        `https://api.telegram.org/bot${token}/sendMessage`,
        "--data-urlencode",
        `chat_id=${TELEGRAM_CHAT_ID}`,
        "--data-urlencode",
        `text=${text}`,
      ],
      { timeout: TIMEOUT_TELEGRAM_MS, encoding: "utf8" },
    );
    const durationMs = native.durationMs + (Date.now() - fallbackStart);
    if (res.error)
      return {
        ok: false,
        error: `${native.error}; raw fallback: ${res.error.message}`,
        durationMs,
      };
    if (res.status !== 0) {
      return {
        ok: false,
        error: `${native.error}; raw fallback exit ${res.status}: ${(res.stderr || "").trim()}`,
        durationMs,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return {
        ok: false,
        error: `${native.error}; raw fallback non-JSON: ${res.stdout.slice(0, 120)}`,
        durationMs,
      };
    }
    if (parsed?.ok) {
      return {
        ok: true,
        durationMs,
        messageId: parsed?.result?.message_id,
        transport: "raw-bot-api",
      };
    }
    return {
      ok: false,
      error: `${native.error}; raw fallback api not-ok: ${parsed?.description || "unknown"}`,
      durationMs,
    };
  } catch (err) {
    return {
      ok: false,
      error: `${native.error}; raw fallback threw: ${err?.message || String(err)}`,
      durationMs: native.durationMs + (Date.now() - fallbackStart),
    };
  }
}

function attemptIMessage(payload) {
  const start = Date.now();
  const text = buildSignedText(payload);
  const escaped = osascriptEscape(text);
  // Same osascript path that worked tonight per spec.
  const script = `tell application "Messages"
\tset targetService to 1st service whose service type = iMessage
\tset targetBuddy to buddy "${IMESSAGE_BUDDY}" of targetService
\tsend "${escaped}" to targetBuddy
end tell`;
  try {
    const res = spawnSync("/usr/bin/osascript", ["-e", script], {
      timeout: TIMEOUT_IMESSAGE_MS,
      encoding: "utf8",
    });
    const durationMs = Date.now() - start;
    if (res.error) return { ok: false, error: res.error.message, durationMs };
    if (res.status !== 0)
      return { ok: false, error: (res.stderr || "").trim() || `exit ${res.status}`, durationMs };
    return { ok: true, durationMs };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), durationMs: Date.now() - start };
  }
}

async function attemptDiscord(payload) {
  const target = readJson(DISCORD_TARGET_PATH, null);
  const channelId = target?.primaryChannel?.id;
  if (!channelId) {
    return { ok: false, error: `no primaryChannel.id in ${DISCORD_TARGET_PATH}`, durationMs: 0 };
  }
  const text = buildSignedText(payload);
  // Discord caps message content at 2000 chars; truncate with marker if needed.
  const safe = text.length > 1900 ? text.slice(0, 1880) + "\n…(truncated)" : text;

  // Preferred path: openclaw message send (target syntax: channel:<id>).
  const native = await sendViaOpenclaw({
    channel: "discord",
    target: `channel:${channelId}`,
    text: safe,
  });
  if (native.ok) {
    return {
      ...native,
      guildId: target?.primaryGuild?.id,
      channelId,
    };
  }

  const fallbackStart = Date.now();
  const cfg = readJson(OPENCLAW_CONFIG, {});
  const token = cfg?.channels?.discord?.token;
  if (!token) {
    return {
      ok: false,
      durationMs: native.durationMs,
      error: `${native.error}; raw fallback skipped (no discord token)`,
    };
  }
  try {
    const res = spawnSync(
      "/usr/bin/curl",
      [
        "-sS",
        "--max-time",
        "10",
        "-X",
        "POST",
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        "-H",
        `Authorization: Bot ${token}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({ content: safe }),
      ],
      { timeout: TIMEOUT_DISCORD_MS, encoding: "utf8" },
    );
    const durationMs = native.durationMs + (Date.now() - fallbackStart);
    if (res.error)
      return {
        ok: false,
        error: `${native.error}; raw fallback: ${res.error.message}`,
        durationMs,
      };
    if (res.status !== 0) {
      return {
        ok: false,
        error: `${native.error}; raw fallback exit ${res.status}: ${(res.stderr || "").trim()}`,
        durationMs,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return {
        ok: false,
        error: `${native.error}; raw fallback non-JSON: ${res.stdout.slice(0, 120)}`,
        durationMs,
      };
    }
    if (parsed?.id) {
      return {
        ok: true,
        durationMs,
        messageId: parsed.id,
        guildId: target?.primaryGuild?.id,
        channelId,
        transport: "raw-bot-api",
      };
    }
    return {
      ok: false,
      error: `${native.error}; raw fallback api no message id: ${parsed?.message || "unknown"}`,
      durationMs,
    };
  } catch (err) {
    return {
      ok: false,
      error: `${native.error}; raw fallback threw: ${err?.message || String(err)}`,
      durationMs: native.durationMs + (Date.now() - fallbackStart),
    };
  }
}

function attemptSmsBridge(payload) {
  // Routes via Messages.app to Joseph's iPhone. Apple's Continuity decides
  // whether the recipient gets iMessage (Apple-to-Apple) or SMS over LTE.
  // When the Mac's Wi-Fi is degraded but the iPhone's cellular link is up,
  // SMS-over-LTE is the working path — separate carrier from openclaw's
  // gateway, by design.
  const text = buildSignedText(payload);
  // Defer ledger writes to chuck-comms-cascade's own success/failure path
  // below (we record under the canonical "sms-bridge" channel name there
  // too) — passing recordToLedger:false avoids double-counting.
  const result = sendViaSmsBridge({ buddy: IMESSAGE_BUDDY, text, recordToLedger: false });
  if (result.ok) {
    return { ok: true, durationMs: result.durationMs, transport: result.transport };
  }
  return {
    ok: false,
    durationMs: result.durationMs,
    error: result.error || "sms-bridge failed",
  };
}

function attemptVoice(payload) {
  const start = Date.now();
  // Tight spoken text: subject only, plus first sentence of body iff critical.
  let spoken = payload.subject || "";
  if (payload.severity === "critical" && payload.body) {
    const first = String(payload.body).split(/(?<=[.!?])\s/)[0] || "";
    if (first) spoken = `${spoken}. ${first}`;
  }
  const escaped = osascriptEscape(spoken);
  try {
    // Async fire-and-forget: spawn detached, don't wait for full speech.
    const child = spawn("/usr/bin/say", ["-v", "Samantha", "-r", "190", escaped], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const durationMs = Date.now() - start;
    if (child.pid) return { ok: true, durationMs };
    return { ok: false, error: "say spawn returned no pid", durationMs };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), durationMs: Date.now() - start };
  }
}

function attemptDigest(payload, ledgerEntryId) {
  const start = Date.now();
  try {
    if (!existsSync(DIGEST_PENDING_DIR)) mkdirSync(DIGEST_PENDING_DIR, { recursive: true });
    const id = ledgerEntryId || ledgerId();
    const record = {
      id,
      ts: new Date().toISOString(),
      ledgerEntryId,
      payload,
      tier: payload.tier || null,
      severity: payload.severity || "info",
    };
    writeJson(join(DIGEST_PENDING_DIR, `${id}.json`), record);
    return { ok: true, durationMs: Date.now() - start, recordId: id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), durationMs: Date.now() - start };
  }
}

const ATTEMPTERS = {
  "web-push": attemptWebPush,
  "apex-apple-bridge": attemptAppleBridge,
  telegram: attemptTelegram,
  discord: attemptDiscord,
  imessage: attemptIMessage,
  "sms-bridge": attemptSmsBridge,
  voice: attemptVoice,
  digest: attemptDigest,
};

// ─── cascade resolution ────────────────────────────────────────────────────
function resolveCascade(tier) {
  const policy = readJson(POLICY_PATH, null);
  // Try to lift cascade order from policy.tier_rules[tier].channels (string of comma/parallel).
  // Policy currently expresses these as prose, so we don't reliably parse it; fall back to default.
  // We DO honor policy presence so future structured edits will be picked up.
  if (policy?.tiers?.[tier]?.cascadeOrder && Array.isArray(policy.tiers[tier].cascadeOrder)) {
    return policy.tiers[tier].cascadeOrder.slice();
  }
  return DEFAULT_CASCADE[tier]
    ? DEFAULT_CASCADE[tier].slice()
    : DEFAULT_CASCADE["immediate-low-friction"].slice();
}

function filterEnabledChannels(cascade) {
  const cfg = readJson(OPENCLAW_CONFIG, {});
  const channels = cfg?.channels || {};
  return cascade.filter((ch) => {
    // Always-available locals: web-push (PWA, runs even with zero subs and
    // self-fails), apex-apple-bridge, voice, digest.
    if (ch === "web-push" || ch === "apex-apple-bridge" || ch === "voice" || ch === "digest")
      return true;
    // Configured channels: telegram, imessage, discord must be enabled.
    if (ch === "telegram" || ch === "imessage" || ch === "discord") {
      return channels?.[ch]?.enabled === true;
    }
    // Unknown channel: drop.
    return false;
  });
}

function applyQuietHoursFilter(cascade, severity) {
  if (severity === "critical") return cascade;
  if (!isQuietHours()) return cascade;
  // Quiet hours, non-critical: drop apex-apple-bridge + voice (audible/visible).
  return cascade.filter((ch) => ch !== "apex-apple-bridge" && ch !== "voice");
}

// ─── notify (the public primitive) ─────────────────────────────────────────
export async function notify(payloadIn) {
  ensureDirs();
  const payload = { ...payloadIn };
  if (!payload.subject) throw new Error("notify: subject is required");

  // Tier resolution.
  let tier = payload.tier || "immediate-low-friction";
  if (payload.severity === "critical") tier = "immediate";
  payload.tier = tier;
  payload.severity = payload.severity || "info";

  const dryRun = payload.dryRun === true;
  const skipAppleBridge = payload.skipAppleBridge === true;

  // Anti-spam check (before allocating ledger).
  const hash = antispamHash(payload);
  if (!dryRun && antispamHit(hash)) {
    return {
      delivered: false,
      channel: null,
      attempts: [],
      ledgerEntryId: null,
      finalReason: "squelched: identical notification within 30s window",
      squelched: true,
    };
  }

  // Resolve cascade.
  let rawCascade = resolveCascade(tier);
  rawCascade = filterEnabledChannels(rawCascade);
  const quietHoursActive = isQuietHours();
  rawCascade = applyQuietHoursFilter(rawCascade, payload.severity);
  // Always ensure digest is the safety-net terminus.
  if (!rawCascade.includes("digest")) rawCascade.push("digest");
  // Prep cascade as channel + skipReason pairs (skip-recorded but not fired).
  const cascade = rawCascade.map((channel) => {
    if (skipAppleBridge && channel === "apex-apple-bridge") {
      return { channel, skipReason: "skipped via --no-apple-bridge" };
    }
    return { channel, skipReason: null };
  });

  const id = ledgerId();
  const cascadeOrderNames = cascade.map((c) => c.channel);
  emitEvent("chuck.notify.cascade.started", {
    ledgerEntryId: id,
    tier,
    cascadeOrder: cascadeOrderNames,
    severity: payload.severity,
    quietHoursActive,
  });

  const attempts = [];
  let delivered = false;
  let deliveredVia = null;

  for (const { channel, skipReason } of cascade) {
    if (skipReason) {
      attempts.push({
        channel,
        ok: false,
        skipped: true,
        ts: new Date().toISOString(),
        durationMs: 0,
        error: skipReason,
      });
      continue;
    }
    const fn = ATTEMPTERS[channel];
    if (!fn) {
      attempts.push({
        channel,
        ok: false,
        ts: new Date().toISOString(),
        durationMs: 0,
        error: "no attempter registered",
      });
      continue;
    }
    let result;
    if (dryRun) {
      result = { ok: true, durationMs: 0, dryRun: true };
    } else {
      try {
        // Some attempters (e.g. web-push) are async; await uniformly so
        // their resolved value lands in `result`, not a pending Promise.
        result = await (channel === "digest" ? fn(payload, id) : fn(payload));
      } catch (err) {
        result = { ok: false, error: err?.message || String(err), durationMs: 0 };
      }
    }
    const attempt = {
      channel,
      ok: !!result.ok,
      ts: new Date().toISOString(),
      durationMs: result.durationMs ?? 0,
    };
    if (!result.ok) attempt.error = result.error || "unknown";
    if (result.dryRun) attempt.dryRun = true;
    // Preserve transport label (openclaw-native vs raw-bot-api) for migration
    // observability — drift between the two paths shows up here.
    if (result.transport) attempt.transport = result.transport;
    if (result.messageId != null) attempt.messageId = result.messageId;
    attempts.push(attempt);
    emitEvent("chuck.notify.attempt", {
      ledgerEntryId: id,
      channel,
      ok: attempt.ok,
      error: attempt.error || null,
      durationMs: attempt.durationMs,
    });
    // Reach-ledger writes: every cascade attempt updates last_proven_at /
    // last_failed_at per channel so future cascades can rank by freshness.
    // Skip recording for the synthetic "digest" channel (always succeeds
    // locally and is a safety-net, not a reach signal) and for skipped
    // entries (--no-apple-bridge, etc).
    if (!skipReason && channel !== "digest" && !result.dryRun) {
      try {
        if (result.ok) {
          recordReachSuccess(channel, {
            messageId: result.messageId ?? null,
            transport: result.transport ?? null,
          });
        } else {
          recordReachFailure(channel, attempt.error || "unknown");
        }
      } catch (err) {
        // Ledger write failures must never break the cascade.
        process.stderr.write(`[reach-ledger] write failed: ${String(err)}\n`);
      }
    }
    if (result.ok) {
      // Digest always succeeds locally; we still want it as the cascade
      // terminus, so a successful digest counts as "delivered to digest" only
      // if no live channel succeeded earlier.
      delivered = true;
      deliveredVia = channel;
      break;
    }
  }

  const finalReason = delivered
    ? `delivered via ${deliveredVia}${attempts.find((a) => a.channel === deliveredVia)?.durationMs != null ? ` in ${attempts.find((a) => a.channel === deliveredVia).durationMs}ms` : ""}`
    : "all attempters failed (this should not happen — digest is the fallback)";

  const ledgerEntry = {
    id,
    ts: new Date().toISOString(),
    payload,
    tier,
    cascadeOrder: cascadeOrderNames,
    attempts,
    delivered,
    deliveredVia,
    finalReason,
    quietHoursActive,
    antispamHash: hash,
    dryRun,
  };
  writeJson(join(LEDGER_DIR, `${id}.json`), ledgerEntry);

  emitEvent(delivered ? "chuck.notify.delivered" : "chuck.notify.failed", {
    ledgerEntryId: id,
    deliveredVia,
    attempts: attempts.length,
  });

  return {
    delivered,
    channel: deliveredVia,
    attempts,
    ledgerEntryId: id,
    finalReason,
  };
}

// ─── status / replay ───────────────────────────────────────────────────────
function listRecentLedger(limit = 10) {
  if (!existsSync(LEDGER_DIR)) return [];
  const files = readdirSync(LEDGER_DIR)
    .filter((n) => n.startsWith("notif-") && n.endsWith(".json"))
    .sort()
    .slice(-limit)
    .reverse();
  return files.map((f) => readJson(join(LEDGER_DIR, f), null)).filter(Boolean);
}

function findLedgerEntry(entryId) {
  const path = join(LEDGER_DIR, `${entryId}.json`);
  if (!existsSync(path)) return null;
  return readJson(path, null);
}

async function runStatus() {
  const recent = listRecentLedger(10);
  const summary = recent.map((e) => ({
    id: e.id,
    ts: e.ts,
    subject: e.payload?.subject || "",
    severity: e.payload?.severity || "info",
    tier: e.tier,
    delivered: e.delivered,
    deliveredVia: e.deliveredVia,
    attempts: (e.attempts || []).map(
      (a) => `${a.channel}:${a.ok ? "ok" : a.skipped ? "skip" : "fail"}`,
    ),
    quietHoursActive: e.quietHoursActive,
    dryRun: e.dryRun || false,
  }));
  return { count: summary.length, recent: summary };
}

async function runReplay(entryId) {
  const entry = findLedgerEntry(entryId);
  if (!entry) return { ok: false, error: `ledger entry not found: ${entryId}` };
  const replayPayload = { ...entry.payload, replayOf: entryId };
  const result = await notify(replayPayload);
  return { ok: true, replayed: entryId, result };
}

// ─── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { _: [] };
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        opts[arg.slice(2)] = true;
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "status";
  const rest = argv.slice(1);
  const opts = parseArgs(rest);

  if (cmd === "notify") {
    const subject = opts._[0];
    if (!subject) {
      console.error(
        'usage: chuck-comms-cascade notify "<subject>" [--body=...] [--severity=info|warn|critical] [--tier=immediate|immediate-low-friction|digest] [--dry-run] [--no-apple-bridge]',
      );
      process.exit(2);
    }
    const payload = {
      subject,
      body: opts.body || null,
      severity: opts.severity || "info",
      tier: opts.tier || undefined,
      dryRun: opts["dry-run"] === true,
      skipAppleBridge: opts["no-apple-bridge"] === true,
    };
    const result = await notify(payload);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "status") {
    const result = await runStatus();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "replay") {
    const entryId = opts._[0];
    if (!entryId) {
      console.error("usage: chuck-comms-cascade replay <ledgerEntryId>");
      process.exit(2);
    }
    const result = await runReplay(entryId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`unknown command: ${cmd}`);
  console.error('usage: chuck-comms-cascade {notify "<subject>" [opts] | status | replay <id>}');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
