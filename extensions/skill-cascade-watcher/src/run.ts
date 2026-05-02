// status / test / dryRun-test command implementations. The daemon poll loop
// itself stays in the .mjs transitional duplicate (LaunchAgent invokes it);
// when openclaw cron supports long-running plugin daemons, the runDaemon()
// equivalent will land here.

import { randomBytes } from "node:crypto";
import type { CascadeWatcherConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { handleEvent } from "./handle.js";
import { fireCascade } from "./notify.js";
import { ensureWatcherDir, loadState } from "./state.js";
import { CASCADE_TRIGGERS, findTrigger, SOURCE } from "./triggers.js";
import type { BusEvent, Trigger } from "./types.js";

export interface StatusSummary {
  startedAt: string | null;
  pid: number | null;
  counts: {
    matches: number;
    fires: number;
    suppressions: number;
    promotions: number;
    activeFloodKeys: number;
  };
  recent: {
    matches: import("./types.js").MatchRecord[];
    fires: import("./types.js").FireRecord[];
    suppressions: import("./types.js").SuppressionRecord[];
    promotions: import("./types.js").PromotionRecord[];
  };
  triggerTable: Array<{
    pattern: string;
    severity: string;
    tier: string;
    hasPredicate: boolean;
  }>;
  autoPromote: {
    enabled: boolean;
    eventType: string;
    riskClasses: string[];
    docketDir: string;
  };
}

export function summarizeStatus(configIn?: CascadeWatcherConfig): StatusSummary {
  const config = configIn ?? resolveConfig({});
  const state = loadState(config);
  return {
    startedAt: state.startedAt,
    pid: state.pid,
    counts: {
      matches: state.matches.length,
      fires: state.fires.length,
      suppressions: state.suppressions.length,
      promotions: state.promotions.length,
      activeFloodKeys: Object.keys(state.floodCounters ?? {}).length,
    },
    recent: {
      matches: state.matches.slice(-10).reverse(),
      fires: state.fires.slice(-10).reverse(),
      suppressions: state.suppressions.slice(-10).reverse(),
      promotions: state.promotions.slice(-10).reverse(),
    },
    triggerTable: CASCADE_TRIGGERS.map((t: Trigger) => ({
      pattern: t.typeMatch.source,
      severity: t.severity,
      tier: t.tier,
      hasPredicate: typeof t.when === "function",
    })),
    autoPromote: {
      enabled: true,
      eventType: "chuck.introspect.observed",
      riskClasses: ["medium", "high"],
      docketDir: config.docketDir,
    },
  };
}

export interface TestOptions {
  severity?: string;
  riskClass?: string;
  dryRun?: boolean;
  batch?: unknown[];
}

export interface TestResult {
  ok: boolean;
  matched?: boolean;
  dryRun?: boolean;
  trigger?: { pattern: string; severity: string; tier: string };
  subject?: string;
  bodyPreview?: string;
  cascadeResult?: {
    delivered: boolean;
    deliveredVia: string | null;
    ledgerEntryId: string | null;
    finalReason: string | null;
    attempts: string[];
  };
  reason?: string;
  candidates?: string[];
  error?: string;
}

export async function runTest(
  eventType: string,
  options: TestOptions = {},
  configIn?: CascadeWatcherConfig,
): Promise<TestResult> {
  const config = configIn ?? resolveConfig({});
  ensureWatcherDir(config);
  if (!eventType) {
    return { ok: false, reason: "eventType is required" };
  }
  const synthetic: BusEvent = {
    id: `e-test-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    ts: new Date().toISOString(),
    actor: "chuck",
    source: "skill-cascade-watcher-test",
    type: eventType,
    payload: {
      task: { id: "task-test-watcher", title: "watcher CLI test" },
      reason: "synthetic test event",
      riskClass: options.severity === "critical" ? "high" : (options.riskClass ?? "low"),
      batch: options.batch ?? ["t1", "t2", "t3"],
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
  let subject: string;
  try {
    subject = trig.subjectFn(synthetic);
  } catch (err) {
    subject = `(subjectFn threw: ${(err as Error).message ?? err})`;
  }
  if (options.dryRun) {
    return {
      ok: true,
      matched: true,
      dryRun: true,
      trigger: { pattern: trig.typeMatch.source, severity: trig.severity, tier: trig.tier },
      subject,
      bodyPreview: JSON.stringify(synthetic.payload).slice(0, 200),
    };
  }
  const severity = (options.severity as Trigger["severity"]) ?? trig.severity;
  let cascade;
  try {
    cascade = await fireCascade({
      subject,
      body: JSON.stringify(synthetic.payload).slice(0, 600),
      severity,
      tier: trig.tier,
      origin: { kind: SOURCE, ref: synthetic.id, mode: "test" },
    });
  } catch (err) {
    return { ok: false, matched: true, error: `fireCascade threw: ${String(err)}`, subject };
  }
  return {
    ok: true,
    matched: true,
    trigger: { pattern: trig.typeMatch.source, severity, tier: trig.tier },
    subject,
    cascadeResult: {
      delivered: cascade.delivered,
      deliveredVia: cascade.channel,
      ledgerEntryId: cascade.ledgerEntryId,
      finalReason: cascade.finalReason ?? null,
      attempts: (cascade.attempts ?? []).map(
        (a) => `${a.channel}:${a.ok ? "ok" : a.skipped ? "skip" : "fail"}`,
      ),
    },
  };
}

export { handleEvent };
