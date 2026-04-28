import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { assessAuthorityDiff } from "./authority-diff.js";
import { CHUCK_V2_STATE_DIR } from "./config.js";
import { intentAnchorForBuilderRun, type IntentAnchor } from "./intent-anchor.js";
import { decisionRecordFromParts, createTaskCapsule } from "./records.js";
import type { AuthorityDiff, DocketItem, FinalAction, RunnerReceipt } from "./types.js";

const execFileAsync = promisify(execFile);

export type BuilderAutonomyEnvelope = "aggressive" | "supervised" | "shadow-only";

export type BuilderStage =
  | "admitted"
  | "authority-checked"
  | "shadow-worktree-created"
  | "patched-shadow"
  | "verified"
  | "applied-main"
  | "docketed"
  | "blocked"
  | "failed";

export type BuilderDisposition =
  | "applied"
  | "docketed-for-approval"
  | "failed-verification"
  | "blocked-by-authority"
  | "needs-human";

export type BuilderVerificationCommand = {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
};

export type BuilderVerification = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  passed: boolean;
};

export type BuilderImplementationPlan = {
  summary: string;
  proposedFiles: string[];
  verifierCommands: BuilderVerificationCommand[];
  blockers: string[];
  sourceRunId?: string;
  sourceReceipts: string[];
};

export type BuilderPatch = {
  patchId: string;
  changedFiles: string[];
  diffSha256: string;
  generatedBy: string[];
  authorityVerdict: AuthorityDiff;
  rollbackPlan: string[];
  patchPath?: string;
};

export type BuilderRun = {
  runId: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  stage: BuilderStage;
  autonomyEnvelope: BuilderAutonomyEnvelope;
  targetFiles: string[];
  authorityDiffId?: string;
  worktreePath?: string;
  patchPath?: string;
  tests: BuilderVerification[];
  disposition: BuilderDisposition;
  operatorActionRequired: boolean;
  reasons: string[];
  implementationPlan?: BuilderImplementationPlan;
  planPath?: string;
  patch?: BuilderPatch;
  decisionRecordId?: string;
  taskCapsuleId?: string;
  intentAnchorId?: string;
  intentAnchorPath?: string;
  approvedAt?: string;
};

export type BuilderCommandRun = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
};

export type BuilderCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BuilderRunCommand = (run: BuilderCommandRun) => Promise<BuilderCommandResult>;

export type RunSelfBuildInput = {
  objective: string;
  stateDir?: string;
  repoRoot?: string;
  autonomyEnvelope?: BuilderAutonomyEnvelope;
  patchText?: string;
  patchFile?: string;
  targetFiles?: string[];
  implementationPlan?: BuilderImplementationPlan;
  generatedBy?: string[];
  receipts?: RunnerReceipt[];
  operatorApproved?: boolean;
  now?: string;
  runId?: string;
  verificationCommands?: BuilderVerificationCommand[];
  signingSecret?: string;
  runCommand?: BuilderRunCommand;
};

export type BuilderStatusInput = {
  stateDir?: string;
  runId?: string;
};

export async function runSelfBuild({
  objective,
  stateDir = CHUCK_V2_STATE_DIR,
  repoRoot = process.cwd(),
  autonomyEnvelope = "aggressive",
  patchText,
  patchFile,
  targetFiles = [],
  implementationPlan,
  generatedBy = ["operator-or-fleet"],
  receipts = [],
  operatorApproved = false,
  now = new Date().toISOString(),
  runId = createBuilderRunId(),
  verificationCommands,
  signingSecret = "chuck-v2-builder-local-secret",
  runCommand = defaultRunCommand,
}: RunSelfBuildInput): Promise<BuilderRun> {
  const loadedPatchText = patchText ?? (patchFile ? await readFile(patchFile, "utf8") : undefined);
  const patchTargets = loadedPatchText ? changedFilesFromPatch(loadedPatchText) : [];
  const targetPaths = [
    ...new Set([...targetFiles, ...patchTargets].map(normalizeRepoPath)),
  ].toSorted();
  const addedImports = loadedPatchText ? addedImportsFromPatch(loadedPatchText) : [];
  const authorityVerdict = assessAuthorityDiff({
    targetPaths,
    addedImports,
    addedCapabilities: loadedPatchText ? ["filesystem.write"] : [],
  });
  const builderDir = builderRunDir(stateDir, runId);
  const persistedPatchPath = loadedPatchText
    ? (patchFile ?? join(builderDir, "candidate.patch"))
    : undefined;
  const persistedPlanPath = implementationPlan
    ? join(builderDir, "implementation-plan.md")
    : undefined;
  const candidatePatch: BuilderPatch | undefined = loadedPatchText
    ? {
        patchId: `patch-${createHash("sha256").update(loadedPatchText).digest("hex").slice(0, 16)}`,
        changedFiles: targetPaths,
        diffSha256: sha256Text(loadedPatchText),
        generatedBy,
        authorityVerdict,
        rollbackPlan: persistedPatchPath ? [`git apply -R ${persistedPatchPath}`] : [],
        patchPath: persistedPatchPath,
      }
    : undefined;
  const intentAnchor = intentAnchorForBuilderRun({
    objective,
    targetFiles: targetPaths,
    receipts,
    authorityDiff: authorityVerdict,
    patchPresent: Boolean(loadedPatchText),
    createdAt: now,
    signingSecret,
  });
  const capsule = createTaskCapsule({
    decisionRecordId: runId,
    actionPlan: [objective],
    allowedTools: ["git", "pnpm"],
    filesystemScope: loadedPatchText ? "ephemeral-worktree" : "none",
    networkScope: "deny",
    leashId: intentAnchor.anchorId,
    protectedPathVerdict: authorityVerdict.protectedPathVerdict,
    verifier: "builder-verification",
    rollbackPlan: candidatePatch?.rollbackPlan ?? [],
    expiresAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
    signingSecret,
  });
  const decisionRecord = decisionRecordFromParts({
    runId,
    stakeClass: loadedPatchText ? "high-mutating" : "medium",
    taskClass: "code-mutation",
    configuredFleetSize: Math.max(
      3,
      new Set(receipts.map((receipt) => receipt.requestedFamily)).size,
    ),
    adjudicatorFamily: "unknown",
    receipts,
    claims: [
      {
        id: `${runId}:objective`,
        text: objective,
        category: "technical",
        evidenceClass: "model-reasoning",
        sourceSpans: [],
        vaultNodes: [],
        confidence: 0.5,
        producedBy: generatedBy,
      },
    ],
    alignmentMatrix: {
      clusters: [
        {
          id: `${runId}:builder`,
          familyVotes: [],
          claimIds: [`${runId}:objective`],
          summary: objective,
        },
      ],
      contradictions: [],
    },
    protocol: receipts.length > 0 ? "INCOMPLETE" : "INCOMPLETE",
    finalAction: finalActionForAuthority(authorityVerdict, operatorApproved),
    operatorActionRequired: authorityVerdict.operatorApprovalRequired && !operatorApproved,
    confidenceLabel: "degraded",
    authorityDiffId: authorityVerdict.diffId,
  });
  let run: BuilderRun = {
    runId,
    objective,
    createdAt: now,
    updatedAt: now,
    stage: "authority-checked",
    autonomyEnvelope,
    targetFiles: targetPaths,
    authorityDiffId: authorityVerdict.diffId,
    tests: [],
    disposition: "needs-human",
    operatorActionRequired: false,
    reasons: [],
    decisionRecordId: decisionRecord.runId,
    taskCapsuleId: capsule.capsuleId,
    intentAnchorId: intentAnchor.anchorId,
    intentAnchorPath: join(builderDir, "intent-anchor.json"),
    ...(candidatePatch ? { patch: candidatePatch } : {}),
    ...(implementationPlan ? { implementationPlan } : {}),
    ...(persistedPlanPath ? { planPath: persistedPlanPath } : {}),
    ...(persistedPatchPath ? { patchPath: persistedPatchPath } : {}),
  };

  if (isBlockedAuthority(authorityVerdict)) {
    run = finishRun(run, "blocked", "blocked-by-authority", true, authorityVerdict.reasons, now);
    await persistBuilderRun({
      stateDir,
      run,
      authorityVerdict,
      decisionRecord,
      taskCapsule: capsule,
      intentAnchor,
    });
    return run;
  }

  if (authorityVerdict.operatorApprovalRequired && !operatorApproved) {
    run = finishRun(run, "docketed", "docketed-for-approval", true, authorityVerdict.reasons, now);
    await persistBuilderRun({
      stateDir,
      run,
      authorityVerdict,
      decisionRecord,
      taskCapsule: capsule,
      intentAnchor,
    });
    return run;
  }

  if (!loadedPatchText) {
    run = finishRun(
      run,
      "docketed",
      "needs-human",
      false,
      ["builder has no patch text yet; Fleet/objective recorded for patch generation"],
      now,
    );
    await persistBuilderRun({
      stateDir,
      run,
      authorityVerdict,
      decisionRecord,
      taskCapsule: capsule,
      intentAnchor,
    });
    return run;
  }

  if (autonomyEnvelope === "shadow-only") {
    run = finishRun(
      run,
      "docketed",
      "needs-human",
      false,
      ["shadow-only autonomy blocks main-worktree apply"],
      now,
    );
    await persistBuilderRun({
      stateDir,
      run,
      authorityVerdict,
      decisionRecord,
      taskCapsule: capsule,
      intentAnchor,
    });
    return run;
  }

  if (!candidatePatch || !persistedPatchPath) {
    run = finishRun(
      run,
      "failed",
      "failed-verification",
      false,
      ["builder patch metadata missing"],
      now,
    );
    await persistBuilderRun({
      stateDir,
      run,
      authorityVerdict,
      decisionRecord,
      taskCapsule: capsule,
      intentAnchor,
    });
    return run;
  }

  const dirtyTargets =
    targetPaths.length > 0
      ? await detectDirtyTargetPaths({ repoRoot, targetFiles: targetPaths, runCommand })
      : [];
  if (dirtyTargets.length > 0) {
    run = finishRun(
      run,
      "docketed",
      "needs-human",
      true,
      [`dirty target files require operator merge: ${dirtyTargets.join(", ")}`],
      now,
    );
    await persistBuilderRun({
      stateDir,
      run,
      authorityVerdict,
      decisionRecord,
      taskCapsule: capsule,
      intentAnchor,
    });
    return run;
  }

  await mkdir(builderDir, { recursive: true });
  if (!patchFile) {
    await writeFile(persistedPatchPath, loadedPatchText, "utf8");
  }
  const worktreePath = join(stateDir, "builder-worktrees", runId);
  await mkdir(join(stateDir, "builder-worktrees"), { recursive: true });
  const commands = verificationCommands ?? defaultBuilderVerificationCommands(targetPaths);
  await runCommandChecked(runCommand, {
    command: "git",
    args: ["worktree", "add", "--detach", worktreePath, "HEAD"],
    cwd: repoRoot,
    timeoutMs: 60_000,
  });
  await seedShadowWorktreeWorkingContext({
    repoRoot,
    worktreePath,
    targetPaths,
    verificationCommands: commands,
  });
  await prepareShadowWorktreeDependencies({ repoRoot, worktreePath });
  run = {
    ...run,
    stage: "shadow-worktree-created",
    worktreePath,
    patchPath: persistedPatchPath,
    updatedAt: now,
  };
  await runCommandChecked(runCommand, {
    command: "git",
    args: ["apply", persistedPatchPath],
    cwd: worktreePath,
    timeoutMs: 60_000,
  });
  run = { ...run, stage: "patched-shadow", updatedAt: now };
  const tests = await runVerificationCommands({
    commands,
    repoRoot,
    worktreePath,
    runCommand,
  });
  run = { ...run, stage: "verified", tests, updatedAt: now };
  if (tests.length === 0 || tests.some((test) => !test.passed)) {
    run = finishRun(
      run,
      "failed",
      "failed-verification",
      false,
      ["verification failed or no verifier ran"],
      now,
    );
    await persistBuilderRun({
      stateDir,
      run,
      authorityVerdict,
      decisionRecord,
      taskCapsule: capsule,
      intentAnchor,
    });
    return run;
  }
  await runCommandChecked(runCommand, {
    command: "git",
    args: ["apply", persistedPatchPath],
    cwd: repoRoot,
    timeoutMs: 60_000,
  });
  run = {
    ...finishRun(
      run,
      "applied-main",
      "applied",
      false,
      ["verified patch applied to main worktree"],
      now,
    ),
    patch: candidatePatch,
    patchPath: persistedPatchPath,
  };
  await persistBuilderRun({
    stateDir,
    run,
    authorityVerdict,
    decisionRecord,
    taskCapsule: capsule,
    intentAnchor,
  });
  return run;
}

export async function readBuilderStatus({
  stateDir = CHUCK_V2_STATE_DIR,
  runId,
}: BuilderStatusInput = {}): Promise<BuilderRun | null> {
  const selectedRunId = runId ?? (await latestBuilderRunId(stateDir));
  if (!selectedRunId) {
    return null;
  }
  try {
    return JSON.parse(
      await readFile(builderRunPath(stateDir, selectedRunId), "utf8"),
    ) as BuilderRun;
  } catch {
    return null;
  }
}

export async function readBuilderDocket({
  stateDir = CHUCK_V2_STATE_DIR,
  limit = 10,
}: {
  stateDir?: string;
  limit?: number;
} = {}): Promise<BuilderRun[]> {
  let names: string[] = [];
  try {
    names = await readdir(join(stateDir, "builder-runs"));
  } catch {
    return [];
  }
  const runs = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .slice(-limit)
      .map(async (name) => {
        try {
          return JSON.parse(
            await readFile(join(stateDir, "builder-runs", name), "utf8"),
          ) as BuilderRun;
        } catch {
          return null;
        }
      }),
  );
  return runs.filter((run): run is BuilderRun => Boolean(run)).toReversed();
}

export async function approveBuilderRun({
  stateDir = CHUCK_V2_STATE_DIR,
  runId,
  approvedAt = new Date().toISOString(),
}: {
  stateDir?: string;
  runId: string;
  approvedAt?: string;
}): Promise<BuilderRun> {
  const run = await readBuilderStatus({ stateDir, runId });
  if (!run) {
    throw new Error(`builder run not found: ${runId}`);
  }
  if (run.disposition !== "docketed-for-approval") {
    throw new Error(`builder run ${runId} is not waiting for approval`);
  }
  const approved: BuilderRun = {
    ...run,
    approvedAt,
    updatedAt: approvedAt,
    disposition: "needs-human",
    operatorActionRequired: false,
    reasons: [
      ...run.reasons,
      "operator approved authority gate; rerun build with approval to execute",
    ],
  };
  await writeFile(
    builderRunPath(stateDir, runId),
    `${JSON.stringify(approved, null, 2)}\n`,
    "utf8",
  );
  await appendFile(
    join(stateDir, "docket.jsonl"),
    `${JSON.stringify(builderDocketItemForRun(approved))}\n`,
    "utf8",
  );
  return approved;
}

export function changedFilesFromPatch(patchText: string): string[] {
  const files = new Set<string>();
  for (const line of patchText.split("\n")) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      files.add(normalizeRepoPath(diffMatch[2] ?? diffMatch[1] ?? ""));
      continue;
    }
    const targetMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (targetMatch) {
      files.add(normalizeRepoPath(targetMatch[1] ?? ""));
      continue;
    }
    const patchToolMatch = line.match(/^\*\*\* (?:Update|Add) File: (.+)$/);
    if (patchToolMatch) {
      files.add(normalizeRepoPath(patchToolMatch[1] ?? ""));
    }
  }
  files.delete("");
  files.delete("/dev/null");
  return [...files].toSorted();
}

export function addedImportsFromPatch(patchText: string): string[] {
  const imports = new Set<string>();
  for (const line of patchText.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }
    const importMatch =
      line.match(/\bfrom\s+["']([^"']+)["']/) ?? line.match(/\brequire\(["']([^"']+)["']\)/);
    if (importMatch?.[1]) {
      imports.add(importMatch[1]);
    }
  }
  return [...imports].toSorted();
}

export function builderDocketItemForRun(run: BuilderRun): DocketItem {
  return {
    docketId: `builder-${run.runId}`,
    runId: run.runId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status:
      run.disposition === "docketed-for-approval"
        ? "needs-approval"
        : run.disposition === "applied"
          ? "ready"
          : run.disposition === "blocked-by-authority" || run.disposition === "failed-verification"
            ? "halted"
            : "waiting-resolution",
    title: `Chuck build: ${run.objective.slice(0, 120)}`,
    stakeClass: "high-mutating",
    taskClass: "code-mutation",
    finalAction: run.disposition,
    operatorActionRequired: run.operatorActionRequired,
    decisionRecordId: run.decisionRecordId,
    reasons: run.reasons,
  };
}

export async function cleanupBuilderWorktree({
  repoRoot = process.cwd(),
  worktreePath,
  runCommand = defaultRunCommand,
}: {
  repoRoot?: string;
  worktreePath?: string;
  runCommand?: BuilderRunCommand;
}): Promise<void> {
  if (!worktreePath) {
    return;
  }
  await runCommand({
    command: "git",
    args: ["worktree", "remove", "--force", worktreePath],
    cwd: repoRoot,
    timeoutMs: 60_000,
  }).catch(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });
}

function finalActionForAuthority(diff: AuthorityDiff, operatorApproved: boolean): FinalAction {
  if (isBlockedAuthority(diff)) {
    return "refuse";
  }
  if (diff.operatorApprovalRequired && !operatorApproved) {
    return "operator-approval-required";
  }
  return "emit-task-capsule";
}

function isBlockedAuthority(diff: AuthorityDiff): boolean {
  return diff.riskClass === "destructive";
}

function finishRun(
  run: BuilderRun,
  stage: BuilderStage,
  disposition: BuilderDisposition,
  operatorActionRequired: boolean,
  reasons: string[],
  updatedAt: string,
): BuilderRun {
  return {
    ...run,
    stage,
    disposition,
    operatorActionRequired,
    reasons: [...run.reasons, ...reasons],
    updatedAt,
  };
}

async function persistBuilderRun({
  stateDir,
  run,
  authorityVerdict,
  decisionRecord,
  taskCapsule,
  intentAnchor,
}: {
  stateDir: string;
  run: BuilderRun;
  authorityVerdict: AuthorityDiff;
  decisionRecord: unknown;
  taskCapsule: unknown;
  intentAnchor: IntentAnchor;
}): Promise<void> {
  const runDir = builderRunDir(stateDir, run.runId);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(stateDir, "builder-runs"), { recursive: true });
  await writeFile(builderRunPath(stateDir, run.runId), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await writeFile(
    join(runDir, "authority-diff.json"),
    `${JSON.stringify(authorityVerdict, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "decision-record.json"),
    `${JSON.stringify(decisionRecord, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "task-capsule.json"),
    `${JSON.stringify(taskCapsule, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "intent-anchor.json"),
    `${JSON.stringify(intentAnchor, null, 2)}\n`,
    "utf8",
  );
  if (run.implementationPlan) {
    await writeFile(
      join(runDir, "implementation-plan.md"),
      implementationPlanMarkdown(run),
      "utf8",
    );
  }
  const docketItem = builderDocketItemForRun(run);
  await writeFile(
    join(runDir, "docket-item.json"),
    `${JSON.stringify(docketItem, null, 2)}\n`,
    "utf8",
  );
  await appendFile(join(stateDir, "docket.jsonl"), `${JSON.stringify(docketItem)}\n`, "utf8");
}

async function latestBuilderRunId(stateDir: string): Promise<string | undefined> {
  let names: string[] = [];
  try {
    names = await readdir(join(stateDir, "builder-runs"));
  } catch {
    return undefined;
  }
  const latest = names
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .at(-1);
  return latest ? basename(latest, ".json") : undefined;
}

async function detectDirtyTargetPaths({
  repoRoot,
  targetFiles,
  runCommand,
}: {
  repoRoot: string;
  targetFiles: string[];
  runCommand: BuilderRunCommand;
}): Promise<string[]> {
  const result = await runCommand({
    command: "git",
    args: ["status", "--porcelain", "--", ...targetFiles],
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    return targetFiles;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeRepoPath(line.slice(3).trim()))
    .filter(Boolean);
}

async function runVerificationCommands({
  commands,
  repoRoot,
  worktreePath,
  runCommand,
}: {
  commands: BuilderVerificationCommand[];
  repoRoot: string;
  worktreePath: string;
  runCommand: BuilderRunCommand;
}): Promise<BuilderVerification[]> {
  const results: BuilderVerification[] = [];
  for (const command of commands) {
    const cwd = command.cwd ?? worktreePath;
    const startedAt = Date.now();
    const result = await runCommand({
      command: command.command,
      args: command.args,
      cwd: cwd === "<repo>" ? repoRoot : cwd,
      timeoutMs: command.timeoutMs ?? 120_000,
    });
    results.push({
      command: command.command,
      args: command.args,
      cwd,
      exitCode: result.exitCode,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
      durationMs: Date.now() - startedAt,
      passed: result.exitCode === 0,
    });
  }
  return results;
}

async function prepareShadowWorktreeDependencies({
  repoRoot,
  worktreePath,
}: {
  repoRoot: string;
  worktreePath: string;
}): Promise<void> {
  const source = join(repoRoot, "node_modules");
  const target = join(worktreePath, "node_modules");
  const [sourceExists, targetExists, worktreeExists] = await Promise.all([
    pathExists(source),
    pathExists(target),
    pathExists(worktreePath),
  ]);
  if (!sourceExists || targetExists || !worktreeExists) {
    return;
  }
  await symlink(source, target, "dir").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
  });
}

async function seedShadowWorktreeWorkingContext({
  repoRoot,
  worktreePath,
  targetPaths,
  verificationCommands,
}: {
  repoRoot: string;
  worktreePath: string;
  targetPaths: string[];
  verificationCommands: BuilderVerificationCommand[];
}): Promise<void> {
  const explicitPaths = new Set<string>();
  const scopeDirs = new Set<string>();
  for (const target of targetPaths) {
    const normalized = safeRepoRelativePath(target);
    if (!normalized) {
      continue;
    }
    explicitPaths.add(normalized);
    const dir = dirname(normalized);
    if (dir && dir !== ".") {
      scopeDirs.add(dir);
    }
  }
  for (const command of verificationCommands) {
    for (const arg of command.args) {
      const normalized = safeRepoRelativePath(arg);
      if (normalized) {
        explicitPaths.add(normalized);
      }
    }
  }
  for (const untracked of await untrackedFilesUnderScopes(repoRoot, [...scopeDirs])) {
    explicitPaths.add(untracked);
  }
  for (const path of explicitPaths) {
    await copyPathIfPresentAndMissing({ sourceRoot: repoRoot, targetRoot: worktreePath, path });
  }
}

async function untrackedFilesUnderScopes(repoRoot: string, scopeDirs: string[]): Promise<string[]> {
  if (scopeDirs.length === 0) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", ...scopeDirs],
      {
        cwd: repoRoot,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return stdout
      .split("\n")
      .map((line) => safeRepoRelativePath(line))
      .filter((line): line is string => Boolean(line));
  } catch {
    return [];
  }
}

function safeRepoRelativePath(value: string): string | undefined {
  const normalized = normalizeRepoPath(value);
  if (
    !normalized ||
    normalized.startsWith("-") ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return undefined;
  }
  if (!normalized.includes("/")) {
    return undefined;
  }
  return normalized;
}

async function copyPathIfPresentAndMissing({
  sourceRoot,
  targetRoot,
  path,
}: {
  sourceRoot: string;
  targetRoot: string;
  path: string;
}): Promise<void> {
  const source = join(sourceRoot, path);
  const target = join(targetRoot, path);
  if (!(await pathExists(source)) || (await pathExists(target))) {
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: false, errorOnExist: false });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function defaultBuilderVerificationCommands(targetFiles: string[]): BuilderVerificationCommand[] {
  const commands: BuilderVerificationCommand[] = [];
  if (targetFiles.length > 0) {
    commands.push({
      command: "pnpm",
      args: ["exec", "oxlint", ...targetFiles],
      timeoutMs: 120_000,
    });
  }
  if (targetFiles.some((file) => file.startsWith("extensions/memory-graph/src/chuck-v2/"))) {
    commands.push({
      command: "pnpm",
      args: ["test", "extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts"],
      timeoutMs: 180_000,
    });
    commands.push({ command: "pnpm", args: ["tsgo:extensions"], timeoutMs: 180_000 });
  }
  if (targetFiles.some((file) => file.startsWith("src/plugins/"))) {
    commands.push({ command: "pnpm", args: ["tsgo:core"], timeoutMs: 180_000 });
  }
  return commands;
}

async function runCommandChecked(
  runCommand: BuilderRunCommand,
  command: BuilderCommandRun,
): Promise<void> {
  const result = await runCommand(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.command} ${command.args.join(" ")} failed: ${tail(result.stderr || result.stdout)}`,
    );
  }
}

async function defaultRunCommand({
  command,
  args,
  cwd,
  timeoutMs,
}: BuilderCommandRun): Promise<BuilderCommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    const error = err as Error & { code?: number | string; stdout?: string; stderr?: string };
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
}

function builderRunDir(stateDir: string, runId: string): string {
  return join(stateDir, "builder-artifacts", runId);
}

function builderRunPath(stateDir: string, runId: string): string {
  return join(stateDir, "builder-runs", `${runId}.json`);
}

function createBuilderRunId(): string {
  return `build-${new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function normalizeRepoPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^a\//, "")
    .replace(/^b\//, "")
    .replace(/^\.\//, "")
    .trim();
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function implementationPlanMarkdown(run: BuilderRun): string {
  const plan = run.implementationPlan;
  if (!plan) {
    return "";
  }
  return [
    `# Chuck Builder Plan: ${run.runId}`,
    "",
    `Objective: ${run.objective}`,
    "",
    "## Summary",
    "",
    plan.summary,
    "",
    "## Proposed Files",
    "",
    ...(plan.proposedFiles.length > 0
      ? plan.proposedFiles.map((file) => `- ${file}`)
      : ["- none identified"]),
    "",
    "## Verifier Commands",
    "",
    ...(plan.verifierCommands.length > 0
      ? plan.verifierCommands.map(
          (command) => `- \`${[command.command, ...command.args].join(" ")}\``,
        )
      : ["- none identified"]),
    "",
    "## Blockers",
    "",
    ...(plan.blockers.length > 0
      ? plan.blockers.map((blocker) => `- ${blocker}`)
      : ["- none identified"]),
    "",
    "## Source Receipts",
    "",
    ...(plan.sourceReceipts.length > 0
      ? plan.sourceReceipts.map((receipt) => `- ${receipt}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function tail(text: string, max = 4_000): string {
  return text.length > max ? text.slice(-max) : text;
}
