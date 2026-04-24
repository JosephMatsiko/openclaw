#!/usr/bin/env node
// DEPRECATED (2026-04-23) — folded into apex-profile-worker-daemon.mjs.
//
// The original pattern was a standalone watcher that spawned a subprocess
// per profile with APEX_CHROME_PROFILE=<p> and connected to the per-profile
// CDP port at 9222/9223/9224. That pattern dies under --remote-debugging-pipe
// because (a) there's no port to connect to and (b) Chrome's exclusive
// --user-data-dir lock means a second Chrome can't attach to the profile
// anyway. The profile-worker-daemon now runs Storage.setCookies on its
// own hourly setInterval against the CDP connection it already owns.
//
// This file is kept as a manual CLI escape hatch — `node ...apex-chrome-cookie-refresh.mjs`
// still works in TCP mode by spawning sideload subprocesses. It is no
// longer wired into watchers/index.mjs JOBS. Do not re-wire without
// re-examining the pipe-mode fold.
//
// Original header follows.
//
// Apex Chrome cookie refresh — hourly re-sideload of session cookies
// from Joseph's main Chrome profile into every Apex Chrome profile.
//
// Keeps cf_clearance + next-auth session tokens fresh across Apex's
// multi-profile fleet.

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
