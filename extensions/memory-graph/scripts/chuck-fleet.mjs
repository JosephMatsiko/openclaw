#!/usr/bin/env node
// apex-ring: 2
// Chuck Fleet — Chuck's authoritative self-knowledge of the panel.
//
// Why this exists: Chuck has stated wrong fleet counts (5, 7) when source-
// of-truth is 11. The principle in feedback_fleet_from_source.md says
// "don't enumerate fleet from memory — read VOICES block from
// apex-panel-ask.mjs." This is the missing primitive that makes obeying
// that principle convenient.
//
// Five exports (+ CLI):
//   1. getFleet()              — canonical fleet array w/ health + recency
//   2. countByVendor()         — vendor diversity breakdown
//   3. recentPanelReturns({lookbackHours}) — scan ~/Documents/ for panels
//   4. fleetGapReport()        — configured vs. healthy vs. recently-returned
//   5. audit()                 — composes the above into a single-screen status
//
// CLI:
//   node chuck-fleet.mjs               # audit (default)
//   node chuck-fleet.mjs --json        # machine-readable audit
//   node chuck-fleet.mjs --vendors     # countByVendor only
//   node chuck-fleet.mjs --recent      # recentPanelReturns only
//   node chuck-fleet.mjs --gaps        # fleetGapReport only
//   node chuck-fleet.mjs --help
//
// Source-of-truth strategy: parse VOICES from apex-panel-ask.mjs (same
// depth-walk regex apex-fleet-router uses). Do NOT import the panel module
// — that would pull Chrome-driver chains into a read-only observability
// tool. Do NOT enumerate from memory.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapLifecycle } from "./apex-lifecycle.mjs";

const HOME = homedir();
const DOCS = join(HOME, "Documents");
const STATE_DIR = join(HOME, ".openclaw", "workspace", "state");
const HEALTH_PATH = join(STATE_DIR, "worker-health.json");

// Source of truth for fleet membership. Parsed, not enumerated.
const PANEL_SCRIPT = fileURLToPath(new URL("./apex-panel-ask.mjs", import.meta.url));

// Health staleness threshold matching apex-fleet-router.mjs.
const HEALTH_STALE_MS = 60 * 60 * 1000;

// 30-day rolling window for return-rate stats.

// Documents-dir filename pattern: <stem>-<voiceLabel>-<YYYY-MM-DD>.md
// (or <stem>-<voiceLabel>-FAIL-<YYYY-MM-DD>.md from apex-panel-ask line 529).
// Both stem AND label may contain hyphens (e.g. "phase-a-review-1" + "Opus-47-CLI"),
// so a pure regex can't disambiguate. Strategy: match date at end, then find which
// known label is the longest suffix of the body. See parsePanelFile() below.
const PANEL_FILE_DATE_RE = /^(.+?)(-FAIL)?-(\d{4}-\d{2}-\d{2})\.md$/;

function parsePanelFile(name, knownLabelsLongestFirst) {
  if (!name.endsWith(".md")) {
    return null;
  }
  const m = name.match(PANEL_FILE_DATE_RE);
  if (!m) {
    return null;
  }
  const [, body, fail, date] = m;
  for (const label of knownLabelsLongestFirst) {
    if (body === label) {
      return { stem: "", label, fail: Boolean(fail), date };
    }
    if (body.endsWith(`-${label}`)) {
      const stem = body.slice(0, -label.length - 1);
      return { stem, label, fail: Boolean(fail), date };
    }
  }
  return null;
}

// ---- 1. Voice membership parser (copied from apex-fleet-router.mjs:89-140
// to avoid pulling that file's transitive imports; canonical source noted.)
// EXTRACT-CANDIDATE: when a third caller appears, lift parsePanelVoices +
// inferVendor into a shared apex-fleet-helpers.mjs.

function parsePanelVoices() {
  if (!existsSync(PANEL_SCRIPT)) {
    throw new Error(`apex-panel-ask.mjs not found at ${PANEL_SCRIPT}`);
  }
  const src = readFileSync(PANEL_SCRIPT, "utf8");
  const startMatch = src.match(/const\s+VOICES\s*=\s*\{/);
  if (!startMatch) {
    throw new Error("VOICES block not found in apex-panel-ask.mjs");
  }
  const startIdx = startMatch.index + startMatch[0].length - 1;
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) {
    throw new Error("VOICES block unterminated");
  }
  const block = src.slice(startIdx, endIdx + 1);

  const voices = [];
  const keyRe = /(?:^|\n)\s*(?:"([^"]+)"|([a-zA-Z_$][\w-]*))\s*:\s*\{/g;
  let m;
  while ((m = keyRe.exec(block))) {
    const id = m[1] ?? m[2];
    if (!id || id === "VOICES") {
      continue;
    }
    let d = 1;
    let j = keyRe.lastIndex;
    while (j < block.length && d > 0) {
      const c = block[j];
      if (c === "{") {
        d++;
      } else if (c === "}") {
        d--;
      }
      j++;
    }
    const inner = block.slice(keyRe.lastIndex, j - 1);
    const labelM = inner.match(/label:\s*"([^"]+)"/);
    const modelM = inner.match(/modelName:\s*"([^"]+)"/);
    const hasFallback = /fallbackRunners\s*:/.test(inner);
    voices.push({
      id,
      label: labelM?.[1] ?? id,
      modelName: modelM?.[1] ?? id,
      hasFallback,
    });
  }
  return voices;
}

// Vendor inference — must match apex-fleet-router.mjs:77-87 exactly so the
// two modules agree on vendor count. Copy is verbatim.
function inferVendor(id, modelName) {
  const m = String(modelName ?? "").toLowerCase();
  const i = String(id ?? "").toLowerCase();
  if (m.includes("claude") || i.includes("claude") || m.includes("anthropic")) {
    return "anthropic";
  }
  if (
    m.includes("gpt") ||
    i.includes("gpt") ||
    m.includes("chatgpt") ||
    i.includes("chatgpt") ||
    i.includes("codex")
  ) {
    return "openai";
  }
  if (
    m.includes("gemini") ||
    i.includes("gemini") ||
    m.includes("aistudio") ||
    i.includes("aistudio")
  ) {
    return "google";
  }
  if (m.includes("grok") || i.includes("grok") || m.includes("xai")) {
    return "xai";
  }
  if (m.includes("perplexity") || i.includes("perplexity")) {
    return "perplexity";
  }
  if (m.includes("ollama") || i.includes("ollama") || m.includes("llama")) {
    return "meta-local";
  }
  return "unknown";
}

// Same panel→health-key mapping the router uses, so health joins line up.
function mapPanelIdToHealthKey(id) {
  const map = {
    "claude-cli": "claude",
    "claude-ai": "claude-ai",
    "chatgpt-web": "chatgpt",
    "gemini-cli": "gemini",
    "gemini-web": "gemini",
    "gemini-studio": "aistudio",
    codex: "codex",
    grok: "grok",
    perplexity: "perplexity",
    "perplexity-mac": "perplexity",
    "ollama-local": "ollama",
  };
  return map[id] ?? id;
}

function readJsonSafe(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ---- Public API #1: getFleet -----------------------------------------

/**
 * Canonical fleet snapshot. Joins parsed VOICES with worker-health,
 * apex-capabilities, and recent panel artifacts. Best-effort on every
 * external file — missing data surfaces as "no <thing> data" strings.
 */
export async function getFleet() {
  const panel = parsePanelVoices();
  const health = readJsonSafe(HEALTH_PATH, null);
  const healthAge = health?.updatedAt ? Date.now() - new Date(health.updatedAt).getTime() : null;
  const healthStale = healthAge !== null && healthAge > HEALTH_STALE_MS;

  const recent = await recentPanelReturns({ lookbackHours: 24 * 30 });
  const byLabel = new Map();
  for (const r of recent.perVoice) {
    byLabel.set(r.label, r);
  }

  return panel.map((v) => {
    const hKey = mapPanelIdToHealthKey(v.id);
    const hRow = health?.workers?.[hKey];
    const recentRow = byLabel.get(v.label);
    return {
      id: v.id,
      label: v.label,
      modelName: v.modelName,
      vendor: inferVendor(v.id, v.modelName),
      hasFallback: v.hasFallback,
      healthy: hRow ? Boolean(hRow.healthy) : null,
      healthDetail:
        hRow?.details ?? (health ? "no probe data for this voice" : "no health data file"),
      healthStale,
      lastPanelReturn: recentRow?.lastReturnedAt ?? null,
      lastPanelReturnFile: recentRow?.lastReturnedPath ?? null,
      lastPanelReturnBytes: recentRow?.lastReturnedBytes ?? null,
      recentReturnRate: recentRow?.returnRate ?? null,
      lastWasFail: recentRow?.lastWasFail ?? false,
    };
  });
}

// ---- Public API #2: countByVendor ------------------------------------

/**
 * Vendor diversity breakdown — how many configured voices speak through
 * each vendor cloud. Used to reason about same-vendor blindspot risk.
 */
export async function countByVendor() {
  const panel = parsePanelVoices();
  const out = {};
  for (const v of panel) {
    const vendor = inferVendor(v.id, v.modelName);
    out[vendor] = (out[vendor] ?? 0) + 1;
  }
  return out;
}

// ---- Public API #3: recentPanelReturns -------------------------------

/**
 * Scan ~/Documents/ for panel artifacts (apex-panel-ask writes
 * <stem>-<label>-<date>.md per voice; -FAIL suffix on empty-or-truncated).
 * Returns: per-voice last-return + 30d return-rate, plus the most recent
 * panel run treated as the "last panel."
 */
export async function recentPanelReturns({ lookbackHours = 24 * 30 } = {}) {
  const panel = parsePanelVoices();
  if (!existsSync(DOCS)) {
    return {
      lastPanel: { stem: null, runAtMs: null, files: [] },
      perVoice: panel.map((v) => emptyPerVoice(v.label)),
    };
  }

  const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const knownLabelsLongestFirst = panel.map((v) => v.label).toSorted((a, b) => b.length - a.length);

  const runs = new Map();
  let entries;
  try {
    entries = readdirSync(DOCS);
  } catch {
    return {
      lastPanel: { stem: null, runAtMs: null, files: [] },
      perVoice: panel.map((v) => emptyPerVoice(v.label)),
    };
  }
  for (const name of entries) {
    const parsed = parsePanelFile(name, knownLabelsLongestFirst);
    if (!parsed) {
      continue;
    }
    const { stem, label, fail, date } = parsed;
    let st;
    try {
      st = statSync(join(DOCS, name));
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoffMs) {
      continue;
    }
    const key = `${stem}|${date}`;
    if (!runs.has(key)) {
      runs.set(key, { stem, date, runAtMs: 0, files: [] });
    }
    const run = runs.get(key);
    run.runAtMs = Math.max(run.runAtMs, st.mtimeMs);
    run.files.push({
      label,
      isFail: fail,
      path: join(DOCS, name),
      bytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  }

  const sortedRuns = [...runs.values()].toSorted((a, b) => b.runAtMs - a.runAtMs);
  const lastPanel = sortedRuns[0]
    ? { stem: sortedRuns[0].stem, runAtMs: sortedRuns[0].runAtMs, files: sortedRuns[0].files }
    : { stem: null, runAtMs: null, files: [] };

  const perVoice = panel.map((v) => {
    const successInRuns = sortedRuns.filter((r) =>
      r.files.some((f) => f.label === v.label && !f.isFail),
    );
    const allForVoice = sortedRuns.flatMap((r) => r.files.filter((f) => f.label === v.label));
    allForVoice.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const last = allForVoice[0] ?? null;
    return {
      label: v.label,
      lastReturnedAt: last ? new Date(last.mtimeMs).toISOString() : null,
      lastReturnedPath: last?.path ?? null,
      lastReturnedBytes: last?.bytes ?? null,
      lastWasFail: Boolean(last?.isFail),
      panelsSeen: sortedRuns.length,
      returnRate:
        sortedRuns.length === 0
          ? null
          : Number((successInRuns.length / sortedRuns.length).toFixed(2)),
    };
  });

  return { lastPanel, perVoice };
}

function emptyPerVoice(label) {
  return {
    label,
    lastReturnedAt: null,
    lastReturnedPath: null,
    lastReturnedBytes: null,
    lastWasFail: false,
    panelsSeen: 0,
    returnRate: null,
  };
}

// ---- Public API #4: fleetGapReport -----------------------------------

export async function fleetGapReport() {
  const fleet = await getFleet();
  const recent = await recentPanelReturns({ lookbackHours: 24 * 30 });
  const lastPanel = recent.lastPanel;
  const labelsInLast = new Set(
    (lastPanel.files ?? []).filter((f) => !f.isFail).map((f) => f.label),
  );

  const noHealthData = fleet.every((v) => v.healthy === null);
  const healthy = noHealthData ? null : fleet.filter((v) => v.healthy === true).length;

  const missingFromLastPanel = lastPanel.runAtMs
    ? fleet.filter((v) => !labelsInLast.has(v.label)).map((v) => v.id)
    : [];

  const stale = fleet
    .filter((v) => {
      if (v.lastPanelReturn === null) {
        return true;
      }
      const age = Date.now() - new Date(v.lastPanelReturn).getTime();
      return age > 7 * 24 * 60 * 60 * 1000;
    })
    .map((v) => v.id);

  return {
    configured: fleet.length,
    healthy,
    returnedInLastPanel: lastPanel.runAtMs ? labelsInLast.size : null,
    missingFromLastPanel,
    stale,
    lastPanelStem: lastPanel.stem,
    lastPanelAgoMin: lastPanel.runAtMs
      ? Math.round((Date.now() - lastPanel.runAtMs) / 60000)
      : null,
    noHealthData,
  };
}

// ---- Public API #5: audit --------------------------------------------

export async function audit() {
  const [fleet, vendors, recent, gaps] = await Promise.all([
    getFleet(),
    countByVendor(),
    recentPanelReturns({ lookbackHours: 24 * 30 }),
    fleetGapReport(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    fleet,
    countByVendor: vendors,
    recentPanelReturns: recent,
    gapReport: gaps,
  };
}

// ---- Pretty printers --------------------------------------------------

function fmtAuditPretty(snap) {
  const lines = [];
  const ts = new Date(snap.generatedAt).toLocaleString();
  lines.push(`Chuck Fleet — ${ts}`);
  lines.push("=".repeat(56));
  const vendorEntries = Object.entries(snap.countByVendor).toSorted((a, b) => b[1] - a[1]);
  const total = snap.fleet.length;
  lines.push(`Configured: ${total} voices across ${vendorEntries.length} vendors`);

  const byVendor = new Map();
  for (const v of snap.fleet) {
    if (!byVendor.has(v.vendor)) {
      byVendor.set(v.vendor, []);
    }
    byVendor.get(v.vendor).push(v);
  }
  for (const [vendor, count] of vendorEntries) {
    const voices = byVendor.get(vendor) ?? [];
    const pad = vendor.padEnd(10);
    const voiceMarks = voices.map((v) => `${v.id} ${markFor(v)}`).join("  ");
    lines.push(`  ${pad}(${count}): ${voiceMarks}`);
  }
  lines.push("");

  const last = snap.recentPanelReturns.lastPanel;
  if (last.runAtMs) {
    const agoMin = Math.round((Date.now() - last.runAtMs) / 60000);
    const successFiles = last.files.filter((f) => !f.isFail);
    const returned = new Set(successFiles.map((f) => f.label)).size;
    lines.push(`Last panel run (${last.stem}, ${agoMin}min ago):`);
    lines.push(`  Returned ${returned}/${total} voices.`);
    if (snap.gapReport.missingFromLastPanel.length > 0) {
      lines.push(`  Missing: ${snap.gapReport.missingFromLastPanel.join(", ")}`);
    }
    if (successFiles.length > 0) {
      const sorted = [...successFiles].toSorted((a, b) => b.bytes - a.bytes);
      const big = sorted[0];
      const small = sorted[sorted.length - 1];
      lines.push(
        `  Largest reply: ${big.label} (${kb(big.bytes)}). Smallest: ${small.label} (${kb(small.bytes)}).`,
      );
    }
  } else {
    lines.push(`Last panel run: no panel artifacts found in ~/Documents/`);
  }
  lines.push("");

  lines.push(`Recent return rate (last 30d):`);
  const perVoiceRows = snap.fleet
    .map((v) => ({
      id: v.id,
      pct: v.recentReturnRate === null ? "—" : `${Math.round(v.recentReturnRate * 100)}%`,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < perVoiceRows.length; i += 2) {
    const a = perVoiceRows[i];
    const b = perVoiceRows[i + 1];
    const left = `${a.id.padEnd(16)} ${String(a.pct).padStart(4)}`;
    const right = b ? `   ${b.id.padEnd(16)} ${String(b.pct).padStart(4)}` : "";
    lines.push(`  ${left}${right}`);
  }
  lines.push("");

  lines.push(`Gaps to address:`);
  if (snap.gapReport.noHealthData) {
    lines.push(`  • No worker-health.json data — health column unavailable`);
  }
  for (const v of snap.fleet.filter((f) => f.lastWasFail)) {
    lines.push(`  • ${v.id}: last reply was -FAIL (${v.healthDetail})`);
  }
  for (const id of snap.gapReport.stale) {
    lines.push(`  • ${id}: stale — no successful return in 7d`);
  }
  if (snap.gapReport.missingFromLastPanel.length > 0) {
    lines.push(
      `  Recommendation: re-run with --only ${snap.gapReport.missingFromLastPanel.join(",")} to backfill`,
    );
  }
  return lines.join("\n");
}

function markFor(v) {
  if (v.healthy === null) {
    return "?";
  }
  if (!v.healthy) {
    return "✗";
  }
  if (v.lastWasFail) {
    return "⚠";
  }
  if (v.healthStale) {
    return "⚠ stale";
  }
  return "✓";
}

function kb(bytes) {
  if (bytes == null) {
    return "—";
  }
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function fmtVendorsPretty(byVendor) {
  let total = 0;
  for (const value of Object.values(byVendor)) {
    total += Number(value);
  }
  const lines = [`Vendor diversity (${total} voices total):`];
  for (const [v, n] of Object.entries(byVendor).toSorted((a, b) => b[1] - a[1])) {
    lines.push(`  ${v.padEnd(12)} ${n.toString().padStart(2)}`);
  }
  return lines.join("\n");
}

function fmtRecentPretty(recent) {
  const lines = [];
  if (recent.lastPanel.runAtMs) {
    const agoMin = Math.round((Date.now() - recent.lastPanel.runAtMs) / 60000);
    lines.push(`Last panel: ${recent.lastPanel.stem} (${agoMin}min ago)`);
    for (const f of recent.lastPanel.files.toSorted((a, b) => b.bytes - a.bytes)) {
      const flag = f.isFail ? " FAIL" : "";
      lines.push(`  ${f.label.padEnd(28)} ${kb(f.bytes).padStart(8)}${flag}`);
    }
  } else {
    lines.push(`No panel artifacts found.`);
  }
  lines.push("");
  lines.push(`Per-voice 30d return rate:`);
  for (const v of recent.perVoice) {
    const pct = v.returnRate === null ? "—" : `${Math.round(v.returnRate * 100)}%`;
    lines.push(`  ${v.label.padEnd(28)} ${pct.padStart(5)}  (${v.panelsSeen} panels seen)`);
  }
  return lines.join("\n");
}

function fmtGapsPretty(gaps) {
  const lines = [];
  lines.push(`Configured: ${gaps.configured}`);
  lines.push(`Healthy:    ${gaps.healthy ?? "no health data"}`);
  lines.push(`Returned in last panel: ${gaps.returnedInLastPanel ?? "no panel found"}`);
  if (gaps.lastPanelStem) {
    lines.push(`Last panel: ${gaps.lastPanelStem} (${gaps.lastPanelAgoMin}min ago)`);
  }
  if (gaps.missingFromLastPanel.length > 0) {
    lines.push(`Missing from last panel: ${gaps.missingFromLastPanel.join(", ")}`);
  }
  if (gaps.stale.length > 0) {
    lines.push(`Stale (>7d no success):  ${gaps.stale.join(", ")}`);
  }
  return lines.join("\n");
}

// ---- CLI --------------------------------------------------------------

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = { mode: "audit", json: false };
  for (const t of a) {
    if (t === "--json") {
      out.json = true;
    } else if (t === "--vendors") {
      out.mode = "vendors";
    } else if (t === "--recent") {
      out.mode = "recent";
    } else if (t === "--gaps") {
      out.mode = "gaps";
    } else if (t === "--help" || t === "-h") {
      out.mode = "help";
    }
  }
  return out;
}

function printHelp() {
  console.log(`chuck-fleet.mjs — Chuck's authoritative self-knowledge of the panel.

  node chuck-fleet.mjs              Full audit (default)
  node chuck-fleet.mjs --json       Audit as JSON
  node chuck-fleet.mjs --vendors    Vendor breakdown only
  node chuck-fleet.mjs --recent     Recent panel returns only
  node chuck-fleet.mjs --gaps       Gap report only
  node chuck-fleet.mjs --help

Source of truth: parses VOICES from apex-panel-ask.mjs (never enumerated).
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === "help") {
    printHelp();
    return;
  }

  if (args.mode === "vendors") {
    const v = await countByVendor();
    console.log(args.json ? JSON.stringify(v, null, 2) : fmtVendorsPretty(v));
    return;
  }

  if (args.mode === "recent") {
    const r = await recentPanelReturns({ lookbackHours: 24 * 30 });
    console.log(args.json ? JSON.stringify(r, null, 2) : fmtRecentPretty(r));
    return;
  }

  if (args.mode === "gaps") {
    const g = await fleetGapReport();
    console.log(args.json ? JSON.stringify(g, null, 2) : fmtGapsPretty(g));
    return;
  }

  const snap = await audit();
  console.log(args.json ? JSON.stringify(snap, null, 2) : fmtAuditPretty(snap));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  wrapLifecycle("chuck-fleet", main).catch((err) => {
    console.error(`[chuck-fleet] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
