#!/usr/bin/env node
// Apex Chrome fingerprint audit — hourly + reactive.
//
// Probes Apex Chrome against common bot-fingerprint sites via CDP:
//   - navigator.webdriver == false
//   - plugins length > 0
//   - WebGL vendor/renderer plausible
//   - User-agent consistent with Chromium headed
// Records score + surfaces drift via the apex-event-bus.
//
// Reactive: subscribes to `apex-cf-signal detection` events — on any
// detection, runs a full probe immediately to see if detection vectors
// have shifted.
//
// Subscribe in watchers/index.mjs with ~3600s interval + event
// subscription to apex-cf-signal.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as cdp from "../apex-chrome-cdp.mjs";

const STATE_DIR = join(homedir(), ".openclaw", "workspace", "state");
const AUDIT_LOG = join(STATE_DIR, "apex-chrome-fingerprint.jsonl");

function ensureDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

async function probeTab(tab) {
  const res = await cdp.evalInTab(
    tab,
    `
    var out = {};
    out.webdriver = navigator.webdriver === true;
    out.plugins = navigator.plugins ? navigator.plugins.length : 0;
    out.languages = navigator.languages;
    out.platform = navigator.platform;
    out.vendor = navigator.vendor;
    out.userAgent = navigator.userAgent;
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.connectionType = navigator.connection ? navigator.connection.effectiveType : null;
    // WebGL check
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (gl) {
        var debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        out.webgl = {
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
        };
      } else {
        out.webgl = null;
      }
    } catch (e) {
      out.webgl = { error: String(e) };
    }
    // Automation controlled signal
    out.automationControlled = (function(){
      try { return /HeadlessChrome/i.test(navigator.userAgent); } catch { return false; }
    })();
    return out;
  `,
  );
  if (!res.ok) {
    return { ok: false, error: res.error };
  }
  return { ok: true, fingerprint: res.value };
}

function scoreFingerprint(fp) {
  let score = 100;
  const flags = [];
  if (fp.webdriver) {
    score -= 40;
    flags.push("navigator.webdriver=true");
  }
  if (fp.automationControlled) {
    score -= 30;
    flags.push("ua-contains-HeadlessChrome");
  }
  if (fp.plugins === 0) {
    score -= 15;
    flags.push("plugins=0");
  }
  if (!fp.webgl || !fp.webgl.vendor) {
    score -= 10;
    flags.push("no-webgl");
  }
  if (!fp.languages || fp.languages.length === 0) {
    score -= 10;
    flags.push("no-languages");
  }
  return { score, flags };
}

export async function audit() {
  ensureDir();
  // Open a neutral probe page and read navigator.
  const tab = await cdp.findOrOpenTab({
    urlMatch: "about:blank",
    createUrl: "https://example.com/",
  });
  await cdp.waitForPageReady(tab, { timeoutMs: 8000 });
  const probe = await probeTab(tab);
  tab.close?.();
  if (!probe.ok) {
    return { ok: false, error: probe.error };
  }
  const { score, flags } = scoreFingerprint(probe.fingerprint);
  const entry = {
    ts: new Date().toISOString(),
    profile: cdp.APEX_PROFILE_ID,
    port: cdp.APEX_CDP_PORT,
    score,
    flags,
    fingerprint: probe.fingerprint,
  };
  try {
    appendFileSync(AUDIT_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    /* ignore */
  }
  return { ok: true, ...entry };
}

export async function tick() {
  return await audit();
}

async function mainCli() {
  const r = await tick();
  console.log(JSON.stringify(r, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[apex-chrome-fingerprint-audit] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
