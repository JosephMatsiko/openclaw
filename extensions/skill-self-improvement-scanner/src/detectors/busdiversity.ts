// Detector: busdiversity — fewer than 10 distinct event types in last 200
// bus events (signals an under-instrumented subsystem somewhere).

import { existsSync, readFileSync } from "node:fs";
import type { DetectorContext, Gap } from "../types.js";
import { fingerprint } from "../util.js";

const TAIL_LINES = 200;
const MIN_DISTINCT_TYPES = 10;

export function detectBusDiversity(ctx: DetectorContext): Gap | null {
  if (!existsSync(ctx.config.eventsPath)) return null;
  let lines: string[] = [];
  try {
    lines = readFileSync(ctx.config.eventsPath, "utf8").trim().split("\n").slice(-TAIL_LINES);
  } catch {
    return null;
  }
  const types = new Set<string>();
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as { type?: string };
      if (typeof e?.type === "string" && e.type.length > 0) types.add(e.type);
    } catch {
      /* skip */
    }
  }
  if (types.size >= MIN_DISTINCT_TYPES) return null;
  const fp = fingerprint("busdiversity", `count:${types.size}`);
  if (ctx.openFps.has(fp)) return null;
  return {
    category: "busdiversity",
    fingerprint: fp,
    title: `Audit bus instrumentation: only ${types.size} distinct event types in last 200`,
    intent: `Apex bus shows only ${types.size} distinct event types in last 200 events (threshold 10). Audit silent subsystems — candidates: chuck-dashboard interactions, chuck-telegram-poller inbound, chuck-prior-capsule writes, chuck-posterior-delta, capability self-heals, MCP lifecycle. Propose 1-line emit() at meaningful seams. Currently-seen: ${[...types].slice(0, 8).join(", ")}.`,
  };
}
