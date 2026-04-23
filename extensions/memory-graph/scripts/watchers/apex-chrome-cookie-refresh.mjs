#!/usr/bin/env node
// Apex Chrome cookie refresh — hourly re-sideload of session cookies
// from Joseph's main Chrome profile into every Apex Chrome profile.
//
// Keeps cf_clearance + next-auth session tokens fresh across Apex's
// multi-profile fleet. Subscribe in `watchers/index.mjs` JOBS array
// with a 3600s interval.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = join(homedir(), "Projects", "openclaw");
const SCRIPTS = join(REPO, "extensions", "memory-graph", "scripts");
const SIDELOAD = join(SCRIPTS, "apex-chrome-cookies-sideload.mjs");

const DOMAINS = [
  "chatgpt.com",
  "openai.com",
  "perplexity.ai",
  "gemini.google.com",
  "google.com",
  "accounts.google.com",
  "claude.ai",
  "anthropic.com",
  "grok.com",
  "x.ai",
  "aistudio.google.com",
];

const PROFILES = (process.env.APEX_CHROME_PROFILES ?? "a").split(/\s+/).filter(Boolean);

function runSideload(profile) {
  return new Promise((resolve) => {
    const env = { ...process.env, APEX_CHROME_PROFILE: profile };
    const p = spawn(process.execPath, [SIDELOAD, ...DOMAINS], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => {
      out += c.toString();
    });
    p.stderr.on("data", (c) => {
      err += c.toString();
    });
    p.on("close", (code) => resolve({ profile, ok: code === 0, out, err }));
    p.on("error", (e) => resolve({ profile, ok: false, err: String(e) }));
  });
}

export async function tick() {
  const results = [];
  for (const p of PROFILES) {
    const r = await runSideload(p);
    results.push(r);
  }
  return { tickedAt: new Date().toISOString(), profiles: PROFILES, results };
}

async function mainCli() {
  const r = await tick();
  console.log(JSON.stringify(r, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[apex-chrome-cookie-refresh] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
