import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CHUCK_V2_STATE_DIR } from "./config.js";

const execFileAsync = promisify(execFile);

export type GitHubBranchCategory =
  | "protected"
  | "current-work"
  | "upstream-overlap"
  | "fork-only-active"
  | "fork-only-stale"
  | "agent-generated"
  | "numeric-or-unknown"
  | "backup"
  | "release-or-integration";

export type GitHubBranchEntry = {
  remote: string;
  name: string;
  sha: string;
  lastCommitAt?: string;
  category: GitHubBranchCategory;
  forkOnly: boolean;
  protected: boolean;
  deleteCandidate: boolean;
  rationale: string;
};

export type GitHubHygieneReport = {
  available: true;
  forkRemote: string;
  upstreamRemote: string;
  currentBranch: string;
  totalForkBranches: number;
  totalUpstreamBranches: number;
  overlapCount: number;
  forkOnlyCount: number;
  deleteCandidateCount: number;
  protectedCount: number;
  categories: Array<{
    category: GitHubBranchCategory;
    total: number;
    deleteCandidates: number;
    examples: string[];
  }>;
  branches: GitHubBranchEntry[];
  blockers: string[];
  nextActions: string[];
  policy: string[];
};

export type UnavailableGitHubHygieneReport = {
  available: false;
  reason: string;
};

export type AnyGitHubHygieneReport = GitHubHygieneReport | UnavailableGitHubHygieneReport;

export type GitHubHygieneCheckpoint = {
  checkpointId: string;
  createdAt: string;
  checkpointDir: string;
  reportPath: string;
  branchManifestPath: string;
  deletionCandidatePath: string;
  remediationMarkdownPath: string;
  commandPlanPath: string;
  report: AnyGitHubHygieneReport;
};

type RawRemoteBranch = {
  remote: string;
  name: string;
  sha: string;
  lastCommitAt?: string;
};

export async function inspectGitHubHygiene({
  repoRoot = process.cwd(),
  forkRemote = "fork",
  upstreamRemote = "origin",
  fetch = false,
  now = new Date().toISOString(),
}: {
  repoRoot?: string;
  forkRemote?: string;
  upstreamRemote?: string;
  fetch?: boolean;
  now?: string;
} = {}): Promise<AnyGitHubHygieneReport> {
  try {
    if (fetch) {
      await Promise.all([
        gitText(repoRoot, ["fetch", forkRemote, "--prune", "--no-tags"]),
        gitText(repoRoot, ["fetch", upstreamRemote, "--prune", "--no-tags"]),
      ]);
    }
    const [forkBranches, upstreamBranches, currentBranch] = await Promise.all([
      remoteBranches(repoRoot, forkRemote),
      remoteBranches(repoRoot, upstreamRemote),
      gitText(repoRoot, ["branch", "--show-current"])
        .then((text) => text.trim())
        .catch(() => ""),
    ]);
    const upstreamByName = new Map(upstreamBranches.map((branch) => [branch.name, branch]));
    const protectedNames = new Set(
      ["main", "master", "develop", "dev", "release", currentBranch].filter(Boolean),
    );
    const branches = forkBranches
      .map((branch) => {
        const upstream = upstreamByName.get(branch.name);
        return classifyForkBranch({
          branch,
          upstream,
          currentBranch,
          protectedNames,
          now,
        });
      })
      .toSorted(
        (a, b) =>
          categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name),
      );
    const categories = summarizeBranchCategories(branches);
    const deleteCandidateCount = branches.filter((branch) => branch.deleteCandidate).length;
    const blockers = githubHygieneBlockers({ deleteCandidateCount, currentBranch });
    return {
      available: true,
      forkRemote,
      upstreamRemote,
      currentBranch,
      totalForkBranches: forkBranches.length,
      totalUpstreamBranches: upstreamBranches.length,
      overlapCount: branches.filter((branch) => !branch.forkOnly).length,
      forkOnlyCount: branches.filter((branch) => branch.forkOnly).length,
      deleteCandidateCount,
      protectedCount: branches.filter((branch) => branch.protected).length,
      categories,
      branches,
      blockers,
      nextActions: githubHygieneNextActions(deleteCandidateCount),
      policy: [
        "GitHub cleanup is destructive; branch deletion requires an explicit review manifest",
        "main, current work, release, integration, and upstream-overlap branches are protected by default",
        "fork-only stale branches are candidates, not commands",
        "delete candidates are snapshotted locally before any remote mutation",
        "GitHub becomes recovery and review infrastructure after local lanes are clean",
      ],
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createGitHubHygieneCheckpoint({
  repoRoot = process.cwd(),
  stateDir = CHUCK_V2_STATE_DIR,
  forkRemote = "fork",
  upstreamRemote = "origin",
  now = new Date().toISOString(),
}: {
  repoRoot?: string;
  stateDir?: string;
  forkRemote?: string;
  upstreamRemote?: string;
  now?: string;
} = {}): Promise<GitHubHygieneCheckpoint> {
  const checkpointId = `github-hygiene-${now.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`;
  const checkpointDir = join(stateDir, "github-hygiene", checkpointId);
  await mkdir(checkpointDir, { recursive: true });
  const report = await inspectGitHubHygiene({
    repoRoot,
    forkRemote,
    upstreamRemote,
    fetch: true,
    now,
  });
  const reportPath = join(checkpointDir, "report.json");
  const branchManifestPath = join(checkpointDir, "branch-manifest.json");
  const deletionCandidatePath = join(checkpointDir, "delete-candidates.review-only.txt");
  const remediationMarkdownPath = join(checkpointDir, "remediation.md");
  const commandPlanPath = join(checkpointDir, "commands.review-only.sh");
  const branches = report.available ? report.branches : [];
  const deletionCandidates = branches.filter((branch) => branch.deleteCandidate);
  await Promise.all([
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(branchManifestPath, `${JSON.stringify(branches, null, 2)}\n`, "utf8"),
    writeFile(
      deletionCandidatePath,
      `${deletionCandidates.map((branch) => branch.name).join("\n")}${deletionCandidates.length > 0 ? "\n" : ""}`,
      "utf8",
    ),
    writeFile(
      remediationMarkdownPath,
      gitHubHygieneRemediationMarkdown({ checkpointId, now, report }),
      "utf8",
    ),
    writeFile(commandPlanPath, gitHubHygieneCommandPlan({ report, deletionCandidatePath }), "utf8"),
  ]);
  return {
    checkpointId,
    createdAt: now,
    checkpointDir,
    reportPath,
    branchManifestPath,
    deletionCandidatePath,
    remediationMarkdownPath,
    commandPlanPath,
    report,
  };
}

export function formatGitHubHygieneReport(report: AnyGitHubHygieneReport): string {
  if (!report.available) {
    return `Chuck GitHub hygiene unavailable: ${report.reason}`;
  }
  const lines = [
    "Chuck GitHub hygiene",
    `Fork remote: ${report.forkRemote}`,
    `Upstream remote: ${report.upstreamRemote}`,
    `Current branch: ${report.currentBranch || "unknown"}`,
    `Fork branches: ${report.totalForkBranches}`,
    `Upstream branches: ${report.totalUpstreamBranches}`,
    `Fork-only branches: ${report.forkOnlyCount}`,
    `Delete candidates: ${report.deleteCandidateCount}`,
    `Protected branches: ${report.protectedCount}`,
  ];
  if (report.blockers.length > 0) {
    lines.push("", "Blockers:");
    lines.push(...report.blockers.map((blocker) => `- ${blocker}`));
  }
  lines.push("", "Categories:");
  lines.push(
    ...report.categories.map(
      (category) =>
        `- ${category.category}: ${category.total} branch(es), ${category.deleteCandidates} delete candidate(s)`,
    ),
  );
  lines.push("", "Next actions:");
  lines.push(...report.nextActions.map((action) => `- ${action}`));
  return lines.join("\n");
}

export function formatGitHubHygieneCheckpoint(checkpoint: GitHubHygieneCheckpoint): string {
  return [
    `Chuck GitHub hygiene checkpoint ${checkpoint.checkpointId}`,
    `Directory: ${checkpoint.checkpointDir}`,
    "",
    "Artifacts:",
    `- ${checkpoint.reportPath}`,
    `- ${checkpoint.branchManifestPath}`,
    `- ${checkpoint.deletionCandidatePath}`,
    `- ${checkpoint.remediationMarkdownPath}`,
    `- ${checkpoint.commandPlanPath}`,
    "",
    formatGitHubHygieneReport(checkpoint.report),
  ].join("\n");
}

export function classifyForkBranch({
  branch,
  upstream,
  currentBranch,
  protectedNames,
  now,
}: {
  branch: RawRemoteBranch;
  upstream?: RawRemoteBranch;
  currentBranch: string;
  protectedNames: Set<string>;
  now: string;
}): GitHubBranchEntry {
  const forkOnly = !upstream;
  const protectedBranch =
    protectedNames.has(branch.name) ||
    branch.name.startsWith("release/") ||
    branch.name.startsWith("mainline/");
  const ageDays = branch.lastCommitAt ? ageInDays(branch.lastCommitAt, now) : undefined;
  const agentGenerated = /^(codex|claude|ak|ag|bm|ci|chore)\//.test(branch.name);
  const backup = branch.name.startsWith("backup/") || branch.name.includes("/backup-");
  const numeric = /^\d+$/.test(branch.name);
  const releaseOrIntegration = /^(release|mainline|staging|prod|production|hotfix)\b/.test(
    branch.name,
  );
  let category: GitHubBranchCategory;
  let rationale: string;
  if (protectedBranch) {
    category = branch.name === currentBranch ? "current-work" : "protected";
    rationale = "protected by name, current checkout, or integration convention";
  } else if (!forkOnly) {
    category = "upstream-overlap";
    rationale = "also present on upstream; do not delete as fork clutter without upstream policy";
  } else if (releaseOrIntegration) {
    category = "release-or-integration";
    rationale = "release/integration-looking branch; manual review required";
  } else if (backup) {
    category = "backup";
    rationale = "backup branch; archive decision must be explicit";
  } else if (agentGenerated) {
    category = "agent-generated";
    rationale = "agent/bot/generated branch namespace";
  } else if (numeric) {
    category = "numeric-or-unknown";
    rationale = "numeric branch name has unclear ownership";
  } else if (ageDays !== undefined && ageDays > 90) {
    category = "fork-only-stale";
    rationale = `fork-only branch older than 90 days (${Math.round(ageDays)} days)`;
  } else {
    category = "fork-only-active";
    rationale =
      ageDays === undefined
        ? "fork-only branch with unknown age"
        : `fork-only branch updated ${Math.round(ageDays)} days ago`;
  }
  const deleteCandidate =
    forkOnly &&
    !protectedBranch &&
    ["agent-generated", "numeric-or-unknown", "fork-only-stale"].includes(category) &&
    (ageDays === undefined || ageDays > 30);
  return {
    remote: branch.remote,
    name: branch.name,
    sha: branch.sha,
    lastCommitAt: branch.lastCommitAt,
    category,
    forkOnly,
    protected: protectedBranch,
    deleteCandidate,
    rationale,
  };
}

function gitHubHygieneRemediationMarkdown({
  checkpointId,
  now,
  report,
}: {
  checkpointId: string;
  now: string;
  report: AnyGitHubHygieneReport;
}): string {
  const lines = [
    `# GitHub Hygiene Remediation: ${checkpointId}`,
    "",
    `Generated: ${now}`,
    "",
    "## Executive Rule",
    "",
    "Do not delete remote branches from the fork until the local repo lanes are clean, the branch manifest is reviewed, and the deletion candidate list is approved. GitHub cleanup is a recovery and coordination step, not a substitute for local hygiene.",
    "",
    "## Current State",
    "",
  ];
  if (report.available) {
    lines.push(
      `- Fork branches: ${report.totalForkBranches}`,
      `- Upstream branches: ${report.totalUpstreamBranches}`,
      `- Fork-only branches: ${report.forkOnlyCount}`,
      `- Delete candidates: ${report.deleteCandidateCount}`,
      `- Protected branches: ${report.protectedCount}`,
      "",
      "## Categories",
      "",
      ...report.categories.map(
        (category) =>
          `- ${category.category}: ${category.total} branch(es), ${category.deleteCandidates} delete candidate(s); examples: ${category.examples.join(", ") || "none"}`,
      ),
      "",
      "## Blockers",
      "",
      ...(report.blockers.length > 0
        ? report.blockers.map((blocker) => `- ${blocker}`)
        : ["- none"]),
    );
  } else {
    lines.push(`- GitHub hygiene unavailable: ${report.reason}`);
  }
  lines.push(
    "",
    "## Cleanup Order",
    "",
    "1. Keep local lane cleanup ahead of remote deletion.",
    "2. Review branch-manifest.json for protected/current/release branches.",
    "3. Review delete-candidates.review-only.txt.",
    "4. Delete candidates in small batches only after approval.",
    "5. Fetch/prune locally after remote cleanup and create a new checkpoint.",
    "",
    "## Durable Policy",
    "",
    "- No branch deletion without a manifest.",
    "- No branch deletion while the current local branch is dirty.",
    "- No deletion of upstream-overlap branches as fork clutter.",
    "- No cleanup push from an unauthenticated or unknown account.",
    "- Prefer PR branches with named lanes over long-lived branch sprawl.",
    "",
  );
  return lines.join("\n");
}

function gitHubHygieneCommandPlan({
  report,
  deletionCandidatePath,
}: {
  report: AnyGitHubHygieneReport;
  deletionCandidatePath: string;
}): string {
  const remote = report.available ? report.forkRemote : "fork";
  const lines = [
    "#!/usr/bin/env bash",
    "# Review-only command plan generated by Chuck GitHub hygiene.",
    "# Do not run wholesale. Remote branch deletion is destructive.",
    "set -euo pipefail",
    "",
    `# Review candidates first: sed -n '1,200p' "${deletionCandidatePath}"`,
    `# Dry mental model: every line would become: git push ${remote} --delete <branch>`,
    "# After explicit approval, delete in small batches and run: git fetch fork --prune --no-tags",
    "",
  ];
  if (report.available) {
    for (const branch of report.branches.filter((entry) => entry.deleteCandidate).slice(0, 200)) {
      lines.push(
        `# git push ${remote} --delete ${quoteShell(branch.name)}  # ${branch.category}: ${branch.rationale}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function summarizeBranchCategories(
  branches: GitHubBranchEntry[],
): GitHubHygieneReport["categories"] {
  const categories = new Map<GitHubBranchCategory, GitHubHygieneReport["categories"][number]>();
  for (const branch of branches) {
    const row = categories.get(branch.category) ?? {
      category: branch.category,
      total: 0,
      deleteCandidates: 0,
      examples: [],
    };
    row.total += 1;
    if (branch.deleteCandidate) {
      row.deleteCandidates += 1;
    }
    if (row.examples.length < 8) {
      row.examples.push(branch.name);
    }
    categories.set(branch.category, row);
  }
  return [...categories.values()].toSorted(
    (a, b) => b.total - a.total || a.category.localeCompare(b.category),
  );
}

function githubHygieneBlockers({
  deleteCandidateCount,
  currentBranch,
}: {
  deleteCandidateCount: number;
  currentBranch: string;
}): string[] {
  const blockers: string[] = [];
  if (!currentBranch) {
    blockers.push("current branch is unknown; protect checkout before remote cleanup");
  }
  if (deleteCandidateCount > 0) {
    blockers.push(
      `${deleteCandidateCount} fork branch(es) are deletion candidates but require explicit manifest review before remote mutation`,
    );
  }
  return blockers;
}

function githubHygieneNextActions(deleteCandidateCount: number): string[] {
  if (deleteCandidateCount === 0) {
    return ["no branch deletion candidates detected; keep using named lane branches"];
  }
  return [
    "finish local repo lane cleanup before remote deletion",
    "review delete-candidates.review-only.txt",
    "delete approved remote branches in small batches only after authentication/account identity is confirmed",
    "prefer one clean branch per lane or PR going forward",
  ];
}

async function remoteBranches(repoRoot: string, remote: string): Promise<RawRemoteBranch[]> {
  const text = await gitText(repoRoot, [
    "for-each-ref",
    `refs/remotes/${remote}`,
    "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)",
  ]);
  const branches = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [ref = "", sha = "", lastCommitAt = ""] = line.split("\t");
      if (!ref || ref === `${remote}/HEAD`) {
        return [];
      }
      const name = ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
      return [{ remote, name, sha, lastCommitAt: lastCommitAt || undefined }];
    });
  if (branches.length > 0) {
    return branches;
  }
  const lsRemoteText = await gitText(repoRoot, ["ls-remote", "--heads", remote]);
  return lsRemoteText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ref = ""] = line.split(/\s+/);
      return {
        remote,
        name: ref.replace(/^refs\/heads\//, ""),
        sha,
      };
    });
}

function ageInDays(iso: string, now: string): number {
  const thenMs = Date.parse(iso);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) {
    return Number.NaN;
  }
  return Math.max(0, (nowMs - thenMs) / 86_400_000);
}

function categoryRank(category: GitHubBranchCategory): number {
  const order: GitHubBranchCategory[] = [
    "current-work",
    "protected",
    "release-or-integration",
    "upstream-overlap",
    "fork-only-active",
    "fork-only-stale",
    "backup",
    "agent-generated",
    "numeric-or-unknown",
  ];
  return order.indexOf(category);
}

async function gitText(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
