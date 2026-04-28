import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CHUCK_V2_STATE_DIR } from "./config.js";
import { inspectRepoHygiene, type AnyRepoHygieneReport } from "./repo-hygiene.js";

const execFileAsync = promisify(execFile);

export type UpstreamSyncReport = {
  available: true;
  currentBranch: string;
  packageVersion?: string;
  headSha: string;
  headSummary: string;
  describe: string;
  upstreamRemote: string;
  latestStableTag?: string;
  latestStableSha?: string;
  upstreamMainSha?: string;
  stableBehind: boolean;
  mainBehind: boolean;
  localDirty: boolean;
  broadSyncAllowed: boolean;
  blockers: string[];
  nextActions: string[];
  policy: string[];
  repoHygiene: AnyRepoHygieneReport;
};

export type UnavailableUpstreamSyncReport = {
  available: false;
  reason: string;
};

export type AnyUpstreamSyncReport = UpstreamSyncReport | UnavailableUpstreamSyncReport;

export type UpstreamSyncCheckpoint = {
  checkpointId: string;
  createdAt: string;
  checkpointDir: string;
  reportPath: string;
  remediationMarkdownPath: string;
  commandPlanPath: string;
  report: AnyUpstreamSyncReport;
};

export async function inspectUpstreamSync({
  repoRoot = process.cwd(),
  upstreamRemote = "origin",
  fetch = false,
}: {
  repoRoot?: string;
  upstreamRemote?: string;
  fetch?: boolean;
} = {}): Promise<AnyUpstreamSyncReport> {
  try {
    if (fetch) {
      await gitText(repoRoot, ["fetch", upstreamRemote, "--tags", "--prune"]);
    }
    const [
      currentBranch,
      packageVersion,
      headSha,
      headSummary,
      describe,
      localStableTags,
      remoteStableTagRefs,
      mainSha,
    ] = await Promise.all([
      gitText(repoRoot, ["branch", "--show-current"]).then((text) => text.trim()),
      packageVersionText(repoRoot),
      gitText(repoRoot, ["rev-parse", "HEAD"]).then((text) => text.trim()),
      gitText(repoRoot, ["log", "-1", "--format=%h %cI %s"]).then((text) => text.trim()),
      gitText(repoRoot, ["describe", "--tags", "--always", "--dirty"]).then((text) => text.trim()),
      gitText(repoRoot, ["tag", "--list", "v[0-9]*", "--sort=-v:refname"]),
      remoteStableTags(repoRoot, upstreamRemote).catch(() => []),
      gitText(repoRoot, ["ls-remote", "--heads", upstreamRemote, "main"])
        .then((text) => text.split(/\s+/)[0] ?? "")
        .catch(() => ""),
    ]);
    const latestLocalStableTag = localStableTags
      .split("\n")
      .map((tag) => tag.trim())
      .filter(isStableReleaseTag)
      .toSorted(compareStableReleaseTags)[0];
    const latestRemoteStable = remoteStableTagRefs[0];
    const latestStableTag = latestRemoteStable?.tag ?? latestLocalStableTag;
    const latestStableSha = latestRemoteStable?.sha
      ? latestRemoteStable.sha
      : latestStableTag
        ? await gitText(repoRoot, ["rev-list", "-n", "1", latestStableTag]).then((text) =>
            text.trim(),
          )
        : undefined;
    const repoHygiene = await inspectRepoHygiene({ repoRoot });
    const localDirty = repoHygiene.available ? !repoHygiene.clean : true;
    const stableBehind = Boolean(latestStableSha && latestStableSha !== headSha);
    const mainBehind = Boolean(mainSha && mainSha !== headSha);
    const blockers = upstreamSyncBlockers({
      localDirty,
      repoHygiene,
      stableBehind,
      latestStableTag,
      currentBranch,
    });
    return {
      available: true,
      currentBranch,
      packageVersion,
      headSha,
      headSummary,
      describe,
      upstreamRemote,
      latestStableTag,
      latestStableSha,
      upstreamMainSha: mainSha || undefined,
      stableBehind,
      mainBehind,
      localDirty,
      broadSyncAllowed: blockers.length === 0,
      blockers,
      nextActions: upstreamSyncNextActions({ localDirty, stableBehind, latestStableTag }),
      policy: [
        "watch upstream continuously, but do not merge/rebase over dirty Chuck lanes",
        "stable release tags are preferred sync anchors; main is for explicit integration lanes",
        "create a repo hygiene checkpoint before sync attempts",
        "after syncing, rerun Kernel, extension, OpenClaw command, and surface-driver smoke tests",
        "sync is reversible: create a named branch or checkpoint before moving the active branch",
      ],
      repoHygiene,
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createUpstreamSyncCheckpoint({
  repoRoot = process.cwd(),
  stateDir = CHUCK_V2_STATE_DIR,
  upstreamRemote = "origin",
  now = new Date().toISOString(),
}: {
  repoRoot?: string;
  stateDir?: string;
  upstreamRemote?: string;
  now?: string;
} = {}): Promise<UpstreamSyncCheckpoint> {
  const checkpointId = `upstream-sync-${now.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`;
  const checkpointDir = join(stateDir, "upstream-sync", checkpointId);
  await mkdir(checkpointDir, { recursive: true });
  const report = await inspectUpstreamSync({ repoRoot, upstreamRemote, fetch: true });
  const reportPath = join(checkpointDir, "report.json");
  const remediationMarkdownPath = join(checkpointDir, "remediation.md");
  const commandPlanPath = join(checkpointDir, "commands.review-only.sh");
  await Promise.all([
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(
      remediationMarkdownPath,
      upstreamSyncRemediationMarkdown({ checkpointId, now, report }),
      "utf8",
    ),
    writeFile(commandPlanPath, upstreamSyncCommandPlan({ report }), "utf8"),
  ]);
  return {
    checkpointId,
    createdAt: now,
    checkpointDir,
    reportPath,
    remediationMarkdownPath,
    commandPlanPath,
    report,
  };
}

export function formatUpstreamSyncReport(report: AnyUpstreamSyncReport): string {
  if (!report.available) {
    return `Chuck upstream sync unavailable: ${report.reason}`;
  }
  const lines = [
    "Chuck upstream sync",
    `Current branch: ${report.currentBranch || "unknown"}`,
    `Package version: ${report.packageVersion ?? "unknown"}`,
    `HEAD: ${report.headSummary}`,
    `Describe: ${report.describe}`,
    `Upstream remote: ${report.upstreamRemote}`,
    `Latest stable tag: ${report.latestStableTag ?? "unknown"}`,
    `Stable drift: ${report.stableBehind ? "behind/different" : "at latest stable tag"}`,
    `Main drift: ${report.mainBehind ? "different from upstream main" : "matches upstream main"}`,
    `Local dirt: ${report.localDirty ? "yes" : "no"}`,
    `Broad sync allowed: ${report.broadSyncAllowed ? "yes" : "no"}`,
  ];
  if (report.blockers.length > 0) {
    lines.push("", "Blockers:");
    lines.push(...report.blockers.map((blocker) => `- ${blocker}`));
  }
  lines.push("", "Next actions:");
  lines.push(...report.nextActions.map((action) => `- ${action}`));
  return lines.join("\n");
}

export function formatUpstreamSyncCheckpoint(checkpoint: UpstreamSyncCheckpoint): string {
  return [
    `Chuck upstream sync checkpoint ${checkpoint.checkpointId}`,
    `Directory: ${checkpoint.checkpointDir}`,
    "",
    "Artifacts:",
    `- ${checkpoint.reportPath}`,
    `- ${checkpoint.remediationMarkdownPath}`,
    `- ${checkpoint.commandPlanPath}`,
    "",
    formatUpstreamSyncReport(checkpoint.report),
  ].join("\n");
}

function upstreamSyncBlockers({
  localDirty,
  repoHygiene,
  stableBehind,
  latestStableTag,
  currentBranch,
}: {
  localDirty: boolean;
  repoHygiene: AnyRepoHygieneReport;
  stableBehind: boolean;
  latestStableTag?: string;
  currentBranch: string;
}): string[] {
  const blockers: string[] = [];
  if (!currentBranch) {
    blockers.push("current branch is unknown; create or checkout a named sync lane first");
  }
  if (!latestStableTag) {
    blockers.push("no stable upstream release tag could be resolved");
  }
  if (localDirty) {
    const total = repoHygiene.available ? repoHygiene.total : "unknown";
    blockers.push(`${total} local dirty path(s) must be checkpointed, committed, or parked first`);
  }
  if (!stableBehind) {
    blockers.push("no stable-release sync needed right now");
  }
  return blockers;
}

function upstreamSyncNextActions({
  localDirty,
  stableBehind,
  latestStableTag,
}: {
  localDirty: boolean;
  stableBehind: boolean;
  latestStableTag?: string;
}): string[] {
  if (localDirty) {
    return [
      "finish repo lane cleanup or commit the current lane checkpoints",
      "create an upstream-sync checkpoint after the repo is clean",
      latestStableTag
        ? `sync on a named lane against ${latestStableTag}, then rerun focused Kernel/OpenClaw tests`
        : "fetch tags and resolve latest stable release before syncing",
    ];
  }
  if (stableBehind && latestStableTag) {
    return [
      `create a named sync lane from current HEAD toward ${latestStableTag}`,
      "merge or rebase in the sync lane, never directly over unreviewed work",
      "run targeted Kernel, extension, command-bridge, and dashboard smoke tests before promotion",
    ];
  }
  return ["no stable-release sync needed; keep watcher active"];
}

function upstreamSyncRemediationMarkdown({
  checkpointId,
  now,
  report,
}: {
  checkpointId: string;
  now: string;
  report: AnyUpstreamSyncReport;
}): string {
  const lines = [
    `# Upstream Sync Remediation: ${checkpointId}`,
    "",
    `Generated: ${now}`,
    "",
    "## Executive Rule",
    "",
    "Keep OpenClaw current, but never let upstream churn overwrite uncheckpointed Chuck Kernel, Fleet, surface, or doctrine work.",
    "",
    "## Current State",
    "",
  ];
  if (report.available) {
    lines.push(
      `- Current branch: ${report.currentBranch || "unknown"}`,
      `- Package version: ${report.packageVersion ?? "unknown"}`,
      `- HEAD: ${report.headSummary}`,
      `- Latest stable tag: ${report.latestStableTag ?? "unknown"}`,
      `- Local dirt: ${report.localDirty ? "yes" : "no"}`,
      `- Broad sync allowed: ${report.broadSyncAllowed ? "yes" : "no"}`,
      "",
      "## Blockers",
      "",
      ...(report.blockers.length > 0
        ? report.blockers.map((blocker) => `- ${blocker}`)
        : ["- none"]),
      "",
      "## Next Actions",
      "",
      ...report.nextActions.map((action) => `- ${action}`),
    );
  } else {
    lines.push(`- Upstream sync unavailable: ${report.reason}`);
  }
  lines.push(
    "",
    "## Durable Policy",
    "",
    "- Watch upstream releases continuously.",
    "- Prefer stable release tags over raw upstream main unless a bugfix demands main.",
    "- Sync only from a clean or explicitly checkpointed local state.",
    "- Do not delete local work to make upstream sync easier.",
    "- After sync, run the Chuck/OpenClaw bridge and Kernel test lanes before promotion.",
    "",
  );
  return lines.join("\n");
}

function upstreamSyncCommandPlan({ report }: { report: AnyUpstreamSyncReport }): string {
  const tag = report.available ? report.latestStableTag : undefined;
  const lines = [
    "#!/usr/bin/env bash",
    "# Review-only command plan generated by Chuck upstream sync.",
    "# Do not run wholesale. Sync mutates repo history/worktree state.",
    "set -euo pipefail",
    "",
    "# First: ensure repo hygiene is clean or intentionally checkpointed.",
    "# node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --repo-hygiene",
    "# node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --repo-hygiene-checkpoint",
    "",
    "# Then, in a named lane:",
  ];
  if (tag) {
    lines.push(
      `# git fetch origin --tags --prune`,
      `# git switch -c upstream-sync/${tag.replace(/^v/, "")}`,
      `# git merge ${tag}`,
      "# pnpm test extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts",
      "# pnpm tsgo:extensions",
      "# pnpm tsgo:core",
    );
  } else {
    lines.push("# git fetch origin --tags --prune");
  }
  return `${lines.join("\n")}\n`;
}

async function packageVersionText(repoRoot: string): Promise<string | undefined> {
  try {
    const text = await gitText(repoRoot, ["show", "HEAD:package.json"]);
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

type RemoteStableTag = {
  tag: string;
  sha: string;
  peeled: boolean;
};

async function remoteStableTags(repoRoot: string, remote: string): Promise<RemoteStableTag[]> {
  const text = await gitText(repoRoot, ["ls-remote", "--tags", remote, "refs/tags/v[0-9]*"]);
  const byTag = new Map<string, RemoteStableTag>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [sha = "", ref = ""] = trimmed.split(/\s+/);
    const peeled = ref.endsWith("^{}");
    const tag = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (!sha || !isStableReleaseTag(tag)) {
      continue;
    }
    const current = byTag.get(tag);
    if (!current || peeled || !current.peeled) {
      byTag.set(tag, { tag, sha, peeled });
    }
  }
  return [...byTag.values()].toSorted((left, right) =>
    compareStableReleaseTags(left.tag, right.tag),
  );
}

function isStableReleaseTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+(?:-\d+)?$/.test(tag);
}

function compareStableReleaseTags(left: string, right: string): number {
  const a = stableReleaseParts(left);
  const b = stableReleaseParts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return left.localeCompare(right);
}

function stableReleaseParts(tag: string): number[] {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/);
  if (!match) {
    return [];
  }
  return [match[1], match[2], match[3], match[4] ?? "0"].map((part) => Number(part));
}

async function gitText(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}
