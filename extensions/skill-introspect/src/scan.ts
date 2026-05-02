// runScan — primary entry point. Bundle state → build prompt → dispatch
// claude-cli → parse observations → idempotency-filter → write records →
// emit chuck.introspect.observed events.

import { randomUUID } from "node:crypto";
import { bundleState } from "./bundle.js";
import type { IntrospectConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { dispatchClaudeCli } from "./dispatch.js";
import { normalizeObservation, tryParseObservations } from "./parse.js";
import { buildScanPrompt } from "./prompt.js";
import {
  isFingerprintBlocked,
  loadAllIntrospections,
  loadLastScan,
  saveLastScan,
  writeIntrospection,
} from "./store.js";
import type { IntrospectionRecord, ScanOptions, ScanResult } from "./types.js";
import { createEventEmitter, ensureDir, fingerprint, introspectId } from "./util.js";

export async function runScan(
  options: ScanOptions = {},
  configIn?: IntrospectConfig,
): Promise<ScanResult> {
  const config = configIn ?? resolveConfig({});
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now();
  const events = createEventEmitter(config.eventsPath);
  const dispatch = options.dispatch ?? ((p: string) => dispatchClaudeCli(p, config));

  ensureDir(config.introspectionsDir);
  const scanRunId = randomUUID();
  const startedAt = now;

  const bundle = bundleState(config);
  const prompt = buildScanPrompt(bundle, config);

  if (dryRun) {
    return {
      mode: "scan",
      scanRunId,
      promptSize: prompt.length,
      promptHead: prompt.slice(0, 1200),
      bundleStats: {
        recentEventsBytes: bundle.recentEvents.length,
        docketCount: bundle.docket.length,
        healReceiptsCount: bundle.healReceipts.length,
        notificationsCount: bundle.notifications.length,
        openDecisionsCount: bundle.openDecisions.length,
        selfImprovementCount: bundle.selfImprovement.length,
        healthSnapshotPresent: bundle.healthSnapshot != null,
        priorsLatestHeadBytes: bundle.priorsLatestHead?.length ?? 0,
        dissentsCount: bundle.dissents.length,
      },
      dryRun: true,
    };
  }

  events.emit("chuck.introspect.scan.started", { scanRunId, promptSize: prompt.length });

  let result;
  try {
    result = await dispatch(prompt);
  } catch (err) {
    events.emit("chuck.introspect.scan.completed", {
      scanRunId,
      observationsCount: 0,
      durationMs: Date.now() - startedAt,
      error: `dispatch threw: ${(err as Error).message ?? err}`,
    });
    return { mode: "scan", scanRunId, error: String((err as Error).message ?? err) };
  }

  if (result.timedOut || result.exitCode !== 0) {
    events.emit("chuck.introspect.scan.completed", {
      scanRunId,
      observationsCount: 0,
      durationMs: Date.now() - startedAt,
      error: result.timedOut ? "claude-cli timed out" : `claude-cli exit=${result.exitCode}`,
      stderrTail: (result.stderr ?? "").slice(-400),
    });
    return {
      mode: "scan",
      scanRunId,
      error: result.timedOut ? "timeout" : `exit=${result.exitCode}`,
    };
  }

  const parsed = tryParseObservations(result.stdout);
  const lastScan = loadLastScan(config);
  const allRecords = loadAllIntrospections(config);

  const emitted: IntrospectionRecord[] = [];
  const skipped: ScanResult["skipped"] = [];
  for (const raw of parsed) {
    if (emitted.length >= config.maxObservationsPerScan) break;
    const obs = normalizeObservation(raw);
    if (!obs) {
      skipped?.push({ reason: "malformed", raw });
      continue;
    }
    const fp = fingerprint(obs.category, obs.recommendation);
    if (isFingerprintBlocked(fp, lastScan, allRecords, config, now)) {
      skipped?.push({ reason: "duplicate-fingerprint", fp, category: obs.category });
      continue;
    }
    const id = introspectId();
    const nowIso = new Date().toISOString();
    const record: IntrospectionRecord = {
      id,
      ts: nowIso,
      scanRunId,
      mode: "scan",
      category: obs.category,
      observation: obs.observation,
      whyNovel: obs.whyNovel,
      recommendation: obs.recommendation,
      riskClass: obs.riskClass,
      rationale: obs.rationale,
      evidence: obs.evidence,
      fingerprint: fp,
      proposedId: obs.proposedId,
      applied: false,
      appliedAt: null,
      dismissed: false,
      dismissedAt: null,
      dismissedReason: null,
    };
    writeIntrospection(record, config);
    events.emit("chuck.introspect.observed", {
      introspectId: id,
      category: record.category,
      riskClass: record.riskClass,
      recommendation: record.recommendation,
    });
    emitted.push(record);
    lastScan.fingerprints = [
      fp,
      ...(Array.isArray(lastScan.fingerprints)
        ? lastScan.fingerprints.filter((f) => f !== fp)
        : []),
    ].slice(0, config.fingerprintHistoryCap);
  }

  lastScan.lastScanAt = new Date().toISOString();
  lastScan.lastScanRunId = scanRunId;
  lastScan.lastEmittedCount = emitted.length;
  saveLastScan(lastScan, config);

  const durationMs = Date.now() - startedAt;
  events.emit("chuck.introspect.scan.completed", {
    scanRunId,
    observationsCount: emitted.length,
    durationMs,
  });

  return {
    mode: "scan",
    scanRunId,
    durationMs,
    promptSize: prompt.length,
    rawSize: (result.stdout ?? "").length,
    parsedCount: parsed.length,
    emitted: emitted.map((e) => ({
      id: e.id,
      category: e.category,
      riskClass: e.riskClass,
      observation: e.observation,
      recommendation: e.recommendation,
    })),
    skipped,
  };
}
