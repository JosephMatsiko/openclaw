// runScan — primary entry point. Loads sources + last-scan state, fetches
// new commits per repo via gh CLI, scores them, builds the daily digest,
// emits bus events, persists raw + state.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IndustryRadarConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { buildDigestMarkdown } from "./digest.js";
import { createEventEmitter } from "./events.js";
import { fetchRepoCommits } from "./fetch.js";
import { scoreCommit } from "./score.js";
import type {
  RadarState,
  RawCommit,
  RepoSignal,
  RepoSource,
  ScanOptions,
  ScanResult,
  ScoredCommit,
  Signal,
  SkippedSignal,
  SourcesConfig,
} from "./types.js";

export function statePath(config: IndustryRadarConfig): string {
  return join(config.stateDir, "state.json");
}

export function sourcesPath(config: IndustryRadarConfig): string {
  return join(config.stateDir, "sources.json");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  if (!existsSync(join(path, ".."))) mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function runScan(
  options: ScanOptions = {},
  configIn?: IndustryRadarConfig,
): Promise<ScanResult> {
  const config = configIn ?? resolveConfig({});
  const now = options.now ?? Date.now();
  const events = createEventEmitter(config.eventsPath);

  // Sources can be supplied inline (testing) or read from sources.json.
  const sources: SourcesConfig = options.sourcesOverride ?? readJson(sourcesPath(config), {});
  if (!sources?.repos || sources.repos.length === 0) {
    return {
      ok: false,
      summary: { reposOk: 0, reposFail: 0, commitsSurfaced: 0 },
    };
  }

  const state = readJson<RadarState>(statePath(config), { lastFullScanAt: null });
  const sinceIso =
    state.lastFullScanAt ?? new Date(now - config.fallbackLookbackHours * 3_600_000).toISOString();
  const startedAt = new Date(now).toISOString();

  events.emit("chuck.industry.radar.scan_started", { startedAt, sinceIso });

  const fetcher =
    options.fetchCommits ?? ((r: RepoSource, s: string) => fetchRepoCommits(r, s, config));

  const repoSignals: RepoSignal[] = [];
  for (const repo of sources.repos) {
    const result = fetcher(repo, sinceIso);
    if (!result.ok) {
      repoSignals.push({ source: repo.id, ok: false, error: result.error });
      continue;
    }
    const commits = result.commits ?? [];
    const ranked: ScoredCommit[] = commits
      .map((c: RawCommit) => ({ ...c, _score: scoreCommit(c, repo), _repo: repo.id }))
      .filter((c) => c._score > 0)
      .sort((a, b) => b._score - a._score);
    repoSignals.push({
      source: repo.id,
      ok: true,
      total: commits.length,
      surfaced: ranked.length,
      commits: ranked.slice(0, config.perRepoCap),
    });
  }

  // Skipped sources (gmail / blogs) — placeholder for v0.2.
  const skipped: SkippedSignal[] = [
    {
      source: "gmail",
      ok: false,
      skipped: true,
      reason:
        "gmail integration deferred — needs MCP CLI bridge or direct OAuth flow. Repo signal lights up the digest in the meantime.",
    },
    {
      source: "blogs",
      ok: false,
      skipped: true,
      reason:
        "RSS/blog scrape deferred — first-ship focuses on commit signal which is the highest-density actionable surface.",
    },
  ];

  const allSignals: Signal[] = [...repoSignals, ...skipped];

  // Per-commit bus events for high-score commits.
  for (const sig of repoSignals) {
    for (const c of sig.commits ?? []) {
      events.emit("chuck.industry.radar.commit_flagged", {
        source: sig.source,
        sha: c.sha,
        score: c._score,
        author: c.commit?.author?.name,
        date: c.commit?.author?.date,
        firstLine: (c.commit?.message ?? "").split("\n", 1)[0]?.slice(0, 200),
        url: c.html_url,
      });
    }
  }

  const todayIso = new Date(now).toISOString();
  const today = todayIso.slice(0, 10);

  let digestPath: string | undefined;
  let rawPath: string | undefined;
  if (!options.dryRun) {
    if (!existsSync(config.stateDir)) mkdirSync(config.stateDir, { recursive: true });
    rawPath = join(config.stateDir, `raw-${today}.json`);
    digestPath = join(config.stateDir, `digest-${today}.md`);
    writeJson(rawPath, { generatedAt: todayIso, startedAt, signals: allSignals });
    writeFileSync(digestPath, buildDigestMarkdown(allSignals, todayIso, todayIso));
    writeJson(statePath(config), {
      ...state,
      lastFullScanAt: startedAt,
      lastDigestPath: digestPath,
      lastRawPath: rawPath,
    });
  }

  const reposOk = repoSignals.filter((s) => s.ok).length;
  const reposFail = repoSignals.filter((s) => !s.ok).length;
  const totalSurfaced = repoSignals.reduce((acc, s) => acc + (s.surfaced ?? 0), 0);

  events.emit("chuck.industry.radar.scan_completed", {
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(startedAt),
    reposScanned: reposOk + reposFail,
    reposOk,
    reposFail,
    commitsSurfaced: totalSurfaced,
    digestPath: digestPath ?? null,
    rawPath: rawPath ?? null,
    notificationCandidate: totalSurfaced > 0,
  });

  return {
    ok: true,
    digestPath,
    rawPath,
    summary: { reposOk, reposFail, commitsSurfaced: totalSurfaced },
    signals: allSignals,
  };
}

export function summarizeStatus(configIn?: IndustryRadarConfig): RadarState | { message: string } {
  const config = configIn ?? resolveConfig({});
  const state = readJson<RadarState | null>(statePath(config), null);
  if (!state) return { message: "no scan run yet" };
  return state;
}
