// Cascade resolution: tier → ordered channel list → enabled-channel filter
// → quiet-hours filter → digest-as-terminus guarantee.

import { existsSync, readFileSync } from "node:fs";
import type { ReachCascadeConfig } from "./config.js";
import { isQuietHoursNow } from "./time.js";
import type { ChannelName, CommsPolicyDoc, Severity, Tier } from "./types.js";

// 2026-04-30: web-push prepended as TRUE first leg. Lands directly on the
// PWA-installed device (iPad/iPhone Safari + macOS Chrome PWA) without
// routing through Telegram. Falls through to apex-apple-bridge when no
// subscriptions are registered (empty PWA install state).
// 2026-05-01: sms-bridge added as the last live channel before voice/digest
// (panel #1 failure-mode mitigation). Uses Apple Continuity SMS via
// Messages.app — when iMessage routing fails, Apple falls back to SMS over
// the iPhone's LTE link, a separate carrier from the Mac's Wi-Fi.
export const DEFAULT_CASCADE: Record<Tier, ChannelName[]> = {
  immediate: [
    "web-push",
    "apex-apple-bridge",
    "telegram",
    "discord",
    "imessage",
    "sms-bridge",
    "voice",
    "digest",
  ],
  "immediate-low-friction": [
    "web-push",
    "apex-apple-bridge",
    "telegram",
    "discord",
    "sms-bridge",
    "digest",
  ],
  digest: ["digest"],
};

export function resolveCascadeOrder(tier: Tier, config: ReachCascadeConfig): ChannelName[] {
  // Try to lift cascade order from policy.tiers[tier].cascadeOrder. The policy
  // doc currently expresses these as prose, so structured overrides may not
  // exist; we honor presence so future structured edits get picked up.
  if (existsSync(config.policyPath)) {
    try {
      const policy = JSON.parse(readFileSync(config.policyPath, "utf8")) as CommsPolicyDoc;
      const override = policy?.tiers?.[tier]?.cascadeOrder;
      if (Array.isArray(override) && override.length > 0) {
        return [...override];
      }
    } catch {
      // Malformed policy → fall back to defaults rather than aborting.
    }
  }
  return [...(DEFAULT_CASCADE[tier] ?? DEFAULT_CASCADE["immediate-low-friction"])];
}

/** Read openclaw.json once per cascade run; resilient to read errors. */
function readEnabledFlags(): Record<string, { enabled?: boolean }> {
  const path = `${process.env.HOME ?? ""}/.openclaw/openclaw.json`;
  if (!existsSync(path)) return {};
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { channels?: Record<string, unknown> };
    return (cfg?.channels ?? {}) as Record<string, { enabled?: boolean }>;
  } catch {
    return {};
  }
}

export function filterEnabledChannels(cascade: ChannelName[]): ChannelName[] {
  const channels = readEnabledFlags();
  return cascade.filter((ch) => {
    // Always-available locals: web-push (PWA self-fails when no subs),
    // apex-apple-bridge, voice, digest.
    if (ch === "web-push" || ch === "apex-apple-bridge" || ch === "voice" || ch === "digest") {
      return true;
    }
    // Configured channels: telegram, imessage, discord, sms-bridge — must be
    // enabled in openclaw.json. sms-bridge is plugin-owned so its enable flag
    // is not in openclaw.json.channels — let it pass.
    if (ch === "sms-bridge") return true;
    if (ch === "telegram" || ch === "imessage" || ch === "discord") {
      return channels?.[ch]?.enabled === true;
    }
    return false;
  });
}

export function applyQuietHoursFilter(
  cascade: ChannelName[],
  severity: Severity,
  config: ReachCascadeConfig,
  now: Date = new Date(),
): ChannelName[] {
  if (severity === "critical") return cascade;
  if (!isQuietHoursNow(config, now)) return cascade;
  // Quiet hours, non-critical: drop the audible/visible channels. Telegram +
  // iMessage stay because silent-on-device is the operator's OS choice.
  return cascade.filter((ch) => ch !== "apex-apple-bridge" && ch !== "voice");
}

/** Always ensure digest is the safety-net terminus. */
export function ensureDigestTerminus(cascade: ChannelName[]): ChannelName[] {
  if (cascade.includes("digest")) return cascade;
  return [...cascade, "digest"];
}
