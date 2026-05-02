// runFocus — Joseph-asks-a-targeted-question entry point. Same pipeline as
// scan but the prompt embeds Joseph's topic + asks for prose answer wrapped
// around an optional <OBSERVATIONS>...</OBSERVATIONS> block. Focus-mode does
// NOT block on full fingerprint dedup — Joseph asked specifically — but
// still skips exact duplicates from the last 24h.

import { randomUUID } from "node:crypto";
import { bundleState } from "./bundle.js";
import type { IntrospectConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { dispatchClaudeCli } from "./dispatch.js";
import { normalizeObservation, tryParseObservations } from "./parse.js";
import { buildFocusPrompt } from "./prompt.js";
import { loadAllIntrospections, loadLastScan, saveLastScan, writeIntrospection } from "./store.js";
import type { FocusOptions, FocusResult, IntrospectionRecord } from "./types.js";
import { createEventEmitter, ensureDir, fingerprint, introspectId } from "./util.js";

const HOUR_MS = 60 * 60 * 1000;

export async function runFocus(
  topic: string,
  options: FocusOptions = {},
  configIn?: IntrospectConfig,
): Promise<FocusResult> {
  const config = configIn ?? resolveConfig({});
  const events = createEventEmitter(config.eventsPath);
  const dispatch = options.dispatch ?? ((p: string) => dispatchClaudeCli(p, config));

  ensureDir(config.introspectionsDir);
  const scanRunId = randomUUID();
  const startedAt = Date.now();
  const bundle = bundleState(config);
  const prompt = buildFocusPrompt(topic, bundle);

  events.emit("chuck.introspect.scan.started", {
    scanRunId,
    mode: "focus",
    topic,
    promptSize: prompt.length,
  });

  let result;
  try {
    result = await dispatch(prompt);
  } catch (err) {
    events.emit("chuck.introspect.scan.completed", {
      scanRunId,
      mode: "focus",
      observationsCount: 0,
      durationMs: Date.now() - startedAt,
      error: `dispatch threw: ${(err as Error).message ?? err}`,
    });
    return { mode: "focus", scanRunId, topic, error: String((err as Error).message ?? err) };
  }

  if (result.timedOut || result.exitCode !== 0) {
    events.emit("chuck.introspect.scan.completed", {
      scanRunId,
      mode: "focus",
      observationsCount: 0,
      durationMs: Date.now() - startedAt,
      error: result.timedOut ? "claude-cli timed out" : `claude-cli exit=${result.exitCode}`,
    });
    return {
      mode: "focus",
      scanRunId,
      topic,
      error: result.timedOut ? "timeout" : `exit=${result.exitCode}`,
    };
  }

  const stdout = result.stdout ?? "";
  const parsed = tryParseObservations(stdout);
  const lastScan = loadLastScan(config);
  const allRecords = loadAllIntrospections(config);

  const emitted: IntrospectionRecord[] = [];
  for (const raw of parsed) {
    if (emitted.length >= config.maxObservationsPerScan) break;
    const obs = normalizeObservation(raw);
    if (!obs) continue;
    const fp = fingerprint(obs.category, obs.recommendation);
    // Focus-mode dedup: only skip exact-duplicate from last 24h.
    const cutoff = Date.now() - 24 * HOUR_MS;
    const dup = allRecords.find(
      (r) => r.fingerprint === fp && !r.dismissed && r.ts && Date.parse(r.ts) >= cutoff,
    );
    if (dup) continue;
    const id = introspectId();
    const nowIso = new Date().toISOString();
    const record: IntrospectionRecord = {
      id,
      ts: nowIso,
      scanRunId,
      mode: "focus",
      topic,
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
      mode: "focus",
    });
    emitted.push(record);
    lastScan.fingerprints = [
      fp,
      ...(Array.isArray(lastScan.fingerprints)
        ? lastScan.fingerprints.filter((f) => f !== fp)
        : []),
    ].slice(0, config.fingerprintHistoryCap);
  }

  lastScan.lastFocusAt = new Date().toISOString();
  lastScan.lastFocusTopic = topic;
  saveLastScan(lastScan, config);

  const durationMs = Date.now() - startedAt;
  events.emit("chuck.introspect.scan.completed", {
    scanRunId,
    mode: "focus",
    observationsCount: emitted.length,
    durationMs,
  });

  return {
    mode: "focus",
    scanRunId,
    durationMs,
    topic,
    promptSize: prompt.length,
    answer: stdout,
    emitted: emitted.map((e) => ({
      id: e.id,
      category: e.category,
      riskClass: e.riskClass,
      observation: e.observation,
      recommendation: e.recommendation,
    })),
  };
}
