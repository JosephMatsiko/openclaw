import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  BuilderImplementationPlan,
  BuilderRun,
  BuilderVerificationCommand,
} from "./builder.js";
import type { ChuckLoopResult, PersistedChuckLoop } from "./loop.js";
import type { RunnerSurfaceProof } from "./model-doctor.js";
import type { FleetDispatchPlan } from "./runner-dispatch.js";
import type { FleetDispatchExecutionResult, RunnerAdapter } from "./runner-executor.js";
import type { FleetScoutResolve } from "./scout-resolve.js";
import type { ChuckConfig, DocketItem } from "./types.js";

export type ChuckCommandKind =
  | "help"
  | "doctor"
  | "docket"
  | "hygiene"
  | "github-hygiene"
  | "surface-atlas"
  | "scout"
  | "onboard"
  | "build"
  | "build-status"
  | "build-docket"
  | "build-approve";

export type ParsedChuckCommand = {
  kind: ChuckCommandKind;
  prompt?: string;
  surfaceAtlasSurface?: string;
  runId?: string;
  patchFile?: string;
  onboardRepair: boolean;
  onboardCandidateFamily?: string;
  onboardCandidateSurface?: string;
  onboardMemberFamily?: string;
  onboardMemberSurface?: string;
  onboardProveSurface?: string;
  hygieneCheckpoint: boolean;
  githubHygieneCheckpoint: boolean;
  generatePatch: boolean;
  targetFiles: string[];
  autoDeepen: boolean;
  includeProvisional: boolean;
};

export type ChuckOpenClawCommandOptions = {
  stateDir?: string;
  signingSecret?: string;
  deps?: Partial<ChuckCommandDeps>;
};

export type ChuckCommandDeps = {
  runLiveScout: typeof runLiveScoutFromOpenClawCommand;
  runDoctor: typeof runDoctorFromOpenClawCommand;
  readRepoHygiene: typeof readRepoHygieneFromOpenClawCommand;
  readGitHubHygiene: typeof readGitHubHygieneFromOpenClawCommand;
  readDocket: typeof readDocketFromOpenClawCommand;
  runOnboard: typeof runOnboardFromOpenClawCommand;
  runBuild: typeof runBuildFromOpenClawCommand;
  readBuildStatus: typeof readBuildStatusFromOpenClawCommand;
  readBuildDocket: typeof readBuildDocketFromOpenClawCommand;
  approveBuild: typeof approveBuildFromOpenClawCommand;
};

export type ChuckLiveScoutCommandResult = {
  summary: Record<string, unknown>;
  result: ChuckLoopResult;
  runnerExecution?: FleetDispatchExecutionResult;
  scoutResolve?: FleetScoutResolve;
  deepenPlan?: FleetDispatchPlan;
  deepenExecution?: FleetDispatchExecutionResult;
  deepenResolve?: FleetScoutResolve;
  cooldownSurfaces: string[];
  persisted?: PersistedChuckLoop;
  persistedRunnerExecution?: { executionPath: string };
  persistedDeepenExecution?: { executionPath: string };
};

const DEFAULT_COMMAND_SIGNING_SECRET = "chuck-v2-openclaw-command-local-runner-secret";
const CHUCK_COMMAND_STATE_DIR = join(homedir(), ".openclaw", "workspace", "state", "chuck-v2");

export function createChuckOpenClawCommand({
  stateDir = CHUCK_COMMAND_STATE_DIR,
  signingSecret = process.env.CHUCK_OPENCLAW_SIGNING_SECRET ?? DEFAULT_COMMAND_SIGNING_SECRET,
  deps = {},
}: ChuckOpenClawCommandOptions = {}): OpenClawPluginCommandDefinition {
  const resolvedDeps: ChuckCommandDeps = {
    runLiveScout: deps.runLiveScout ?? runLiveScoutFromOpenClawCommand,
    runDoctor: deps.runDoctor ?? runDoctorFromOpenClawCommand,
    readRepoHygiene: deps.readRepoHygiene ?? readRepoHygieneFromOpenClawCommand,
    readGitHubHygiene: deps.readGitHubHygiene ?? readGitHubHygieneFromOpenClawCommand,
    readDocket: deps.readDocket ?? readDocketFromOpenClawCommand,
    runOnboard: deps.runOnboard ?? runOnboardFromOpenClawCommand,
    runBuild: deps.runBuild ?? runBuildFromOpenClawCommand,
    readBuildStatus: deps.readBuildStatus ?? readBuildStatusFromOpenClawCommand,
    readBuildDocket: deps.readBuildDocket ?? readBuildDocketFromOpenClawCommand,
    approveBuild: deps.approveBuild ?? approveBuildFromOpenClawCommand,
  };
  return {
    name: "chuck",
    description: "Run Chuck's Fleet governor from OpenClaw channels.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) =>
      await handleChuckOpenClawCommand(ctx, {
        stateDir,
        signingSecret,
        deps: resolvedDeps,
      }),
  };
}

export async function handleChuckOpenClawCommand(
  ctx: PluginCommandContext,
  {
    stateDir = CHUCK_COMMAND_STATE_DIR,
    signingSecret = DEFAULT_COMMAND_SIGNING_SECRET,
    deps = {
      runLiveScout: runLiveScoutFromOpenClawCommand,
      runDoctor: runDoctorFromOpenClawCommand,
      readRepoHygiene: readRepoHygieneFromOpenClawCommand,
      readGitHubHygiene: readGitHubHygieneFromOpenClawCommand,
      readDocket: readDocketFromOpenClawCommand,
      runOnboard: runOnboardFromOpenClawCommand,
      runBuild: runBuildFromOpenClawCommand,
      readBuildStatus: readBuildStatusFromOpenClawCommand,
      readBuildDocket: readBuildDocketFromOpenClawCommand,
      approveBuild: approveBuildFromOpenClawCommand,
    },
  }: {
    stateDir?: string;
    signingSecret?: string;
    deps?: Partial<ChuckCommandDeps>;
  } = {},
): Promise<{ text: string }> {
  const resolvedDeps: ChuckCommandDeps = {
    runLiveScout: deps.runLiveScout ?? runLiveScoutFromOpenClawCommand,
    runDoctor: deps.runDoctor ?? runDoctorFromOpenClawCommand,
    readRepoHygiene: deps.readRepoHygiene ?? readRepoHygieneFromOpenClawCommand,
    readGitHubHygiene: deps.readGitHubHygiene ?? readGitHubHygieneFromOpenClawCommand,
    readDocket: deps.readDocket ?? readDocketFromOpenClawCommand,
    runOnboard: deps.runOnboard ?? runOnboardFromOpenClawCommand,
    runBuild: deps.runBuild ?? runBuildFromOpenClawCommand,
    readBuildStatus: deps.readBuildStatus ?? readBuildStatusFromOpenClawCommand,
    readBuildDocket: deps.readBuildDocket ?? readBuildDocketFromOpenClawCommand,
    approveBuild: deps.approveBuild ?? approveBuildFromOpenClawCommand,
  };
  const parsed = parseChuckCommandArgs(ctx.args);
  if (parsed.kind === "help") {
    return { text: formatChuckCommandHelp() };
  }
  if (parsed.kind === "doctor") {
    const doctor = await resolvedDeps.runDoctor({ stateDir });
    return { text: formatDoctorReply(doctor) };
  }
  if (parsed.kind === "docket") {
    const items = await resolvedDeps.readDocket({ stateDir, limit: 8 });
    return { text: formatDocketReply(items) };
  }
  if (parsed.kind === "hygiene") {
    const report = await resolvedDeps.readRepoHygiene({ checkpoint: parsed.hygieneCheckpoint });
    return { text: report.text };
  }
  if (parsed.kind === "github-hygiene") {
    const report = await resolvedDeps.readGitHubHygiene({
      checkpoint: parsed.githubHygieneCheckpoint,
    });
    return { text: report.text };
  }
  if (parsed.kind === "surface-atlas") {
    const { formatSurfaceAtlasReport, surfaceAtlasSummary } = await import("./surface-atlas.js");
    const { buildCapabilityLedgerForState } = await import("./capability-ledger.js");
    const summary = surfaceAtlasSummary();
    const ledger = buildCapabilityLedgerForState({ stateDir });
    return {
      text: formatSurfaceAtlasReport(summary, { surface: parsed.surfaceAtlasSurface, ledger }),
    };
  }
  if (parsed.kind === "onboard") {
    const report = await resolvedDeps.runOnboard({
      stateDir,
      repair: parsed.onboardRepair,
      proveSurface: parsed.onboardProveSurface,
      member:
        parsed.onboardMemberFamily && parsed.onboardMemberSurface
          ? { family: parsed.onboardMemberFamily, surface: parsed.onboardMemberSurface }
          : undefined,
      candidate:
        parsed.onboardCandidateFamily && parsed.onboardCandidateSurface
          ? {
              familyOrProduct: parsed.onboardCandidateFamily,
              surface: parsed.onboardCandidateSurface,
            }
          : undefined,
    });
    return { text: report.text };
  }
  if (parsed.kind === "build-docket") {
    const items = await resolvedDeps.readBuildDocket({ stateDir, limit: 8 });
    return { text: formatBuildDocketReply(items) };
  }
  if (parsed.kind === "build-status") {
    const run = await resolvedDeps.readBuildStatus({ stateDir, runId: parsed.runId });
    return { text: formatBuildStatusReply(run) };
  }
  if (parsed.kind === "build-approve") {
    if (!parsed.runId) {
      return { text: "Chuck build approve needs a run id." };
    }
    const run = await resolvedDeps.approveBuild({ stateDir, runId: parsed.runId });
    return { text: formatBuildStatusReply(run) };
  }
  if (parsed.kind === "build") {
    const objective = parsed.prompt?.trim();
    if (!objective) {
      return {
        text: "Chuck build needs an objective. Try `/chuck build add dashboard status for builder runs`.",
      };
    }
    const run = await resolvedDeps.runBuild({
      objective,
      stateDir,
      signingSecret,
      patchFile: parsed.patchFile,
      generatePatch: parsed.generatePatch,
      targetFiles: parsed.targetFiles,
    });
    return { text: formatBuildStatusReply(run) };
  }
  const prompt = parsed.prompt?.trim();
  if (!prompt) {
    return { text: "Chuck needs a prompt. Try `/chuck scout evaluate this plan...`." };
  }
  const run = await resolvedDeps.runLiveScout({
    prompt,
    autoDeepen: parsed.autoDeepen,
    includeProvisional: parsed.includeProvisional,
    stateDir,
    signingSecret,
  });
  return { text: formatLiveScoutReply(run) };
}

export function parseChuckCommandArgs(args: string | undefined): ParsedChuckCommand {
  const raw = args?.trim() ?? "";
  if (!raw || raw === "help" || raw === "--help" || raw === "-h") {
    return baseParsed("help");
  }
  const firstToken = raw.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (firstToken === "doctor" || firstToken === "status") {
    return baseParsed("doctor");
  }
  if (firstToken === "docket" || firstToken === "queue") {
    return baseParsed("docket");
  }
  if (firstToken === "hygiene" || firstToken === "clean" || firstToken === "repo") {
    const rest = raw.slice(firstToken.length).trim().toLowerCase();
    return {
      ...baseParsed("hygiene"),
      hygieneCheckpoint: rest === "checkpoint" || rest === "freeze",
    };
  }
  if (firstToken === "github" || firstToken === "remote") {
    const rest = raw.slice(firstToken.length).trim().toLowerCase();
    const words = new Set(rest.split(/\s+/).filter(Boolean));
    const checkpoint = words.has("checkpoint") || words.has("freeze");
    return { ...baseParsed("github-hygiene"), githubHygieneCheckpoint: checkpoint };
  }
  if (
    firstToken === "atlas" ||
    firstToken === "surfaces" ||
    firstToken === "surface-atlas" ||
    firstToken === "buttons" ||
    firstToken === "keys" ||
    firstToken === "abilities"
  ) {
    const rest = raw.slice(firstToken.length).trim();
    return { ...baseParsed("surface-atlas"), surfaceAtlasSurface: rest || undefined };
  }
  if (firstToken === "onboard" || firstToken === "onboarding") {
    return parseChuckOnboardArgs(raw.slice(firstToken.length).trim());
  }
  if (firstToken === "build") {
    return parseChuckBuildArgs(raw.slice(firstToken.length).trim());
  }

  const promptSource =
    firstToken === "scout" || firstToken === "run" || firstToken === "ask"
      ? raw.slice(firstToken.length).trim()
      : raw;
  const flags = new Set(
    (promptSource.match(/--[a-z0-9-]+/gi) ?? []).map((flag) => flag.toLowerCase()),
  );
  const prompt = promptSource
    .replaceAll(/\s*--no-auto-deepen\b/gi, "")
    .replaceAll(/\s*--include-provisional\b/gi, "")
    .trim();
  return {
    kind: "scout",
    prompt,
    targetFiles: [],
    generatePatch: false,
    hygieneCheckpoint: false,
    githubHygieneCheckpoint: false,
    onboardRepair: false,
    autoDeepen: !flags.has("--no-auto-deepen"),
    includeProvisional: flags.has("--include-provisional"),
  };
}

function baseParsed(kind: ChuckCommandKind): ParsedChuckCommand {
  return {
    kind,
    autoDeepen: true,
    includeProvisional: false,
    hygieneCheckpoint: false,
    githubHygieneCheckpoint: false,
    generatePatch: false,
    onboardRepair: false,
    targetFiles: [],
  };
}

function parseChuckOnboardArgs(input: string): ParsedChuckCommand {
  const trimmed = input.trim();
  const parsed = { ...baseParsed("onboard"), prompt: trimmed };
  if (!trimmed) {
    return parsed;
  }
  const [first = "", second = "", third = ""] = trimmed.split(/\s+/);
  if (first.toLowerCase() === "repair") {
    return { ...parsed, onboardRepair: true };
  }
  if (first.toLowerCase() === "candidate") {
    return {
      ...parsed,
      onboardCandidateFamily: second || undefined,
      onboardCandidateSurface: third || undefined,
    };
  }
  if (
    first.toLowerCase() === "member" ||
    first.toLowerCase() === "surface" ||
    first.toLowerCase() === "child"
  ) {
    return {
      ...parsed,
      onboardMemberFamily: second || undefined,
      onboardMemberSurface: third || undefined,
    };
  }
  if (first.toLowerCase() === "prove" || first.toLowerCase() === "proof") {
    return {
      ...parsed,
      onboardProveSurface: second || undefined,
    };
  }
  return parsed;
}

function parseChuckBuildArgs(input: string): ParsedChuckCommand {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
    return { ...baseParsed("help"), prompt: "build" };
  }
  const firstToken = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (firstToken === "status") {
    return {
      ...baseParsed("build-status"),
      runId: trimmed.slice(firstToken.length).trim() || undefined,
    };
  }
  if (firstToken === "docket" || firstToken === "queue") {
    return baseParsed("build-docket");
  }
  if (firstToken === "approve") {
    return {
      ...baseParsed("build-approve"),
      runId: trimmed.slice(firstToken.length).trim() || undefined,
    };
  }
  let patchFile: string | undefined;
  const flags = new Set((trimmed.match(/--[a-z0-9-]+/gi) ?? []).map((flag) => flag.toLowerCase()));
  const targetFiles: string[] = [];
  const withoutFlags = trimmed
    .replaceAll(/\s+--generate-patch\b/gi, "")
    .replaceAll(/\s+--patch-file(?:=|\s+)(\S+)/gi, (_match, value: string) => {
      patchFile = value;
      return "";
    })
    .replaceAll(/\s+--target(?:=|\s+)(\S+)/gi, (_match, value: string) => {
      targetFiles.push(
        ...value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      return "";
    })
    .trim();
  return {
    ...baseParsed("build"),
    prompt: withoutFlags,
    patchFile,
    generatePatch: flags.has("--generate-patch"),
    targetFiles,
  };
}

export async function runLiveScoutFromOpenClawCommand({
  prompt,
  autoDeepen = true,
  includeProvisional = false,
  stateDir = CHUCK_COMMAND_STATE_DIR,
  signingSecret = DEFAULT_COMMAND_SIGNING_SECRET,
  onlySurfaces = [],
}: {
  prompt: string;
  autoDeepen?: boolean;
  includeProvisional?: boolean;
  stateDir?: string;
  signingSecret?: string;
  onlySurfaces?: string[];
}): Promise<ChuckLiveScoutCommandResult> {
  const [
    { configWithSafeCliScoutSurfaces },
    { loadRunnerSurfaceProofs },
    {
      defaultLoadBearingRunnerAdapters,
      defaultRunnerAdapters,
      executeFleetDispatchPlan,
      persistFleetDispatchExecution,
    },
    { createFleetDeepenDispatchPlan, resolveFleetScout },
    { persistChuckLoopResult, runChuckLoop, summarizeChuckLoopResult },
  ] = await Promise.all([
    import("./config.js"),
    import("./model-doctor.js"),
    import("./runner-executor.js"),
    import("./scout-resolve.js"),
    import("./loop.js"),
  ]);
  const runtimeConfig = configWithSafeCliScoutSurfaces();
  const proofHistory = loadRunnerSurfaceProofs({ stateDir });
  const cooldownSurfaces: string[] = [];
  const selectedSurfaces = new Set(onlySurfaces.map((surface) => surface.trim()).filter(Boolean));
  const adapters = selectCommandRunnerAdapters({
    includeProvisional,
    proofHistory,
    allAdapters: defaultRunnerAdapters(),
    loadBearingAdapters: defaultLoadBearingRunnerAdapters(),
  }).filter((adapter) => {
    if (selectedSurfaces.size > 0 && !selectedSurfaces.has(adapter.surface)) {
      return false;
    }
    const coolingDown =
      selectedSurfaces.size === 0 && isSurfaceCoolingDown(proofHistory[adapter.surface]);
    if (coolingDown) {
      cooldownSurfaces.push(adapter.surface);
    }
    return !coolingDown;
  });
  const adapterSurfaces = new Set(adapters.map((adapter) => adapter.surface));
  const executionConfig = filterChuckConfigBySurfaces(runtimeConfig, adapterSurfaces);
  if (executionConfig.fleet.length === 0) {
    throw new Error("No executable Chuck Fleet surfaces are currently available.");
  }

  const localServer = await ensureOllamaServerForRun(adapterSurfaces);
  try {
    const result = await runChuckLoop({
      requestText: prompt,
      mode: "preflight",
      config: executionConfig,
    });
    const runnerExecution = await executeFleetDispatchPlan({
      dispatchPlan: {
        ...result.dispatchPlan,
        tasks: result.dispatchPlan.tasks.filter((task) => adapterSurfaces.has(task.surface)),
      },
      adapters,
      signingSecret,
      transcriptDir: join(stateDir, "transcripts", result.runId),
    });
    const scoutResolve = resolveFleetScout(runnerExecution);
    const deepenPlan = autoDeepen
      ? createFleetDeepenDispatchPlan({
          scoutPlan: result.dispatchPlan,
          scoutResolve,
          requestText: prompt,
        })
      : undefined;
    const deepenExecution = deepenPlan
      ? await executeFleetDispatchPlan({
          dispatchPlan: deepenPlan,
          adapters,
          signingSecret,
          transcriptDir: join(stateDir, "transcripts", result.runId),
        })
      : undefined;
    const deepenResolve = deepenExecution ? resolveFleetScout(deepenExecution) : undefined;
    const persisted = await persistChuckLoopResult(result, { stateDir });
    const persistedRunnerExecution = await persistFleetDispatchExecution({
      stateDir,
      execution: runnerExecution,
    });
    const persistedDeepenExecution = deepenExecution
      ? await persistFleetDispatchExecution({ stateDir, execution: deepenExecution })
      : undefined;
    return {
      summary: summarizeChuckLoopResult(result),
      result,
      runnerExecution,
      scoutResolve,
      deepenPlan,
      deepenExecution,
      deepenResolve,
      cooldownSurfaces,
      persisted,
      persistedRunnerExecution,
      persistedDeepenExecution,
    };
  } finally {
    await localServer?.stop();
  }
}

export async function runDoctorFromOpenClawCommand({
  stateDir = CHUCK_COMMAND_STATE_DIR,
}: {
  stateDir?: string;
} = {}): Promise<Record<string, unknown>> {
  const [
    { configWithSafeCliScoutSurfaces },
    { loadRunnerSurfaceProofs, modelDoctorSummary, runModelDoctor },
    { buildCapabilityLedgerForState },
  ] = await Promise.all([
    import("./config.js"),
    import("./model-doctor.js"),
    import("./capability-ledger.js"),
  ]);
  const config = configWithSafeCliScoutSurfaces();
  const report = runModelDoctor({
    config,
    stateDir,
    executionProofs: loadRunnerSurfaceProofs({ stateDir }),
  });
  const capabilityLedger = buildCapabilityLedgerForState({ stateDir, config });
  return {
    ...modelDoctorSummary(report),
    capabilityLedgerSummary: capabilityLedger.summary,
    readinessBoard: capabilityLedger.entries.slice(0, 12).map((entry) => ({
      family: entry.family,
      surface: entry.surface,
      readiness: entry.readiness,
      canCountForFamily: entry.countsAsIndependentFamily,
      nextRepairAction: entry.nextRepairAction,
      caveats: entry.caveats.slice(0, 3),
    })),
  };
}

export async function readDocketFromOpenClawCommand({
  stateDir = CHUCK_COMMAND_STATE_DIR,
  limit = 8,
}: {
  stateDir?: string;
  limit?: number;
} = {}): Promise<DocketItem[]> {
  const { readDocketItems } = await import("./loop.js");
  return await readDocketItems({ stateDir, limit });
}

export async function readRepoHygieneFromOpenClawCommand({
  repoRoot = process.cwd(),
  stateDir = CHUCK_COMMAND_STATE_DIR,
  checkpoint = false,
}: {
  repoRoot?: string;
  stateDir?: string;
  checkpoint?: boolean;
} = {}): Promise<{ text: string; report: unknown }> {
  const {
    createRepoHygieneCheckpoint,
    formatRepoHygieneCheckpoint,
    formatRepoHygienePlan,
    formatRepoHygieneReport,
    inspectRepoHygiene,
    planRepoHygiene,
  } = await import("./repo-hygiene.js");
  if (checkpoint) {
    const frozen = await createRepoHygieneCheckpoint({ repoRoot, stateDir });
    return { text: formatRepoHygieneCheckpoint(frozen), report: frozen };
  }
  const report = await inspectRepoHygiene({ repoRoot });
  const plan = planRepoHygiene(report);
  return {
    text: `${formatRepoHygieneReport(report)}\n\n${formatRepoHygienePlan(plan)}`,
    report: { report, plan },
  };
}

export async function readGitHubHygieneFromOpenClawCommand({
  repoRoot = process.cwd(),
  stateDir = CHUCK_COMMAND_STATE_DIR,
  checkpoint = false,
}: {
  repoRoot?: string;
  stateDir?: string;
  checkpoint?: boolean;
} = {}): Promise<{ text: string; report: unknown }> {
  const {
    createGitHubHygieneCheckpoint,
    formatGitHubHygieneCheckpoint,
    formatGitHubHygieneReport,
    inspectGitHubHygiene,
  } = await import("./github-hygiene.js");
  if (checkpoint) {
    const frozen = await createGitHubHygieneCheckpoint({ repoRoot, stateDir });
    return { text: formatGitHubHygieneCheckpoint(frozen), report: frozen };
  }
  const report = await inspectGitHubHygiene({ repoRoot });
  return { text: formatGitHubHygieneReport(report), report };
}

export async function runOnboardFromOpenClawCommand({
  stateDir = CHUCK_COMMAND_STATE_DIR,
  repair = false,
  proveSurface,
  member,
  candidate,
}: {
  stateDir?: string;
  repair?: boolean;
  proveSurface?: string;
  member?: {
    family: string;
    surface: string;
  };
  candidate?: {
    familyOrProduct: string;
    surface: string;
  };
} = {}): Promise<{ text: string; report: unknown }> {
  const {
    formatCandidateOnboardingRecord,
    formatOnboardingReport,
    runCandidateOnboarding,
    runChuckOnboarding,
  } = await import("./onboarding.js");
  if (member) {
    const record = await runCandidateOnboarding({
      stateDir,
      familyOrProduct: member.family,
      surface: member.surface,
      persist: true,
    });
    return { text: formatCandidateOnboardingRecord(record), report: record };
  }
  if (candidate) {
    const record = await runCandidateOnboarding({
      stateDir,
      familyOrProduct: candidate.familyOrProduct,
      surface: candidate.surface,
      persist: true,
    });
    return { text: formatCandidateOnboardingRecord(record), report: record };
  }
  if (proveSurface) {
    const proofRun = await withSurfaceProofTimeout(
      proveSurface,
      async () =>
        await runLiveScoutFromOpenClawCommand({
          prompt: [
            "Chuck harmless surface proof.",
            "Reply with exactly one short sentence containing SURFACE_PROOF_OK if this prompt reached the intended model surface.",
            "Do not access tools, files, browser history, accounts, or private context.",
          ].join("\n"),
          autoDeepen: false,
          includeProvisional: true,
          onlySurfaces: [proveSurface],
          stateDir,
        }),
    );
    return { text: formatSurfaceProofReply(proofRun, proveSurface), report: proofRun };
  }
  const report = await runChuckOnboarding({ stateDir, repair });
  return { text: formatOnboardingReport(report), report };
}

export async function runBuildFromOpenClawCommand({
  objective,
  stateDir = CHUCK_COMMAND_STATE_DIR,
  signingSecret = DEFAULT_COMMAND_SIGNING_SECRET,
  patchFile,
  generatePatch = false,
  targetFiles = [],
}: {
  objective: string;
  stateDir?: string;
  signingSecret?: string;
  patchFile?: string;
  generatePatch?: boolean;
  targetFiles?: string[];
}): Promise<BuilderRun> {
  const { runSelfBuild } = await import("./builder.js");
  let generatedBy = ["fleet-scout-unavailable"];
  let receipts: NonNullable<Parameters<typeof runSelfBuild>[0]["receipts"]> = [];
  let implementationPlan: BuilderImplementationPlan | undefined;
  let patchText: string | undefined;
  try {
    const scout = await runLiveScoutFromOpenClawCommand({
      prompt: [
        "Chuck self-build objective.",
        "Produce an implementation plan, likely file scope, authority risks, verifier commands, and blockers.",
        ...(generatePatch
          ? [
              "If safe and specific enough, also produce one unified git diff in a fenced ```diff block.",
              "The diff must be directly consumable by git apply, must touch only the proposed file scope, and must not modify Tier-0, credential, destructive, sandbox, approval-policy, model-counting, launchd, or doctrine paths.",
              "If the objective is underspecified or risky, do not produce a diff; state the blocker instead.",
            ]
          : ["Do not produce a patch yet."]),
        "Do not produce an unsafe patch. Preserve Tier-0, credential, destructive, sandbox, and doctrine approval gates.",
        "",
        objective,
      ].join("\n"),
      autoDeepen: true,
      includeProvisional: false,
      stateDir,
      signingSecret,
    });
    receipts = [
      ...(scout.runnerExecution?.receipts ?? []),
      ...(scout.deepenExecution?.receipts ?? []),
    ];
    generatedBy =
      receipts.length > 0
        ? receipts.map((receipt) => `${receipt.actualFamily}:${receipt.surface}`)
        : [`fleet-scout:${scout.result.runId}`];
    implementationPlan = implementationPlanFromScout({
      objective,
      sourceRunId: scout.result.runId,
      runnerExecution: scout.runnerExecution,
      deepenExecution: scout.deepenExecution,
    });
    if (generatePatch && !patchFile) {
      const candidate = extractUnifiedDiffPatchCandidate(
        [...(scout.deepenExecution?.executions ?? []), ...(scout.runnerExecution?.executions ?? [])]
          .filter((execution) => execution.status === "completed")
          .map((execution) => execution.text)
          .join("\n\n---\n\n"),
      );
      if (candidate.patchText) {
        patchText = candidate.patchText;
      }
      if (candidate.blockers.length > 0) {
        implementationPlan = {
          ...implementationPlan,
          blockers: [...new Set([...implementationPlan.blockers, ...candidate.blockers])].slice(
            0,
            12,
          ),
        };
      }
    }
  } catch (error) {
    generatedBy = [`fleet-scout-failed:${error instanceof Error ? error.message : String(error)}`];
    implementationPlan = {
      summary: "Fleet Scout failed before producing a usable implementation plan.",
      proposedFiles: targetFiles,
      verifierCommands: verifierCommandsForFiles(targetFiles),
      blockers: [error instanceof Error ? error.message : String(error)],
      sourceReceipts: [],
    };
  }
  return await runSelfBuild({
    objective,
    stateDir,
    signingSecret,
    patchFile,
    patchText,
    targetFiles,
    implementationPlan,
    generatedBy,
    receipts,
    autonomyEnvelope: "aggressive",
  });
}

export async function readBuildStatusFromOpenClawCommand({
  stateDir = CHUCK_COMMAND_STATE_DIR,
  runId,
}: {
  stateDir?: string;
  runId?: string;
} = {}): Promise<BuilderRun | null> {
  const { readBuilderStatus } = await import("./builder.js");
  return await readBuilderStatus({ stateDir, runId });
}

export async function readBuildDocketFromOpenClawCommand({
  stateDir = CHUCK_COMMAND_STATE_DIR,
  limit = 8,
}: {
  stateDir?: string;
  limit?: number;
} = {}): Promise<BuilderRun[]> {
  const { readBuilderDocket } = await import("./builder.js");
  return await readBuilderDocket({ stateDir, limit });
}

export async function approveBuildFromOpenClawCommand({
  stateDir = CHUCK_COMMAND_STATE_DIR,
  runId,
}: {
  stateDir?: string;
  runId: string;
}): Promise<BuilderRun> {
  const { approveBuilderRun } = await import("./builder.js");
  return await approveBuilderRun({ stateDir, runId });
}

export function formatLiveScoutReply(run: ChuckLiveScoutCommandResult): string {
  const summary = run.summary;
  const scout = run.scoutResolve;
  const deepen = run.deepenResolve;
  const receipts = run.runnerExecution?.receipts ?? [];
  const failed = (run.runnerExecution?.executions ?? []).filter(
    (item) => item.status !== "completed",
  );
  const surfaces = receipts.map((receipt) => receipt.surface).join(", ") || "none";
  const lines = [
    `Chuck Fleet run ${displayScalar(summary.runId, run.result.runId)}`,
    `Stake: ${displayScalar(summary.stakeClass)} / ${displayScalar(summary.taskClass)}`,
    `Scout: ${receipts.length} receipt${receipts.length === 1 ? "" : "s"} across ${scout?.independentUsableFamilyCount ?? 0} independent famil${scout?.independentUsableFamilyCount === 1 ? "y" : "ies"}.`,
    `Resolve: ${scout?.disposition ?? displayScalar(summary.disposition)}`,
    `Surfaces: ${surfaces}`,
  ];
  if (scout?.deepenNeededSurfaces.length) {
    lines.push(`Deepen requested: ${scout.deepenNeededSurfaces.join(", ")}`);
  }
  if (deepen) {
    lines.push(
      `Deepen resolve: ${deepen.disposition} (${deepen.independentUsableFamilyCount} families)`,
    );
  }
  if (run.cooldownSurfaces.length > 0) {
    lines.push(`Cooldown skipped: ${run.cooldownSurfaces.join(", ")}`);
  }
  if (failed.length > 0) {
    lines.push(
      `Surface misses: ${failed.map((item) => `${item.surface}:${item.status}`).join(", ")}`,
    );
  }
  lines.push(`Docket: ${displayScalar(summary.docketStatus, run.result.docketItem.status)}`);
  return lines.join("\n");
}

export function formatSurfaceProofReply(run: ChuckLiveScoutCommandResult, surface: string): string {
  const receipts = run.runnerExecution?.receipts ?? [];
  const failures = (run.runnerExecution?.executions ?? []).filter(
    (execution) => execution.status !== "completed",
  );
  const completed = (run.runnerExecution?.executions ?? []).find(
    (execution) => execution.status === "completed" && execution.surface === surface,
  );
  return [
    `Chuck surface proof ${surface}`,
    `Receipts: ${receipts.length}`,
    `Independent families: ${run.scoutResolve?.independentUsableFamilyCount ?? 0}`,
    `Disposition: ${run.scoutResolve?.disposition ?? "unknown"}`,
    completed && "promptDeliveryProof" in completed
      ? `Prompt delivery: ${completed.promptDeliveryProof.verdict}`
      : "Prompt delivery: missing",
    completed && "answerAttributionProof" in completed
      ? `Answer attribution: ${completed.answerAttributionProof.verdict}`
      : "Answer attribution: missing",
    `Surfaces: ${receipts.map((receipt) => `${receipt.actualFamily}:${receipt.surface}`).join(", ") || "none"}`,
    failures.length > 0
      ? `Misses: ${failures.map((execution) => `${execution.surface}:${execution.status}`).join(", ")}`
      : "Misses: none",
  ].join("\n");
}

export function formatDoctorReply(summary: Record<string, unknown>): string {
  const ready = stringArray(summary.readyFamilies).join(", ") || "none";
  const executionReady = stringArray(summary.executionReadyFamilies).join(", ") || "none";
  const blocked = stringArray(summary.blockedFamilies).join(", ") || "none";
  const ledgerSummary = summary.capabilityLedgerSummary as
    | {
        loadBearingSurfaces?: number;
        independentLoadBearingFamilies?: unknown[];
        independentLoadBearingFamilyCount?: number;
      }
    | undefined;
  const readinessLines = ledgerSummary
    ? [
        `Kernel-ready families: ${stringArray(ledgerSummary.independentLoadBearingFamilies).join(", ") || "none"}`,
        `Load-bearing surfaces: ${displayScalar(ledgerSummary.loadBearingSurfaces, "0")}`,
      ]
    : [];
  return [
    "Chuck model doctor",
    `Configured voices: ${displayScalar(summary.configuredVoices, "unknown")}`,
    `Ready families: ${ready}`,
    `Execution-ready families: ${executionReady}`,
    ...readinessLines,
    `Blocked families: ${blocked}`,
    `Load-bearing minimum: ${summary.canRunLoadBearingMinimumFleet ? "ready" : "not ready"}`,
    `High-risk minimum: ${summary.canRunLoadBearingHighRiskFleet ? "ready" : "not ready"}`,
  ].join("\n");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = displayScalar(item, "");
        return text ? [text] : [];
      })
    : [];
}

function displayScalar(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function formatDocketReply(
  items: Awaited<ReturnType<typeof readDocketFromOpenClawCommand>>,
): string {
  if (items.length === 0) {
    return "Chuck docket is empty.";
  }
  return [
    "Chuck docket",
    ...items.map((item) => `- ${item.status}: ${item.title} (${item.runId})`),
  ].join("\n");
}

export function formatBuildStatusReply(run: BuilderRun | null): string {
  if (!run) {
    return "Chuck build status: no builder runs found.";
  }
  const lines = [
    `Chuck build ${run.runId}`,
    `Stage: ${run.stage}`,
    `Disposition: ${run.disposition}`,
    `Authority: ${run.authorityDiffId ?? "none"}`,
    `Intent anchor: ${run.intentAnchorId ?? "none"}`,
    `Operator approval: ${run.operatorActionRequired ? "required" : "not required"}`,
    `Targets: ${run.targetFiles.length > 0 ? run.targetFiles.join(", ") : "none"}`,
    `Tests: ${run.tests.length === 0 ? "not run" : `${run.tests.filter((test) => test.passed).length}/${run.tests.length} passed`}`,
  ];
  if (run.worktreePath) {
    lines.push(`Shadow worktree: ${run.worktreePath}`);
  }
  if (run.patchPath) {
    lines.push(`Patch: ${run.patchPath}`);
  }
  if (run.planPath) {
    lines.push(`Plan: ${run.planPath}`);
  }
  if (run.implementationPlan) {
    lines.push(
      `Proposed files: ${run.implementationPlan.proposedFiles.length > 0 ? run.implementationPlan.proposedFiles.join(", ") : "none"}`,
    );
    lines.push(`Plan summary: ${run.implementationPlan.summary}`);
  }
  if (run.reasons.length > 0) {
    lines.push(`Reasons: ${run.reasons.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatBuildDocketReply(items: BuilderRun[]): string {
  if (items.length === 0) {
    return "Chuck build docket is empty.";
  }
  return [
    "Chuck build docket",
    ...items.map((item) => `- ${item.disposition}: ${item.objective} (${item.runId})`),
  ].join("\n");
}

function implementationPlanFromScout({
  objective,
  sourceRunId,
  runnerExecution,
  deepenExecution,
}: {
  objective: string;
  sourceRunId: string;
  runnerExecution?: FleetDispatchExecutionResult;
  deepenExecution?: FleetDispatchExecutionResult;
}): BuilderImplementationPlan {
  const executions = [
    ...(runnerExecution?.executions ?? []),
    ...(deepenExecution?.executions ?? []),
  ];
  const completed = executions.filter((execution) => execution.status === "completed");
  const combinedText = completed.map((execution) => execution.text).join("\n\n---\n\n");
  const proposedFiles = extractRepoPaths(combinedText);
  const blockers = [
    ...extractSectionBullets(combinedText, "BLOCKERS"),
    ...extractSectionBullets(combinedText, "RISKS"),
    ...extractSectionBullets(combinedText, "MISSING_EVIDENCE"),
  ]
    .filter((item, index, all) => item && all.indexOf(item) === index)
    .slice(0, 8);
  return {
    summary: summarizeFleetPlanText(combinedText, objective),
    proposedFiles,
    verifierCommands: verifierCommandsForFiles(proposedFiles),
    blockers,
    sourceRunId,
    sourceReceipts: [
      ...(runnerExecution?.receipts ?? []),
      ...(deepenExecution?.receipts ?? []),
    ].map(
      (receipt) =>
        `${receipt.actualFamily}:${receipt.surface}:${receipt.runnerSignature.slice(0, 12)}`,
    ),
  };
}

function summarizeFleetPlanText(text: string, objective: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)
    .filter(
      (line) => !/^(claims|risks|missing_evidence|deepen_needed|summary|plan):?$/i.test(line),
    );
  const planLine = lines.find((line) =>
    /\b(?:implement|add|update|wire|create|patch|test|verify)\b/i.test(line),
  );
  return (
    planLine ??
    `Fleet recorded the self-build objective and did not produce a patch yet: ${objective}`
  ).slice(0, 900);
}

function extractRepoPaths(text: string): string[] {
  const files = new Set<string>();
  const pathPattern =
    /\b(?:extensions|src|scripts|test|ui|ui-phone|ui-phone-v3)\/[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._@+-]+)*\.(?:ts|tsx|js|mjs|cjs|json|md|css|html|yml|yaml|sh|swift)\b/g;
  for (const match of text.matchAll(pathPattern)) {
    files.add(match[0]);
  }
  return [...files].toSorted().slice(0, 16);
}

function extractSectionBullets(text: string, section: string): string[] {
  const lines = text.split("\n");
  const bullets: string[] = [];
  let inSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (new RegExp(`^${section}:?$`, "i").test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^[A-Z_ ]+:?$/.test(line) && !line.startsWith("-")) {
      break;
    }
    if (inSection && /^[-*]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*]\s+/, "").slice(0, 240));
    }
  }
  return bullets;
}

function verifierCommandsForFiles(files: string[]): BuilderVerificationCommand[] {
  const commands: BuilderVerificationCommand[] = [];
  if (files.length > 0) {
    commands.push({ command: "pnpm", args: ["exec", "oxlint", ...files], timeoutMs: 120_000 });
  }
  if (files.some((file) => file.startsWith("extensions/memory-graph/src/chuck-v2/"))) {
    commands.push({
      command: "pnpm",
      args: ["test", "extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts"],
      timeoutMs: 180_000,
    });
    commands.push({ command: "pnpm", args: ["tsgo:extensions"], timeoutMs: 180_000 });
  }
  return commands;
}

export function extractUnifiedDiffPatchCandidate(text: string): {
  patchText?: string;
  blockers: string[];
} {
  const blockers: string[] = [];
  const fencedCandidates = [...text.matchAll(/```(?:diff|patch)\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  const diffStart = text.indexOf("diff --git");
  const rawCandidates =
    fencedCandidates.length > 0
      ? fencedCandidates
      : diffStart >= 0
        ? [text.slice(diffStart).trim()]
        : [];
  for (const candidate of rawCandidates) {
    if (/^\*\*\* Begin Patch/m.test(candidate)) {
      blockers.push(
        "Fleet produced apply_patch syntax; Builder Generate requires a git-apply unified diff.",
      );
      continue;
    }
    if (!/^diff --git /m.test(candidate)) {
      blockers.push("Fleet did not produce a unified diff with diff --git headers.");
      continue;
    }
    if (!/^--- /m.test(candidate) || !/^\+\+\+ /m.test(candidate)) {
      blockers.push("Fleet diff is missing ---/+++ file headers.");
      continue;
    }
    const patchText = candidate.endsWith("\n") ? candidate : `${candidate}\n`;
    if (extractRepoPaths(patchText).length === 0) {
      blockers.push("Fleet diff did not expose any recognized repo file paths.");
      continue;
    }
    return { patchText, blockers: [...new Set(blockers)].slice(0, 6) };
  }
  if (blockers.length === 0) {
    blockers.push("Fleet did not produce a patch candidate.");
  }
  return { blockers: [...new Set(blockers)].slice(0, 6) };
}

export function formatChuckCommandHelp(): string {
  return [
    "Chuck command surface",
    "/chuck scout <prompt> — run sealed Fleet Scout, adaptive Deepen, receipts, and Docket logging.",
    "/chuck <prompt> — same as scout.",
    "/chuck scout --no-auto-deepen <prompt> — stop after Scout.",
    "/chuck onboard [repair] — inspect setup, Fleet proofs, resources, and candidate intake.",
    "/chuck onboard prove <surface> — run one harmless signed receipt proof for a configured surface.",
    "/chuck onboard member <family> <surface> — register a child/cousin surface inside an existing family.",
    "/chuck onboard candidate <family-or-product> <surface> — register a provisional future model/product surface with proof gates.",
    "/chuck build <objective> — start a governed Chuck-builds-Chuck run.",
    "/chuck build <objective> --generate-patch — ask Fleet for a patch candidate, then verify it.",
    "/chuck build status [runId] — show a builder run.",
    "/chuck build docket — list builder runs.",
    "/chuck build approve <runId> — approve a docketed authority gate.",
    "/chuck doctor — summarize configured and execution-ready model families.",
    "/chuck atlas [surface] — show the durable Surface Atlas: controls, shortcuts, abilities, tool routes, leases, and mastery gaps.",
    "/chuck hygiene — classify repo dirt and show self-build cleanliness gates.",
    "/chuck hygiene checkpoint — freeze repo diffs, manifests, and cleanup lanes.",
    "/chuck github — classify fork/upstream branch sprawl and cleanup gates.",
    "/chuck github checkpoint — freeze remote branch manifests and review-only deletion candidates.",
    "/chuck docket — list recent Chuck decisions.",
  ].join("\n");
}

function selectCommandRunnerAdapters({
  includeProvisional,
  proofHistory,
  allAdapters,
  loadBearingAdapters,
}: {
  includeProvisional: boolean;
  proofHistory: Record<string, RunnerSurfaceProof>;
  allAdapters: RunnerAdapter[];
  loadBearingAdapters: RunnerAdapter[];
}): RunnerAdapter[] {
  if (includeProvisional) {
    return allAdapters;
  }
  const loadBearingSurfaces = new Set(loadBearingAdapters.map((adapter) => adapter.surface));
  return allAdapters.filter(
    (adapter) =>
      loadBearingSurfaces.has(adapter.surface) || proofHistory[adapter.surface]?.repeatable,
  );
}

function filterChuckConfigBySurfaces(config: ChuckConfig, surfaces: Set<string>): ChuckConfig {
  return {
    ...config,
    fleet: config.fleet.filter((entry) => surfaces.has(entry.surface)),
  };
}

function isSurfaceCoolingDown(proof?: RunnerSurfaceProof, now = new Date()): boolean {
  if (!proof || proof.latestStatus !== "failed") {
    return false;
  }
  const failureAtMs = Date.parse(proof.lastFailureAt ?? "");
  if (!Number.isFinite(failureAtMs)) {
    return true;
  }
  return now.getTime() - failureAtMs < 30 * 60 * 1000;
}

async function withSurfaceProofTimeout<T>(surface: string, fn: () => Promise<T>): Promise<T> {
  const timeout = surfaceProofTimeout(surface);
  if (!timeout) {
    return await fn();
  }
  const previous = process.env[timeout.envName];
  process.env[timeout.envName] = String(timeout.timeoutMs);
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[timeout.envName];
    } else {
      process.env[timeout.envName] = previous;
    }
  }
}

function surfaceProofTimeout(surface: string): { envName: string; timeoutMs: number } | undefined {
  if (surface === "grok/web-or-app") {
    return { envName: "CHUCK_GROK_SCOUT_TIMEOUT_MS", timeoutMs: 300_000 };
  }
  if (surface === "chatgpt/web-chat") {
    return { envName: "CHUCK_CHATGPT_WEB_TIMEOUT_MS", timeoutMs: 300_000 };
  }
  if (surface === "chatgpt/mac-app") {
    return { envName: "CHUCK_CHATGPT_MAC_TIMEOUT_MS", timeoutMs: 360_000 };
  }
  if (surface === "claude/web-chat") {
    return { envName: "CHUCK_CLAUDE_WEB_TIMEOUT_MS", timeoutMs: 300_000 };
  }
  if (surface === "claude/mac-app") {
    return { envName: "CHUCK_CLAUDE_MAC_TIMEOUT_MS", timeoutMs: 360_000 };
  }
  if (surface === "codex-review/exec") {
    return { envName: "CHUCK_CODEX_REVIEW_TIMEOUT_MS", timeoutMs: 180_000 };
  }
  if (surface === "perplexity/mac-app") {
    return { envName: "CHUCK_PERPLEXITY_MAC_SCOUT_TIMEOUT_MS", timeoutMs: 600_000 };
  }
  if (surface === "perplexity/web") {
    return { envName: "CHUCK_PERPLEXITY_WEB_TIMEOUT_MS", timeoutMs: 360_000 };
  }
  if (surface === "gemini/web-chat") {
    return { envName: "CHUCK_GEMINI_WEB_TIMEOUT_MS", timeoutMs: 300_000 };
  }
  if (surface === "aistudio/web") {
    return { envName: "CHUCK_AISTUDIO_WEB_TIMEOUT_MS", timeoutMs: 360_000 };
  }
  return undefined;
}

async function ensureOllamaServerForRun(
  surfaces: Set<string>,
): Promise<{ stop(): Promise<void> } | undefined> {
  if (!surfaces.has("ollama/localhost") || (await isOllamaReady())) {
    return undefined;
  }
  const child = spawn("/opt/homebrew/bin/ollama", ["serve"], {
    env: {
      ...process.env,
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0",
      OLLAMA_NUM_PARALLEL: "1",
      OLLAMA_MAX_LOADED_MODELS: "1",
      OLLAMA_KEEP_ALIVE: "30s",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  for (let i = 0; i < 20; i += 1) {
    if (await isOllamaReady()) {
      return { stop: () => stopChild(child) };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stopChild(child);
  return undefined;
}

async function isOllamaReady(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const force = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
    force.unref();
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
