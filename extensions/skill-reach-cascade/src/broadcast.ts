// broadcast() — sibling to notify(). Fan-out to EVERY enabled channel in
// parallel, not first-success-wins like the cascade.
//
// Use when Joseph explicitly wants the same payload on every surface (e.g.
// session-end ship announcement, fleet-state changes, all-hands).
//
// Why a separate function from notify(): the cascade is correctly first-
// success-wins (the right default for "Chuck got X to Joseph") — adding a
// broadcast mode to notify() would muddy the cascade's contract. broadcast()
// shares all the per-channel attempters but runs them in parallel and
// records to a separate broadcast-ledger. Anti-spam window is 60s here vs
// the cascade's 30s — broadcast is a wider blast, so dedupe is correspondingly
// tighter.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { antispamHash, createAntispamCache, type AntispamCache } from "./antispam.js";
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
import { createEventEmitter } from "./events.js";
import type {
  AttemptResult,
  CascadeAttempt,
  ChannelName,
  NotifyPayload,
  Severity,
} from "./types.js";

export interface BroadcastOptions {
  /** When true, append `voice` to the broadcast set (off by default — too loud). */
  includeVoice?: boolean;
  /** When true, walk the broadcast but never actually fire any channel. */
  dryRun?: boolean;
  /** Channel ids to skip on this broadcast. */
  exclude?: ChannelName[];
  /** Skip the in-process anti-spam cache (testing or replay). */
  bypassAntispam?: boolean;
}

export interface BroadcastResult {
  delivered: boolean;
  ledgerEntryId: string | null;
  okCount: number;
  totalAttempts: number;
  attempts: CascadeAttempt[];
  squelched?: boolean;
  reason?: string;
}

interface BroadcastLedgerEntry {
  id: string;
  ts: string;
  payload: NotifyPayload;
  attempts: CascadeAttempt[];
  okCount: number;
  totalAttempts: number;
  antispamHash: string;
  dryRun: boolean;
}

const DEFAULT_BROADCAST_CHANNELS: ChannelName[] = [
  "apex-apple-bridge",
  "telegram",
  "discord",
  "imessage",
  "sms-bridge",
  "web-push",
  "digest",
];
const BROADCAST_ANTISPAM_WINDOW_MS = 60_000; // 2x the cascade's 30s

function broadcastLedgerId(): string {
  return `bcast-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function broadcastLedgerDir(config: ReachCascadeConfig): string {
  // Reuse parent of cascade ledger so all reach state lives under chuck-v3.
  return config.ledgerDir.replace(/notification-ledger$/, "broadcast-ledger");
}

const ANTISPAM_CACHES = new Map<string, AntispamCache>();
function getBroadcastAntispamCache(ledgerDir: string): AntispamCache {
  const key = `bcast::${ledgerDir}`;
  let cache = ANTISPAM_CACHES.get(key);
  if (!cache) {
    cache = createAntispamCache({ ledgerDir, windowMs: BROADCAST_ANTISPAM_WINDOW_MS });
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

/**
 * Fan-out a notification to every enabled channel in parallel. Unlike
 * notify(), this does NOT stop at first success — every channel runs and
 * the result aggregates per-channel ok/fail.
 *
 * Channels recorded:
 *   - apex-apple-bridge (always)
 *   - telegram, discord, imessage, sms-bridge (when enabled)
 *   - web-push (always; falls through if no subscriptions)
 *   - voice (off by default; opt in with includeVoice)
 *   - digest (always; safety-net log)
 */
export async function broadcast(
  payloadIn: NotifyPayload,
  options: BroadcastOptions = {},
  configIn?: ReachCascadeConfig,
): Promise<BroadcastResult> {
  const config = configIn ?? resolveConfig({});
  const events = createEventEmitter(config.eventsPath);

  const payload: NotifyPayload = { ...payloadIn };
  if (!payload.subject) throw new Error("broadcast: subject is required");
  const severity: Severity = payload.severity ?? "info";
  payload.severity = severity;

  const dryRun = options.dryRun === true;

  // Anti-spam check (broadcast-scoped — separate from cascade's antispam).
  const ledgerDir = broadcastLedgerDir(config);
  if (!existsSync(ledgerDir)) mkdirSync(ledgerDir, { recursive: true });
  const hash = antispamHash(payload);
  if (!dryRun && !options.bypassAntispam) {
    const cache = getBroadcastAntispamCache(ledgerDir);
    if (cache.check(hash)) {
      return {
        delivered: false,
        ledgerEntryId: null,
        okCount: 0,
        totalAttempts: 0,
        attempts: [],
        squelched: true,
        reason: `identical broadcast within ${BROADCAST_ANTISPAM_WINDOW_MS}ms window`,
      };
    }
  }

  const exclude = new Set(options.exclude ?? []);
  const includeVoice = options.includeVoice === true;
  const channels = DEFAULT_BROADCAST_CHANNELS.filter((c) => !exclude.has(c));
  if (includeVoice && !exclude.has("voice")) channels.push("voice");

  const id = broadcastLedgerId();
  events.emit("chuck.broadcast.started", {
    ledgerEntryId: id,
    severity,
    channels,
  });

  const settled = await Promise.all(
    channels.map(async (channel): Promise<CascadeAttempt> => {
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
      return attempt;
    }),
  );

  const okCount = settled.filter((a) => a.ok).length;
  const ledgerEntry: BroadcastLedgerEntry = {
    id,
    ts: new Date().toISOString(),
    payload,
    attempts: settled,
    okCount,
    totalAttempts: settled.length,
    antispamHash: hash,
    dryRun,
  };
  writeFileSync(join(ledgerDir, `${id}.json`), `${JSON.stringify(ledgerEntry, null, 2)}\n`, "utf8");
  events.emit("chuck.broadcast.completed", {
    ledgerEntryId: id,
    okCount,
    total: settled.length,
    perChannel: settled.map((a) => ({ channel: a.channel, ok: a.ok })),
  });

  return {
    delivered: okCount > 0,
    ledgerEntryId: id,
    okCount,
    totalAttempts: settled.length,
    attempts: settled,
  };
}
