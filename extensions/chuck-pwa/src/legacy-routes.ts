// Cockpit + push-subscription handlers salvaged from chuck-pwa-server.mjs.
//
// These serve the legacy React cockpit (index.html, the docket / status /
// decisions UI). Joseph's daily PWA flow is the chat surface (chat.html);
// the cockpit is a separate UI he opens occasionally. We migrate them
// now anyway so chuck-pwa-server.mjs can retire cleanly in this same
// commit — no half-states.
//
// Exports:
//   makeVapidPublicHandler  — GET  /api/chuck-v3/push/vapid-public
//   makeSubscribeHandler    — POST /api/chuck-v3/push/subscribe
//   makeUnsubscribeHandler  — POST /api/chuck-v3/push/unsubscribe
//   makeSubscriptionsList   — GET  /api/chuck-v3/push/subscriptions
//   makeDocketHandler       — GET  /api/chuck-v3/docket
//   makeStatusStripHandler  — GET  /api/chuck-v3/status-strip
//   makeDecisionsHandler    — GET  /api/chuck-v3/decisions

import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  listSubscriptions,
  loadVapidKeys,
  removeSubscription,
  resolveConfig as resolveWebPushConfig,
  saveSubscription,
} from "../../web-push/api.js";

const webPushConfig = resolveWebPushConfig({});

const HOME = homedir();
const CHUCK_V3 = join(HOME, ".openclaw", "workspace", "state", "chuck-v3");
const DOCKET_DIR = join(CHUCK_V3, "docket");
const DECISIONS_DIR = join(CHUCK_V3, "decisions");
const HEALTH_SNAPSHOT_PATH = join(CHUCK_V3, "health-snapshot.json");
const EXECUTOR_CONTROL_PATH = join(CHUCK_V3, "executor-control.json");
const RUNTIME_CHOOSER_STATE_PATH = join(CHUCK_V3, "runtime-chooser", "state.json");

const MAX_BODY_BYTES = 256 * 1024;

function setHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function readJsonSafe<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

function isValidSubscription(obj: unknown): obj is PushSubscriptionBody {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.endpoint !== "string") return false;
  if (!o.keys || typeof o.keys !== "object") return false;
  const keys = o.keys as Record<string, unknown>;
  return typeof keys.p256dh === "string" && typeof keys.auth === "string";
}

// ─── push/vapid-public ─────────────────────────────────────────────────────
export function makeVapidPublicHandler() {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    try {
      const keys = loadVapidKeys(webPushConfig);
      if (!keys?.publicKey) {
        sendJson(res, 500, { error: "vapid keys present but missing publicKey" });
        return true;
      }
      sendJson(res, 200, { publicKey: keys.publicKey });
    } catch (err) {
      sendJson(res, 500, {
        error: `vapid load failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  };
}

// ─── push/subscribe ────────────────────────────────────────────────────────
export function makeSubscribeHandler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    let body: PushSubscriptionBody;
    try {
      body = await readJsonBody<PushSubscriptionBody>(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    if (!isValidSubscription(body)) {
      sendJson(res, 400, {
        error: "invalid PushSubscription shape; need endpoint + keys.p256dh + keys.auth",
      });
      return true;
    }
    const userAgent = typeof body.userAgent === "string" ? body.userAgent : null;
    const { userAgent: _, ...sub } = body;
    try {
      const result = saveSubscription({ ...sub, userAgent }, webPushConfig);
      sendJson(res, result?.deduped ? 200 : 201, {
        ok: true,
        deduped: !!result?.deduped,
        file: result?.file ?? null,
        endpointPreview: sub.endpoint.slice(0, 60) + "...",
      });
    } catch (err) {
      sendJson(res, 500, {
        error: `save failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  };
}

// ─── push/unsubscribe ──────────────────────────────────────────────────────
export function makeUnsubscribeHandler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    let body: { endpoint?: string };
    try {
      body = await readJsonBody<{ endpoint?: string }>(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    if (!body?.endpoint || typeof body.endpoint !== "string") {
      sendJson(res, 400, { error: "missing 'endpoint' string" });
      return true;
    }
    try {
      const result = removeSubscription(body.endpoint, webPushConfig);
      sendJson(res, 200, { ok: true, removed: !!result?.ok });
    } catch (err) {
      sendJson(res, 500, {
        error: `remove failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  };
}

// ─── push/subscriptions ────────────────────────────────────────────────────
export function makeSubscriptionsListHandler() {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    try {
      const subs = listSubscriptions(webPushConfig);
      sendJson(res, 200, { count: subs.length, subscriptions: subs });
    } catch (err) {
      sendJson(res, 500, {
        error: `list failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  };
}

// ─── docket ────────────────────────────────────────────────────────────────
export function makeDocketHandler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!existsSync(DOCKET_DIR)) {
      sendJson(res, 200, {
        tasks: [],
        updatedAt: new Date().toISOString(),
        source: "no-docket-dir",
      });
      return true;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const limit = Math.max(
      1,
      Math.min(500, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100),
    );
    const includeStates = (
      url.searchParams.get("status") ??
      "pending,running,failed,failed-validation,blocked,completed,skipped"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const includeSet = new Set(includeStates);
    let entries: string[];
    try {
      entries = readdirSync(DOCKET_DIR).filter((f) => f.endsWith(".json"));
    } catch (err) {
      sendJson(res, 500, {
        error: `readdir failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return true;
    }
    const tasks: Record<string, unknown>[] = [];
    for (const f of entries) {
      const t = readJsonSafe<Record<string, unknown>>(join(DOCKET_DIR, f));
      if (!t || typeof t !== "object" || !t.id) continue;
      const status = (t.status as string) || "unknown";
      if (!includeSet.has(status)) continue;
      const heartbeats = Array.isArray(t.heartbeats)
        ? (t.heartbeats as Array<Record<string, unknown>>)
        : [];
      tasks.push({
        id: t.id,
        title: t.title || "(untitled)",
        status,
        risk: t.risk ?? null,
        commandKind: t.commandKind ?? null,
        surface: t.surface ?? null,
        createdAt: t.createdAt ?? null,
        updatedAt: t.updatedAt ?? t.createdAt ?? null,
        createdBy: t.createdBy ?? null,
        sourceKind: (t.source as Record<string, unknown> | null | undefined)?.kind ?? null,
        lastPhase:
          heartbeats.length > 0 ? (heartbeats[heartbeats.length - 1]?.phase ?? null) : null,
        promotedFrom:
          (t.promotedFrom as Record<string, unknown> | null | undefined)?.introspectId ?? null,
      });
    }
    tasks.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    const truncated = tasks.length > limit;
    const out = truncated ? tasks.slice(0, limit) : tasks;
    sendJson(res, 200, {
      tasks: out,
      count: out.length,
      totalMatched: tasks.length,
      truncated,
      updatedAt: new Date().toISOString(),
      statusFilter: includeStates,
    });
    return true;
  };
}

// ─── status-strip ──────────────────────────────────────────────────────────
export function makeStatusStripHandler() {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const health = readJsonSafe<Record<string, unknown>>(HEALTH_SNAPSHOT_PATH);
    const executor = readJsonSafe<Record<string, unknown>>(EXECUTOR_CONTROL_PATH);
    const chooser = readJsonSafe<Record<string, unknown>>(RUNTIME_CHOOSER_STATE_PATH);
    const history = (chooser?.history as Array<Record<string, unknown>> | undefined) ?? [];
    const latestProbe = history.length > 0 ? history[history.length - 1] : null;
    const probes = (latestProbe?.probes as Array<Record<string, unknown>> | undefined) ?? [];
    sendJson(res, 200, {
      ok: true,
      ts: new Date().toISOString(),
      health: health
        ? {
            generatedAt: health.generatedAt,
            selectedVoices: ((health.selectedVoices as unknown[]) ?? []).slice(0, 12),
            summary: health.summary ?? null,
          }
        : null,
      executor: executor
        ? {
            mode: executor.mode,
            paused: executor.paused === true,
            reason: executor.reason ?? null,
            updatedAt: executor.updatedAt,
          }
        : null,
      runtime: {
        currentWinner: chooser?.currentWinner ?? null,
        lastUpdatedAt: chooser?.lastUpdatedAt ?? null,
        latestProbe: latestProbe
          ? {
              ts: latestProbe.ts,
              winner: latestProbe.winner,
              probes: probes.map((p) => ({
                runtime: p.runtime,
                ok: p.ok,
                score: p.score,
                latencyMs: p.latencyMs,
                rateLimited: p.rateLimited,
              })),
            }
          : null,
      },
    });
    return true;
  };
}

// ─── decisions ─────────────────────────────────────────────────────────────
export function makeDecisionsHandler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!existsSync(DECISIONS_DIR)) {
      sendJson(res, 200, {
        decisions: [],
        updatedAt: new Date().toISOString(),
        source: "no-decisions-dir",
      });
      return true;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const limit = Math.max(
      1,
      Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
    );
    let entries: string[];
    try {
      entries = readdirSync(DECISIONS_DIR).filter(
        (f) => f.startsWith("decision-") && f.endsWith(".json"),
      );
    } catch (err) {
      sendJson(res, 500, {
        error: `readdir failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return true;
    }
    const decisions: Record<string, unknown>[] = [];
    for (const f of entries) {
      const d = readJsonSafe<Record<string, unknown>>(join(DECISIONS_DIR, f));
      if (!d || typeof d !== "object" || !d.id) continue;
      const options = Array.isArray(d.options) ? (d.options as Array<Record<string, unknown>>) : [];
      decisions.push({
        id: d.id,
        ts: d.ts ?? null,
        category: d.category ?? null,
        situation: d.situation ?? null,
        recommendation: d.recommendation ?? null,
        rationale: d.rationale ?? null,
        riskClass: d.riskClass ?? null,
        autoApply: d.autoApply === true,
        applied: d.applied === true,
        appliedAt: d.appliedAt ?? null,
        appliedAction: d.appliedAction ?? null,
        optionLabels: options.map((o) => o?.label as string | undefined).filter(Boolean),
      });
    }
    decisions.sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
    const truncated = decisions.length > limit;
    const out = truncated ? decisions.slice(0, limit) : decisions;
    sendJson(res, 200, {
      decisions: out,
      count: out.length,
      totalMatched: decisions.length,
      truncated,
      updatedAt: new Date().toISOString(),
    });
    return true;
  };
}
