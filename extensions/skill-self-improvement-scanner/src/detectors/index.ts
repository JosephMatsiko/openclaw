// Detector registry. Each detector returns a Gap (or array of Gaps) or null.

import type { DetectorContext, Gap, GapCategory } from "../types.js";
import { detectBusDiversity } from "./busdiversity.js";
import { detectDocketHealth } from "./dockethealth.js";
import { detectMcpGap } from "./mcpgap.js";
import { detectPlistGap } from "./plistgap.js";
import { detectSkillGap } from "./skillgap.js";
import { detectStuckPending } from "./stuckpending.js";

export const ALL_CATEGORIES: GapCategory[] = [
  "dockethealth",
  "stuckpending",
  "mcpgap",
  "plistgap",
  "skillgap",
  "busdiversity",
];

/** Run every detector and concatenate results. */
export function runAllDetectors(ctxByCat: Record<GapCategory, DetectorContext>): Gap[] {
  const gaps: Gap[] = [];
  const dh = detectDocketHealth(ctxByCat.dockethealth);
  if (dh) gaps.push(dh);
  gaps.push(...detectStuckPending(ctxByCat.stuckpending));
  gaps.push(...detectMcpGap(ctxByCat.mcpgap));
  gaps.push(...detectPlistGap(ctxByCat.plistgap));
  gaps.push(...detectSkillGap(ctxByCat.skillgap));
  const bd = detectBusDiversity(ctxByCat.busdiversity);
  if (bd) gaps.push(bd);
  return gaps;
}

export {
  detectBusDiversity,
  detectDocketHealth,
  detectMcpGap,
  detectPlistGap,
  detectSkillGap,
  detectStuckPending,
};
