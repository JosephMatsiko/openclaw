import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import * as chuckV2 from "../src/chuck-v2/index.js";

const execFileAsync = promisify(execFile);

type ChuckConfig = chuckV2.ChuckConfig;
type FleetScoutResolve = chuckV2.FleetScoutResolve;
type RunnerSurfaceProof = chuckV2.RunnerSurfaceProof;
type WorkerHealthSnapshot = chuckV2.WorkerHealthSnapshot;

const {
  appendChuckEventLine,
  CHUCK_V2_STATE_DIR,
  createChuckEvent,
  createFleetDeepenDispatchPlan,
  configWithSafeCliScoutSurfaces,
  DEFAULT_CHUCK_CONFIG,
  docketItemsForModelDoctor,
  createOllamaRunnerAdapter,
  defaultLoadBearingRunnerAdapters,
  defaultRunnerAdapters,
  executeFleetDispatchPlan,
  handleChuckOpenClawCommand,
  loadRunnerSurfaceProofs,
  modelDoctorSummary,
  persistFleetDispatchExecution,
  persistChuckLoopResult,
  readDocketItems,
  resolveFleetScout,
  runChuckLoop,
  runModelDoctor,
  summarizeChuckLoopResult,
  workerProbeNamesForConfig,
} = chuckV2;

type CliOptions = {
  mode: "preflight" | "demo-fleet";
  stateDir?: string;
  json: boolean;
  persist: boolean;
  prompt: string;
  listDocket: boolean;
  surfaceAtlas: boolean;
  surfaceAtlasSurface?: string;
  capabilityLedger: boolean;
  doctor: boolean;
  repoHygiene: boolean;
  repoHygieneCheckpoint: boolean;
  githubHygiene: boolean;
  githubHygieneCheckpoint: boolean;
  upstreamSync: boolean;
  upstreamSyncCheckpoint: boolean;
  onboard: boolean;
  onboardRepair: boolean;
  onboardCandidate: boolean;
  onboardCandidateFamily?: string;
  onboardCandidateSurface?: string;
  onboardMemberFamily?: string;
  onboardMemberSurface?: string;
  onboardProveSurface?: string;
  buildPlan: boolean;
  buildGeneratePatch: boolean;
  buildPatchFile: boolean;
  patchFile?: string;
  targetFiles: string[];
  healthFile?: string;
  probe: boolean;
  localScout: boolean;
  liveScout: boolean;
  includeProvisional: boolean;
  autoDeepen: boolean;
  onlySurfaces: string[];
  ollamaModel?: string;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runtimeConfig =
    options.liveScout || options.doctor ? configWithSafeCliScoutSurfaces() : undefined;
  const stateDir = options.stateDir ?? CHUCK_V2_STATE_DIR;
  const proofHistory = loadRunnerSurfaceProofs({ stateDir });
  const baseAdapters = options.liveScout
    ? options.includeProvisional
      ? defaultRunnerAdapters()
      : defaultPromotedRunnerAdapters(proofHistory)
    : [createOllamaRunnerAdapter({ model: options.ollamaModel })];
  const cooldownSurfaces: string[] = [];
  const adapters =
    options.liveScout && options.onlySurfaces.length === 0
      ? baseAdapters.filter((adapter) => {
          const coolingDown = isSurfaceCoolingDown(proofHistory[adapter.surface]);
          if (coolingDown) {
            cooldownSurfaces.push(adapter.surface);
          }
          return !coolingDown;
        })
      : baseAdapters;
  const adapterSurfaces = new Set(adapters.map((adapter) => adapter.surface));
  const selectedSurfaces = new Set(options.onlySurfaces);
  const executableSurfaces = filterExecutableSurfaces({ adapterSurfaces, selectedSurfaces });
  const executionConfig = options.liveScout
    ? filterChuckConfigBySurfaces(runtimeConfig ?? DEFAULT_CHUCK_CONFIG, executableSurfaces)
    : options.localScout
      ? filterChuckConfigBySurfaces(DEFAULT_CHUCK_CONFIG, new Set(["ollama/localhost"]))
      : runtimeConfig;
  if (options.listDocket) {
    const rows = await readDocketItems({ stateDir: options.stateDir, limit: 20 });
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("Chuck docket is empty.");
      return;
    }
    for (const item of rows) {
      console.log(`${item.createdAt}  ${item.status.padEnd(18)} ${item.runId}  ${item.title}`);
    }
    return;
  }

  if (options.capabilityLedger) {
    const ledger = chuckV2.buildCapabilityLedgerForState({ stateDir });
    const text = chuckV2.formatCapabilityLedgerReport(ledger);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, text, ledger, summary: ledger.summary }, null, 2));
      return;
    }
    console.log(text);
    return;
  }

  if (options.surfaceAtlas) {
    const summary = chuckV2.surfaceAtlasSummary();
    const ledger = chuckV2.buildCapabilityLedgerForState({ stateDir });
    const text = chuckV2.formatSurfaceAtlasReport(summary, {
      surface: options.surfaceAtlasSurface,
      ledger,
    });
    if (options.json) {
      console.log(
        JSON.stringify({ ok: true, text, summary, capabilityLedger: ledger.summary }, null, 2),
      );
      return;
    }
    console.log(text);
    return;
  }

  if (options.doctor) {
    const health = options.healthFile
      ? await readWorkerHealthSnapshot(options.healthFile)
      : options.probe
        ? await runWorkerProbe(runtimeConfig)
        : undefined;
    const doctorStateDir = options.stateDir ?? CHUCK_V2_STATE_DIR;
    const report = runModelDoctor({
      config: runtimeConfig,
      stateDir: options.stateDir,
      health,
      executionProofs: loadRunnerSurfaceProofs({ stateDir: doctorStateDir }),
    });
    const capabilityLedger = chuckV2.buildCapabilityLedgerForState({
      stateDir: doctorStateDir,
      config: runtimeConfig,
      generatedAt: report.generatedAt,
    });
    const docketItems = docketItemsForModelDoctor(report);
    const persisted = options.persist
      ? await persistDoctor({ report, docketItems, stateDir: options.stateDir })
      : null;
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ...modelDoctorSummary(report),
            capabilityLedgerSummary: capabilityLedger.summary,
            readinessBoard: capabilityLedger.entries.slice(0, 18),
            persisted,
          },
          null,
          2,
        ),
      );
      return;
    }
    printDoctor(report, capabilityLedger);
    if (persisted) {
      console.log(`doctorPath: ${persisted.doctorPath}`);
      console.log(`docketPath: ${persisted.docketPath}`);
    }
    return;
  }

  if (options.repoHygiene) {
    if (options.repoHygieneCheckpoint) {
      const checkpoint = await chuckV2.createRepoHygieneCheckpoint({
        repoRoot: process.cwd(),
        stateDir,
      });
      if (options.json) {
        console.log(
          JSON.stringify(
            { ok: true, text: chuckV2.formatRepoHygieneCheckpoint(checkpoint), checkpoint },
            null,
            2,
          ),
        );
        return;
      }
      console.log(chuckV2.formatRepoHygieneCheckpoint(checkpoint));
      return;
    }
    const report = await chuckV2.inspectRepoHygiene({ repoRoot: process.cwd() });
    const plan = chuckV2.planRepoHygiene(report);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: report.available,
            text: `${chuckV2.formatRepoHygieneReport(report)}\n\n${chuckV2.formatRepoHygienePlan(plan)}`,
            report,
            plan,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(chuckV2.formatRepoHygieneReport(report));
    console.log("");
    console.log(chuckV2.formatRepoHygienePlan(plan));
    return;
  }

  if (options.githubHygiene) {
    if (options.githubHygieneCheckpoint) {
      const checkpoint = await chuckV2.createGitHubHygieneCheckpoint({
        repoRoot: process.cwd(),
        stateDir,
      });
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: checkpoint.report.available,
              text: chuckV2.formatGitHubHygieneCheckpoint(checkpoint),
              checkpoint,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(chuckV2.formatGitHubHygieneCheckpoint(checkpoint));
      return;
    }
    const report = await chuckV2.inspectGitHubHygiene({ repoRoot: process.cwd(), fetch: false });
    if (options.json) {
      console.log(
        JSON.stringify(
          { ok: report.available, text: chuckV2.formatGitHubHygieneReport(report), report },
          null,
          2,
        ),
      );
      return;
    }
    console.log(chuckV2.formatGitHubHygieneReport(report));
    return;
  }

  if (options.upstreamSync) {
    if (options.upstreamSyncCheckpoint) {
      const checkpoint = await chuckV2.createUpstreamSyncCheckpoint({
        repoRoot: process.cwd(),
        stateDir,
      });
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: checkpoint.report.available,
              text: chuckV2.formatUpstreamSyncCheckpoint(checkpoint),
              checkpoint,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(chuckV2.formatUpstreamSyncCheckpoint(checkpoint));
      return;
    }
    const report = await chuckV2.inspectUpstreamSync({ repoRoot: process.cwd(), fetch: false });
    if (options.json) {
      console.log(
        JSON.stringify(
          { ok: report.available, text: chuckV2.formatUpstreamSyncReport(report), report },
          null,
          2,
        ),
      );
      return;
    }
    console.log(chuckV2.formatUpstreamSyncReport(report));
    return;
  }

  if (options.onboard) {
    if (options.onboardCandidate) {
      if (!options.onboardCandidateFamily || !options.onboardCandidateSurface) {
        printUsage();
        process.exitCode = 2;
        return;
      }
      const { formatCandidateOnboardingRecord, runCandidateOnboarding } =
        await import("../src/chuck-v2/index.js");
      const record = await runCandidateOnboarding({
        stateDir,
        familyOrProduct: options.onboardCandidateFamily,
        surface: options.onboardCandidateSurface,
        persist: true,
      });
      const text = formatCandidateOnboardingRecord(record);
      if (options.json) {
        console.log(JSON.stringify({ ok: true, text, record }, null, 2));
        return;
      }
      console.log(text);
      return;
    }
    if (options.onboardMemberFamily && options.onboardMemberSurface) {
      const { formatCandidateOnboardingRecord, runCandidateOnboarding } =
        await import("../src/chuck-v2/index.js");
      const record = await runCandidateOnboarding({
        stateDir,
        familyOrProduct: options.onboardMemberFamily,
        surface: options.onboardMemberSurface,
        persist: true,
      });
      const text = formatCandidateOnboardingRecord(record);
      if (options.json) {
        console.log(JSON.stringify({ ok: true, text, record }, null, 2));
        return;
      }
      console.log(text);
      return;
    }
    if (options.onboardProveSurface) {
      const result = await handleChuckOpenClawCommand(
        {
          args: `onboard prove ${options.onboardProveSurface}`,
          channel: "dashboard",
          commandBody: `/chuck onboard prove ${options.onboardProveSurface}`,
          config: {},
          isAuthorizedSender: true,
          requestConversationBinding: async () => ({
            status: "error",
            message: "dashboard onboarding does not bind conversations",
          }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        },
        { stateDir },
      );
      if (options.json) {
        console.log(JSON.stringify({ ok: true, text: result.text }, null, 2));
        return;
      }
      console.log(result.text);
      return;
    }
    const { formatOnboardingReport, runChuckOnboarding } = await import("../src/chuck-v2/index.js");
    const report = await runChuckOnboarding({ stateDir, repair: options.onboardRepair });
    const text = formatOnboardingReport(report);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, text, report }, null, 2));
      return;
    }
    console.log(text);
    return;
  }

  if (options.buildPlan) {
    if (!options.prompt.trim()) {
      printUsage();
      process.exitCode = 2;
      return;
    }
    const result = await handleChuckOpenClawCommand({
      args: `build ${options.prompt}`,
      channel: "dashboard",
      commandBody: `/chuck build ${options.prompt}`,
      config: {},
      isAuthorizedSender: true,
      requestConversationBinding: async () => ({
        status: "error",
        message: "dashboard builder does not bind conversations",
      }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });
    if (options.json) {
      const run = await import("../src/chuck-v2/index.js").then((module) =>
        module.readBuilderStatus({ stateDir }),
      );
      console.log(JSON.stringify({ ok: true, text: result.text, run }, null, 2));
      return;
    }
    console.log(result.text);
    return;
  }

  if (options.buildPatchFile) {
    if (!options.prompt.trim() || !options.patchFile) {
      printUsage();
      process.exitCode = 2;
      return;
    }
    const targetArgs = options.targetFiles.map((target) => ` --target ${target}`).join("");
    const result = await handleChuckOpenClawCommand({
      args: `build ${options.prompt} --patch-file ${options.patchFile}${targetArgs}`,
      channel: "dashboard",
      commandBody: `/chuck build ${options.prompt} --patch-file ${options.patchFile}${targetArgs}`,
      config: {},
      isAuthorizedSender: true,
      requestConversationBinding: async () => ({
        status: "error",
        message: "dashboard builder does not bind conversations",
      }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });
    if (options.json) {
      const run = await import("../src/chuck-v2/index.js").then((module) =>
        module.readBuilderStatus({ stateDir }),
      );
      console.log(JSON.stringify({ ok: true, text: result.text, run }, null, 2));
      return;
    }
    console.log(result.text);
    return;
  }

  if (options.buildGeneratePatch) {
    if (!options.prompt.trim()) {
      printUsage();
      process.exitCode = 2;
      return;
    }
    const targetArgs = options.targetFiles.map((target) => ` --target ${target}`).join("");
    const result = await handleChuckOpenClawCommand({
      args: `build ${options.prompt} --generate-patch${targetArgs}`,
      channel: "dashboard",
      commandBody: `/chuck build ${options.prompt} --generate-patch${targetArgs}`,
      config: {},
      isAuthorizedSender: true,
      requestConversationBinding: async () => ({
        status: "error",
        message: "dashboard builder does not bind conversations",
      }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });
    if (options.json) {
      const run = await import("../src/chuck-v2/index.js").then((module) =>
        module.readBuilderStatus({ stateDir }),
      );
      console.log(JSON.stringify({ ok: true, text: result.text, run }, null, 2));
      return;
    }
    console.log(result.text);
    return;
  }

  if (!options.prompt.trim()) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const localServer =
    options.liveScout || options.localScout
      ? await ensureOllamaServerForRun(executableSurfaces)
      : undefined;
  const health = options.healthFile
    ? await readWorkerHealthSnapshot(options.healthFile)
    : options.probe || options.liveScout
      ? await runWorkerProbe(executionConfig)
      : undefined;
  const result = await runChuckLoop({
    requestText: options.prompt,
    mode: options.mode,
    config: executionConfig,
    health,
  });
  const runnerExecution =
    options.liveScout || options.localScout
      ? await executeFleetDispatchPlan({
          dispatchPlan: {
            ...result.dispatchPlan,
            tasks: options.liveScout
              ? result.dispatchPlan.tasks.filter(
                  (task) =>
                    adapterSurfaces.has(task.surface) &&
                    (selectedSurfaces.size === 0 || selectedSurfaces.has(task.surface)),
                )
              : result.dispatchPlan.tasks.filter((task) => task.surface === "ollama/localhost"),
          },
          adapters,
          signingSecret: "chuck-v2-cli-local-runner-secret",
          transcriptDir: options.persist ? join(stateDir, "transcripts", result.runId) : undefined,
        })
      : undefined;
  const scoutResolve = runnerExecution ? resolveFleetScout(runnerExecution) : undefined;
  const deepenPlan =
    options.liveScout && options.autoDeepen && scoutResolve
      ? createFleetDeepenDispatchPlan({
          scoutPlan: result.dispatchPlan,
          scoutResolve,
          requestText: options.prompt,
        })
      : undefined;
  const deepenExecution = deepenPlan
    ? await executeFleetDispatchPlan({
        dispatchPlan: deepenPlan,
        adapters,
        signingSecret: "chuck-v2-cli-local-runner-secret",
        transcriptDir: options.persist ? join(stateDir, "transcripts", result.runId) : undefined,
      })
    : undefined;
  const deepenResolve = deepenExecution ? resolveFleetScout(deepenExecution) : undefined;
  const persisted = options.persist
    ? await persistChuckLoopResult(result, { stateDir })
    : undefined;
  const persistedRunnerExecution =
    options.persist && runnerExecution
      ? await persistRunnerExecutionArtifacts({
          stateDir,
          execution: runnerExecution,
          scoutResolve,
          occurredAt: result.createdAt,
          stage: "scout",
        })
      : undefined;
  const persistedDeepenExecution =
    options.persist && deepenExecution
      ? await persistRunnerExecutionArtifacts({
          stateDir,
          execution: deepenExecution,
          scoutResolve: deepenResolve,
          occurredAt: result.createdAt,
          stage: "deepen",
        })
      : undefined;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...summarizeChuckLoopResult(result),
          runnerExecution,
          scoutResolve,
          deepenPlan,
          deepenExecution,
          deepenResolve,
          cooldownSurfaces,
          persisted,
          persistedRunnerExecution,
          persistedDeepenExecution,
        },
        null,
        2,
      ),
    );
    await localServer?.stop();
    return;
  }

  const summary = summarizeChuckLoopResult(result);
  console.log(`Chuck run: ${displayScalar(summary.runId)}`);
  console.log(`mode: ${displayScalar(summary.mode)}`);
  console.log(`stake: ${displayScalar(summary.stakeClass)} / ${displayScalar(summary.taskClass)}`);
  console.log(`disposition: ${displayScalar(summary.disposition)}`);
  console.log(`finalAction: ${displayScalar(summary.finalAction)}`);
  console.log(`docket: ${displayScalar(summary.docketStatus)}`);
  console.log(`dispatch: ${displayScalar(summary.dispatchTaskCount, "0")} task(s)`);
  if (cooldownSurfaces.length > 0) {
    console.log(`cooldownSkipped: ${cooldownSurfaces.join(", ")}`);
  }
  console.log(`trace: ${displayScalar(summary.traceId)} (${displayScalar(summary.traceGrade)})`);
  if (typeof summary.protocol === "string") {
    console.log(`protocol: ${summary.protocol}`);
  }
  if (runnerExecution) {
    console.log(`runnerReceipts: ${runnerExecution.receipts.length}`);
    for (const execution of runnerExecution.executions) {
      console.log(`- ${execution.surface}: ${execution.status}`);
      if (execution.status !== "completed") {
        console.log(`  reason: ${execution.reason}`);
      }
    }
  }
  if (scoutResolve) {
    console.log(`scoutResolve: ${scoutResolve.disposition}`);
    console.log(`usableSurfaces: ${scoutResolve.usableSurfaces.length}`);
    console.log(`usableFamilies: ${scoutResolve.independentUsableFamilyCount}`);
    if (scoutResolve.deepenNeededSurfaces.length > 0) {
      console.log(`deepenNeeded: ${scoutResolve.deepenNeededSurfaces.join(", ")}`);
    }
  }
  if (deepenExecution) {
    console.log(`deepenReceipts: ${deepenExecution.receipts.length}`);
    for (const execution of deepenExecution.executions) {
      console.log(`- ${execution.surface}: ${execution.status}`);
      if (execution.status !== "completed") {
        console.log(`  reason: ${execution.reason}`);
      }
    }
  }
  if (deepenResolve) {
    console.log(`deepenResolve: ${deepenResolve.disposition}`);
    console.log(`deepenUsableSurfaces: ${deepenResolve.usableSurfaces.length}`);
    console.log(`deepenUsableFamilies: ${deepenResolve.independentUsableFamilyCount}`);
  }
  if (typeof summary.decisionRecordId === "string") {
    console.log(`decisionRecord: ${summary.decisionRecordId}`);
  }
  if (persisted) {
    console.log(`runPath: ${persisted.runPath}`);
    if (persisted.decisionRecordPath) {
      console.log(`decisionRecordPath: ${persisted.decisionRecordPath}`);
    }
    console.log(`traceDbPath: ${persisted.traceDbPath}`);
    console.log(`traceId: ${persisted.traceId}`);
    console.log(`docketPath: ${persisted.docketPath}`);
    console.log(`eventsPath: ${persisted.eventsPath}`);
  }
  if (persistedRunnerExecution) {
    console.log(`runnerExecutionPath: ${persistedRunnerExecution.executionPath}`);
    console.log(`runnerEventsPath: ${persistedRunnerExecution.eventsPath}`);
  }
  if (persistedDeepenExecution) {
    console.log(`deepenExecutionPath: ${persistedDeepenExecution.executionPath}`);
    console.log(`deepenEventsPath: ${persistedDeepenExecution.eventsPath}`);
  }
  const reasons = stringArray(summary.reasons);
  if (reasons.length > 0) {
    console.log("reasons:");
    for (const reason of reasons) {
      console.log(`- ${reason}`);
    }
  }
  await localServer?.stop();
}

function displayScalar(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = displayScalar(item, "");
        return text ? [text] : [];
      })
    : [];
}

function parseArgs(args: string[]): CliOptions {
  const prompt: string[] = [];
  const options: CliOptions = {
    mode: "preflight",
    json: false,
    persist: true,
    prompt: "",
    listDocket: false,
    surfaceAtlas: false,
    capabilityLedger: false,
    doctor: false,
    repoHygiene: false,
    repoHygieneCheckpoint: false,
    githubHygiene: false,
    githubHygieneCheckpoint: false,
    upstreamSync: false,
    upstreamSyncCheckpoint: false,
    onboard: false,
    onboardRepair: false,
    onboardCandidate: false,
    buildPlan: false,
    buildGeneratePatch: false,
    buildPatchFile: false,
    targetFiles: [],
    probe: false,
    localScout: false,
    liveScout: false,
    includeProvisional: false,
    autoDeepen: true,
    onlySurfaces: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--demo-fleet") {
      options.mode = "demo-fleet";
    } else if (arg === "--mode") {
      const value = args[++i];
      if (value !== "preflight" && value !== "demo-fleet") {
        throw new Error(`unsupported --mode ${value}`);
      }
      options.mode = value;
    } else if (arg === "--state-dir") {
      options.stateDir = args[++i];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-persist") {
      options.persist = false;
    } else if (arg === "--docket") {
      options.listDocket = true;
    } else if (arg === "--surface-atlas" || arg === "--atlas" || arg === "--surfaces") {
      options.surfaceAtlas = true;
    } else if (arg === "--surface-atlas-surface" || arg === "--atlas-surface") {
      options.surfaceAtlas = true;
      options.surfaceAtlasSurface = args[++i];
    } else if (arg === "--capability-ledger" || arg === "--readiness-board") {
      options.capabilityLedger = true;
    } else if (arg === "--doctor") {
      options.doctor = true;
    } else if (arg === "--repo-hygiene" || arg === "--hygiene") {
      options.repoHygiene = true;
    } else if (arg === "--repo-hygiene-checkpoint" || arg === "--hygiene-checkpoint") {
      options.repoHygiene = true;
      options.repoHygieneCheckpoint = true;
    } else if (arg === "--github-hygiene" || arg === "--remote-hygiene") {
      options.githubHygiene = true;
    } else if (arg === "--github-hygiene-checkpoint" || arg === "--remote-hygiene-checkpoint") {
      options.githubHygiene = true;
      options.githubHygieneCheckpoint = true;
    } else if (arg === "--upstream-sync" || arg === "--upstream" || arg === "--updates") {
      options.upstreamSync = true;
    } else if (arg === "--upstream-sync-checkpoint" || arg === "--upstream-checkpoint") {
      options.upstreamSync = true;
      options.upstreamSyncCheckpoint = true;
    } else if (arg === "--onboard") {
      options.onboard = true;
    } else if (arg === "--onboard-repair") {
      options.onboard = true;
      options.onboardRepair = true;
    } else if (arg === "--onboard-candidate") {
      options.onboard = true;
      options.onboardCandidate = true;
      options.onboardCandidateFamily = args[++i];
      options.onboardCandidateSurface = args[++i];
    } else if (arg === "--onboard-member") {
      options.onboard = true;
      options.onboardMemberFamily = args[++i];
      options.onboardMemberSurface = args[++i];
    } else if (arg === "--onboard-prove") {
      options.onboard = true;
      options.onboardProveSurface = args[++i];
    } else if (arg === "--build-plan") {
      options.buildPlan = true;
    } else if (arg === "--build-generate-patch") {
      options.buildGeneratePatch = true;
    } else if (arg === "--build-patch-file") {
      options.buildPatchFile = true;
    } else if (arg === "--patch-file") {
      options.patchFile = args[++i];
    } else if (arg === "--target") {
      options.targetFiles.push(
        ...(args[++i] ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    } else if (arg === "--health-file") {
      options.healthFile = args[++i];
    } else if (arg === "--probe") {
      options.probe = true;
    } else if (arg === "--local-scout") {
      options.localScout = true;
    } else if (arg === "--live-scout") {
      options.liveScout = true;
    } else if (arg === "--include-provisional") {
      options.includeProvisional = true;
    } else if (arg === "--no-auto-deepen") {
      options.autoDeepen = false;
    } else if (arg === "--only-surface" || arg === "--only-surfaces") {
      options.onlySurfaces = (args[++i] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--ollama-model") {
      options.ollamaModel = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      prompt.push(arg);
    }
  }
  options.prompt = prompt.join(" ");
  return options;
}

function filterExecutableSurfaces({
  adapterSurfaces,
  selectedSurfaces,
}: {
  adapterSurfaces: Set<string>;
  selectedSurfaces: Set<string>;
}): Set<string> {
  if (selectedSurfaces.size === 0) {
    return new Set(adapterSurfaces);
  }
  return new Set([...adapterSurfaces].filter((surface) => selectedSurfaces.has(surface)));
}

function filterChuckConfigBySurfaces(config: ChuckConfig, surfaces: Set<string>): ChuckConfig {
  return {
    ...config,
    fleet: config.fleet.filter((entry) => surfaces.has(entry.surface)),
  };
}

function defaultPromotedRunnerAdapters(proofHistory: Record<string, RunnerSurfaceProof>) {
  const loadBearingSurfaces = new Set(
    defaultLoadBearingRunnerAdapters().map((adapter) => adapter.surface),
  );
  return defaultRunnerAdapters().filter(
    (adapter) =>
      loadBearingSurfaces.has(adapter.surface) || proofHistory[adapter.surface]?.repeatable,
  );
}

function isSurfaceCoolingDown(proof?: RunnerSurfaceProof, now = new Date()): boolean {
  if (!proof || proof.latestStatus !== "failed") {
    return false;
  }
  const failureAtMs = Date.parse(proof.lastFailureAt ?? "");
  if (!Number.isFinite(failureAtMs)) {
    return true;
  }
  const cooldownMs = 30 * 60 * 1000;
  return now.getTime() - failureAtMs < cooldownMs;
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
  process.once("exit", () => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  });
  for (let i = 0; i < 20; i += 1) {
    if (await isOllamaReady()) {
      return {
        stop: () => stopChild(child),
      };
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

async function runWorkerProbe(config?: ChuckConfig): Promise<WorkerHealthSnapshot> {
  const scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "worker-probe.mjs",
  );
  const workers: WorkerHealthSnapshot["workers"] = {};
  for (const workerName of workerProbeNamesForConfig(config)) {
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [scriptPath, "--json", "--only", workerName],
        {
          cwd: process.cwd(),
          maxBuffer: 2 * 1024 * 1024,
          timeout: 60_000,
        },
      );
      Object.assign(workers, JSON.parse(stdout) as WorkerHealthSnapshot["workers"]);
    } catch (error) {
      workers[workerName] = {
        worker: workerName,
        healthy: false,
        details: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return {
    updatedAt: new Date().toISOString(),
    workers,
  };
}

async function readWorkerHealthSnapshot(path: string): Promise<WorkerHealthSnapshot> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (isWorkerHealthSnapshot(parsed)) {
    return parsed;
  }
  return {
    updatedAt: new Date().toISOString(),
    workers: parsed as WorkerHealthSnapshot["workers"],
  };
}

function isWorkerHealthSnapshot(value: unknown): value is WorkerHealthSnapshot {
  return Boolean(value && typeof value === "object" && "workers" in value);
}

async function persistDoctor({
  report,
  docketItems,
  stateDir = report.stateDir,
}: {
  report: ReturnType<typeof runModelDoctor>;
  docketItems: ReturnType<typeof docketItemsForModelDoctor>;
  stateDir?: string;
}): Promise<{ doctorPath: string; docketPath: string; eventsPath: string }> {
  const doctorDir = join(stateDir, "model-doctor");
  await mkdir(doctorDir, { recursive: true });
  const stamp = report.generatedAt.replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const doctorPath = join(doctorDir, `${stamp}.json`);
  const docketPath = join(stateDir, "docket.jsonl");
  const eventsPath = join(stateDir, "events.jsonl");
  await writeFile(doctorPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (docketItems.length > 0) {
    await appendFile(
      docketPath,
      docketItems.map((item) => `${JSON.stringify(item)}\n`).join(""),
      "utf8",
    );
  }
  await appendFile(
    eventsPath,
    appendChuckEventLine(
      createChuckEvent({
        type: "model.doctor",
        occurredAt: report.generatedAt,
        eventId: `evt-model-doctor-${stamp}`,
        payload: modelDoctorSummary(report),
      }),
    ),
    "utf8",
  );
  return { doctorPath, docketPath, eventsPath };
}

async function persistRunnerExecutionArtifacts({
  stateDir,
  execution,
  scoutResolve,
  occurredAt,
  stage = "scout",
}: {
  stateDir: string;
  execution: Awaited<ReturnType<typeof executeFleetDispatchPlan>>;
  scoutResolve?: FleetScoutResolve;
  occurredAt: string;
  stage?: "scout" | "deepen";
}): Promise<{ executionPath: string; eventsPath: string }> {
  const persisted = await persistFleetDispatchExecution({ stateDir, execution });
  const eventsPath = join(stateDir, "events.jsonl");
  if (execution.receipts.length > 0) {
    await appendFile(
      eventsPath,
      execution.receipts
        .map((receipt, index) =>
          appendChuckEventLine(
            createChuckEvent({
              eventId: `${execution.runId}:${stage}:runner-receipt:${index}`,
              type: "runner.receipt",
              occurredAt,
              runId: execution.runId,
              payload: {
                stage,
                dispatchId: execution.dispatchId,
                family: receipt.actualFamily,
                surface: receipt.surface,
                actualRunner: receipt.actualRunner,
                modelClaimed: receipt.modelClaimed,
                modelVerified: receipt.modelVerified,
                transcriptPath: receipt.transcriptPath,
                transcriptSha256: receipt.transcriptSha256,
              },
            }),
          ),
        )
        .join(""),
      "utf8",
    );
  }
  if (scoutResolve) {
    await appendFile(
      eventsPath,
      appendChuckEventLine(
        createChuckEvent({
          eventId: `${execution.runId}:${stage}-resolve`,
          type: stage === "deepen" ? "fleet.deepen.resolve" : "fleet.scout.resolve",
          occurredAt,
          runId: execution.runId,
          payload: {
            stage,
            dispatchId: execution.dispatchId,
            disposition: scoutResolve.disposition,
            usableSurfaces: scoutResolve.usableSurfaces,
            usableFamilies: scoutResolve.usableFamilies,
            independentUsableFamilyCount: scoutResolve.independentUsableFamilyCount,
            deepenNeededSurfaces: scoutResolve.deepenNeededSurfaces,
            failedSurfaces: scoutResolve.failedSurfaces,
            skippedSurfaces: scoutResolve.skippedSurfaces,
            dissentRetained: scoutResolve.dissentRetained,
            normalizedClaimCount: scoutResolve.normalizedClaims.length,
          },
        }),
      ),
      "utf8",
    );
  }
  return { ...persisted, eventsPath };
}

function printDoctor(
  report: ReturnType<typeof runModelDoctor>,
  ledger?: chuckV2.CapabilityLedger,
): void {
  console.log("Chuck model doctor");
  console.log(`configured voices: ${report.configuredVoices}`);
  console.log(`configured families: ${report.configuredFamilies.join(", ")}`);
  console.log(`ready families: ${report.readyFamilies.join(", ") || "none"}`);
  console.log(`unknown families: ${report.unknownFamilies.join(", ") || "none"}`);
  console.log(`blocked families: ${report.blockedFamilies.join(", ") || "none"}`);
  console.log(`load-bearing families: ${report.executionReadyFamilies.join(", ") || "none"}`);
  console.log(`minimum fleet ready: ${report.canRunMinimumFleet ? "yes" : "no"}`);
  console.log(`high-risk fleet ready: ${report.canRunHighRiskFleet ? "yes" : "no"}`);
  console.log(`load-bearing minimum ready: ${report.canRunLoadBearingMinimumFleet ? "yes" : "no"}`);
  console.log(
    `load-bearing high-risk ready: ${report.canRunLoadBearingHighRiskFleet ? "yes" : "no"}`,
  );
  if (ledger) {
    console.log(
      `kernel-ready families: ${ledger.summary.independentLoadBearingFamilies.join(", ") || "none"}`,
    );
    console.log(`load-bearing surfaces: ${ledger.summary.loadBearingSurfaces}`);
  }
  for (const row of report.rows) {
    console.log("");
    console.log(`${row.status.toUpperCase()}  ${row.family}  ${row.surface}`);
    console.log(`voice: ${row.voice}`);
    console.log(`health: ${row.healthReason}`);
    console.log(`execution: ${row.executionStatus} (${row.executionReason})`);
    console.log(`probe: ${row.guide.preferredProbe}`);
    console.log(`window: ${row.guide.windowPolicy}`);
    console.log(`next: ${row.nextAction}`);
  }
}

function printUsage(): void {
  console.log(`Usage:
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts "evaluate this architecture spec"
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --demo-fleet "evaluate this architecture spec"
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --docket
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --surface-atlas
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --surface-atlas --surface-atlas-surface perplexity/mac-app
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --capability-ledger
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --doctor
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --repo-hygiene
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --repo-hygiene-checkpoint
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --github-hygiene
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --github-hygiene-checkpoint
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --upstream-sync
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --upstream-sync-checkpoint
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --onboard
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --onboard-prove codex/exec
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --onboard-member openai chatgpt/mac-app
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --onboard-candidate mistral mistral/le-chat
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --build-plan "add builder status"
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --build-generate-patch "add builder status"
  node --import tsx extensions/memory-graph/scripts/chuck-v2-run.ts --build-patch-file --patch-file /tmp/candidate.patch "apply safe builder patch"

Options:
  --demo-fleet       Exercise the full DecisionRecord path with explicit shadow receipts. No model is called.
  --mode <mode>      preflight | demo-fleet
  --state-dir <dir>  Override state directory.
  --json             Print JSON summary.
  --no-persist       Do not write run, docket, or event files.
  --local-scout      Execute only the local Ollama dispatch task after planning.
  --live-scout       Execute load-bearing safe CLI/local adapters after planning.
  --include-provisional
                     With --live-scout, also execute provisional app/web adapters such as Perplexity/Grok.
  --no-auto-deepen   With --live-scout, stop after Scout even when Resolve requests Deepen.
  --only-surface     With --live-scout, execute only the listed comma-separated surfaces.
  --ollama-model     Override CHUCK_OLLAMA_MODEL for --local-scout.
  --docket           List recent docket items.
  --surface-atlas    Print the durable surface controls, abilities, tool routes, leases, and mastery gaps.
  --surface-atlas-surface
                     Limit --surface-atlas to one surface id.
  --capability-ledger
                     Print the Kernel-derived Fleet Readiness Board.
  --doctor           Inspect configured model surfaces and create setup/proof Docket items.
  --repo-hygiene     Classify git dirt and report self-build cleanliness gates.
  --repo-hygiene-checkpoint
                     Freeze status, diffs, untracked manifest, and cleanup plan under Chuck state.
  --github-hygiene  Classify fork branch sprawl and remote cleanup gates.
  --github-hygiene-checkpoint
                     Freeze fork/upstream branch manifests and review-only cleanup plan under Chuck state.
  --upstream-sync   Report OpenClaw release drift and safe-sync gates.
  --upstream-sync-checkpoint
                     Fetch tags and freeze a review-only upstream sync plan under Chuck state.
  --onboard          Inspect complete Chuck onboarding readiness.
  --onboard-repair   Persist onboarding report and setup docket items.
  --onboard-prove <surface>
                     Run one harmless signed receipt proof for a configured surface.
  --onboard-member <family> <surface>
                     Register a child/cousin surface inside an existing family.
  --onboard-candidate <family-or-product> <surface>
                     Register a provisional future model/product surface with proof gates.
  --build-plan       Start a governed no-patch BuilderRun from a dashboard/OpenClaw objective.
  --build-generate-patch
                     Ask Fleet for a patch candidate, then run governed Builder verification.
  --build-patch-file Start a governed BuilderRun from a local patch file.
  --patch-file       Local patch file for --build-patch-file.
  --target           Optional comma-separated target files for --build-patch-file.
  --probe            With --doctor, run worker-probe.mjs directly before reporting.
  --health-file      Worker health JSON from worker-probe.mjs; raw worker map or {workers}.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
