// computeDigest — pure read of docket + events; aggregates into a typed
// DigestData record. No I/O beyond filesystem reads.
//
// Anchoring: window starts at yesterday's `anchorHour:anchorMinute` local
// time. Even when run AFTER today's anchor (e.g. 09:00), the window still
// starts at YESTERDAY's anchor — that's the intentional "look back at the
// last full day" semantics chuck-morning-digest shipped with.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MorningDigestConfig } from "./config.js";
import type { DecisionEvent, DigestData, DigestWindow, DocketTaskRecord } from "./types.js";

const SHIPPED_STATUSES = new Set(["completed", "done", "closed", "shipped", "succeeded"]);

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function listDocketFiles(docketDir: string): string[] {
  if (!existsSync(docketDir)) return [];
  try {
    return readdirSync(docketDir)
      .filter((n) => n.startsWith("task-") && n.endsWith(".json"))
      .map((n) => join(docketDir, n));
  } catch {
    return [];
  }
}

function parseTs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = Date.parse(typeof v === "number" ? new Date(v).toISOString() : v);
  return Number.isFinite(t) ? t : null;
}

export function computeWindow(
  config: Pick<MorningDigestConfig, "anchorHour" | "anchorMinute">,
  now: Date = new Date(),
): DigestWindow {
  const start = new Date(now);
  start.setHours(config.anchorHour, config.anchorMinute, 0, 0);
  // Always anchor to YESTERDAY's anchor — even when called before today's anchor.
  // This matches the chuck-morning-digest.mjs semantics: a digest at 06:00 covers
  // yesterday-08:05 -> now (so the prior morning's anchor closes the prior day).
  start.setDate(start.getDate() - 1);
  return {
    startMs: start.getTime(),
    startIso: start.toISOString(),
    endMs: now.getTime(),
    endIso: now.toISOString(),
  };
}

function loadTasks(docketDir: string): DocketTaskRecord[] {
  const out: DocketTaskRecord[] = [];
  for (const path of listDocketFiles(docketDir)) {
    const data = readJson<Record<string, unknown> | null>(path, null);
    if (!data) continue;
    const status = String((data.status as string | undefined) ?? "unknown").toLowerCase();
    const updatedAt = parseTs(
      data.updatedAt ?? data.finishedAt ?? data.startedAt ?? data.createdAt,
    );
    const finishedAt = parseTs(data.finishedAt);
    const createdAt = parseTs(data.createdAt);
    const id = String(
      data.id ??
        data.taskId ??
        path
          .split("/")
          .pop()
          ?.replace(/\.json$/, "") ??
        "(unknown)",
    );
    const title = String(data.title ?? data.intent ?? data.summary ?? "(untitled)");
    const awaiting =
      (data.awaiting as string | boolean | null | undefined) ??
      (data.awaitingOperator as boolean | undefined) ??
      null;
    out.push({
      id,
      title,
      status,
      awaiting: awaiting ?? null,
      updatedAt,
      finishedAt,
      createdAt,
      raw: data,
    });
  }
  return out;
}

function readDecisionEvents(eventsPath: string, startMs: number, endMs: number): DecisionEvent[] {
  if (!existsSync(eventsPath)) return [];
  const lines = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const out: DecisionEvent[] = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as { ts?: string; type?: string; source?: string };
      const ts = parseTs(ev.ts);
      if (!ts || ts < startMs || ts > endMs) continue;
      if (typeof ev.type === "string" && ev.type.startsWith("chuck.decision.")) {
        out.push({ ts: ev.ts ?? "", type: ev.type, source: ev.source ?? null });
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeDigest(config: MorningDigestConfig, now: Date = new Date()): DigestData {
  const window = computeWindow(config, now);
  const tasks = loadTasks(config.docketDir);

  const shipped = tasks.filter(
    (t) =>
      SHIPPED_STATUSES.has(t.status) &&
      t.finishedAt != null &&
      t.finishedAt >= window.startMs &&
      t.finishedAt <= window.endMs,
  );

  const blockers = tasks.filter(
    (t) =>
      (t.status === "blocked" || t.status === "failed") &&
      (t.updatedAt ?? 0) >= window.startMs &&
      (t.updatedAt ?? 0) <= window.endMs,
  );

  const decisions = readDecisionEvents(config.eventsPath, window.startMs, window.endMs);

  // awaiting: explicit awaiting=joseph markers, otherwise pending tasks > 24h old.
  const explicit = tasks.filter(
    (t) =>
      t.status === "pending" &&
      (t.awaiting === "joseph" ||
        t.awaiting === true ||
        (t.raw.awaitingOperator as boolean | undefined) === true),
  );
  const awaiting =
    explicit.length > 0
      ? explicit
      : tasks.filter(
          (t) =>
            t.status === "pending" && t.createdAt != null && now.getTime() - t.createdAt > DAY_MS,
        );

  return { window, shipped, blockers, decisions, awaiting };
}
