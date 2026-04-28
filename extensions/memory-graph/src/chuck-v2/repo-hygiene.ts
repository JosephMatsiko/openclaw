import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CHUCK_V2_STATE_DIR } from "./config.js";

const execFileAsync = promisify(execFile);

export type RepoHygieneBucketName =
  | "chuck-v2-source"
  | "chuck-surface-drivers"
  | "chuck-v3-docs"
  | "apex-salvage"
  | "memory-graph-extension"
  | "phone-ui"
  | "openclaw-core"
  | "local-generated"
  | "other";

export type RepoHygieneEntry = {
  status: string;
  path: string;
  bucket: RepoHygieneBucketName;
  tracked: boolean;
  untracked: boolean;
};

export type RepoHygieneBucket = {
  bucket: RepoHygieneBucketName;
  total: number;
  tracked: number;
  untracked: number;
  examples: Array<{
    status: string;
    path: string;
  }>;
};

export type RepoHygieneReport = {
  available: true;
  clean: boolean;
  total: number;
  trackedModified: number;
  untracked: number;
  selfBuildSafe: boolean;
  entries: RepoHygieneEntry[];
  buckets: RepoHygieneBucket[];
  blockers: string[];
  nextActions: string[];
  policy: string[];
};

export type UnavailableRepoHygieneReport = {
  available: false;
  reason: string;
};

export type AnyRepoHygieneReport = RepoHygieneReport | UnavailableRepoHygieneReport;

export type RepoHygieneLaneStatus =
  | "safe-now"
  | "targeted-only"
  | "needs-checkpoint"
  | "needs-classification"
  | "blocked";

export type RepoHygieneLane = {
  id: string;
  title: string;
  status: RepoHygieneLaneStatus;
  rationale: string;
  pathCount: number;
  examplePaths: string[];
  nextAction: string;
};

export type RepoHygienePlan = {
  planId: string;
  createdAt: string;
  broadSelfBuildAllowed: boolean;
  targetedSelfBuildAllowed: boolean;
  checkpointRecommended: boolean;
  lanes: RepoHygieneLane[];
  immediateActions: string[];
  cleanupOrder: string[];
};

export type UntrackedManifestEntry = {
  path: string;
  sizeBytes?: number;
  sha256?: string;
  hashSkippedReason?: string;
};

export type RepoHygieneCheckpoint = {
  checkpointId: string;
  createdAt: string;
  checkpointDir: string;
  statusPath: string;
  trackedDiffPath: string;
  stagedDiffPath: string;
  untrackedManifestPath: string;
  laneManifestDir: string;
  remediationMarkdownPath: string;
  commandPlanPath: string;
  planPath: string;
  reportPath: string;
  report: AnyRepoHygieneReport;
  plan: RepoHygienePlan;
};

export type RepoHygieneLaneManifest = {
  laneId: string;
  title: string;
  disposition:
    | "commit"
    | "review-commit"
    | "promote-or-archive"
    | "archive-or-ignore"
    | "manual-review";
  risk: "low" | "medium" | "high";
  rationale: string;
  paths: string[];
  commandHints: string[];
};

export async function inspectRepoHygiene({
  repoRoot = process.cwd(),
}: {
  repoRoot?: string;
} = {}): Promise<AnyRepoHygieneReport> {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain=v1"], {
      cwd: repoRoot,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return analyzeRepoHygieneFromPorcelain(result.stdout);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function analyzeRepoHygieneFromPorcelain(statusText: string): RepoHygieneReport {
  const entries = statusText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(" -> ") ? (rawPath.split(" -> ").at(-1) ?? rawPath) : rawPath;
      const bucket = repoHygieneBucket(path);
      return {
        status,
        path,
        bucket,
        tracked: status !== "??",
        untracked: status === "??",
      };
    });
  const buckets = repoHygieneBuckets(entries);
  const blockers = repoHygieneBlockers(entries);
  return {
    available: true,
    clean: entries.length === 0,
    total: entries.length,
    trackedModified: entries.filter((entry) => entry.tracked).length,
    untracked: entries.filter((entry) => entry.untracked).length,
    selfBuildSafe: blockers.length === 0,
    entries,
    buckets,
    blockers,
    nextActions: repoHygieneNextActions(entries, blockers),
    policy: [
      "runtime state belongs under ~/.openclaw/workspace/state, not the repo",
      "self-build patches must run in shadow worktrees and refuse dirty target files",
      "old salvage should be archived or promoted intentionally, not left as ambiguous untracked work",
      "same-session work should land as small checkpoints once tests pass",
    ],
  };
}

export function planRepoHygiene(
  report: AnyRepoHygieneReport,
  {
    now = new Date().toISOString(),
  }: {
    now?: string;
  } = {},
): RepoHygienePlan {
  const planId = `repo-hygiene-${now.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`;
  if (!report.available) {
    return {
      planId,
      createdAt: now,
      broadSelfBuildAllowed: false,
      targetedSelfBuildAllowed: false,
      checkpointRecommended: false,
      lanes: [
        {
          id: "repo-unavailable",
          title: "Restore repo inspection",
          status: "blocked",
          rationale: report.reason,
          pathCount: 0,
          examplePaths: [],
          nextAction: "repair git status access before autonomous build",
        },
      ],
      immediateActions: ["repair repo inspection"],
      cleanupOrder: ["repo-unavailable"],
    };
  }
  const byBucket = new Map(report.buckets.map((bucket) => [bucket.bucket, bucket]));
  const trackedCoreCount = report.entries.filter(
    (entry) => entry.tracked && ["openclaw-core", "memory-graph-extension"].includes(entry.bucket),
  ).length;
  const untrackedSourceCount = report.entries.filter(
    (entry) =>
      entry.untracked &&
      !["local-generated", "chuck-v3-docs", "apex-salvage"].includes(entry.bucket),
  ).length;
  const apexSalvage = byBucket.get("apex-salvage");
  const lanes: RepoHygieneLane[] = [
    {
      id: "freeze-current-state",
      title: "Freeze current dirty state",
      status: report.clean ? "safe-now" : "needs-checkpoint",
      rationale:
        "A checkpoint preserves the diff and manifests before any cleanup or checkpoint commit.",
      pathCount: report.total,
      examplePaths: report.entries.slice(0, 8).map((entry) => entry.path),
      nextAction: report.clean ? "no checkpoint needed" : "run repo hygiene checkpoint",
    },
    {
      id: "targeted-self-build",
      title: "Allow targeted self-build only",
      status: "targeted-only",
      rationale:
        "Dirty target blocking is already enforced; clean target files may still be patched in shadow worktrees.",
      pathCount: report.total,
      examplePaths: [],
      nextAction: "continue only when proposed target files are clean",
    },
    {
      id: "checkpoint-tracked-core",
      title: "Checkpoint tracked core and extension edits",
      status: trackedCoreCount > 0 ? "needs-checkpoint" : "safe-now",
      rationale:
        "Tracked source changes are likely intentional work and should be committed, stashed, or explicitly parked before broad mutation.",
      pathCount: trackedCoreCount,
      examplePaths: report.entries
        .filter(
          (entry) =>
            entry.tracked && ["openclaw-core", "memory-graph-extension"].includes(entry.bucket),
        )
        .slice(0, 8)
        .map((entry) => entry.path),
      nextAction:
        trackedCoreCount > 0
          ? "review and checkpoint tracked core/extension edits as one or more named slices"
          : "no tracked core/extension checkpoint needed",
    },
    {
      id: "classify-source-like-untracked",
      title: "Classify untracked source-like files",
      status: untrackedSourceCount > 0 ? "needs-classification" : "safe-now",
      rationale:
        "Untracked source-like files are ambiguous: they may be real source, generated experiments, or salvage.",
      pathCount: untrackedSourceCount,
      examplePaths: report.entries
        .filter(
          (entry) =>
            entry.untracked &&
            !["local-generated", "chuck-v3-docs", "apex-salvage"].includes(entry.bucket),
        )
        .slice(0, 8)
        .map((entry) => entry.path),
      nextAction:
        untrackedSourceCount > 0
          ? "classify as source, salvage, generated, or discard candidate"
          : "no untracked source-like classification needed",
    },
    {
      id: "salvage-ledger",
      title: "Move Apex salvage through the salvage ledger",
      status: apexSalvage && apexSalvage.total > 0 ? "needs-classification" : "safe-now",
      rationale:
        "Old Apex tools should be promoted, archived, or excluded from active build scope instead of floating as repo noise.",
      pathCount: apexSalvage?.total ?? 0,
      examplePaths: apexSalvage?.examples.map((entry) => entry.path) ?? [],
      nextAction:
        apexSalvage && apexSalvage.total > 0
          ? "promote useful tools into Chuck modules; archive or exclude the rest"
          : "no Apex salvage cleanup needed",
    },
  ];
  return {
    planId,
    createdAt: now,
    broadSelfBuildAllowed: report.selfBuildSafe,
    targetedSelfBuildAllowed: true,
    checkpointRecommended: !report.clean,
    lanes,
    immediateActions: report.clean
      ? ["continue with shadow-worktree self-build"]
      : [
          "create repo hygiene checkpoint",
          "keep broad self-build blocked",
          "continue targeted builder work only when target files are clean",
          "checkpoint/promote/archive one lane at a time",
        ],
    cleanupOrder: [
      "freeze-current-state",
      "checkpoint-tracked-core",
      "classify-source-like-untracked",
      "salvage-ledger",
      "targeted-self-build",
    ],
  };
}

export async function createRepoHygieneCheckpoint({
  repoRoot = process.cwd(),
  stateDir = CHUCK_V2_STATE_DIR,
  now = new Date().toISOString(),
  maxHashBytes = 1024 * 1024,
}: {
  repoRoot?: string;
  stateDir?: string;
  now?: string;
  maxHashBytes?: number;
} = {}): Promise<RepoHygieneCheckpoint> {
  const checkpointId = `repo-hygiene-${now.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`;
  const checkpointDir = join(stateDir, "repo-hygiene", checkpointId);
  await mkdir(checkpointDir, { recursive: true });
  const [statusText, trackedDiff, stagedDiff, untrackedFiles, report] = await Promise.all([
    gitText(repoRoot, ["status", "--porcelain=v1"]),
    gitText(repoRoot, ["diff", "--binary"]),
    gitText(repoRoot, ["diff", "--cached", "--binary"]),
    gitText(repoRoot, ["ls-files", "--others", "--exclude-standard"]),
    inspectRepoHygiene({ repoRoot }),
  ]);
  const plan = planRepoHygiene(report, { now });
  const untrackedManifest = await untrackedManifestForFiles({
    repoRoot,
    files: untrackedFiles
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    maxHashBytes,
  });
  const laneManifests = repoHygieneLaneManifests({
    report,
    untrackedManifest,
  });
  const statusPath = join(checkpointDir, "status-porcelain.txt");
  const trackedDiffPath = join(checkpointDir, "tracked.diff");
  const stagedDiffPath = join(checkpointDir, "staged.diff");
  const untrackedManifestPath = join(checkpointDir, "untracked-manifest.json");
  const laneManifestDir = join(checkpointDir, "lanes");
  const remediationMarkdownPath = join(checkpointDir, "remediation.md");
  const commandPlanPath = join(checkpointDir, "commands.review-only.sh");
  const planPath = join(checkpointDir, "plan.json");
  const reportPath = join(checkpointDir, "report.json");
  await mkdir(laneManifestDir, { recursive: true });
  await Promise.all([
    writeFile(statusPath, statusText, "utf8"),
    writeFile(trackedDiffPath, trackedDiff, "utf8"),
    writeFile(stagedDiffPath, stagedDiff, "utf8"),
    writeFile(untrackedManifestPath, `${JSON.stringify(untrackedManifest, null, 2)}\n`, "utf8"),
    ...laneManifests.flatMap((manifest) => [
      writeFile(
        join(laneManifestDir, `${manifest.laneId}.paths`),
        `${manifest.paths.join("\n")}${manifest.paths.length > 0 ? "\n" : ""}`,
        "utf8",
      ),
      writeFile(
        join(laneManifestDir, `${manifest.laneId}.json`),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      ),
    ]),
    writeFile(
      remediationMarkdownPath,
      repoHygieneRemediationMarkdown({ checkpointId, now, report, plan, laneManifests }),
      "utf8",
    ),
    writeFile(commandPlanPath, repoHygieneCommandPlan({ laneManifests }), "utf8"),
    writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8"),
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  ]);
  return {
    checkpointId,
    createdAt: now,
    checkpointDir,
    statusPath,
    trackedDiffPath,
    stagedDiffPath,
    untrackedManifestPath,
    laneManifestDir,
    remediationMarkdownPath,
    commandPlanPath,
    planPath,
    reportPath,
    report,
    plan,
  };
}

export function repoHygieneLaneManifests({
  report,
  untrackedManifest = [],
}: {
  report: AnyRepoHygieneReport;
  untrackedManifest?: UntrackedManifestEntry[];
}): RepoHygieneLaneManifest[] {
  if (!report.available) {
    return [
      {
        laneId: "repo-unavailable",
        title: "Repo unavailable",
        disposition: "manual-review",
        risk: "high",
        rationale: report.reason,
        paths: [],
        commandHints: ["repair git status access"],
      },
    ];
  }
  const trackedOrDirectoryPaths = report.entries.map((entry) => entry.path);
  const allPaths = [
    ...new Set([...trackedOrDirectoryPaths, ...untrackedManifest.map((entry) => entry.path)]),
  ].toSorted();
  const pathsFor = (predicate: (path: string) => boolean) => allPaths.filter(predicate);
  const manifests: RepoHygieneLaneManifest[] = [
    {
      laneId: "chuck-kernel-current",
      title: "Chuck Kernel, dashboard, Fleet, and surface drivers",
      disposition: "review-commit",
      risk: "medium",
      rationale:
        "This is the live Chuck build lane. Commit in small verified slices after targeted tests pass.",
      paths: pathsFor(
        (path) =>
          path.startsWith("extensions/memory-graph/src/chuck-v2/") ||
          path === "extensions/memory-graph/scripts/chuck-v2-run.ts" ||
          path === "extensions/memory-graph/scripts/chuck-dashboard.mjs" ||
          path === "extensions/memory-graph/scripts/chuck-fleet.mjs" ||
          path === "extensions/memory-graph/scripts/chuck-surface-control.mjs" ||
          path === "extensions/memory-graph/scripts/chuck-surface-preflight.mjs" ||
          path.startsWith("extensions/memory-graph/scripts/research-"),
      ),
      commandHints: [
        "pnpm test extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts",
        "pnpm tsgo:extensions",
        "pnpm exec oxlint --pathspec-from-file=<lane>.paths is not supported; pass reviewed paths explicitly",
        'git add --pathspec-from-file=<lane>.paths && git commit -m "chuck: checkpoint governed fleet and hygiene kernel"',
      ],
    },
    {
      laneId: "chuck-docs-and-specs",
      title: "Chuck V3 docs, specs, dashboards, and app views",
      disposition: "review-commit",
      risk: "low",
      rationale:
        "Docs and app-view artifacts can be committed separately from runtime code to keep review small.",
      paths: pathsFor(
        (path) =>
          path.startsWith("extensions/memory-graph/data/chuck-v2-design/") ||
          path.startsWith("extensions/memory-graph/mcp-app-views/"),
      ),
      commandHints: [
        "review markdown/spec generated content",
        'git add --pathspec-from-file=<lane>.paths && git commit -m "docs: checkpoint chuck v3 canon and dashboard artifacts"',
      ],
    },
    {
      laneId: "openclaw-core-bridge",
      title: "OpenClaw core bridge changes",
      disposition: "review-commit",
      risk: "high",
      rationale:
        "Core OpenClaw files are high leverage and should be reviewed separately from Chuck extension work.",
      paths: pathsFor(
        (path) => path.startsWith("src/") || path.startsWith("test/") || path.startsWith("ui/"),
      ),
      commandHints: [
        "run targeted core tests for these files",
        'git add --pathspec-from-file=<lane>.paths && git commit -m "openclaw: checkpoint chuck command bridge"',
      ],
    },
    {
      laneId: "memory-graph-legacy-extension",
      title: "Memory graph legacy extension changes",
      disposition: "manual-review",
      risk: "medium",
      rationale:
        "These are pre-Chuck extension surfaces and utility scripts; separate active source from historical edits.",
      paths: pathsFor(
        (path) =>
          path.startsWith("extensions/memory-graph/") &&
          !path.startsWith("extensions/memory-graph/src/chuck-v2/") &&
          !path.startsWith("extensions/memory-graph/scripts/chuck-") &&
          !path.startsWith("extensions/memory-graph/scripts/research-") &&
          !path.startsWith("extensions/memory-graph/scripts/apex-") &&
          !path.startsWith("extensions/memory-graph/data/chuck-v2-design/") &&
          !path.startsWith("extensions/memory-graph/mcp-app-views/"),
      ),
      commandHints: [
        "split active extension changes from historical changes before commit",
        "do not broad-commit this lane until each file has an owner",
      ],
    },
    {
      laneId: "apex-salvage",
      title: "Apex salvage and old tools",
      disposition: "promote-or-archive",
      risk: "high",
      rationale:
        "Useful pieces should become Chuck modules; unsafe/outdated pieces should be archived or excluded from active build scope.",
      paths: pathsFor(
        (path) =>
          path.startsWith("extensions/memory-graph/scripts/apex-") ||
          path.startsWith("skills/apex-"),
      ),
      commandHints: [
        "promote only reviewed tools into Chuck modules",
        "archive or exclude the rest; do not add this lane wholesale to an active build commit",
      ],
    },
    {
      laneId: "phone-ui",
      title: "Phone and future interface work",
      disposition: "review-commit",
      risk: "medium",
      rationale:
        "Interface work is valuable but should not be mixed with Fleet/kernel correctness.",
      paths: pathsFor((path) => path.startsWith("ui-phone") || path.startsWith("ui-phone-v3")),
      commandHints: [
        "run phone UI checks before commit",
        'git add --pathspec-from-file=<lane>.paths && git commit -m "ui: checkpoint chuck command surface"',
      ],
    },
    {
      laneId: "lockfiles-and-other",
      title: "Lockfiles and uncategorized changes",
      disposition: "manual-review",
      risk: "medium",
      rationale:
        "Lockfiles and miscellaneous paths can hide dependency churn; review before committing.",
      paths: pathsFor(
        (path) =>
          path === "pnpm-lock.yaml" ||
          repoHygieneBucket(path) === "other" ||
          repoHygieneBucket(path) === "local-generated",
      ),
      commandHints: [
        "verify whether dependency changes are intentional",
        "commit lockfile changes only with the source change that required them",
      ],
    },
  ];
  return manifests
    .map((manifest) => {
      manifest.paths = [...new Set(manifest.paths)].toSorted();
      return manifest;
    })
    .filter((manifest) => manifest.paths.length > 0 || manifest.laneId === "repo-unavailable");
}

export function repoHygieneBucket(path: string): RepoHygieneBucketName {
  if (path.startsWith("extensions/memory-graph/src/chuck-v2/")) {
    return "chuck-v2-source";
  }
  if (
    path.startsWith("extensions/memory-graph/scripts/chuck-") ||
    path.startsWith("extensions/memory-graph/scripts/research-")
  ) {
    return "chuck-surface-drivers";
  }
  if (path.startsWith("extensions/memory-graph/data/chuck-v2-design/")) {
    return "chuck-v3-docs";
  }
  if (path.startsWith("extensions/memory-graph/scripts/apex-") || path.startsWith("skills/apex-")) {
    return "apex-salvage";
  }
  if (path.startsWith("extensions/memory-graph/")) {
    return "memory-graph-extension";
  }
  if (path.startsWith("ui-phone") || path.startsWith("ui-phone-v3")) {
    return "phone-ui";
  }
  if (path.startsWith("src/") || path.startsWith("test/") || path.startsWith("ui/")) {
    return "openclaw-core";
  }
  if (path.startsWith(".") || path.startsWith("tmp/") || path.startsWith("analysis/")) {
    return "local-generated";
  }
  return "other";
}

export function formatRepoHygieneReport(report: AnyRepoHygieneReport): string {
  if (!report.available) {
    return `Chuck repo hygiene unavailable: ${report.reason}`;
  }
  const lines = [
    "Chuck repo hygiene",
    `Status: ${report.clean ? "clean" : "dirty but classified"}`,
    `Changed paths: ${report.total} (${report.trackedModified} tracked, ${report.untracked} untracked)`,
    `Self-build safe: ${report.selfBuildSafe ? "yes" : "no"}`,
  ];
  if (report.blockers.length > 0) {
    lines.push("", "Blockers:");
    lines.push(...report.blockers.map((blocker) => `- ${blocker}`));
  }
  lines.push("", "Buckets:");
  lines.push(
    ...report.buckets.map(
      (bucket) =>
        `- ${bucket.bucket}: ${bucket.total} path(s), ${bucket.tracked} tracked, ${bucket.untracked} untracked`,
    ),
  );
  lines.push("", "Next actions:");
  lines.push(...report.nextActions.map((action) => `- ${action}`));
  return lines.join("\n");
}

export function formatRepoHygienePlan(plan: RepoHygienePlan): string {
  return [
    `Chuck repo hygiene plan ${plan.planId}`,
    `Broad self-build: ${plan.broadSelfBuildAllowed ? "allowed" : "blocked"}`,
    `Targeted self-build: ${plan.targetedSelfBuildAllowed ? "allowed with clean targets" : "blocked"}`,
    `Checkpoint recommended: ${plan.checkpointRecommended ? "yes" : "no"}`,
    "",
    "Immediate actions:",
    ...plan.immediateActions.map((action) => `- ${action}`),
    "",
    "Lanes:",
    ...plan.lanes.map(
      (lane) => `- ${lane.status}: ${lane.title} (${lane.pathCount} path(s)) — ${lane.nextAction}`,
    ),
  ].join("\n");
}

export function formatRepoHygieneCheckpoint(checkpoint: RepoHygieneCheckpoint): string {
  return [
    `Chuck repo hygiene checkpoint ${checkpoint.checkpointId}`,
    `Directory: ${checkpoint.checkpointDir}`,
    `Status: ${checkpoint.report.available && checkpoint.report.clean ? "clean" : "dirty frozen"}`,
    `Broad self-build: ${checkpoint.plan.broadSelfBuildAllowed ? "allowed" : "blocked"}`,
    `Targeted self-build: ${checkpoint.plan.targetedSelfBuildAllowed ? "allowed with clean targets" : "blocked"}`,
    "",
    "Artifacts:",
    `- ${checkpoint.statusPath}`,
    `- ${checkpoint.trackedDiffPath}`,
    `- ${checkpoint.stagedDiffPath}`,
    `- ${checkpoint.untrackedManifestPath}`,
    `- ${checkpoint.laneManifestDir}`,
    `- ${checkpoint.remediationMarkdownPath}`,
    `- ${checkpoint.commandPlanPath}`,
    `- ${checkpoint.planPath}`,
    `- ${checkpoint.reportPath}`,
    "",
    ...formatRepoHygienePlan(checkpoint.plan).split("\n").slice(1),
  ].join("\n");
}

function repoHygieneRemediationMarkdown({
  checkpointId,
  now,
  report,
  plan,
  laneManifests,
}: {
  checkpointId: string;
  now: string;
  report: AnyRepoHygieneReport;
  plan: RepoHygienePlan;
  laneManifests: RepoHygieneLaneManifest[];
}): string {
  const lines = [
    `# Repo Hygiene Remediation: ${checkpointId}`,
    "",
    `Generated: ${now}`,
    "",
    "## Executive Rule",
    "",
    "Broad autonomous self-build stays blocked until ambiguous tracked core changes, untracked source-like files, and Apex salvage are resolved. Targeted self-build remains allowed only when the proposed target files are clean and verification runs in a shadow worktree.",
    "",
    "## Current State",
    "",
  ];
  if (report.available) {
    lines.push(
      `- Changed paths: ${report.total}`,
      `- Tracked modified: ${report.trackedModified}`,
      `- Untracked: ${report.untracked}`,
      `- Self-build safe: ${report.selfBuildSafe ? "yes" : "no"}`,
    );
    if (report.blockers.length > 0) {
      lines.push("", "## Blockers", "", ...report.blockers.map((blocker) => `- ${blocker}`));
    }
  } else {
    lines.push(`- Repo unavailable: ${report.reason}`);
  }
  lines.push(
    "",
    "## Cleanup Order",
    "",
    ...plan.cleanupOrder.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Lanes",
    "",
  );
  for (const lane of laneManifests) {
    lines.push(
      `### ${lane.title}`,
      "",
      `- Lane ID: ${lane.laneId}`,
      `- Disposition: ${lane.disposition}`,
      `- Risk: ${lane.risk}`,
      `- Paths: ${lane.paths.length}`,
      `- Rationale: ${lane.rationale}`,
      "",
      "Command hints:",
      ...lane.commandHints.map((hint) => `- ${hint}`),
      "",
      "Example paths:",
      ...lane.paths.slice(0, 20).map((path) => `- ${path}`),
      "",
    );
  }
  lines.push(
    "## Durable Policy",
    "",
    "- Runtime state never enters the repo.",
    "- Shadow worktrees are mandatory for generated code patches.",
    "- Dirty target files block autonomous mutation.",
    "- Same-session work lands as small checkpoint commits after targeted tests.",
    "- Apex salvage is never bulk-promoted; each tool is promoted, archived, or excluded intentionally.",
    "",
  );
  return lines.join("\n");
}

function repoHygieneCommandPlan({
  laneManifests,
}: {
  laneManifests: RepoHygieneLaneManifest[];
}): string {
  const lines = [
    "#!/usr/bin/env bash",
    "# Review-only command plan generated by Chuck repo hygiene.",
    "# Do not run wholesale. Pick one lane, review its manifest, run checks, then commit/archive intentionally.",
    "set -euo pipefail",
    "",
  ];
  for (const lane of laneManifests) {
    const manifestPath = `lanes/${lane.laneId}.paths`;
    lines.push(
      `# Lane: ${lane.title}`,
      `# Risk: ${lane.risk}`,
      `# Disposition: ${lane.disposition}`,
      `# Path manifest: ${manifestPath}`,
      `# Review: sed -n '1,200p' "${manifestPath}"`,
    );
    for (const hint of lane.commandHints) {
      lines.push(`# ${hint.replace("<lane>.paths", manifestPath)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function repoHygieneBuckets(entries: RepoHygieneEntry[]): RepoHygieneBucket[] {
  const buckets = new Map<RepoHygieneBucketName, RepoHygieneBucket>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.bucket) ?? {
      bucket: entry.bucket,
      total: 0,
      tracked: 0,
      untracked: 0,
      examples: [],
    };
    bucket.total += 1;
    if (entry.tracked) {
      bucket.tracked += 1;
    }
    if (entry.untracked) {
      bucket.untracked += 1;
    }
    if (bucket.examples.length < 8) {
      bucket.examples.push({ status: entry.status, path: entry.path });
    }
    buckets.set(entry.bucket, bucket);
  }
  return [...buckets.values()].toSorted(
    (a, b) => b.total - a.total || a.bucket.localeCompare(b.bucket),
  );
}

function repoHygieneBlockers(entries: RepoHygieneEntry[]): string[] {
  const blockers: string[] = [];
  const trackedCore = entries.filter(
    (entry) => entry.tracked && ["openclaw-core", "memory-graph-extension"].includes(entry.bucket),
  );
  if (trackedCore.length > 0) {
    blockers.push(
      `${trackedCore.length} tracked core/extension file(s) need checkpoint, stash, or explicit ownership before broad self-build`,
    );
  }
  const apexSalvage = entries.filter((entry) => entry.bucket === "apex-salvage");
  if (apexSalvage.length > 20) {
    blockers.push(
      `${apexSalvage.length} Apex salvage file(s) should be archived, promoted, or excluded from active build scope`,
    );
  }
  const untrackedSource = entries.filter(
    (entry) =>
      entry.untracked &&
      !["local-generated", "chuck-v3-docs", "apex-salvage"].includes(entry.bucket),
  );
  if (untrackedSource.length > 0) {
    blockers.push(`${untrackedSource.length} untracked source-like file(s) need classification`);
  }
  return blockers;
}

function repoHygieneNextActions(entries: RepoHygieneEntry[], blockers: string[]): string[] {
  if (entries.length === 0) {
    return ["repo is clean; continue with shadow-worktree self-build"];
  }
  const actions: string[] = [];
  if (blockers.some((blocker) => blocker.includes("tracked core/extension"))) {
    actions.push(
      "checkpoint or explicitly park tracked core/extension changes before broad autonomous mutation",
    );
  }
  if (blockers.some((blocker) => blocker.includes("Apex salvage"))) {
    actions.push(
      "move Apex salvage through the salvage ledger: promote, archive, or exclude from active build scope",
    );
  }
  if (blockers.some((blocker) => blocker.includes("untracked source-like"))) {
    actions.push(
      "classify untracked source-like files as source, salvage, generated, or discard candidates",
    );
  }
  actions.push("keep targeted builder patches allowed only when their target files are clean");
  return [...new Set(actions)];
}

async function gitText(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

async function untrackedManifestForFiles({
  repoRoot,
  files,
  maxHashBytes,
}: {
  repoRoot: string;
  files: string[];
  maxHashBytes: number;
}): Promise<UntrackedManifestEntry[]> {
  const manifest: UntrackedManifestEntry[] = [];
  for (const path of files.toSorted()) {
    const fullPath = join(repoRoot, path);
    try {
      const stats = await stat(fullPath);
      if (!stats.isFile()) {
        manifest.push({ path, sizeBytes: stats.size, hashSkippedReason: "not a regular file" });
        continue;
      }
      if (stats.size > maxHashBytes) {
        manifest.push({
          path,
          sizeBytes: stats.size,
          hashSkippedReason: `larger than ${maxHashBytes} bytes`,
        });
        continue;
      }
      const bytes = await readFile(fullPath);
      manifest.push({
        path,
        sizeBytes: stats.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      manifest.push({
        path,
        hashSkippedReason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return manifest;
}
