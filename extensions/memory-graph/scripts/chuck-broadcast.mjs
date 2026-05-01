#!/usr/bin/env node
// chuck-broadcast — fan-out a notification to EVERY enabled channel in parallel,
// not first-success-wins like chuck-comms-cascade. Use when Joseph explicitly
// wants the same payload on every surface (e.g. session-end ship announcement).
//
// Why a separate script: chuck-comms-cascade is correctly first-success-wins
// (the right default for "Chuck got X to Joseph") — adding a broadcast mode
// inline would muddy the cascade's contract. This script is the explicit
// broadcast door, with its own anti-spam window so a misuse doesn't flood
// every channel twice.
//
// Channels (only enabled ones from openclaw.json fire):
//   - apex-apple-bridge (always)
//   - telegram (channels.telegram.enabled)
//   - discord (channels.discord.enabled)
//   - imessage (channels.imessage.enabled)
//   - web-push (always; falls through if no subscriptions)
//   - voice (default off; opt in with --voice)
//   - digest (always; safety-net log)
//
// CLI:
//   chuck-broadcast "<subject>" [--body=...] [--severity=...] [--voice]
//                              [--dry-run] [--exclude=ch1,ch2]
//
// Anti-spam: 60s window per (subject+body+severity) hash, broadcast-scoped
// (separate from chuck-comms-cascade's anti-spam). Identical broadcast within
// 60s is squelched.
//
// State: ~/.openclaw/workspace/state/chuck-v3/broadcast-ledger/<id>.json

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatLongUpdate } from "./chuck-format-update.mjs";

const HOME = homedir();
const WORKSPACE_STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(WORKSPACE_STATE, "chuck-v3");
const LEDGER_DIR = join(CHUCK_V3, "broadcast-ledger");
const EVENTS_PATH = join(WORKSPACE_STATE, "apex-events.jsonl");
const OPENCLAW_CONFIG = join(HOME, ".openclaw", "openclaw.json");
const DISCORD_TARGET_PATH = join(HOME, ".openclaw", "credentials", "discord-target.json");

const SOURCE = "chuck-broadcast";
// Defaults are evidence-derived (per "nothing arbitrary"):
//   ANTISPAM_WINDOW_MS 60s — broadcast is wider blast than cascade's 30s,
//     so anti-spam is correspondingly tighter (shouldn't double-fire same
//     content within 1 minute even by accident).
//   PER_CHANNEL_TIMEOUT_MS 12s — telegram/discord typical send is 200-2000ms;
//     12s captures degraded-but-functional and rules out hung connections.
//   OPENCLAW_NATIVE_TIMEOUT_MS 30s — openclaw CLI cold-start (plugin warmup +
//     gateway connect) can outrun PER_CHANNEL_TIMEOUT_MS. Native attempt is
//     allowed a wider budget; on miss we still have raw curl as backstop.
const ANTISPAM_WINDOW_MS = 60_000;
const PER_CHANNEL_TIMEOUT_MS = 12_000;
const OPENCLAW_NATIVE_TIMEOUT_MS = 30_000;
const TELEGRAM_CHAT_ID = "8630163522";
const IMESSAGE_BUDDY = "+14044517063";
const OPENCLAW_CLI = "/Users/josephmatsiko/Projects/openclaw/dist/index.js";

function nowIso() {
  return new Date().toISOString();
}
function ledgerId() {
  return `bcast-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function ensureDirs() {
  if (!existsSync(LEDGER_DIR)) mkdirSync(LEDGER_DIR, { recursive: true });
}

function emitEvent(type, payload) {
  const ev = {
    id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    ts: nowIso(),
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

function antispamHash(payload) {
  const key = `${payload.subject || ""}::${payload.body || ""}::${payload.severity || "info"}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function antispamHit(hash) {
  const now = Date.now();
  if (!existsSync(LEDGER_DIR)) return false;
  const cutoff = now - ANTISPAM_WINDOW_MS;
  try {
    const recent = readdirSync(LEDGER_DIR)
      .filter((n) => n.startsWith("bcast-") && n.endsWith(".json"))
      .filter((n) => {
        const m = n.match(/^bcast-(\d+)-/);
        return m && parseInt(m[1], 10) >= cutoff;
      });
    for (const f of recent) {
      const e = readJson(join(LEDGER_DIR, f));
      if (e && e.antispamHash === hash) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function osascriptEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSignedText(payload) {
  const ymd = nowIso().slice(0, 10);
  const head = payload.body ? `${payload.subject}\n\n${payload.body}` : payload.subject;
  return `${head}\n\n— Chuck — for Joseph — ${ymd}`;
}

// ─── openclaw-native send (preferred path; falls back to raw API on failure) ──
//
// Subprocess-spawns the openclaw CLI with `message send --json`. Parses the
// final JSON object from stdout (CLI prints config warnings + plugin chatter
// before the payload, so we slice from the last "\n{" to the end).
//
// Return shape matches per-channel attempter contract:
//   { ok, durationMs, detail?: { messageId, transport: "openclaw-native" }, error? }
//
// Timeout is OPENCLAW_NATIVE_TIMEOUT_MS — wider than PER_CHANNEL_TIMEOUT_MS so
// CLI cold-start (plugin warmup + gateway connect) doesn't false-fail us into
// the raw-API fallback when the gateway is healthy but slow.
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
          resolve({
            ok: true,
            durationMs,
            detail: { messageId, transport: "openclaw-native" },
          });
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

// ─── per-channel attempters (each returns { ok, durationMs, error?, detail? }) ──

async function tryAppleBridge(payload) {
  const start = Date.now();
  const subj = osascriptEscape(payload.subject || "Chuck");
  const text = osascriptEscape(
    payload.body
      ? `${payload.subject || ""}: ${payload.body.slice(0, 240)}`
      : payload.subject || "",
  );
  const sound = payload.severity === "critical" ? "Sosumi" : "default";
  const script =
    sound === "default"
      ? `display notification "${text}" with title "${subj}"`
      : `display notification "${text}" with title "${subj}" sound name "${sound}"`;
  const res = spawnSync("/usr/bin/osascript", ["-e", script], {
    timeout: PER_CHANNEL_TIMEOUT_MS,
    encoding: "utf8",
  });
  const durationMs = Date.now() - start;
  if (res.status !== 0) {
    return { ok: false, durationMs, error: (res.stderr || "").trim() || `exit ${res.status}` };
  }
  return { ok: true, durationMs };
}

async function sendTelegramHtmlRaw(htmlText, cfg) {
  const start = Date.now();
  const token = cfg?.channels?.telegram?.botToken;
  if (!token) return { ok: false, durationMs: 0, error: "no telegram botToken" };
  const res = spawnSync(
    "/usr/bin/curl",
    [
      "-sS",
      "--max-time",
      String(Math.floor(PER_CHANNEL_TIMEOUT_MS / 1000)),
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
    { timeout: PER_CHANNEL_TIMEOUT_MS, encoding: "utf8" },
  );
  const durationMs = Date.now() - start;
  if (res.status !== 0) {
    return {
      ok: false,
      durationMs,
      error: (res.stderr || "").trim() || `curl exit ${res.status}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, durationMs, error: `non-JSON response: ${res.stdout.slice(0, 120)}` };
  }
  if (parsed?.ok) {
    return {
      ok: true,
      durationMs,
      detail: { messageId: parsed?.result?.message_id, transport: "raw-bot-api-html" },
    };
  }
  return {
    ok: false,
    durationMs,
    error: parsed?.description || "telegram api returned not-ok (HTML mode)",
  };
}

async function tryTelegram(payload) {
  const cfg = readJson(OPENCLAW_CONFIG, {});
  if (!cfg?.channels?.telegram?.enabled)
    return { ok: false, durationMs: 0, error: "telegram disabled in openclaw.json" };
  const text = buildSignedText(payload);

  // Long-form HTML auto-format: when the signed body crosses the threshold,
  // wrap titled sections in <blockquote expandable> via formatLongUpdate
  // and send through raw Bot API with parse_mode=HTML. Short content stays
  // on the openclaw native plain-text path.
  const formatted = formatLongUpdate(text);
  if (formatted.parseMode === "HTML") {
    return await sendTelegramHtmlRaw(formatted.text, cfg);
  }

  // Preferred path: openclaw message send (uses configured channel binding,
  // gateway-routed, observable in openclaw event ledger). Falls back to raw
  // Telegram Bot API on failure so we don't lose delivery if the gateway hiccups.
  const native = await sendViaOpenclaw({ channel: "telegram", target: TELEGRAM_CHAT_ID, text });
  if (native.ok) return native;

  const fallbackStart = Date.now();
  const token = cfg?.channels?.telegram?.botToken;
  if (!token) {
    return {
      ok: false,
      durationMs: native.durationMs,
      error: `${native.error}; raw fallback skipped (no telegram botToken)`,
    };
  }
  const res = spawnSync(
    "/usr/bin/curl",
    [
      "-sS",
      "--max-time",
      String(Math.floor(PER_CHANNEL_TIMEOUT_MS / 1000)),
      "-X",
      "POST",
      `https://api.telegram.org/bot${token}/sendMessage`,
      "--data-urlencode",
      `chat_id=${TELEGRAM_CHAT_ID}`,
      "--data-urlencode",
      `text=${text}`,
    ],
    { timeout: PER_CHANNEL_TIMEOUT_MS, encoding: "utf8" },
  );
  const durationMs = native.durationMs + (Date.now() - fallbackStart);
  if (res.status !== 0) {
    return {
      ok: false,
      durationMs,
      error: `${native.error}; raw fallback failed: ${(res.stderr || "").trim() || `exit ${res.status}`}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return {
      ok: false,
      durationMs,
      error: `${native.error}; raw fallback non-JSON: ${res.stdout.slice(0, 120)}`,
    };
  }
  if (parsed?.ok) {
    return {
      ok: true,
      durationMs,
      detail: { messageId: parsed?.result?.message_id, transport: "raw-bot-api" },
    };
  }
  return {
    ok: false,
    durationMs,
    error: `${native.error}; raw fallback api not-ok: ${parsed?.description || "unknown"}`,
  };
}

async function tryDiscord(payload) {
  const cfg = readJson(OPENCLAW_CONFIG, {});
  if (!cfg?.channels?.discord?.enabled)
    return { ok: false, durationMs: 0, error: "discord disabled in openclaw.json" };
  const target = readJson(DISCORD_TARGET_PATH);
  const channelId = target?.primaryChannel?.id;
  if (!channelId) return { ok: false, durationMs: 0, error: "no primaryChannel.id" };
  const text = buildSignedText(payload);
  const safe = text.length > 1900 ? text.slice(0, 1880) + "\n…(truncated)" : text;

  // Preferred path: openclaw message send. Discord target syntax expects
  // channel:<id> per `openclaw message send --help`.
  const native = await sendViaOpenclaw({
    channel: "discord",
    target: `channel:${channelId}`,
    text: safe,
  });
  if (native.ok) return native;

  const fallbackStart = Date.now();
  const token = cfg?.channels?.discord?.token;
  if (!token) {
    return {
      ok: false,
      durationMs: native.durationMs,
      error: `${native.error}; raw fallback skipped (no discord token)`,
    };
  }
  const res = spawnSync(
    "/usr/bin/curl",
    [
      "-sS",
      "--max-time",
      String(Math.floor(PER_CHANNEL_TIMEOUT_MS / 1000)),
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
    { timeout: PER_CHANNEL_TIMEOUT_MS, encoding: "utf8" },
  );
  const durationMs = native.durationMs + (Date.now() - fallbackStart);
  if (res.status !== 0) {
    return {
      ok: false,
      durationMs,
      error: `${native.error}; raw fallback failed: ${(res.stderr || "").trim() || `exit ${res.status}`}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return {
      ok: false,
      durationMs,
      error: `${native.error}; raw fallback non-JSON: ${res.stdout.slice(0, 120)}`,
    };
  }
  if (parsed?.id) {
    return {
      ok: true,
      durationMs,
      detail: { messageId: parsed.id, transport: "raw-bot-api" },
    };
  }
  return {
    ok: false,
    durationMs,
    error: `${native.error}; raw fallback api no message id: ${parsed?.message || "unknown"}`,
  };
}

async function tryIMessage(payload) {
  const start = Date.now();
  const cfg = readJson(OPENCLAW_CONFIG, {});
  if (!cfg?.channels?.imessage?.enabled)
    return { ok: false, durationMs: 0, error: "imessage disabled" };
  const text = buildSignedText(payload);
  const escaped = osascriptEscape(text);
  const script = `tell application "Messages"
\tset targetService to 1st service whose service type = iMessage
\tset targetBuddy to buddy "${IMESSAGE_BUDDY}" of targetService
\tsend "${escaped}" to targetBuddy
end tell`;
  const res = spawnSync("/usr/bin/osascript", ["-e", script], {
    timeout: PER_CHANNEL_TIMEOUT_MS,
    encoding: "utf8",
  });
  const durationMs = Date.now() - start;
  if (res.status !== 0)
    return { ok: false, durationMs, error: (res.stderr || "").trim() || `exit ${res.status}` };
  return { ok: true, durationMs };
}

async function tryWebPush(payload) {
  const start = Date.now();
  let mod;
  try {
    mod = await import("./chuck-web-push.mjs");
  } catch (err) {
    return { ok: false, durationMs: Date.now() - start, error: `import failed: ${err?.message}` };
  }
  let subs;
  try {
    subs = await mod.listSubscriptions();
  } catch (err) {
    return { ok: false, durationMs: Date.now() - start, error: `list failed: ${err?.message}` };
  }
  if (!subs || subs.length === 0)
    return { ok: false, durationMs: Date.now() - start, error: "no subscriptions registered" };
  const wpPayload = {
    title: payload.subject || "Chuck",
    body: payload.body || "",
    tag: "chuck-broadcast",
    severity: payload.severity || "info",
    data: { ts: nowIso() },
  };
  const results = await Promise.all(
    subs.map((s) => mod.sendWebPush({ subscription: s, payload: wpPayload })),
  );
  const okCount = results.filter((r) => r.ok).length;
  const durationMs = Date.now() - start;
  return {
    ok: okCount > 0,
    durationMs,
    detail: { subscriptionCount: subs.length, successCount: okCount },
  };
}

async function tryVoice(payload) {
  const start = Date.now();
  let spoken = payload.subject || "";
  if (payload.severity === "critical" && payload.body) {
    const first = String(payload.body).split(/(?<=[.!?])\s/)[0] || "";
    if (first) spoken = `${spoken}. ${first}`;
  }
  const escaped = osascriptEscape(spoken);
  try {
    const child = spawn("/usr/bin/say", ["-v", "Samantha", "-r", "190", escaped], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: !!child.pid, durationMs: Date.now() - start };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - start, error: err?.message || String(err) };
  }
}

function tryDigest(payload, ledgerEntryId) {
  const start = Date.now();
  const dir = join(CHUCK_V3, "morning-digest", "pending");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const id = ledgerEntryId || ledgerId();
  const record = {
    id,
    ts: nowIso(),
    via: "chuck-broadcast",
    payload,
  };
  try {
    writeJson(join(dir, `${id}.json`), record);
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - start, error: err?.message || String(err) };
  }
}

// ─── orchestrator ─────────────────────────────────────────────────────────
async function broadcast(payloadIn, opts = {}) {
  ensureDirs();
  const payload = { ...payloadIn };
  if (!payload.subject) throw new Error("broadcast: subject required");
  payload.severity = payload.severity || "info";

  const hash = antispamHash(payload);
  if (!opts.dryRun && antispamHit(hash)) {
    return {
      delivered: false,
      ledgerEntryId: null,
      squelched: true,
      reason: `identical broadcast within ${ANTISPAM_WINDOW_MS}ms window`,
    };
  }

  const exclude = new Set((opts.exclude || []).map((s) => s.trim()).filter(Boolean));
  const includeVoice = opts.voice === true;

  const id = ledgerId();
  emitEvent("chuck.broadcast.started", { ledgerEntryId: id, severity: payload.severity });

  // Fire ALL channels in parallel.
  const tasks = [];
  if (!exclude.has("apex-apple-bridge")) tasks.push(["apex-apple-bridge", tryAppleBridge(payload)]);
  if (!exclude.has("telegram")) tasks.push(["telegram", tryTelegram(payload)]);
  if (!exclude.has("discord")) tasks.push(["discord", tryDiscord(payload)]);
  if (!exclude.has("imessage")) tasks.push(["imessage", tryIMessage(payload)]);
  if (!exclude.has("web-push")) tasks.push(["web-push", tryWebPush(payload)]);
  if (includeVoice && !exclude.has("voice")) tasks.push(["voice", tryVoice(payload)]);
  // digest is sync + always-on
  const digest = exclude.has("digest") ? null : tryDigest(payload, id);

  const settled = await Promise.all(
    tasks.map(async ([name, p]) => {
      try {
        const r = await p;
        return { channel: name, ...r };
      } catch (err) {
        return { channel: name, ok: false, durationMs: 0, error: err?.message || String(err) };
      }
    }),
  );
  if (digest) settled.push({ channel: "digest", ...digest });

  const okCount = settled.filter((a) => a.ok).length;
  const ledgerEntry = {
    id,
    ts: nowIso(),
    payload,
    attempts: settled.map((a) => ({
      channel: a.channel,
      ok: !!a.ok,
      durationMs: a.durationMs ?? 0,
      error: a.error || null,
      detail: a.detail || null,
    })),
    okCount,
    totalAttempts: settled.length,
    antispamHash: hash,
    dryRun: opts.dryRun === true,
  };
  writeJson(join(LEDGER_DIR, `${id}.json`), ledgerEntry);
  emitEvent("chuck.broadcast.completed", {
    ledgerEntryId: id,
    okCount,
    total: settled.length,
    perChannel: settled.map((a) => ({ channel: a.channel, ok: a.ok })),
  });

  return {
    delivered: okCount > 0,
    ledgerEntryId: id,
    okCount,
    totalAttempts: settled.length,
    attempts: settled,
  };
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      else opts[arg.slice(2)] = true;
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const subject = opts._[0];
  if (!subject) {
    console.error(
      'usage: chuck-broadcast "<subject>" [--body=...] [--severity=info|warn|critical] [--voice] [--dry-run] [--exclude=ch1,ch2]',
    );
    process.exit(2);
  }
  const payload = {
    subject,
    body: opts.body || null,
    severity: opts.severity || "info",
  };
  const exclude = typeof opts.exclude === "string" ? opts.exclude.split(",") : [];
  const result = await broadcast(payload, {
    voice: opts.voice === true,
    dryRun: opts["dry-run"] === true,
    exclude,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.delivered && !result.squelched) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}

export { broadcast };
