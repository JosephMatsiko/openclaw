// tick — single watchdog iteration. Probe → bail if healthy / in cooldown /
// daily-cap-hit → restart (with backoff + day bucket) → emit + save.
//
// Pure-ish: filesystem + subprocess + apex-events.jsonl emit. No global
// state. The long-running daemon (poll loop) lives in the .mjs.

import type { GatewayWatchdogConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { createEventEmitter } from "./events.js";
import { probe } from "./probe.js";
import { restartGateway } from "./restart.js";
import { ensureWatchdogDir, loadState, rollDayBucket, saveState } from "./state.js";
import type { TickResult } from "./types.js";

export interface TickOptions {
  /** When true, skip the actual launchctl kickstart but still update state. */
  dryRun?: boolean;
  /** Pin "now" for deterministic tests. */
  now?: number;
}

export async function tick(
  options: TickOptions = {},
  configIn?: GatewayWatchdogConfig,
): Promise<TickResult> {
  const config = configIn ?? resolveConfig({});
  const now = options.now ?? Date.now();
  const events = createEventEmitter(config.eventsPath);

  ensureWatchdogDir(config);
  const state = loadState(config);
  if (!state.startedAt) state.startedAt = new Date(now).toISOString();
  rollDayBucket(state, new Date(now));

  const p = probe(config, now);
  const ts = new Date(now).toISOString();
  state.lastProbe = { ts, ...p };
  state.history.push({ ts, ...p, action: null });

  if (p.healthy) {
    saveState(state, config);
    return { action: "healthy", probe: p };
  }
  if (now < state.nextRestartAllowedMs) {
    state.history[state.history.length - 1].action = "deferred-cooldown";
    saveState(state, config);
    return {
      action: "deferred-cooldown",
      probe: p,
      nextAllowedAt: new Date(state.nextRestartAllowedMs).toISOString(),
    };
  }
  if (state.restartCountToday >= config.maxRestartsPerDay) {
    state.history[state.history.length - 1].action = "daily-cap-hit";
    events.emit("chuck.gateway.watchdog.cap_hit", {
      restartCountToday: state.restartCountToday,
      max: config.maxRestartsPerDay,
      reason: p.reason,
    });
    saveState(state, config);
    return { action: "daily-cap-hit", probe: p };
  }

  events.emit("chuck.gateway.watchdog.restart_initiated", {
    pid: p.pid,
    cpu: p.cpu,
    blockSummary: p.eventLoopBlocks,
    reason: p.reason,
    restartCountToday: state.restartCountToday,
  });

  const restart = options.dryRun
    ? { ok: true, durationMs: 0, error: null, dryRun: true }
    : restartGateway(config);

  state.history[state.history.length - 1].action = restart.ok ? "restarted" : "restart-failed";
  state.history[state.history.length - 1].restart = restart;

  if (restart.ok) {
    state.restartCount += 1;
    state.restartCountToday += 1;
    state.consecutiveRestartFailures = 0;
    state.nextRestartAllowedMs = now + config.cooldownAfterRestartMs;
    events.emit("chuck.gateway.watchdog.restart_completed", {
      durationMs: restart.durationMs,
      restartCount: state.restartCount,
      restartCountToday: state.restartCountToday,
    });
  } else {
    state.consecutiveRestartFailures += 1;
    const backoff = Math.min(
      config.restartBackoffBaseMs * 2 ** (state.consecutiveRestartFailures - 1),
      config.restartBackoffMaxMs,
    );
    state.nextRestartAllowedMs = now + backoff;
    events.emit("chuck.gateway.watchdog.restart_failed", {
      error: restart.error,
      consecutiveFailures: state.consecutiveRestartFailures,
      backoffMs: backoff,
    });
  }
  saveState(state, config);
  return {
    action: restart.ok ? "restarted" : "restart-failed",
    probe: p,
    restart,
  };
}
