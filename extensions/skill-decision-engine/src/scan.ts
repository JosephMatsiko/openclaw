// runScan — main orchestrator. Loads docket + events, runs every detector,
// dedupes against the fingerprint window, applies the per-scan flood cap,
// optionally auto-applies low-risk docket promotions, and stages the rest
// as proposals + Telegram notifications.

import { dropFollowupDocketTask } from "./auto-apply.js";
import type { DecisionEngineConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { ALL_DETECTORS } from "./detectors/index.js";
import { loadDocket, loadEvents } from "./loaders.js";
import { sendProposalNotification } from "./notify.js";
import { shouldAutoApply } from "./policy.js";
import { loadDecisions, loadLastScan, saveLastScan, writeDecision } from "./store.js";
import type { DetectorContext, Proposal, ScanOptions, ScanSummary } from "./types.js";
import { createEventEmitter, decisionId, ensureDir } from "./util.js";

const HOUR_MS = 60 * 60 * 1000;

export async function runScan(
  options: ScanOptions = {},
  configIn?: DecisionEngineConfig,
): Promise<ScanSummary> {
  const config = configIn ?? resolveConfig({});
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const events = createEventEmitter(config.eventsPath);

  ensureDir(config.decisionsDir);

  if (!dryRun) events.emit("chuck.decision.scan.started", { dryRun: false });

  const tasks = loadDocket(config.docketDir);
  const eventLog = loadEvents(config.eventsPath, 500);
  const ctx: DetectorContext = { tasks, events: eventLog, config, now };

  const lastScan = loadLastScan(config);
  const fpDeduped = lastScan.fingerprints ?? {};
  const cutoffDedup = now.getTime() - config.fingerprintDedupHours * HOUR_MS;
  const allHits = [];

  for (const detector of ALL_DETECTORS) {
    let hit = null;
    try {
      hit = detector(ctx);
    } catch (err) {
      // Detector failures must never kill the scan.
      hit = null;
      process.stderr.write(`[skill-decision-engine] detector error: ${String(err)}\n`);
    }
    if (!hit) continue;
    const last = fpDeduped[hit.fingerprint];
    if (last?.ts && Date.parse(last.ts) >= cutoffDedup) continue;
    // Skip if a rejected decision exists for this fingerprint.
    const rejected = loadDecisions(config).some(
      (dec) => dec.fingerprint === hit?.fingerprint && dec.status === "rejected",
    );
    if (rejected) continue;
    allHits.push(hit);
  }

  const toEmit = allHits.slice(0, config.maxProposalsPerScan);
  const skipped = allHits.length - toEmit.length;

  const proposals: Proposal[] = [];
  for (const hit of toEmit) {
    const id = decisionId();
    const proposal: Proposal = {
      ...hit,
      id,
      ts: new Date().toISOString(),
      autoApply: false,
      applied: false,
      appliedAt: null,
      appliedAction: null,
      approvalNeeded: hit.riskClass !== "low",
      approvalChannel: "telegram",
      approvalChatId: config.telegramChatId,
      status: "open",
    };
    proposal.autoApply = shouldAutoApply(proposal);

    if (dryRun) {
      proposals.push(proposal);
      continue;
    }

    if (proposal.autoApply) {
      const result = dropFollowupDocketTask(proposal, config);
      proposal.applied = true;
      proposal.appliedAt = new Date().toISOString();
      proposal.appliedAction = result.action;
      proposal.status = "applied";
    }
    writeDecision(proposal, config);
    events.emit("chuck.decision.proposed", {
      decisionId: proposal.id,
      category: proposal.category,
      riskClass: proposal.riskClass,
      recommendation: proposal.recommendation,
    });
    if (proposal.applied) {
      events.emit("chuck.decision.applied", {
        decisionId: proposal.id,
        action: proposal.appliedAction,
      });
    } else if (proposal.approvalNeeded) {
      const tg = await sendProposalNotification(proposal);
      events.emit("chuck.decision.notification_sent", {
        decisionId: proposal.id,
        channel: "telegram",
        chatId: config.telegramChatId,
        sent: tg.sent,
        reason: tg.reason ?? null,
        transport: tg.transport ?? null,
        messageId: tg.messageId ?? null,
      });
    }
    fpDeduped[proposal.fingerprint] = { ts: proposal.ts, decisionId: proposal.id };
    proposals.push(proposal);
  }

  if (!dryRun) {
    saveLastScan({ lastScanAt: new Date().toISOString(), fingerprints: fpDeduped }, config);
  }

  return {
    dryRun,
    detectorsRun: ALL_DETECTORS.length,
    hits: allHits.length,
    emitted: proposals.length,
    floodSkipped: skipped,
    proposals: proposals.map((p) => ({
      id: p.id,
      category: p.category,
      riskClass: p.riskClass,
      autoApply: p.autoApply,
      applied: p.applied,
      recommendation: p.recommendation,
    })),
  };
}
