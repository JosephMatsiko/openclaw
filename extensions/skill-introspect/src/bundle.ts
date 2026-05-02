// State bundling — reads the recent operational state into a compact bundle
// the LLM prompt embeds. Each bundleX function is read-only + tolerant of
// missing files (returns empty array / null).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { IntrospectConfig } from "./config.js";
import type { StateBundle } from "./types.js";
import { listJsonByMtime, readJson, readTextHead, tailLines } from "./util.js";

function bundleRecentEvents(config: IntrospectConfig): string {
  const lines = tailLines(config.eventsPath, 100);
  return lines.join("\n");
}

function bundleDocketTasks(config: IntrospectConfig, limit = 20): Array<Record<string, unknown>> {
  const entries = listJsonByMtime(config.docketDir, limit);
  return entries
    .map((e) => readJson<Record<string, unknown> | null>(e.path, null))
    .filter((t): t is Record<string, unknown> => t !== null)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      risk: t.risk,
      commandKind: t.commandKind,
      surface: t.surface,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      createdBy: t.createdBy,
      lastHeartbeat:
        Array.isArray(t.heartbeats) && t.heartbeats.length
          ? t.heartbeats[t.heartbeats.length - 1]
          : null,
      sourceKind: (t as { source?: { kind?: string } }).source?.kind ?? null,
    }));
}

function bundleHealReceipts(config: IntrospectConfig, limit = 5): Array<Record<string, unknown>> {
  const entries = listJsonByMtime(config.macHealReceiptsDir, limit);
  return entries
    .map((e) => readJson<Record<string, unknown> | null>(e.path, null))
    .filter((r): r is Record<string, unknown> => r !== null)
    .map((r) => ({
      id: r.id ?? r.runId,
      ts: r.ts ?? r.startedAt ?? r.completedAt,
      actionsApplied: r.actionsApplied ?? r.applied ?? null,
      summary: r.summary ?? r.note ?? null,
    }));
}

function bundleNotifications(config: IntrospectConfig, limit = 10): Array<Record<string, unknown>> {
  const entries = listJsonByMtime(config.notificationLedgerDir, limit);
  return entries
    .map((e) => readJson<Record<string, unknown> | null>(e.path, null))
    .filter((n): n is Record<string, unknown> => n !== null)
    .map((n) => ({
      id: n.id,
      ts: n.ts ?? n.createdAt,
      kind: n.kind ?? n.type,
      channel: n.channel,
      title: n.title,
      sent: n.sent,
    }));
}

function bundleOpenDecisions(config: IntrospectConfig): Array<Record<string, unknown>> {
  if (!existsSync(config.decisionsDir)) return [];
  return readdirSync(config.decisionsDir)
    .filter((n) => n.startsWith("decision-") && n.endsWith(".json"))
    .map((n) => readJson<Record<string, unknown> | null>(join(config.decisionsDir, n), null))
    .filter((d): d is Record<string, unknown> => d !== null)
    .filter(
      (d) =>
        d.status === "open" ||
        ((d as { applied?: boolean }).applied === false && d.status !== "rejected"),
    )
    .map((d) => ({
      id: d.id,
      ts: d.ts,
      category: d.category,
      situation: d.situation,
      recommendation: d.recommendation,
      riskClass: d.riskClass,
      status: d.status,
    }));
}

function bundleSelfImprovementRuns(config: IntrospectConfig): Array<Record<string, unknown>> {
  const data = readJson<{
    recentScans?: unknown[];
    scans?: unknown[];
    lastScanAt?: string;
    ts?: string;
    hits?: number;
    detectedCount?: number;
    promoted?: number;
  } | null>(config.selfImprovementLastScanPath, null);
  if (!data) return [];
  if (Array.isArray(data.recentScans))
    return data.recentScans.slice(-5) as Array<Record<string, unknown>>;
  if (Array.isArray(data.scans)) return data.scans.slice(-5) as Array<Record<string, unknown>>;
  return [
    {
      lastScanAt: data.lastScanAt ?? data.ts ?? null,
      hits: data.hits ?? data.detectedCount ?? null,
      promoted: data.promoted ?? null,
    },
  ];
}

function bundleDissents(config: IntrospectConfig, limit = 20): Array<Record<string, unknown>> {
  if (!existsSync(config.dissentDir)) return [];
  return readdirSync(config.dissentDir)
    .filter((n) => n.endsWith(".json"))
    .slice(0, limit)
    .map((n) => readJson<Record<string, unknown> | null>(join(config.dissentDir, n), null))
    .filter((d): d is Record<string, unknown> => d !== null)
    .filter(
      (d) =>
        (d as { status?: string; resolvedAt?: unknown }).status !== "resolved" &&
        (d as { resolvedAt?: unknown }).resolvedAt == null,
    )
    .map((d) => ({
      id: d.id,
      ts: d.ts ?? d.createdAt,
      topic: d.topic ?? d.subject,
      voices: d.voices ?? d.dissenters,
      summary: d.summary,
    }));
}

export function bundleState(config: IntrospectConfig): StateBundle {
  const events = bundleRecentEvents(config);
  const docket = bundleDocketTasks(config, 20);
  const healReceipts = bundleHealReceipts(config, 5);
  const notifications = bundleNotifications(config, 10);
  const openDecisions = bundleOpenDecisions(config);
  const selfImprovement = bundleSelfImprovementRuns(config);
  const healthSnapshot = readJson<unknown>(config.healthSnapshotPath, null);
  const priorsLatestRaw = readTextHead(config.priorsLatestPath, config.priorHeadChars);
  const dissents = bundleDissents(config);

  return {
    bundledAt: new Date().toISOString(),
    recentEvents: events,
    docket,
    healReceipts,
    notifications,
    openDecisions,
    selfImprovement,
    healthSnapshot: healthSnapshot
      ? JSON.stringify(healthSnapshot, null, 2).slice(0, config.healthHeadChars)
      : null,
    priorsLatestHead: priorsLatestRaw,
    dissents,
  };
}

export function renderStateForPrompt(bundle: StateBundle): string {
  const sections: string[] = [];
  sections.push(`# Recent apex-events (last 100 lines)\n${bundle.recentEvents || "(none)"}`);
  sections.push(`# Docket tasks (last 20 by mtime)\n${JSON.stringify(bundle.docket, null, 2)}`);
  sections.push(
    `# mac-self-heal receipts (last 5)\n${JSON.stringify(bundle.healReceipts, null, 2)}`,
  );
  sections.push(
    `# Notification ledger (last 10)\n${JSON.stringify(bundle.notifications, null, 2)}`,
  );
  sections.push(
    `# Open decision proposals (chuck-decision-engine output)\n${JSON.stringify(bundle.openDecisions, null, 2)}`,
  );
  sections.push(
    `# Self-improvement scanner — recent runs\n${JSON.stringify(bundle.selfImprovement, null, 2)}`,
  );
  sections.push(
    `# Health snapshot${bundle.healthSnapshot ? "" : " (missing)"}\n${bundle.healthSnapshot ?? "(none)"}`,
  );
  sections.push(
    `# Active priors — head of chuck-v3/priors/latest.json${bundle.priorsLatestHead ? "" : " (missing)"}\n${bundle.priorsLatestHead ?? "(none)"}`,
  );
  sections.push(`# Open dissents\n${JSON.stringify(bundle.dissents, null, 2)}`);
  return sections.join("\n\n---\n\n");
}
