// fetchRepoCommits — calls `gh api repos/<owner>/<repo>/commits?since=<iso>`
// to fetch commits since the last scan. No git clone needed. Requires
// `gh auth` set up; if not authed, the call returns an error → radar marks
// the source unhealthy and continues.

import { spawnSync } from "node:child_process";
import type { IndustryRadarConfig } from "./config.js";
import type { RawCommit, RepoSource } from "./types.js";

export interface FetchResult {
  ok: boolean;
  commits?: RawCommit[];
  error?: string;
}

export function fetchRepoCommits(
  repo: RepoSource,
  sinceIso: string,
  config: IndustryRadarConfig,
): FetchResult {
  const args = [
    "api",
    `/repos/${repo.owner}/${repo.repo}/commits?since=${encodeURIComponent(sinceIso)}&per_page=${config.ghPerPage}`,
    "--jq",
    "[.[] | {sha, commit: {author: {name: .commit.author.name, date: .commit.author.date}, message: .commit.message}, html_url, files_changed_skipped: true}]",
  ];
  const result = spawnSync(config.ghCliPath, args, {
    encoding: "utf-8",
    timeout: config.ghTimeoutMs,
  });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? "").trim().slice(0, 240) };
  }
  let commits: RawCommit[];
  try {
    commits = JSON.parse(result.stdout) as RawCommit[];
  } catch (err) {
    return { ok: false, error: `parse error: ${(err as Error).message ?? err}` };
  }
  return { ok: true, commits };
}
