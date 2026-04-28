#!/usr/bin/env node
// Apex Event Bus — the ambient backbone.
//
// Unified pub/sub layer every watcher + daemon + event-driven module
// subscribes to. JSONL-backed (durable, greppable, replayable) with an
// in-process EventEmitter shim for same-node subscribers.
//
// Event shape:
//   { id, ts, source, type, payload }
//
// Storage:
//   ~/.openclaw/workspace/state/apex-events.jsonl  (append-only live log)
//   ~/.openclaw/workspace/state/apex-events-cursors.json  (per-subscriber cursor positions)
//   ~/.openclaw/workspace/state/apex-events-dedupe.json  (emitOnce TTL cache)
//   ~/.openclaw/workspace/state/archive/events-<ymd>.jsonl.gz  (rotated by Vanguard)
//
// Three ways to consume:
//   1. In-process emit/subscribe via Node EventEmitter (same process only).
//   2. Cross-process subscribe via chokidar tail of the JSONL file.
//   3. One-shot replay via `readEvents({ since, pattern })`.
//
// Guarantees:
//   - Append order preserved; every event has a monotonically-increasing id.
//   - `emitOnce(key, event, ttlMs)` dedupes by key within ttl — safe for watchers
//     that re-scan the same source on overlap.
//   - Fsync'd on every emit (acceptable cost at event rates < 100/s).
//   - Subscriber handlers run sequentially per subscription to preserve order.
//
// Usage (library):
//   import { emit, emitOnce, subscribe, subscribeFile, readEvents } from "./apex-event-bus.mjs";
//   await emit({ source: "imessage-watcher", type: "new-message", payload: {...} });
//   const off = subscribe({ source: "imessage-watcher" }, (evt) => { ... });
//
// CLI (debug / test):
//   node apex-event-bus.mjs tail                    # stream events as they arrive
//   node apex-event-bus.mjs emit --source x --type y '{"a":1}'
//   node apex-event-bus.mjs stats                   # event counts, sources, types
//   node apex-event-bus.mjs replay --since 1h --source imessage-watcher

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const STATE_DIR = join(HOME, ".openclaw", "workspace", "state");
const LIVE_LOG = join(STATE_DIR, "apex-events.jsonl");
const _CURSORS_PATH = join(STATE_DIR, "apex-events-cursors.json");
const DEDUPE_PATH = join(STATE_DIR, "apex-events-dedupe.json");

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
  }
}

function ensureState() {
  ensureDir(STATE_DIR);
  if (!existsSync(LIVE_LOG)) {
    writeFileSync(LIVE_LOG, "", "utf8");
  }
}

function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function _writeJsonAtomic(path, obj) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, path);
}

// In-process emitter; cross-process subscribers use chokidar via subscribeFile.
const inproc = new EventEmitter();
inproc.setMaxListeners(100);

// ---- gateway forwarding (M2 of OpenClaw migration, 2026-04-24) --------
//
// Every apex emit() also forwards a compact summary to OpenClaw's gateway
// event stream so the gateway sees the same unified observability layer
// Chuck's JSONL has. Dual-emission pattern: local JSONL stays canonical +
// durable; gateway gets signal-grade summaries for dashboards/doctor/backup.
//
// Design:
//   - Fire-and-forget. `openclaw system event` is spawned detached/unref'd;
//     never blocks emit() or breaks fsync discipline.
//   - Signal filter. High-rate data-ingestion sources (imessage-watcher,
//     cross-device-watcher) are skipped by default — they account for
//     ~85% of events and are noise, not signal.
//   - Compact payload. We summarize payload so gateway log doesn't bloat.
//   - Env overrides: APEX_GATEWAY_FORWARD=0 disables, APEX_GATEWAY_ONLY_SOURCES
//     whitelist, APEX_GATEWAY_SKIP_SOURCES blacklist. Defaults are sane for
//     Joseph's actual traffic pattern.
const GATEWAY_DEFAULT_SKIP_SOURCES = new Set([
  "imessage-watcher", // 22k+ new-message events — data ingestion, not signal
  "cross-device-watcher", // 12k+ heartbeats — same
]);
const GATEWAY_MAX_PAYLOAD_CHARS = 400;
const GATEWAY_FORWARD_ENABLED = process.env.APEX_GATEWAY_FORWARD !== "0";

// Bounded subprocess spawning — prevents unbounded accumulation when the
// gateway is slow or unresponsive. Without this, each emit() spawned a new
// `openclaw system event` child; slow children piled up to OOM (observed
// 2026-04-24: 36+ leaked openclaw-system processes consuming 8 GB resident).
const GATEWAY_CHILD_TIMEOUT_MS = Number(process.env.APEX_GATEWAY_CHILD_TIMEOUT_MS ?? 10_000);
const GATEWAY_MAX_INFLIGHT = Number(process.env.APEX_GATEWAY_MAX_INFLIGHT ?? 5);
const inflightGatewayChildren = new Set();

function resolveEnvSet(name) {
  const raw = process.env[name];
  if (!raw) {
    return null;
  }
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? new Set(parts) : null;
}

function shouldForwardToGateway(event) {
  if (!GATEWAY_FORWARD_ENABLED) {
    return false;
  }
  const only = resolveEnvSet("APEX_GATEWAY_ONLY_SOURCES");
  if (only) {
    return only.has(String(event.source));
  }
  const userSkip = resolveEnvSet("APEX_GATEWAY_SKIP_SOURCES");
  const effectiveSkip = userSkip ?? GATEWAY_DEFAULT_SKIP_SOURCES;
  if (effectiveSkip.has(String(event.source))) {
    return false;
  }
  return true;
}

function summarizePayload(payload) {
  if (payload == null) {
    return null;
  }
  try {
    const json = JSON.stringify(payload);
    if (!json) {
      return null;
    }
    if (json.length <= GATEWAY_MAX_PAYLOAD_CHARS) {
      return payload;
    }
    // Too large — return a compact digest so gateway log stays readable.
    const keys =
      typeof payload === "object" && !Array.isArray(payload)
        ? Object.keys(payload).slice(0, 12)
        : null;
    return {
      _truncated: true,
      _bytes: json.length,
      ...(keys ? { _keys: keys } : {}),
      _head: json.slice(0, GATEWAY_MAX_PAYLOAD_CHARS - 64),
    };
  } catch {
    return null;
  }
}

function forwardToGateway(event) {
  try {
    if (!shouldForwardToGateway(event)) {
      return;
    }
    if (inflightGatewayChildren.size >= GATEWAY_MAX_INFLIGHT) {
      // Backpressure: drop forwarding rather than accumulate subprocesses.
      return;
    }
    const text = JSON.stringify({
      id: event.id,
      ts: event.ts,
      actor: event.actor,
      source: event.source,
      type: event.type,
      payload: summarizePayload(event.payload),
    });
    // Fire-and-forget. Detach so parent process doesn't block/wait.
    const child = spawn(
      "openclaw",
      ["system", "event", "--text", text, "--mode", "next-heartbeat"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    inflightGatewayChildren.add(child);
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, GATEWAY_CHILD_TIMEOUT_MS);
    // unref so a one-shot parent (CLI script) can exit before the timer
    // fires. Long-running daemons stay alive on their own work; the timer
    // still ticks at scheduled time. Without unref, every emit() blocked
    // CLI exit by up to GATEWAY_CHILD_TIMEOUT_MS — observable as 30s+
    // hangs on apex-chrome-cdp.mjs launch (3 emits × 10s).
    killTimer.unref();
    const cleanup = () => {
      clearTimeout(killTimer);
      inflightGatewayChildren.delete(child);
    };
    child.on("close", cleanup);
    child.on("error", cleanup);
    child.unref();
  } catch {
    // Best-effort forwarding; never propagate.
  }
}

// ---- public api --------------------------------------------------------

export async function emit({ source, type, payload = {}, id: explicitId, actor } = {}) {
  if (!source || !type) {
    throw new Error("emit: source + type required");
  }
  ensureState();
  // Unified-identity discipline (2026-04-24): every event is signed by
  // Chuck as the actor. `source` names WHICH of Chuck's scripts emitted
  // it; `actor` names the identity that OWNS the action. Same Chuck
  // across every surface. Callers can pass actor:"..." to override
  // (rare — only if we ever split identity intentionally).
  const event = {
    id: explicitId ?? `e-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    ts: new Date().toISOString(),
    actor: String(actor ?? "chuck"),
    source: String(source),
    type: String(type),
    payload,
  };
  const line = JSON.stringify(event) + "\n";
  // Append + fsync so crash-safety is real.
  const fd = openSync(LIVE_LOG, "a");
  try {
    appendFileSync(fd, line, "utf8");
    try {
      fsyncSync(fd);
    } catch {
      /* ignore on filesystems that don't support it */
    }
  } finally {
    closeSync(fd);
  }
  // Fan out in-process.
  inproc.emit("event", event);
  inproc.emit(`source:${source}`, event);
  inproc.emit(`type:${type}`, event);
  // Dual-emit to OpenClaw gateway (M2 migration). Non-blocking.
  forwardToGateway(event);
  return event;
}

// Dedupe via small key cache with TTL. Idempotent against repeated triggers
// (e.g. a watcher that re-scans on overlap).
export async function emitOnce(key, eventDef, { ttlMs = 60 * 60 * 1000 } = {}) {
  ensureState();
  const now = Date.now();
  const cache = readJsonSafe(DEDUPE_PATH, {});
  // GC expired keys.
  for (const k of Object.keys(cache)) {
    if (!cache[k]?.at || now - cache[k].at > (cache[k].ttlMs ?? ttlMs)) {
      delete cache[k];
    }
  }
  if (cache[key]) {
    return { duplicate: true, event: null };
  }
  const event = await emit(eventDef);
  cache[key] = { at: now, ttlMs, eventId: event.id };
  writeFileSync(DEDUPE_PATH, JSON.stringify(cache, null, 2), "utf8");
  return { duplicate: false, event };
}

// In-process subscribe. Returns an `off()` unsubscribe fn.
export function subscribe(pattern, handler) {
  const match = buildMatcher(pattern);
  const listener = (event) => {
    if (match(event)) {
      try {
        handler(event);
      } catch (err) {
        console.error(
          `[apex-event-bus] subscriber error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  inproc.on("event", listener);
  return () => inproc.off("event", listener);
}

// Cross-process subscribe via JSONL tail. Uses node's built-in fs.watch for
// low-cost tailing. Handler called once per matching new line.
export function subscribeFile(pattern, handler, { fromOffset = "end" } = {}) {
  ensureState();
  const match = buildMatcher(pattern);
  let lastOffset = fromOffset === "start" ? 0 : (statSafe(LIVE_LOG)?.size ?? 0);
  const drain = () => {
    const st = statSafe(LIVE_LOG);
    if (!st) {
      return;
    }
    if (st.size <= lastOffset) {
      return;
    }
    const fd = openSync(LIVE_LOG, "r");
    try {
      const toRead = st.size - lastOffset;
      const buf = Buffer.alloc(toRead);
      readSync(fd, buf, 0, toRead, lastOffset);
      lastOffset = st.size;
      const chunk = buf.toString("utf8");
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (match(evt)) {
          try {
            handler(evt);
          } catch (err) {
            console.error(
              `[apex-event-bus] file-subscriber error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } finally {
      closeSync(fd);
    }
  };
  // Initial drain for any events already beyond fromOffset.
  if (fromOffset === "start") {
    drain();
  }
  const watcher = watch(LIVE_LOG, { persistent: true }, () => drain());
  return () => {
    try {
      watcher.close();
    } catch {
      /* noop */
    }
  };
}

// Replay events from disk for one-shot consumers.
export function readEvents({ since, until, pattern } = {}) {
  ensureState();
  const match = buildMatcher(pattern ?? {});
  const sinceMs = resolveSince(since);
  const untilMs = until ? new Date(until).getTime() : Infinity;
  const content = readFileSync(LIVE_LOG, "utf8");
  const out = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const evtMs = new Date(evt.ts).getTime();
    if (evtMs < sinceMs || evtMs > untilMs) {
      continue;
    }
    if (!match(evt)) {
      continue;
    }
    out.push(evt);
  }
  return out;
}

export function stats() {
  ensureState();
  const content = readFileSync(LIVE_LOG, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const bySource = {};
  const byType = {};
  let oldest = null;
  let newest = null;
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      bySource[evt.source] = (bySource[evt.source] ?? 0) + 1;
      byType[evt.type] = (byType[evt.type] ?? 0) + 1;
      if (!oldest || evt.ts < oldest) {
        oldest = evt.ts;
      }
      if (!newest || evt.ts > newest) {
        newest = evt.ts;
      }
    } catch {
      /* noop */
    }
  }
  const st = statSafe(LIVE_LOG);
  return {
    total: lines.length,
    bySource,
    byType,
    oldest,
    newest,
    bytes: st?.size ?? 0,
    path: LIVE_LOG,
  };
}

// ---- helpers -----------------------------------------------------------

function buildMatcher(pattern) {
  if (!pattern || typeof pattern !== "object") {
    return () => true;
  }
  const {
    source, // string | RegExp | undefined
    type, // string | RegExp | undefined
  } = pattern;
  const s = source instanceof RegExp ? source : source ? new RegExp(`^${escape(source)}$`) : null;
  const t = type instanceof RegExp ? type : type ? new RegExp(`^${escape(type)}$`) : null;
  return (evt) => {
    if (s && !s.test(String(evt.source ?? ""))) {
      return false;
    }
    if (t && !t.test(String(evt.type ?? ""))) {
      return false;
    }
    return true;
  };
}

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function resolveSince(since) {
  if (!since) {
    return 0;
  }
  if (since instanceof Date) {
    return since.getTime();
  }
  if (typeof since === "number") {
    return since;
  }
  const m = String(since).match(/^(\d+)\s*(m|h|d)$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit === "m" ? 60 * 1000 : unit === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return Date.now() - n * mult;
  }
  const parsed = Date.parse(String(since));
  return Number.isFinite(parsed) ? parsed : 0;
}

// (native ESM — no require shim needed; readSync + renameSync imported directly.)

// ---- CLI ---------------------------------------------------------------

async function mainCli() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "tail") {
    console.log(`[apex-event-bus] tailing ${LIVE_LOG}`);
    subscribeFile({}, (evt) => {
      console.log(JSON.stringify(evt));
    });
    await new Promise(() => {});
    return;
  }
  if (cmd === "emit") {
    const args = { payload: {} };
    for (let i = 0; i < rest.length; i += 1) {
      const t = rest[i];
      if (t === "--source") {
        args.source = rest[i + 1];
        i += 1;
      } else if (t === "--type") {
        args.type = rest[i + 1];
        i += 1;
      } else if (t.startsWith("{")) {
        try {
          args.payload = JSON.parse(t);
        } catch {
          /* leave empty */
        }
      }
    }
    const evt = await emit(args);
    console.log(JSON.stringify(evt, null, 2));
    return;
  }
  if (cmd === "stats") {
    console.log(JSON.stringify(stats(), null, 2));
    return;
  }
  if (cmd === "replay") {
    const args = { pattern: {} };
    for (let i = 0; i < rest.length; i += 1) {
      const t = rest[i];
      if (t === "--since") {
        args.since = rest[i + 1];
        i += 1;
      } else if (t === "--source") {
        args.pattern.source = rest[i + 1];
        i += 1;
      } else if (t === "--type") {
        args.pattern.type = rest[i + 1];
        i += 1;
      }
    }
    const evts = readEvents(args);
    for (const evt of evts) {
      console.log(JSON.stringify(evt));
    }
    return;
  }
  console.log(
    "usage: apex-event-bus.mjs (tail | emit --source X --type Y {json} | stats | replay --since 1h --source X --type Y)",
  );
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[apex-event-bus] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
