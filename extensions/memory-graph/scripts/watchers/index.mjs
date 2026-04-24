#!/usr/bin/env node
// Watchers + Jobs daemon — registry + lifecycle for the Apex.
//
// Runs as a long-lived process under launchd (KeepAlive). Two registries:
//
//   WATCHERS — poll external sources, emit events. Each exports `scanOnce()`.
//   JOBS     — internal processors that READ the bus and act. Each exports
//              a `runOnce()` (or `runXxx`) that returns a small summary.
//
// Both run on interval-based ticks with per-entry lastRun tracking. The
// daemon loops every 60s, fires due entries, sleeps. Cross-process
// subscribers (Vanguard, Claude Desktop MCP) observe effects via the bus.
//
// Adding a new watcher: export scanOnce() and add to WATCHERS below.
// Adding a new job:    export runXxx() and add to JOBS with a runner wrapper.

import { runAnticipator } from "../apex-anticipator.mjs";
import { runArcInitiator } from "../apex-arc-initiator.mjs";
import { runArcTracker } from "../apex-arc-tracker.mjs";
import { runBetter } from "../apex-better.mjs";
import { runCompetitiveMapper } from "../apex-competitive-mapper.mjs";
import { runCorrelator } from "../apex-correlator.mjs";
import { runDailyDigest } from "../apex-daily-digest.mjs";
import { dominion_verify, dominion_compound } from "../apex-dominion.mjs";
import { runDriftScan } from "../apex-drift-scan.mjs";
import { runEndeavorLint } from "../apex-endeavor-lint.mjs";
import { emit } from "../apex-event-bus.mjs";
import { runExfilDaemonTick } from "../apex-exfil.mjs";
import { runCoordinator } from "../apex-fleet-coordinator.mjs";
import { runFrontierScan } from "../apex-frontier-scan.mjs";
import { runHorizonWeekly } from "../apex-horizon-weekly.mjs";
import { runInferer } from "../apex-inferer.mjs";
import { runLookahead } from "../apex-lookahead.mjs";
import { runRegistryWatcher } from "../apex-mcp-registry-watcher.mjs";
import { runCleanup as runProposalCleanup } from "../apex-proposal-cleanup.mjs";
import { runHandler as runProposerHandler } from "../apex-proposer-handler.mjs";
import { proposeToTelegram } from "../apex-proposer-telegram.mjs";
import { runUsageHeat } from "../apex-usage-heat.mjs";
import { runTrigger as runVanguardTrigger } from "../apex-vanguard-trigger.mjs";
import { runTrigger as runVideoTrigger } from "../apex-video-trigger.mjs";
import { runDrafter as runGmailDrafter } from "../gmail-reply-drafter.mjs";
import { run as runObsidianWriter } from "../obsidian-writer.mjs";
import { scanOnce as academicScan } from "./academic-watcher.mjs";
import { scanOnce as agentActivityScan } from "./agent-activity-watcher.mjs";
import { tick as runApexCapabilityAbsorption } from "./apex-capability-absorption.mjs";
// apex-chrome-cookie-refresh folded into apex-profile-worker-daemon 2026-04-23.
// Reason: standalone watcher spawns a subprocess with APEX_CHROME_PROFILE=<p>
// that opens its own CDP connection to the per-profile port. That path is
// TCP-only — in pipe mode Chrome's debugger is reachable only via the pipe
// fds the daemon owns, and the profile directory is exclusively locked.
// The daemon now runs sideloadCookies on its own hourly timer against the
// CDP connection it already has. See apex-profile-worker-daemon.mjs.
import { tick as runApexChromeFingerprintAudit } from "./apex-chrome-fingerprint-audit.mjs";
import { tick as runApexChromeSelectorFarm } from "./apex-chrome-selector-farm.mjs";
import { scanOnce as calendarScan } from "./calendar-watcher.mjs";
import { scanOnce as crossDeviceScan } from "./cross-device-watcher.mjs";
import { scanOnce as filesystemScan } from "./filesystem-watcher.mjs";
import { scanOnce as gitScan } from "./git-watcher.mjs";
import { scanOnce as gmailScan } from "./gmail-watcher.mjs";
import { scanOnce as imessageScan } from "./imessage-watcher.mjs";
import { scanOnce as obsidianScan } from "./obsidian-watcher.mjs";
import { scanOnce as ringFeedsScan } from "./ring-feeds-watcher.mjs";
import { scanOnce as sermonScan } from "./sermon-watcher.mjs";
import { scanOnce as whatsappScan } from "./whatsapp-watcher.mjs";
import { scanOnce as ytChannelScan } from "./yt-channel-watcher.mjs";

const DEFAULT_TICK_MS = 60 * 1000;

// Quiet hours — REMOVED per Joseph's directive (arbitrary limits rejected).
// Previously the daemon gated Telegram-sending jobs between 23:00-08:00 CDT;
// we no longer do that. The Apex fires when it has something to say.
function inQuietHours() {
  return false;
}

const WATCHERS = [
  { name: "imessage", intervalMs: 2 * 60 * 1000, scan: imessageScan },
  { name: "obsidian", intervalMs: 5 * 60 * 1000, scan: obsidianScan },
  { name: "calendar", intervalMs: 15 * 60 * 1000, scan: calendarScan },
  { name: "filesystem", intervalMs: 3 * 60 * 1000, scan: filesystemScan },
  { name: "agent-activity", intervalMs: 2 * 60 * 1000, scan: agentActivityScan },
  { name: "gmail", intervalMs: 5 * 60 * 1000, scan: gmailScan },
  { name: "git", intervalMs: 10 * 60 * 1000, scan: gitScan },
  { name: "sermon", intervalMs: 60 * 60 * 1000, scan: sermonScan },
  { name: "academic", intervalMs: 60 * 60 * 1000, scan: academicScan },
  { name: "ring-feeds", intervalMs: 45 * 60 * 1000, scan: ringFeedsScan },
  { name: "whatsapp", intervalMs: 2 * 60 * 1000, scan: whatsappScan },
  { name: "cross-device", intervalMs: 5 * 60 * 1000, scan: crossDeviceScan },
  { name: "yt-channel", intervalMs: 30 * 60 * 1000, scan: ytChannelScan },
];

// Jobs — internal processors. Each `run` returns a summary object.
// Cadences tuned for leverage vs cost.
const JOBS = [
  {
    name: "apex-fleet-coordinator",
    intervalMs: 15 * 60 * 1000,
    run: () => runCoordinator({ dryRun: false, escalate: true }),
  },
  {
    name: "apex-vanguard-trigger",
    intervalMs: 10 * 60 * 1000,
    run: () => runVanguardTrigger({ dryRun: false }),
  },
  {
    name: "apex-lookahead",
    intervalMs: 15 * 60 * 1000,
    respectQuietHours: true,
    run: () => runLookahead({ sinceMs: Date.now() - 4 * 60 * 60 * 1000, dryRun: false }),
  },
  {
    name: "apex-correlator",
    intervalMs: 6 * 60 * 60 * 1000,
    run: () => runCorrelator({ windowHours: 72, dryRun: false }),
  },
  {
    name: "apex-arc-tracker",
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => runArcTracker({ windowWeeks: 8, dryRun: false }),
  },
  {
    name: "apex-anticipator",
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => runAnticipator({ windowDays: 30, dryRun: false }),
  },
  {
    name: "apex-inferer",
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => runInferer({ dryRun: false }),
  },
  {
    name: "apex-proposer-telegram",
    intervalMs: 24 * 60 * 60 * 1000,
    respectQuietHours: true,
    // Fires shortly after inferer on the same daily cadence.
    run: () => proposeToTelegram({ dryRun: false, max: 25 }),
  },
  {
    name: "gmail-reply-drafter",
    intervalMs: 15 * 60 * 1000,
    run: () =>
      runGmailDrafter({
        sinceMs: Date.now() - 6 * 60 * 60 * 1000,
        max: 3,
        dryRun: false,
      }),
  },
  {
    name: "apex-proposer-handler",
    intervalMs: 5 * 60 * 1000, // act on Joseph's /apex-* commands quickly
    run: () => runProposerHandler({ sinceMs: Date.now() - 24 * 60 * 60 * 1000, dryRun: false }),
  },
  {
    name: "apex-horizon-weekly",
    intervalMs: 7 * 24 * 60 * 60 * 1000,
    respectQuietHours: true,
    run: () => runHorizonWeekly({ dryRun: false, ping: true }),
  },
  {
    name: "apex-frontier-scan",
    intervalMs: 30 * 24 * 60 * 60 * 1000,
    respectQuietHours: true,
    run: () => runFrontierScan({ dryRun: false, ping: true }),
  },
  {
    name: "obsidian-writer",
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => runObsidianWriter({ mode: "all", dryRun: false }),
  },
  {
    name: "apex-drift-scan",
    intervalMs: 90 * 24 * 60 * 60 * 1000, // quarterly
    run: () => runDriftScan({ baseline: false, dryRun: false }),
  },
  {
    // Feedback-writeback edge: rolls apex-graph-usage JSONL events into
    // per-node heat scores. Daily so daily-digest + drift-scan read a
    // fresh rollup, not stale deciles.
    name: "apex-usage-heat",
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => runUsageHeat({ dryRun: false }),
  },
  {
    name: "apex-daily-digest",
    intervalMs: 24 * 60 * 60 * 1000,
    respectQuietHours: true,
    run: () => runDailyDigest({ windowHours: 24, dryRun: false, ping: true }),
  },
  {
    name: "apex-mcp-registry-watcher",
    intervalMs: 7 * 24 * 60 * 60 * 1000, // weekly MCP registry sweep
    run: () => runRegistryWatcher({ dryRun: false }),
  },
  {
    name: "apex-arc-initiator",
    intervalMs: 6 * 60 * 60 * 1000, // every 6 hours
    run: () => runArcInitiator({ dryRun: false }),
  },
  {
    name: "apex-proposal-cleanup",
    intervalMs: 12 * 60 * 60 * 1000, // twice daily
    run: () => runProposalCleanup({ dryRun: false, autoTop: 5 }),
  },
  {
    // Maps frontier-scan release-detected events → endeavor item priority
    // shifts. Field motion drives endeavor response.
    name: "apex-competitive-mapper",
    intervalMs: 15 * 60 * 1000,
    run: () => runCompetitiveMapper({ dryRun: false }),
  },
  {
    // Ring-invariant audit — soft check that every script declares a vector.
    // Reports through the bus; never blocks.
    name: "apex-endeavor-lint",
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => runEndeavorLint({ dryRun: false, strict: false }),
  },
  {
    // Data Dominance (V2.2) — runner checks registered exporters for
    // due-ness. Individual exporters manage their own cadences (iMessage
    // weekly, future Gmail monthly, etc.). Outer check every 4h is cheap.
    name: "apex-exfil",
    intervalMs: 4 * 60 * 60 * 1000,
    run: () => runExfilDaemonTick({}),
  },
  {
    // Universal exponential loop — health-probes every registered capability,
    // autopromotes dead → healthy successor (self-heal first, then fallbacks),
    // autocreates when improve-scan finds a winning candidate. Fleet-wide
    // rate-limited (5 autoactions/day), per-capability cooldown (6h), fully
    // audit-logged at ~/.openclaw/logs/apex-better.jsonl.
    name: "apex-better",
    intervalMs: 6 * 60 * 60 * 1000,
    run: () => runBetter({ dryRun: false }),
  },
  {
    // Dominion self-test: verifies every critical capability is live.
    // Failures auto-emit capability-gap proposals via apex-dominion.
    name: "apex-dominion-verify",
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => dominion_verify({}),
  },
  {
    // Compound recent tool invocations + open capability gaps into a daily
    // synthesis node. Feeds into the morning digest.
    name: "apex-dominion-compound",
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => dominion_compound({ sinceHours: 24 }),
  },
  {
    // Auto-ingest YouTube URLs discovered in the event bus (ring-feeds,
    // Safari visits, etc) into memory-graph video nodes. Throttled to
    // max 2 per tick, framesOnly by default (no whisper cost).
    name: "apex-video-trigger",
    intervalMs: 30 * 60 * 1000,
    run: () => runVideoTrigger({ maxPerTick: 2 }),
  },
  {
    // Hourly Apex Chrome fingerprint audit — probes navigator,
    // plugins, WebGL, UA. Drop > 10% score → flag drift via event bus.
    // (apex-chrome-cookie-refresh folded into apex-profile-worker-daemon
    // — see that file and the import-block comment above. The daemon
    // runs Storage.setCookies on its own CDP connection hourly, so the
    // standalone watcher is redundant.)
    name: "apex-chrome-fingerprint-audit",
    intervalMs: 60 * 60 * 1000,
    run: () => runApexChromeFingerprintAudit(),
  },
  {
    // Weekly selector farm — probes each Chrome worker's DOM selectors
    // against live sites. Records regressions for review + proposes
    // replacements via Claude Vision. Never auto-patches production.
    name: "apex-chrome-selector-farm",
    intervalMs: 7 * 24 * 60 * 60 * 1000,
    run: () => runApexChromeSelectorFarm(),
  },
  {
    // Monthly scan of Claude-in-Chrome tool surface — detects new
    // features Anthropic ships so Apex can absorb parity.
    name: "apex-capability-absorption",
    intervalMs: 30 * 24 * 60 * 60 * 1000,
    run: () => runApexCapabilityAbsorption(),
  },
];

function parseArgs(argv) {
  const out = { once: false, only: null, tickMs: DEFAULT_TICK_MS, skipJobs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--once") {
      out.once = true;
    } else if (t === "--only") {
      out.only = String(argv[i + 1] ?? "");
      i += 1;
    } else if (t === "--tick-ms") {
      out.tickMs = Number.parseInt(argv[i + 1] ?? String(DEFAULT_TICK_MS), 10);
      i += 1;
    } else if (t === "--skip-jobs") {
      out.skipJobs = true;
    } else if (t === "-h" || t === "--help") {
      console.log("usage: watchers/index.mjs [--once] [--only <name>] [--tick-ms N] [--skip-jobs]");
      process.exit(0);
    }
  }
  return out;
}

async function runPass({ only, lastRuns, entries, label }) {
  const results = [];
  for (const e of entries) {
    if (only && e.name !== only) {
      continue;
    }
    const last = lastRuns.get(e.name) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < e.intervalMs && !only) {
      continue;
    }
    if (e.respectQuietHours && inQuietHours() && !only) {
      results.push({ name: e.name, skipped: "quiet-hours" });
      continue;
    }
    try {
      const fn = e.scan ?? e.run;
      const res = await fn();
      lastRuns.set(e.name, Date.now());
      results.push({ name: e.name, ...res });
      const emittedCount = Number(res?.emitted ?? 0);
      const changedCount = Number(res?.changes?.length ?? 0);
      const sentCount = Number(res?.sent ?? 0);
      const execedCount = Number(res?.executed?.length ?? 0);
      const draftedCount = Number(res?.drafted ?? 0);
      const interesting = emittedCount + changedCount + sentCount + execedCount + draftedCount;
      if (interesting > 0) {
        console.error(
          `[${label}] ${e.name}: ${JSON.stringify({
            emitted: emittedCount || undefined,
            changes: changedCount || undefined,
            sent: sentCount || undefined,
            executed: execedCount || undefined,
            drafted: draftedCount || undefined,
          })}`,
        );
      }
    } catch (err) {
      console.error(
        `[${label}] ${e.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({ name: e.name, error: String(err?.message ?? err) });
      // Mark the run time even on failure so we don't retry-storm every 60s.
      // Use a conservative error-cooldown: min(intervalMs, 5 min).
      // A persistently broken 24h job now retries every 5m instead of every tick.
      const backoff = Math.min(e.intervalMs, 5 * 60 * 1000);
      lastRuns.set(e.name, Date.now() - (e.intervalMs - backoff));
    }
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lastRuns = new Map();

  if (args.once) {
    const watchers = await runPass({
      only: args.only,
      lastRuns,
      entries: WATCHERS,
      label: "watchers",
    });
    const jobs = args.skipJobs
      ? []
      : await runPass({ only: args.only, lastRuns, entries: JOBS, label: "jobs" });
    console.log(JSON.stringify({ mode: "once", watchers, jobs }, null, 2));
    return;
  }

  console.error(
    `[watchers] daemon started · watchers=${WATCHERS.map((w) => w.name).join(",")} · jobs=${JOBS.map((j) => j.name).join(",")} · tick=${args.tickMs}ms`,
  );
  await emit({
    source: "watchers-daemon",
    type: "started",
    payload: {
      pid: process.pid,
      watchers: WATCHERS.map((w) => w.name),
      jobs: JOBS.map((j) => j.name),
    },
  });

  const state = { stopping: false };
  const stop = async (sig) => {
    if (state.stopping) {
      return;
    }
    state.stopping = true;
    console.error(`[watchers] ${sig} — shutting down`);
    await emit({
      source: "watchers-daemon",
      type: "stopped",
      payload: { pid: process.pid, signal: sig },
    });
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const heartbeatMs = 10 * 60 * 1000;
  let lastHeartbeat = Date.now();

  while (!state.stopping) {
    await runPass({ only: args.only, lastRuns, entries: WATCHERS, label: "watchers" });
    if (!args.skipJobs) {
      await runPass({ only: args.only, lastRuns, entries: JOBS, label: "jobs" });
    }
    if (Date.now() - lastHeartbeat >= heartbeatMs) {
      await emit({
        source: "watchers-daemon",
        type: "heartbeat",
        payload: { pid: process.pid, uptimeMs: process.uptime() * 1000 },
      });
      lastHeartbeat = Date.now();
    }
    await sleep(args.tickMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(`[watchers] fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
