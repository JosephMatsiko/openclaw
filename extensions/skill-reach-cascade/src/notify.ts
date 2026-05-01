// notify() — primary entry point for the cascade.
//
// Resolves tier → cascade order → enabled-channel filter → quiet-hours
// filter → digest-as-terminus → walks attempters in order → first ok stops
// → all-fail still records to digest. Every cascade run lands in the
// notification ledger and emits bus events.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  recordFailure as recordReachFailure,
  recordSuccess as recordReachSuccess,
} from "../../reach-ledger/api.js";
import { antispamHash, createAntispamCache, type AntispamCache } from "./antispam.js";
import {
  applyQuietHoursFilter,
  ensureDigestTerminus,
  filterEnabledChannels,
  resolveCascadeOrder,
} from "./cascade.js";
import { attemptAppleBridge } from "./channels/apple-bridge.js";
import { attemptDigest } from "./channels/digest.js";
import { attemptDiscord } from "./channels/discord.js";
import { attemptImessage } from "./channels/imessage.js";
import { attemptSmsBridge } from "./channels/sms-bridge.js";
import { attemptTelegram } from "./channels/telegram.js";
import { attemptVoice } from "./channels/voice.js";
import { attemptWebPush } from "./channels/web-push.js";
import type { ReachCascadeConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { createEventEmitter, type EventEmitter } from "./events.js";
import { isQuietHoursNow } from "./time.js";
import type {
  AttemptResult,
  CascadeAttempt,
  ChannelName,
  LedgerEntry,
  NotifyOptions,
  NotifyPayload,
  NotifyResult,
  Severity,
  Tier,
} from "./types.js";

function ledgerId(): string {
  return `notif-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function ensureDirs(config: ReachCascadeConfig): void {
  for (const d of [config.ledgerDir, config.digestPendingDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function writeLedgerEntry(path: string, entry: LedgerEntry): void {
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

/**
 * Module-scoped antispam cache so a long-lived process (chuck-cascade-watcher
 * etc.) shares dedupe state across notify() calls. Keyed on `ledgerDir +
 * windowMs` so config changes don't carry stale state forward.
 */
const ANTISPAM_CACHES = new Map<string, AntispamCache>();
function getAntispamCache(ledgerDir: string, windowMs: number): AntispamCache {
  const key = `${ledgerDir}::${windowMs}`;
  let cache = ANTISPAM_CACHES.get(key);
  if (!cache) {
    cache = createAntispamCache({ ledgerDir, windowMs });
    ANTISPAM_CACHES.set(key, cache);
  }
  return cache;
}

async function dispatchOne(
  channel: ChannelName,
  payload: NotifyPayload,
  ledgerEntryId: string,
  config: ReachCascadeConfig,
): Promise<AttemptResult> {
  switch (channel) {
    case "web-push":
      return await attemptWebPush(payload);
    case "apex-apple-bridge":
      return attemptAppleBridge(payload);
    case "telegram":
      return await attemptTelegram(payload, {
        chatId: config.telegramChatId,
        cliPath: config.openclawCliPath,
        nativeTimeoutMs: config.openclawNativeTimeoutMs,
      });
    case "discord":
      return await attemptDiscord(payload, {
        cliPath: config.openclawCliPath,
        nativeTimeoutMs: config.openclawNativeTimeoutMs,
      });
    case "imessage":
      return attemptImessage(payload, { buddy: config.imessageBuddy });
    case "sms-bridge":
      return attemptSmsBridge(payload, { buddy: config.imessageBuddy });
    case "voice":
      return attemptVoice(payload);
    case "digest":
      return attemptDigest(payload, ledgerEntryId, {
        digestPendingDir: config.digestPendingDir,
      });
  }
}

export async function notify(
  payloadIn: NotifyPayload,
  options: NotifyOptions = {},
  configIn?: ReachCascadeConfig,
): Promise<NotifyResult> {
  const config: ReachCascadeConfig = {
    ...(configIn ?? resolveConfig({})),
    ...(options.configOverrides ?? {}),
  };
  ensureDirs(config);
  const events: EventEmitter = createEventEmitter(config.eventsPath);

  const payload: NotifyPayload = { ...payloadIn };
  if (!payload.subject) throw new Error("notify: subject is required");

  // Tier resolution. critical → immediate.
  let tier: Tier = (payload.tier ?? "immediate-low-friction") as Tier;
  if (payload.severity === "critical") tier = "immediate";
  payload.tier = tier;
  const severity: Severity = payload.severity ?? "info";
  payload.severity = severity;

  const dryRun = payload.dryRun === true;
  const skipAppleBridge = payload.skipAppleBridge === true;

  // Anti-spam check.
  const hash = antispamHash(payload);
  if (!dryRun && !options.bypassAntispam) {
    const cache = getAntispamCache(config.ledgerDir, config.antispamWindowMs);
    if (cache.check(hash)) {
      return {
        delivered: false,
        channel: null,
        attempts: [],
        ledgerEntryId: null,
        finalReason: `squelched: identical notification within ${config.antispamWindowMs}ms window`,
        squelched: true,
      };
    }
  }

  // Resolve cascade pipeline.
  let cascadeOrder = resolveCascadeOrder(tier, config);
  cascadeOrder = filterEnabledChannels(cascadeOrder);
  const quietHoursActive = isQuietHoursNow(config);
  cascadeOrder = applyQuietHoursFilter(cascadeOrder, severity, config);
  cascadeOrder = ensureDigestTerminus(cascadeOrder);

  const id = ledgerId();
  events.emit("chuck.notify.cascade.started", {
    ledgerEntryId: id,
    tier,
    cascadeOrder,
    severity,
    quietHoursActive,
  });

  const attempts: CascadeAttempt[] = [];
  let delivered = false;
  let deliveredVia: ChannelName | null = null;

  for (const channel of cascadeOrder) {
    if (skipAppleBridge && channel === "apex-apple-bridge") {
      attempts.push({
        channel,
        ok: false,
        skipped: true,
        ts: new Date().toISOString(),
        durationMs: 0,
        error: "skipped via skipAppleBridge",
      });
      continue;
    }

    let result: AttemptResult;
    if (dryRun) {
      result = { ok: true, durationMs: 0, dryRun: true };
    } else {
      try {
        result = await dispatchOne(channel, payload, id, config);
      } catch (err) {
        result = {
          ok: false,
          error: (err as Error).message ?? String(err),
          durationMs: 0,
        };
      }
    }

    const attempt: CascadeAttempt = {
      channel,
      ok: result.ok,
      ts: new Date().toISOString(),
      durationMs: result.durationMs ?? 0,
    };
    if (!result.ok && result.error) attempt.error = result.error;
    if (result.dryRun) attempt.dryRun = true;
    if (result.transport) attempt.transport = result.transport;
    if (result.messageId != null) attempt.messageId = result.messageId;
    attempts.push(attempt);

    events.emit("chuck.notify.attempt", {
      ledgerEntryId: id,
      channel,
      ok: attempt.ok,
      error: attempt.error ?? null,
      durationMs: attempt.durationMs,
    });

    // Reach-ledger writes: every cascade attempt updates last_proven_at /
    // last_failed_at per channel. Skip the synthetic digest channel and
    // dry-runs.
    if (channel !== "digest" && !result.dryRun) {
      try {
        if (result.ok) {
          recordReachSuccess(channel, {
            messageId: result.messageId == null ? null : String(result.messageId),
            transport: result.transport ?? null,
          });
        } else {
          recordReachFailure(channel, attempt.error ?? "unknown");
        }
      } catch (err) {
        // Ledger write failures must never break the cascade.
        process.stderr.write(`[reach-ledger] write failed: ${String(err)}\n`);
      }
    }

    if (result.ok) {
      delivered = true;
      deliveredVia = channel;
      break;
    }
  }

  const deliveredAttempt = attempts.find((a) => a.channel === deliveredVia);
  const finalReason = delivered
    ? `delivered via ${deliveredVia}${deliveredAttempt ? ` in ${deliveredAttempt.durationMs}ms` : ""}`
    : "all attempters failed (this should not happen — digest is the fallback)";

  const ledgerEntry: LedgerEntry = {
    id,
    ts: new Date().toISOString(),
    payload,
    tier,
    cascadeOrder,
    attempts,
    delivered,
    deliveredVia,
    finalReason,
    quietHoursActive,
    antispamHash: hash,
    dryRun,
  };
  writeLedgerEntry(join(config.ledgerDir, `${id}.json`), ledgerEntry);

  events.emit(delivered ? "chuck.notify.delivered" : "chuck.notify.failed", {
    ledgerEntryId: id,
    deliveredVia,
    attempts: attempts.length,
  });

  return {
    delivered,
    channel: deliveredVia,
    attempts,
    ledgerEntryId: id,
    finalReason,
  };
}
