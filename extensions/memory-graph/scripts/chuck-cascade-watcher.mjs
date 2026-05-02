#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 6b of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/skill-cascade-watcher/src/* (re-exported via
//   @openclaw/skill-cascade-watcher api.ts)
//
// This .mjs preserves identical trigger / handle / flood / promote semantics
// so the LaunchAgent ~/Library/LaunchAgents/com.openclaw.chuck-cascade-watcher.plist
// keeps polling apex-events.jsonl unchanged. Vanilla Node can't import the
// TS plugin's api.ts at runtime (and the polling daemon is long-running, so
// subprocess-per-event isn't viable), so duplicating the logic is the
// working seam.
//
// EDITS: bug fixes go in BOTH places (here AND
// extensions/skill-cascade-watcher/src/*.ts).
// The .mjs retires when openclaw cron grows long-running plugin-daemon
// support and absorbs the LaunchAgent — at which point the entire
// chuck-comms-cascade.mjs / chuck-reach-ledger.mjs / chuck-sms-bridge.mjs /
// chuck-format-update.mjs duplicate chain finally retires too.
// =============================================================================
//
// chuck-cascade-watcher — generalize comms-cascade trigger across the bus.
//
// Where chuck-docket-executor only fires the cascade for task failures, this
// daemon tails ~/.openclaw/workspace/state/apex-events.jsonl and routes any
// failure-class / notable bus event through chuck-comms-cascade. Adds an
// editable trigger table so new event types can be wired without rewiring
// each emitter.
//
// Anti-recursion is critical: we never fire on events the cascade itself
// emits (chuck.notify.*) or on our own watcher events (chuck.cascade.watcher.*).
//
// Anti-flood: per (triggerType + source), >3 fires in 5 min suppresses
// further fires until the window resets; suppression is logged to the bus.
//
// Backlog policy: on startup we record the file's current size and only
// react to bytes appended AFTER startup. Last 200 lines are loaded into a
// "seen" set as a belt-and-suspenders dedupe layer.
//
// File-watch strategy: polling via fs.statSync every 500ms. fs.watch on
// macOS APFS is unreliable for append-only logs (FSEvents coalesces and
// sometimes drops "change" deliveries on rapid writes), and the watcher
// must never miss a failure event. Polling at 500ms costs ~2 syscalls/sec.
//
// CLI:
//   node chuck-cascade-watcher.mjs run                    — daemon loop (launchd entrypoint)
//   node chuck-cascade-watcher.mjs status                 — last matches/fires/suppressions
//   node chuck-cascade-watcher.mjs test <event-type>      — synthesize event, verify trigger + cascade fire (no bus write)
//                                                           [--severity=<s>] [--dry-run]

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { notify as commsNotify } from "./chuck-comms-cascade.mjs";

const HOME = homedir();
const WORKSPACE_STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(WORKSPACE_STATE, "chuck-v3");
const EVENTS_PATH = join(WORKSPACE_STATE, "apex-events.jsonl");
const WATCHER_DIR = join(CHUCK_V3, "cascade-watcher");
const STATE_PATH = join(WATCHER_DIR, "state.json");
const DOCKET_DIR = join(CHUCK_V3, "docket");

const SOURCE = "chuck-cascade-watcher";
const POLL_INTERVAL_MS = 500;
const SEEN_BACKLOG_LINES = 200;
const SEEN_CACHE_MAX = 5_000;
const ANTIFLOOD_WINDOW_MS = 5 * 60 * 1000;
const ANTIFLOOD_MAX_FIRES = 3;
const STATE_RECENT_LIMIT = 50;
const PROMOTED_RECENT_LIMIT = 200;
const READ_BUFFER_BYTES = 64 * 1024;

// ─── Trigger table ────────────────────────────────────────────────────────
// Each entry:
//   typeMatch: RegExp matched against event.type
//   when:      optional predicate (event) → bool; only fires if true
//   severity:  cascade severity (info | warn | critical)
//   tier:      cascade tier (immediate | immediate-low-friction | digest)
//   subjectFn: (event) → string subject line
const CASCADE_TRIGGERS = [
  // Task / docket failures (executor already fires; harmless backstop).
  {
    typeMatch: /^chuck\.docket\.(failed|validation_failed)$/,
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) =>
      `Task failed: ${ev.payload?.task?.title ?? ev.payload?.task?.id ?? "(unknown)"}`,
  },
  // Mac-self-heal failures.
  {
    typeMatch: /^chuck\.mac\.self_heal\.failed$/,
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) => `Mac self-heal failed: ${ev.payload?.reason ?? "(no reason)"}`,
  },
  // Gateway / executor crashes.
  {
    typeMatch: /^chuck\.(gateway|executor)\.crashed$/,
    severity: "critical",
    tier: "immediate",
    subjectFn: (ev) =>
      `${ev.payload?.subsystem ?? ev.type.split(".")[1] ?? "subsystem"} crashed: ${ev.payload?.reason ?? "(no reason)"}`,
  },
  // Zombie cluster sweeps (≥3 in one tick = real anomaly, not routine recovery).
  {
    typeMatch: /^chuck\.zombie_recovered$/,
    when: (ev) => (ev.payload?.batch?.length ?? 1) >= 3,
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) =>
      `Zombie cluster recovered: ${ev.payload?.batch?.length ?? 1} tasks in one sweep`,
  },
  // Codex lockout state changes.
  {
    typeMatch: /^chuck\.codex\.(locked|unlocked)$/,
    severity: "info",
    tier: "immediate-low-friction",
    subjectFn: (ev) => `Codex ${ev.type.split(".").pop()}: ${ev.payload?.reason ?? "(no reason)"}`,
  },
  // High-risk decision proposals.
  {
    typeMatch: /^chuck\.decision\.proposed$/,
    when: (ev) => ev.payload?.riskClass === "high",
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) =>
      `High-risk decision needs review: ${ev.payload?.recommendation ?? "(no rec)"}`,
  },
  // High-risk introspection observations.
  {
    typeMatch: /^chuck\.introspect\.observed$/,
    when: (ev) => ev.payload?.riskClass === "high",
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) =>
      `Introspection flagged high-risk: ${ev.payload?.recommendation ?? "(no rec)"}`,
  },
  // NOTE: chuck.notify.failed is intentionally NOT a trigger — a failed
  // cascade firing another cascade would loop. It's the cascade's own job
  // to record into the digest.
];

// ─── helpers ──────────────────────────────────────────────────────────────
function ensureDirs() {
  if (!existsSync(WATCHER_DIR)) mkdirSync(WATCHER_DIR, { recursive: true });
  if (!existsSync(DOCKET_DIR)) mkdirSync(DOCKET_DIR, { recursive: true });
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

function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// Determine whether an event should be ignored regardless of trigger match.
// Anti-recursion: skip cascade-emitted and watcher-emitted events.
function isOwnEcho(ev) {
  if (!ev || typeof ev.type !== "string") return true;
  if (ev.source === SOURCE) return true;
  if (ev.type.startsWith("chuck.notify.")) return true;
  if (ev.type.startsWith("chuck.cascade.watcher.")) return true;
  return false;
}

function findTrigger(ev) {
  for (const trig of CASCADE_TRIGGERS) {
    if (!trig.typeMatch.test(ev.type)) continue;
    if (typeof trig.when === "function") {
      let ok = false;
      try {
        ok = !!trig.when(ev);
      } catch {
        ok = false;
      }
      if (!ok) continue;
    }
    return trig;
  }
  return null;
}

// ─── State (recent matches/fires/suppressions for `status`) ──────────────
function loadState() {
  const s = readJson(STATE_PATH, null) || {};
  return {
    startedAt: s.startedAt ?? null,
    pid: s.pid ?? null,
    matches: Array.isArray(s.matches) ? s.matches : [],
    fires: Array.isArray(s.fires) ? s.fires : [],
    suppressions: Array.isArray(s.suppressions) ? s.suppressions : [],
    promotions: Array.isArray(s.promotions) ? s.promotions : [],
    floodCounters: s.floodCounters && typeof s.floodCounters === "object" ? s.floodCounters : {},
  };
}

function saveState(state) {
  // Trim recent arrays to STATE_RECENT_LIMIT each (promotions get a larger budget
  // because they're cheap and we use them for cross-restart idempotency).
  state.matches = state.matches.slice(-STATE_RECENT_LIMIT);
  state.fires = state.fires.slice(-STATE_RECENT_LIMIT);
  state.suppressions = state.suppressions.slice(-STATE_RECENT_LIMIT);
  state.promotions = state.promotions.slice(-PROMOTED_RECENT_LIMIT);
  writeJson(STATE_PATH, state);
}

function pruneFloodCounters(state, nowMs) {
  const cutoff = nowMs - ANTIFLOOD_WINDOW_MS;
  for (const [key, entry] of Object.entries(state.floodCounters)) {
    entry.fires = (entry.fires || []).filter((ts) => ts >= cutoff);
    if (entry.fires.length === 0) delete state.floodCounters[key];
  }
}

function antifloodKey(triggerType, source) {
  return `${triggerType}::${source || "unknown"}`;
}

// Returns { suppressed: bool, count: number, windowMs: number }.
function checkAndRecordFlood(state, triggerType, source, nowMs) {
  pruneFloodCounters(state, nowMs);
  const key = antifloodKey(triggerType, source);
  const entry = state.floodCounters[key] || { fires: [] };
  if (entry.fires.length >= ANTIFLOOD_MAX_FIRES) {
    return { suppressed: true, count: entry.fires.length, windowMs: ANTIFLOOD_WINDOW_MS, key };
  }
  entry.fires.push(nowMs);
  state.floodCounters[key] = entry;
  return { suppressed: false, count: entry.fires.length, windowMs: ANTIFLOOD_WINDOW_MS, key };
}

// ─── Auto-promote-to-docket (introspect's own observation 09:31 UTC 2026-04-30:
// "auto-promote risk≥medium proposals to docket tasks or expire/close after N
// hours"). Idempotent on introspectId so re-processing a backlog event doesn't
// duplicate the docket task. Risk-class mapping caps docketed risk at "medium"
// so the dockethealth scanner doesn't escalate auto-promoted tasks into the
// recursive failure-investigation cycle if they later fail.
function shouldPromoteToDocket(ev) {
  if (ev?.type !== "chuck.introspect.observed") return false;
  const riskClass = ev?.payload?.riskClass;
  return riskClass === "medium" || riskClass === "high";
}

function alreadyPromoted(state, introspectId) {
  if (!introspectId) return false;
  return (state.promotions || []).some((p) => p.introspectId === introspectId);
}

function promoteObservationToDocket(ev, state) {
  const introspectId = ev?.payload?.introspectId;
  if (!introspectId) {
    return { promoted: false, reason: "no introspectId" };
  }
  if (alreadyPromoted(state, introspectId)) {
    return { promoted: false, reason: "already-promoted", introspectId };
  }
  const taskId = `task-introspect-promoted-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const now = new Date().toISOString();
  const riskClass = ev.payload.riskClass;
  const docketRisk = riskClass === "high" ? "medium" : "low";
  const category = ev.payload.category || "introspect-observation";
  const recommendation =
    ev.payload.recommendation || "Address introspect observation (no recommendation in payload)";
  const titleBase =
    recommendation.length > 80 ? recommendation.slice(0, 77) + "..." : recommendation;
  const title = `Introspect[${riskClass}/${category}]: ${titleBase}`;
  const task = {
    id: taskId,
    title,
    status: "pending",
    risk: docketRisk,
    commandKind: "claude-cli-build",
    surface: "chuck-cockpit",
    intent: recommendation,
    createdAt: now,
    updatedAt: now,
    createdBy: SOURCE,
    source: {
      kind: "chuck-introspect-promotion",
      category,
      fingerprint: introspectId,
    },
    heartbeats: [
      {
        at: now,
        phase: "pending",
        message: `Auto-promoted by ${SOURCE} from introspect observation ${introspectId} (riskClass=${riskClass})`,
      },
    ],
    promotedFrom: {
      eventId: ev.id,
      observedAt: ev.ts,
      introspectId,
      riskClass,
    },
  };
  const taskPath = join(DOCKET_DIR, `${taskId}.json`);
  try {
    writeFileSync(taskPath, JSON.stringify(task, null, 2) + "\n", "utf8");
  } catch (err) {
    return { promoted: false, reason: `write failed: ${err?.message || err}` };
  }
  state.promotions.push({
    ts: now,
    introspectId,
    eventId: ev.id,
    taskId,
    taskPath,
    riskClass,
    category,
  });
  emitEvent("chuck.cascade.watcher.promoted", {
    triggerEventId: ev.id,
    introspectId,
    taskId,
    riskClass,
    category,
  });
  return { promoted: true, taskId, introspectId };
}

// ─── Trigger matching & cascade firing ───────────────────────────────────
async function handleEvent(ev, state) {
  if (isOwnEcho(ev)) return;

  // Auto-promote risk≥medium introspect observations to docket tasks.
  // Runs in PARALLEL to (not instead of) the cascade-notify path so a high-risk
  // observation both notifies AND lands as an actionable docket task.
  if (shouldPromoteToDocket(ev)) {
    try {
      const result = promoteObservationToDocket(ev, state);
      if (result.promoted) saveState(state);
    } catch (err) {
      console.error(`promote-to-docket error: ${err?.stack || err}`);
    }
  }

  const trig = findTrigger(ev);
  if (!trig) return;

  const nowMs = Date.now();
  const triggerType = trig.typeMatch.source;
  const source = ev.source || "unknown";

  // Anti-flood gate.
  const flood = checkAndRecordFlood(state, triggerType, source, nowMs);
  if (flood.suppressed) {
    state.suppressions.push({
      ts: new Date(nowMs).toISOString(),
      triggerType,
      source,
      count: flood.count,
      windowMs: flood.windowMs,
      triggerEventId: ev.id,
      triggerEventType: ev.type,
    });
    emitEvent("chuck.cascade.watcher.suppressed", {
      triggerType,
      source,
      count: flood.count,
      windowMs: flood.windowMs,
      triggerEventId: ev.id,
      triggerEventType: ev.type,
    });
    saveState(state);
    return;
  }

  // Record + emit match before firing.
  let subject;
  try {
    subject = trig.subjectFn(ev);
  } catch (err) {
    subject = `Trigger ${triggerType} fired (subjectFn threw: ${err?.message || err})`;
  }
  state.matches.push({
    ts: new Date(nowMs).toISOString(),
    triggerEventId: ev.id,
    triggerType,
    eventType: ev.type,
    source,
    severity: trig.severity,
    tier: trig.tier,
    subject,
  });
  emitEvent("chuck.cascade.watcher.matched", {
    triggerEventId: ev.id,
    triggerType,
    eventType: ev.type,
    riskClass: ev.payload?.riskClass ?? null,
    severity: trig.severity,
    tier: trig.tier,
  });

  // Fire cascade.
  const bodyRaw = JSON.stringify(ev.payload ?? {});
  const body = bodyRaw.length > 600 ? bodyRaw.slice(0, 600) : bodyRaw;
  let result;
  try {
    result = await commsNotify({
      subject,
      body,
      severity: trig.severity,
      tier: trig.tier,
      origin: { kind: SOURCE, ref: ev.id },
    });
  } catch (err) {
    result = {
      delivered: false,
      channel: null,
      ledgerEntryId: null,
      finalReason: `commsNotify threw: ${err?.message || err}`,
    };
  }

  state.fires.push({
    ts: new Date().toISOString(),
    triggerEventId: ev.id,
    triggerType,
    eventType: ev.type,
    subject,
    delivered: !!result.delivered,
    deliveredVia: result.channel || null,
    ledgerEntryId: result.ledgerEntryId || null,
    finalReason: result.finalReason || null,
  });
  emitEvent("chuck.cascade.watcher.fired", {
    triggerEventId: ev.id,
    triggerType,
    ledgerEntryId: result.ledgerEntryId || null,
    deliveredVia: result.channel || null,
    delivered: !!result.delivered,
  });

  saveState(state);
}

// ─── Tail loop ────────────────────────────────────────────────────────────
function readTailLines(path, maxLines) {
  if (!existsSync(path)) return [];
  try {
    const buf = readFileSync(path, "utf8");
    const lines = buf.split("\n").filter((l) => l.length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function readBytesFrom(path, offset) {
  // Read [offset, EOF). Returns string content (utf8). Empty string if no growth.
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    let st;
    try {
      st = statSync(path);
    } catch {
      return "";
    }
    const size = st.size;
    if (size <= offset) return "";
    const buf = Buffer.alloc(Math.min(size - offset, READ_BUFFER_BYTES * 64));
    let total = 0;
    let cur = offset;
    while (cur < size) {
      const want = Math.min(size - cur, buf.length - total);
      if (want <= 0) break;
      const n = readSync(fd, buf, total, want, cur);
      if (n <= 0) break;
      total += n;
      cur += n;
      if (total >= buf.length) break; // safety: process this chunk, loop will resume from new offset
    }
    return buf.slice(0, total).toString("utf8");
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

async function runDaemon() {
  ensureDirs();
  const state = loadState();
  state.startedAt = new Date().toISOString();
  state.pid = process.pid;
  // Reset flood counters on startup — fresh window.
  state.floodCounters = {};

  // Backlog dedupe: load last N event ids as "seen" so even if we mis-track
  // the offset by a line we don't fire on already-stored events.
  const seenIds = new Set();
  const backlog = readTailLines(EVENTS_PATH, SEEN_BACKLOG_LINES);
  for (const line of backlog) {
    const ev = parseEventLine(line);
    if (ev?.id) seenIds.add(ev.id);
  }

  // Track file size — only react to bytes appended AFTER startup.
  let lastSize = 0;
  let lastInode = null;
  try {
    const st = statSync(EVENTS_PATH);
    lastSize = st.size;
    lastInode = st.ino;
  } catch {
    /* file may not exist yet — treat as size 0 */
  }

  saveState(state);
  emitEvent("chuck.cascade.watcher.started", {
    pid: process.pid,
    watchPath: EVENTS_PATH,
    startupOffset: lastSize,
    backlogSeenIds: seenIds.size,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  // Carry buffer for partial-line reads.
  let carry = "";

  // Polling loop. Each tick: stat → if grown, read [lastSize, size), parse
  // line-by-line, dispatch each new event.
  let stopping = false;
  const handleSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    emitEvent("chuck.cascade.watcher.stopping", { pid: process.pid, signal: sig });
    // Give pending writes a chance to flush.
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));

  while (!stopping) {
    let st;
    try {
      st = statSync(EVENTS_PATH);
    } catch {
      st = null;
    }
    if (st) {
      // Detect file rotation / truncation: inode change or size shrunk.
      if (lastInode !== null && st.ino !== lastInode) {
        // rotated: start from 0 of new file
        lastSize = 0;
        lastInode = st.ino;
        carry = "";
      } else if (st.size < lastSize) {
        // truncated: reset to current size (don't replay)
        lastSize = st.size;
        carry = "";
      } else if (st.size > lastSize) {
        const chunk = readBytesFrom(EVENTS_PATH, lastSize);
        if (chunk.length > 0) {
          // The chunk we got might be smaller than (size - lastSize) because
          // the buffer is bounded; advance lastSize by the bytes we actually
          // consumed.
          const bytesRead = Buffer.byteLength(chunk, "utf8");
          lastSize += bytesRead;
          const combined = carry + chunk;
          const lines = combined.split("\n");
          // Last element is either an empty string (clean newline-terminated
          // batch) or a partial line we need to carry.
          carry = lines.pop() || "";
          for (const line of lines) {
            const ev = parseEventLine(line);
            if (!ev) continue;
            if (ev.id && seenIds.has(ev.id)) continue;
            if (ev.id) {
              seenIds.add(ev.id);
              if (seenIds.size > SEEN_CACHE_MAX) {
                // FIFO-ish trim by rebuilding from second half of insertion.
                const arr = Array.from(seenIds);
                seenIds.clear();
                for (const id of arr.slice(-Math.floor(SEEN_CACHE_MAX / 2))) seenIds.add(id);
              }
            }
            try {
              await handleEvent(ev, state);
            } catch (err) {
              console.error(`handleEvent error: ${err?.stack || err}`);
            }
          }
        }
      }
      if (lastInode === null) lastInode = st.ino;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ─── status / test commands ──────────────────────────────────────────────
function runStatus() {
  const state = loadState();
  return {
    startedAt: state.startedAt,
    pid: state.pid,
    counts: {
      matches: (state.matches || []).length,
      fires: (state.fires || []).length,
      suppressions: (state.suppressions || []).length,
      promotions: (state.promotions || []).length,
      activeFloodKeys: Object.keys(state.floodCounters || {}).length,
    },
    recent: {
      matches: (state.matches || []).slice(-10).reverse(),
      fires: (state.fires || []).slice(-10).reverse(),
      suppressions: (state.suppressions || []).slice(-10).reverse(),
      promotions: (state.promotions || []).slice(-10).reverse(),
    },
    triggerTable: CASCADE_TRIGGERS.map((t) => ({
      pattern: t.typeMatch.source,
      severity: t.severity,
      tier: t.tier,
      hasPredicate: typeof t.when === "function",
    })),
    autoPromote: {
      enabled: true,
      eventType: "chuck.introspect.observed",
      riskClasses: ["medium", "high"],
      docketDir: DOCKET_DIR,
    },
  };
}

async function runTest(eventType, opts) {
  ensureDirs();
  if (!eventType) {
    return { ok: false, error: "usage: test <event-type> [--severity=<s>] [--dry-run]" };
  }
  const synthetic = {
    id: `e-test-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    ts: new Date().toISOString(),
    actor: "chuck",
    source: "chuck-cascade-watcher-test",
    type: eventType,
    payload: {
      task: { id: "task-test-watcher", title: "watcher CLI test" },
      reason: "synthetic test event",
      riskClass: opts.severity === "critical" ? "high" : opts.riskClass || "low",
      batch: opts.batch || ["t1", "t2", "t3"],
    },
  };
  const trig = findTrigger(synthetic);
  if (!trig) {
    return {
      ok: false,
      matched: false,
      reason: `no trigger pattern matches event type '${eventType}' (or predicate returned false)`,
      candidates: CASCADE_TRIGGERS.map((t) => t.typeMatch.source),
    };
  }
  let subject;
  try {
    subject = trig.subjectFn(synthetic);
  } catch (err) {
    subject = `(subjectFn threw: ${err?.message || err})`;
  }
  if (opts.dryRun) {
    return {
      ok: true,
      matched: true,
      dryRun: true,
      trigger: {
        pattern: trig.typeMatch.source,
        severity: trig.severity,
        tier: trig.tier,
      },
      subject,
      bodyPreview: JSON.stringify(synthetic.payload).slice(0, 200),
    };
  }
  const severity = opts.severity || trig.severity;
  let result;
  try {
    result = await commsNotify({
      subject,
      body: JSON.stringify(synthetic.payload).slice(0, 600),
      severity,
      tier: trig.tier,
      origin: { kind: SOURCE, ref: synthetic.id, mode: "test" },
    });
  } catch (err) {
    return {
      ok: false,
      matched: true,
      error: `commsNotify threw: ${err?.message || err}`,
      subject,
    };
  }
  return {
    ok: true,
    matched: true,
    trigger: {
      pattern: trig.typeMatch.source,
      severity,
      tier: trig.tier,
    },
    subject,
    cascadeResult: {
      delivered: !!result.delivered,
      deliveredVia: result.channel || null,
      ledgerEntryId: result.ledgerEntryId || null,
      finalReason: result.finalReason || null,
      attempts: (result.attempts || []).map(
        (a) => `${a.channel}:${a.ok ? "ok" : a.skipped ? "skip" : "fail"}`,
      ),
    },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────
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
  const cmd = argv[0] || "run";
  const rest = argv.slice(1);
  const opts = parseArgs(rest);

  if (cmd === "run") {
    await runDaemon();
    return;
  }
  if (cmd === "status") {
    console.log(JSON.stringify(runStatus(), null, 2));
    return;
  }
  if (cmd === "test") {
    const eventType = opts._[0];
    const result = await runTest(eventType, {
      severity: opts.severity || null,
      riskClass: opts["risk-class"] || null,
      dryRun: opts["dry-run"] === true,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exit(1);
    return;
  }

  console.error(`unknown command: ${cmd}`);
  console.error(
    "usage: chuck-cascade-watcher.mjs {run | status | test <event-type> [--severity=<s>] [--dry-run]}",
  );
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
