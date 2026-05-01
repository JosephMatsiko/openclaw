// Detector: channel-drift — enabled channel silent 7d+.

import type { Detector, DetectorHit } from "../types.js";
import { fingerprint, readJson } from "../util.js";

const HOUR_MS = 60 * 60 * 1000;

interface OpenclawConfig {
  channels?: Record<string, { enabled?: boolean }>;
}

export const detectChannelDrift: Detector = ({ events, config, now }): DetectorHit | null => {
  const cfg = readJson<OpenclawConfig>(config.openclawConfigPath, {});
  const channels = cfg?.channels ?? {};
  const cutoff = now.getTime() - 7 * 24 * HOUR_MS;

  const drifted: string[] = [];
  for (const [name, c] of Object.entries(channels)) {
    if (!c?.enabled) continue;
    const seen = events.some((e) => {
      if (!e?.ts || Date.parse(e.ts) < cutoff) return false;
      const t = e.type ?? "";
      const s = e.source ?? "";
      const p = JSON.stringify(e.payload ?? {});
      return (
        t.startsWith("chat.") ||
        t.startsWith("channel.") ||
        s.includes(name) ||
        p.includes(`"channel":"${name}"`) ||
        p.includes(`"channel": "${name}"`)
      );
    });
    if (!seen) drifted.push(name);
  }
  if (drifted.length === 0) return null;

  const candidate = drifted[0];
  return {
    category: "channel-drift",
    fingerprint: fingerprint("channel-drift", candidate),
    situation: `Channel '${candidate}' is enabled in openclaw.json but has zero events in apex-events.jsonl over last 7 days`,
    options: [
      {
        label: "retire",
        action: `Set channels.${candidate}.enabled = false in openclaw.json (reversible)`,
      },
      {
        label: "investigate-routing",
        action: `Probe channel '${candidate}' send/receive path to confirm whether it's routing correctly but silent vs. actually broken`,
      },
    ],
    recommendation: "investigate-routing",
    rationale: `Silence is ambiguous — could mean Joseph never uses the channel (retire fits) or routing is broken (retire would mask it). Investigation resolves the ambiguity. Other drifted enabled channels: ${drifted.slice(1).join(", ") || "none"}.`,
    riskClass: "low",
    evidence: { channel: candidate, otherDrifted: drifted.slice(1), windowDays: 7 },
    rollback: `If retire is applied: set channels.${candidate}.enabled = true in openclaw.json.`,
  };
};
