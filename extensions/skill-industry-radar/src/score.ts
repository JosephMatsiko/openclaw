// scoreCommit — heuristic relevance scoring. High score = surface as bus
// event. Filters out docs typos, dependabot, test-only.
//
// Over-weights architectural-decision signals because that's the unique gap
// this radar fills (Pete-style refactor + AGENTS.md/CLAUDE.md rule additions
// that constrain Chuck's future work).

import type { RawCommit, RepoSource } from "./types.js";

export function scoreCommit(commit: RawCommit, repo: RepoSource): number {
  const message = commit.commit?.message ?? "";
  const firstLine = message.split("\n", 1)[0]?.toLowerCase() ?? "";
  const author = commit.commit?.author?.name ?? "";

  let score = 0;
  // Architectural-decision signals (unique gap this radar fills)
  if (/agents\.md|claude\.md|architecture\.md|adr/i.test(message)) score += 5;
  if (/breaking change/i.test(message)) score += 5;
  if (/^refactor/i.test(firstLine)) score += 4;
  if (/deprecat/i.test(message)) score += 3;
  if (/migrate|migration/i.test(message)) score += 2;
  // Type-prefix signals
  if (/^(feat|breaking|security|fix\(critical\))/i.test(firstLine)) score += 3;
  if (/architecture|design point|boundary/i.test(firstLine)) score += 3;
  // Demerits — never surface
  if (/^docs?(\(\w+\))?: typo|fix typo|spelling/i.test(firstLine)) score -= 6;
  if (/^chore\(deps\)/i.test(firstLine)) score -= 5;
  if (/^test(\(\w+\))?:/i.test(firstLine)) score -= 3;
  if (/dependabot|renovate|github-actions\[bot\]/i.test(author)) score -= 6;
  // Repo-weight multiplier
  return Math.round(score * (repo.weight ?? 1));
}
