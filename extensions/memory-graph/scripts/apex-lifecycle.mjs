#!/usr/bin/env node
// apex-lifecycle — unified start/finish/failed emission wrapper for launchd
// and cron-triggered scripts. Any script that runs on a schedule should
// wrap its main() so the event bus (and hence OpenClaw gateway, dashboards,
// and daily digest) can see:
//
//   { source: <name>, type: "started"  }  — on entry
//   { source: <name>, type: "finished" }  — on clean exit
//   { source: <name>, type: "failed"   }  — on thrown error
//
// Why this exists (M4 of the OpenClaw migration, 2026-04-24): 5 launchd-
// scheduled scripts (apex-vanguard, magazine, photo-analyzer,
// photo-drop-ingest, summarize-day) emitted ZERO bus events, so the
// gateway's unified observability layer had blind spots — a failure in
// any of them would surface only when downstream consumers noticed
// missing outputs. This wrapper closes that gap without touching any
// business logic.
//
// Usage:
//   import { wrapLifecycle } from "./apex-lifecycle.mjs";
//   async function main() { /* existing code */ }
//   if (import.meta.url === `file://${process.argv[1]}`) {
//     wrapLifecycle("my-script-name", main).catch(() => process.exit(1));
//   }

import { emit } from "./apex-event-bus.mjs";

/**
 * Wraps a scheduled script's main() function with lifecycle emissions.
 *
 * Guarantees:
 *   - `started` emits BEFORE main runs (useful if main hangs — you still
 *     see it in the bus).
 *   - `finished` emits AFTER main's promise resolves cleanly.
 *   - `failed` emits on any thrown error, WITH the error message + stack.
 *   - The returned promise resolves with main's return value on success,
 *     rejects with the original error on failure. Callers should handle
 *     exit codes.
 *   - Emissions never break the script — if the bus is broken, we swallow.
 *
 * @param {string} source The event-bus source tag (kebab-case script name).
 * @param {() => Promise<any>} mainFn The script's main function.
 * @param {object} [options]
 * @param {object} [options.payloadOnStart] Extra fields to include in started event payload.
 * @returns {Promise<any>} Whatever main returns.
 */
export async function wrapLifecycle(source, mainFn, { payloadOnStart = {} } = {}) {
  if (!source || typeof source !== "string") {
    throw new Error("wrapLifecycle: source (string) required");
  }
  if (typeof mainFn !== "function") {
    throw new Error("wrapLifecycle: mainFn (function) required");
  }
  const startedAt = Date.now();
  const startIso = new Date(startedAt).toISOString();
  try {
    await emit({
      source,
      type: "started",
      payload: {
        startedAt: startIso,
        argv: process.argv.slice(2).slice(0, 20),
        ...payloadOnStart,
      },
    });
  } catch {
    /* bus down — don't fail the script on observability loss */
  }

  let result;
  try {
    result = await mainFn();
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    try {
      await emit({
        source,
        type: "failed",
        payload: {
          startedAt: startIso,
          durationMs,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? (err.stack ?? "").slice(0, 2000) : undefined,
        },
      });
    } catch {
      /* best-effort */
    }
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  try {
    await emit({
      source,
      type: "finished",
      payload: {
        startedAt: startIso,
        durationMs,
        ...(result != null && typeof result === "object" && !Array.isArray(result)
          ? { summary: compactSummary(result) }
          : {}),
      },
    });
  } catch {
    /* best-effort */
  }
  return result;
}

// Compact a possibly-large main() return value so the bus event doesn't bloat.
function compactSummary(obj) {
  try {
    const entries = Object.entries(obj);
    const out = {};
    for (const [k, v] of entries) {
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
        out[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
      } else if (v == null) {
        out[k] = v;
      } else if (Array.isArray(v)) {
        out[k] = { _len: v.length };
      } else {
        out[k] = { _type: "object" };
      }
      if (Object.keys(out).length >= 20) {
        break;
      }
    }
    return out;
  } catch {
    return null;
  }
}
