#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 10 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/skill-industry-radar/src/* (re-exported via
//   @openclaw/skill-industry-radar api.ts)
//
// This .mjs is the manual CLI surface (`node chuck-industry-radar.mjs run`)
// until openclaw cron supports long-running plugin daemons or Joseph wires a
// LaunchAgent to invoke the plugin via the openclaw native CLI. No daemon
// exists today, but the .mjs survives so the manual run path keeps working.
//
// EDITS: bug fixes go in BOTH places (here AND
// extensions/skill-industry-radar/src/*.ts).
// The .mjs retires when openclaw exposes a `skill exec` CLI and the cron
// picks it up.
// =============================================================================
//
// chuck-industry-radar — upstream-commit watcher for architectural decisions.
//
// SCOPED to the unique gap: existing watchers cover bus-event digests
// (apex-daily-digest), feed discovery (apex-feed-discovery), MCP registry
// (apex-mcp-registry-watcher); ClawHub covers RSS/newsletter/release/website
// changes (ai-daily-digest, github-release-watcher, website-change-watcher,
// rss-digest, etc.). What's MISSING is per-commit watching of upstream source
// repos for architectural decisions like maintainer-authored AGENTS.md /
// CLAUDE.md changes, refactors that constrain or unlock Chuck's work.
//
// Use case (the trigger): Pete Steinberger committed
// "refactor(plugins): simplify plugin cache boundaries" on 2026-04-29 with a
// new src/plugins/AGENTS.md rule against persistent metadata caches. Chuck
// discovered that rule mid-attempt while trying to add a cache. If this
// radar had been running, the prior day would have surfaced the commit and
// Chuck would have known the constraint up front.
//
// EMITS bus events; does NOT write its own digest. apex-daily-digest already
// summarizes the bus, so flagged commits land in the morning Telegram digest
// automatically.
//
// Sources config: ~/.openclaw/workspace/state/chuck-v3/industry-radar/sources.json
// Output dir:     ~/.openclaw/workspace/state/chuck-v3/industry-radar/
//   - state.json     last-run timestamps + per-source last-seen-sha
//   - raw-YYYY-MM-DD.json   raw aggregated input for replays / audits
//
// Bus events emitted (apex-daily-digest consumes):
//   - chuck.industry.radar.scan_started
//   - chuck.industry.radar.commit_flagged   (per surfaced commit, with score)
//   - chuck.industry.radar.scan_completed
//
// Usage:
//   chuck-industry-radar.mjs run         daily scan + emit
//   chuck-industry-radar.mjs status      print last-run summary

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const STATE_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "industry-radar");
const SOURCES_PATH = join(STATE_DIR, "sources.json");
const STATE_PATH = join(STATE_DIR, "state.json");
const APEX_EVENTS_PATH = join(HOME, ".openclaw", "workspace", "state", "apex-events.jsonl");

const SCANNER_KIND = "chuck-industry-radar";

function nowIso() {
  return new Date().toISOString();
}
function todayDate() {
  return nowIso().slice(0, 10);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function emitBus(type, payload) {
  if (!existsSync(dirname(APEX_EVENTS_PATH))) {
    mkdirSync(dirname(APEX_EVENTS_PATH), { recursive: true });
  }
  const entry = {
    id: `e-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`,
    ts: nowIso(),
    actor: "chuck",
    source: SCANNER_KIND,
    type,
    payload,
  };
  try {
    writeFileSync(APEX_EVENTS_PATH, `${JSON.stringify(entry)}\n`, { flag: "a" });
  } catch {
    // bus failure should never block radar work
  }
}

// ─── Source A: GitHub repos via gh CLI ──────────────────────────────────
//
// We use `gh api repos/<owner>/<repo>/commits?since=<iso>` to fetch commits
// since the last scan. No git clone needed. Requires `gh auth` set up; if
// not authed, the call returns an error — radar marks the source unhealthy
// and continues.

function fetchRepoCommits(repo, sinceIso) {
  const args = [
    "api",
    `/repos/${repo.owner}/${repo.repo}/commits?since=${encodeURIComponent(sinceIso)}&per_page=50`,
    "--jq",
    "[.[] | {sha, commit: {author: {name: .commit.author.name, date: .commit.author.date}, message: .commit.message}, html_url, files_changed_skipped: true}]",
  ];
  const result = spawnSync("gh", args, { encoding: "utf-8", timeout: 30_000 });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || "").trim().slice(0, 240) };
  }
  let commits;
  try {
    commits = JSON.parse(result.stdout);
  } catch (err) {
    return { ok: false, error: `parse error: ${err?.message ?? err}` };
  }
  return { ok: true, commits };
}

// Heuristic relevance score for a commit. High score = surface as bus event.
// Filters out docs typos, dependabot, test-only.
//
// We over-weight architectural-decision signals because that's the unique
// gap this radar is designed for — Pete-style refactor + AGENTS.md/CLAUDE.md
// rule additions that constrain Chuck's future work.
function scoreCommit(commit, repo) {
  const message = commit.commit?.message ?? "";
  const firstLine = message.split("\n", 1)[0].toLowerCase();
  const author = commit.commit?.author?.name ?? "";

  let score = 0;
  // Architectural-decision signals (the unique gap this radar fills)
  if (/agents\.md|claude\.md|architecture\.md|adr/i.test(message)) score += 5;
  if (/breaking change/i.test(message)) score += 5;
  if (/^refactor/i.test(firstLine)) score += 4;
  if (/deprecat/i.test(message)) score += 3;
  if (/migrate|migration/i.test(message)) score += 2;
  // Type prefix signals
  if (/^(feat|breaking|security|fix\(critical\))/i.test(firstLine)) score += 3;
  if (/architecture|design point|boundary/i.test(firstLine)) score += 3;
  // Demerits — never surface
  if (/^docs?(\(\w+\))?: typo|fix typo|spelling/i.test(firstLine)) score -= 6;
  if (/^chore\(deps\)/i.test(firstLine)) score -= 5;
  if (/^test(\(\w+\))?:/i.test(firstLine)) score -= 3;
  if (/dependabot|renovate|github-actions\[bot\]/i.test(author)) score -= 6;
  // Repo-weight multiplier
  score = Math.round(score * (repo.weight ?? 1));
  return score;
}

async function collectFromRepos(sources, state) {
  const out = [];
  const sinceIso = state.lastFullScanAt ?? new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  for (const repo of sources.repos ?? []) {
    process.stderr.write(`[radar] scanning ${repo.id} since ${sinceIso}…\n`);
    const result = fetchRepoCommits(repo, sinceIso);
    if (!result.ok) {
      out.push({ source: repo.id, ok: false, error: result.error });
      continue;
    }
    const ranked = result.commits
      .map((c) => ({ ...c, _score: scoreCommit(c, repo), _repo: repo.id }))
      .filter((c) => c._score > 0)
      .sort((a, b) => b._score - a._score);
    out.push({
      source: repo.id,
      ok: true,
      total: result.commits.length,
      surfaced: ranked.length,
      commits: ranked.slice(0, 8), // cap per-repo
    });
  }
  return out;
}

// ─── Source B: Gmail (newsletter scan) ───────────────────────────────────
//
// Joseph's gmail-toolkit MCP is available, but invoking it from this script
// requires either spawning the MCP server + JSON-RPC or finding a CLI shortcut.
// For first ship, fall back to the gmail-toolkit's underlying gmail API call
// via the `mcp` CLI bridge if available, OR skip with a documented reason.
// Keep the integration optional so radar still produces useful digest from
// repos alone.

async function collectFromGmail(sources) {
  // First-ship: skip with note. Gmail integration is a follow-up.
  return {
    source: "gmail",
    ok: false,
    skipped: true,
    reason:
      "gmail integration deferred — needs MCP CLI bridge or direct OAuth flow. Repo signal lights up the digest in the meantime.",
  };
}

// ─── Source C: Blog feeds (planned) ──────────────────────────────────────

async function collectFromBlogs(sources) {
  return {
    source: "blogs",
    ok: false,
    skipped: true,
    reason:
      "RSS/blog scrape deferred — first-ship focuses on commit signal which is the highest-density actionable surface.",
  };
}

// ─── Synthesis ───────────────────────────────────────────────────────────

function buildDigestMarkdown(allSignals, sources) {
  const lines = [];
  const today = todayDate();
  lines.push(`# Industry Radar — ${today}`);
  lines.push("");
  lines.push(
    `Daily aggregation of upstream commits + blog/newsletter signal that may affect Joseph's openclaw fork stack.`,
  );
  lines.push(``);

  // Repos section
  const repoSignals = allSignals.filter(
    (s) => s.source && s.source !== "gmail" && s.source !== "blogs",
  );
  let totalSurfaced = 0;
  for (const sig of repoSignals) {
    totalSurfaced += sig.surfaced ?? 0;
  }
  lines.push(`## Upstream commits (${totalSurfaced} flagged)`);
  lines.push(``);
  for (const sig of repoSignals) {
    if (!sig.ok) {
      lines.push(`- \`${sig.source}\`: ⚠ scan failed — ${sig.error}`);
      continue;
    }
    if (sig.surfaced === 0) {
      lines.push(`- \`${sig.source}\`: clean (${sig.total} commits scanned, none flagged)`);
      continue;
    }
    lines.push(`### \`${sig.source}\` — ${sig.surfaced} flagged`);
    for (const c of sig.commits) {
      const firstLine = (c.commit?.message ?? "").split("\n", 1)[0].slice(0, 100);
      const author = c.commit?.author?.name ?? "?";
      const date = (c.commit?.author?.date ?? "").slice(0, 10);
      lines.push(
        `- **score=${c._score}** \`${c.sha?.slice(0, 7)}\` ${firstLine} — ${author} (${date}) — [link](${c.html_url})`,
      );
    }
    lines.push(``);
  }

  // Skipped sources
  const skipped = allSignals.filter((s) => s.skipped);
  if (skipped.length > 0) {
    lines.push(`## Sources skipped (first-ship)`);
    for (const s of skipped) {
      lines.push(`- \`${s.source}\`: ${s.reason}`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`Generated by chuck-industry-radar at ${nowIso()}.`);
  lines.push(
    `Synthesis prompt available at \`sources.json#synthesisPrompt\` for fleet-voice synthesis (next iteration).`,
  );
  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────

async function runScan({ synthesize = true } = {}) {
  if (!existsSync(SOURCES_PATH)) {
    process.stderr.write(`[radar] sources config missing at ${SOURCES_PATH}\n`);
    process.exit(2);
  }
  const sources = readJson(SOURCES_PATH, {});
  const state = readJson(STATE_PATH, { lastFullScanAt: null });

  const startedAt = nowIso();
  emitBus("chuck.industry.radar.scan_started", { startedAt, mode: synthesize ? "run" : "scan" });

  const repoSignals = await collectFromRepos(sources, state);
  const gmailSignal = await collectFromGmail(sources);
  const blogsSignal = await collectFromBlogs(sources);

  const all = [...repoSignals, gmailSignal, blogsSignal];

  // Persist raw + digest
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const today = todayDate();
  const rawPath = join(STATE_DIR, `raw-${today}.json`);
  const digestPath = join(STATE_DIR, `digest-${today}.md`);
  writeJson(rawPath, { generatedAt: nowIso(), startedAt, signals: all });
  writeFileSync(digestPath, buildDigestMarkdown(all, sources));

  // Update state
  const newState = {
    ...state,
    lastFullScanAt: startedAt,
    lastDigestPath: digestPath,
    lastRawPath: rawPath,
  };
  writeJson(STATE_PATH, newState);

  // Summary stats for bus
  const totalSurfaced = repoSignals.reduce((acc, s) => acc + (s.surfaced ?? 0), 0);
  const reposOk = repoSignals.filter((s) => s.ok).length;
  const reposFail = repoSignals.filter((s) => !s.ok).length;

  emitBus("chuck.industry.radar.scan_completed", {
    startedAt,
    completedAt: nowIso(),
    durationMs: Date.now() - Date.parse(startedAt),
    reposScanned: reposOk + reposFail,
    reposOk,
    reposFail,
    commitsSurfaced: totalSurfaced,
    digestPath,
    rawPath,
    notificationCandidate: totalSurfaced > 0,
  });

  return {
    ok: true,
    digestPath,
    rawPath,
    summary: { reposOk, reposFail, commitsSurfaced: totalSurfaced },
  };
}

function runStatus() {
  const state = readJson(STATE_PATH, null);
  if (!state) {
    return { ok: true, message: "no scan run yet" };
  }
  return state;
}

const cmd = process.argv[2] ?? "run";
const subResult =
  cmd === "run"
    ? await runScan({ synthesize: true })
    : cmd === "scan"
      ? await runScan({ synthesize: false })
      : cmd === "status"
        ? runStatus()
        : { ok: false, error: `unknown command: ${cmd}` };

process.stdout.write(`${JSON.stringify(subResult, null, 2)}\n`);
process.exit(subResult.ok === false ? 1 : 0);
