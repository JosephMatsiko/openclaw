// Detector: plistgap — daemon-shape chuck-* .mjs without a launchd plist.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DetectorContext, Gap } from "../types.js";
import { fingerprint } from "../util.js";

const PLIST_PATTERNS: RegExp[] = [
  /^chuck-.*-executor\.mjs$/,
  /^chuck-.*-self-heal\.mjs$/,
  /^chuck-.*-digest\.mjs$/,
  /^chuck-.*-scanner\.mjs$/,
];

export function detectPlistGap(ctx: DetectorContext): Gap[] {
  if (!existsSync(ctx.config.scriptsDir)) return [];
  let candidates: string[];
  try {
    candidates = readdirSync(ctx.config.scriptsDir).filter((n) =>
      PLIST_PATTERNS.some((re) => re.test(n)),
    );
  } catch {
    return [];
  }
  const out: Gap[] = [];
  for (const script of candidates) {
    const name = script.replace(/\.mjs$/, "");
    const plistPath = join(ctx.config.launchAgentsDir, `com.openclaw.${name}.plist`);
    if (existsSync(plistPath)) continue;
    const fp = fingerprint("plistgap", name);
    if (ctx.openFps.has(fp)) continue;
    out.push({
      category: "plistgap",
      fingerprint: fp,
      title: `Build launchd plist for ${name}`,
      intent: `Build launchd plist at ${plistPath} for ${join(ctx.config.scriptsDir, script)}. Default schedule: StartInterval=21600 (every 6h), RunAtLoad=true, KeepAlive=false, ProcessType=Background. Mirror com.openclaw.chuck-mac-self-heal.plist (logs at ~/.openclaw/logs/${name}.{out,err}.log; PATH includes nvm node bin). Load with 'launchctl load -w <path>'.`,
    });
  }
  return out;
}
