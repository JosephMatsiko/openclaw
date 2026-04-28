import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SurfaceExtractionMethod, SurfaceProofRecord } from "./capability-ledger.js";
import { signRunnerReceipt } from "./receipt.js";
import type { FleetDispatchPlan, FleetDispatchTask } from "./runner-dispatch.js";
import type { RunnerReceipt } from "./types.js";

export type RunnerAdapterOutput = {
  text: string;
  actualRunner: string;
  actualFamily: FleetDispatchTask["family"];
  modelClaimed: string;
  modelVerified: boolean;
  authProfileId?: string;
  calibration?: RunnerOutputCalibration;
  promptDeliveryProof?: SurfaceProofRecord;
  answerAttributionProof?: SurfaceProofRecord;
  extractionMethod?: SurfaceExtractionMethod;
};

export type RunnerOutputCalibrationVerdict = "usable" | "degraded" | "failed";

export type RunnerOutputCalibration = {
  verdict: RunnerOutputCalibrationVerdict;
  reasons: string[];
  roleplayDriftDetected: boolean;
  formatCompliant: boolean;
};

export type RunnerAdapter = {
  adapterId: string;
  family: FleetDispatchTask["family"];
  surface: string;
  run(task: FleetDispatchTask): Promise<RunnerAdapterOutput>;
};

export type FleetDispatchTaskExecution =
  | {
      taskId: string;
      family: FleetDispatchTask["family"];
      surface: string;
      status: "completed";
      receipt: RunnerReceipt;
      text: string;
      calibration: RunnerOutputCalibration;
      promptDeliveryProof: SurfaceProofRecord;
      answerAttributionProof: SurfaceProofRecord;
      extractionMethod: SurfaceExtractionMethod;
      countingEligible: boolean;
    }
  | {
      taskId: string;
      family: FleetDispatchTask["family"];
      surface: string;
      status: "failed" | "skipped";
      reason: string;
    };

export type FleetDispatchExecutionResult = {
  dispatchId: string;
  runId: string;
  receipts: RunnerReceipt[];
  executions: FleetDispatchTaskExecution[];
};

export async function executeFleetDispatchPlan({
  dispatchPlan,
  adapters,
  signingSecret,
  transcriptDir,
  now = () => new Date().toISOString(),
}: {
  dispatchPlan: FleetDispatchPlan;
  adapters: RunnerAdapter[];
  signingSecret: string;
  transcriptDir?: string;
  now?: () => string;
}): Promise<FleetDispatchExecutionResult> {
  const receipts: RunnerReceipt[] = [];
  const executions: FleetDispatchTaskExecution[] = [];
  if (transcriptDir) {
    await mkdir(transcriptDir, { recursive: true });
  }
  const execute = (task: FleetDispatchTask) =>
    executeFleetDispatchTask({
      task,
      adapters,
      signingSecret,
      transcriptDir,
      now,
    });
  const results =
    dispatchPlan.schedulingMode === "parallel"
      ? await runParallelWithExclusiveSurfaces(dispatchPlan.tasks, execute)
      : await runStaggered(dispatchPlan.tasks, execute);
  for (const result of results) {
    executions.push(result.execution);
    if (result.receipt) {
      receipts.push(result.receipt);
    }
  }
  return {
    dispatchId: dispatchPlan.dispatchId,
    runId: dispatchPlan.runId,
    receipts,
    executions,
  };
}

async function executeFleetDispatchTask({
  task,
  adapters,
  signingSecret,
  transcriptDir,
  now,
}: {
  task: FleetDispatchTask;
  adapters: RunnerAdapter[];
  signingSecret: string;
  transcriptDir?: string;
  now: () => string;
}): Promise<{ execution: FleetDispatchTaskExecution; receipt?: RunnerReceipt }> {
  const adapter = adapters.find(
    (candidate) => candidate.family === task.family && candidate.surface === task.surface,
  );
  if (!adapter) {
    return {
      execution: {
        taskId: task.taskId,
        family: task.family,
        surface: task.surface,
        status: "skipped",
        reason: "no runner adapter registered for surface",
      },
    };
  }
  const startedAt = now();
  try {
    const output = await adapter.run(task);
    const endedAt = now();
    const calibration =
      output.calibration ??
      calibrateRunnerOutput({
        family: output.actualFamily,
        surface: task.surface,
        text: output.text,
        prompt: task.prompt,
      });
    const promptDeliveryProof =
      output.promptDeliveryProof ??
      defaultPromptDeliveryProof({
        task,
        output,
        adapterId: adapter.adapterId,
        checkedAt: endedAt,
      });
    const answerAttributionProof =
      output.answerAttributionProof ??
      defaultAnswerAttributionProof({
        task,
        output,
        calibration,
        adapterId: adapter.adapterId,
        checkedAt: endedAt,
      });
    const extractionMethod = output.extractionMethod ?? defaultExtractionMethod(task.surface);
    const modelVerified =
      output.modelVerified &&
      calibration.verdict === "usable" &&
      promptDeliveryProof.verdict === "proved" &&
      answerAttributionProof.verdict === "proved";
    const transcriptPath = transcriptDir
      ? await writeTranscript({
          transcriptDir,
          task,
          text: output.text,
        })
      : undefined;
    const receipt = signRunnerReceipt({
      declaredVoice: task.voice,
      requestedFamily: task.family,
      actualRunner: output.actualRunner,
      actualFamily: output.actualFamily,
      surface: task.surface,
      layerUsed: `chuck-v2-runner:${adapter.adapterId}`,
      modelClaimed: output.modelClaimed,
      modelVerified,
      authProfileId: output.authProfileId,
      transcriptPath,
      transcriptText: output.text,
      startedAt,
      endedAt,
      signingSecret,
    });
    return {
      receipt,
      execution: {
        taskId: task.taskId,
        family: task.family,
        surface: task.surface,
        status: "completed",
        receipt,
        text: output.text,
        calibration,
        promptDeliveryProof,
        answerAttributionProof,
        extractionMethod,
        countingEligible: modelVerified,
      },
    };
  } catch (error) {
    return {
      execution: {
        taskId: task.taskId,
        family: task.family,
        surface: task.surface,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function runStaggered<T>(
  tasks: FleetDispatchTask[],
  execute: (task: FleetDispatchTask) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const task of tasks) {
    results.push(await execute(task));
  }
  return results;
}

async function runParallelWithExclusiveSurfaces<T>(
  tasks: FleetDispatchTask[],
  execute: (task: FleetDispatchTask) => Promise<T>,
): Promise<T[]> {
  const indexed = tasks.map((task, index) => ({ task, index }));
  const parallelSafe = indexed.filter(({ task }) => !requiresExclusiveGuiLane(task.surface));
  const exclusive = indexed.filter(({ task }) => requiresExclusiveGuiLane(task.surface));
  const results: T[] = [];
  await Promise.all(
    parallelSafe.map(async ({ task, index }) => {
      results[index] = await execute(task);
    }),
  );
  for (const { task, index } of exclusive) {
    results[index] = await execute(task);
  }
  return results;
}

function requiresExclusiveGuiLane(surface: string): boolean {
  return [
    "chatgpt/web-chat",
    "chatgpt/mac-app",
    "claude/web-chat",
    "claude/mac-app",
    "gemini/web-chat",
    "aistudio/web",
    "perplexity/mac-app",
    "perplexity/web",
    "grok/web-or-app",
  ].includes(surface);
}

export function calibrateRunnerOutput({
  family,
  surface,
  text,
  prompt = "",
}: {
  family: FleetDispatchTask["family"];
  surface: string;
  text: string;
  prompt?: string;
}): RunnerOutputCalibration {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const requiredScoutLabels = ["claims:", "risks:", "missing_evidence:", "deepen_needed:"];
  const labelsFound = requiredScoutLabels.filter((label) => lower.includes(label)).length;
  const strictLocalScout = family === "sovereign-local" && surface === "ollama/localhost";
  const literalExactRequested =
    /\b(?:say|reply|return|respond|answer)\s+(?:with\s+)?exactly\b/i.test(prompt);
  const literalProofToken =
    literalExactRequested &&
    /\b(?:SURFACE_PROOF_OK|APEXOK[A-Z0-9]+)\b/.test(trimmed) &&
    trimmed.length <= 240;
  const literalLocalDiagnostic =
    strictLocalScout &&
    literalExactRequested &&
    trimmed.length > 0 &&
    trimmed.length <= 80 &&
    !trimmed.includes("\n");
  const formatCompliant = literalProofToken || literalLocalDiagnostic || labelsFound >= 3;
  const roleplayDriftDetected =
    strictLocalScout &&
    [
      /\basteroid\b/i,
      /\benergy signatures?\b/i,
      /\blight-minutes?\b/i,
      /\bmission log\b/i,
      /\bnavigation hazard\b/i,
      /\bnavigation computer\b/i,
      /\bportside\b/i,
      /\bpropulsion\b/i,
      /\bship\b/i,
      /\bscout path\b/i,
      /\bsensor sweep\b/i,
      /\bspace mission\b/i,
      /\bstarship\b/i,
      /\buncharted\b/i,
    ].some((pattern) => pattern.test(trimmed));
  const reasons: string[] = [];

  if (!trimmed) {
    reasons.push("runner returned empty output");
  }
  if (roleplayDriftDetected) {
    reasons.push("local runner drifted into fictional or roleplay framing");
  }
  if (!formatCompliant) {
    reasons.push("local runner did not follow the required scout structure");
  }

  if (!trimmed) {
    return {
      verdict: "failed",
      reasons,
      roleplayDriftDetected,
      formatCompliant,
    };
  }

  return {
    verdict: reasons.length === 0 ? "usable" : "degraded",
    reasons,
    roleplayDriftDetected,
    formatCompliant,
  };
}

export async function persistFleetDispatchExecution({
  stateDir,
  execution,
}: {
  stateDir: string;
  execution: FleetDispatchExecutionResult;
}): Promise<{ executionPath: string }> {
  const dir = join(stateDir, "runner-executions");
  await mkdir(dir, { recursive: true });
  const executionPath = join(
    dir,
    `${sanitizeFilePart(execution.runId)}-${sanitizeFilePart(execution.dispatchId)}.json`,
  );
  await writeFile(executionPath, `${JSON.stringify(execution, null, 2)}\n`, "utf8");
  return { executionPath };
}

export type MinimalFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export type MinimalFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<MinimalFetchResponse>;

export type OllamaRunnerAdapterOptions = {
  endpoint?: string;
  model?: string;
  fetchImpl?: MinimalFetch;
};

export type CommandRunnerAdapterOptions = {
  command?: string;
  model?: string;
  spawnImpl?: typeof spawn;
  cwd?: string;
};

export function createOllamaRunnerAdapter({
  endpoint = process.env.OLLAMA_HOST ?? "http://localhost:11434",
  model = process.env.CHUCK_OLLAMA_MODEL ?? "qwen3:8b",
  fetchImpl = fetch as unknown as MinimalFetch,
}: OllamaRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "ollama-http-local",
    family: "sovereign-local",
    surface: "ollama/localhost",
    async run(task) {
      const controller = new AbortController();
      const timeoutBudget = computeRunnerTimeoutBudget({
        surface: "ollama/localhost",
        baseTimeoutMs: task.timeoutMs,
        promptChars: task.prompt.length,
        envName: "CHUCK_OLLAMA_TIMEOUT_MS",
      });
      const timer = setTimeout(() => controller.abort(), timeoutBudget.timeoutMs);
      try {
        const response = await fetchImpl(`${endpoint}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: buildOllamaScoutPrompt(task.prompt),
            stream: false,
            think: false,
            keep_alive: "30s",
            options: {
              num_ctx: 2048,
              num_predict: 220,
              temperature: 0,
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "(unreadable)");
          throw new Error(`ollama HTTP ${response.status}: ${text.slice(0, 400)}`);
        }
        const parsed = (await response.json()) as { response?: unknown; model?: unknown };
        const text = typeof parsed.response === "string" ? parsed.response.trim() : "";
        if (!text) {
          throw new Error("ollama HTTP returned empty response field");
        }
        return {
          text,
          actualRunner: "ollama-http-local",
          actualFamily: "sovereign-local",
          modelClaimed: `ollama/${typeof parsed.model === "string" ? parsed.model : model} (local)`,
          modelVerified: true,
          extractionMethod: "http-json",
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`ollama timed out after ${timeoutBudget.timeoutMs}ms`, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function buildOllamaScoutPrompt(prompt: string): string {
  return [
    "You are the local sovereignty scout for Chuck.",
    "This is a technical evaluation pass, not fiction, roleplay, game text, or worldbuilding.",
    "Interpret the word scout as a short independent technical review.",
    "Do not invent spacecraft, mission, navigation, engine, sensor, or environmental details.",
    "If the request is simple or exact, keep the claims literal and minimal.",
    "Use only this exact structure:",
    "CLAIMS:",
    "- ...",
    "RISKS:",
    "- ...",
    "MISSING_EVIDENCE:",
    "- ...",
    "DEEPEN_NEEDED: yes|no",
    "If the request is a diagnostic, answer it literally.",
    "",
    prompt,
  ].join("\n");
}

function defaultPromptDeliveryProof({
  task,
  output,
  adapterId,
  checkedAt,
}: {
  task: FleetDispatchTask;
  output: RunnerAdapterOutput;
  adapterId: string;
  checkedAt: string;
}): SurfaceProofRecord {
  return {
    verdict: "proved",
    method: `runner-adapter:${adapterId}`,
    evidence: `${task.surface} accepted prompt and returned ${output.text.length} character(s)`,
    caveats: [],
    checkedAt,
  };
}

function defaultAnswerAttributionProof({
  task,
  output,
  calibration,
  adapterId,
  checkedAt,
}: {
  task: FleetDispatchTask;
  output: RunnerAdapterOutput;
  calibration: RunnerOutputCalibration;
  adapterId: string;
  checkedAt: string;
}): SurfaceProofRecord {
  const familyMatch = output.actualFamily === task.family;
  const hasText = output.text.trim().length > 0;
  return {
    verdict: familyMatch && hasText ? "proved" : "failed",
    method: `runner-adapter:${adapterId}`,
    evidence: familyMatch
      ? `answer attributed to ${output.actualFamily}:${task.surface}`
      : `requested ${task.family}:${task.surface}, got ${output.actualFamily}`,
    caveats: calibration.verdict === "usable" ? [] : calibration.reasons,
    checkedAt,
  };
}

function defaultExtractionMethod(surface: string): SurfaceExtractionMethod {
  if (surface === "ollama/localhost") {
    return "http-json";
  }
  if (surface.endsWith("/exec") || surface === "gemini/cli") {
    return "cli-stdout";
  }
  if (surface.endsWith("/mac-app")) {
    return "app-driver-text";
  }
  if (
    surface.includes("/web") ||
    surface.includes("web-") ||
    surface === "aistudio/web" ||
    surface === "grok/web-or-app"
  ) {
    return "driver-json";
  }
  return "unknown";
}

export function createClaudeCliRunnerAdapter({
  command = "claude",
  model = process.env.CHUCK_CLAUDE_MODEL ?? "sonnet",
  spawnImpl = spawn,
}: CommandRunnerAdapterOptions = {}): RunnerAdapter {
  const effort = process.env.CHUCK_CLAUDE_EFFORT ?? "low";
  return commandRunnerAdapter({
    adapterId: "claude-cli",
    family: "anthropic",
    surface: "claude-cli/exec",
    command,
    argsForPrompt: (prompt) => [
      "-p",
      buildSealedCliScoutPrompt(prompt),
      "--model",
      model,
      "--output-format",
      "text",
      "--tools",
      "",
      "--effort",
      effort,
      "--permission-mode",
      "plan",
      "--no-session-persistence",
    ],
    modelClaimed: `claude-cli/${model};effort=${effort};tools=disabled`,
    spawnImpl,
  });
}

export function createGeminiCliRunnerAdapter({
  command = "gemini",
  model = process.env.CHUCK_GEMINI_SCOUT_MODEL ?? "gemini-2.5-flash",
  spawnImpl = spawn,
}: CommandRunnerAdapterOptions = {}): RunnerAdapter {
  return commandRunnerAdapter({
    adapterId: "gemini-cli",
    family: "google",
    surface: "gemini/cli",
    command,
    argsForPrompt: (prompt) => [
      "-p",
      buildSealedCliScoutPrompt(prompt),
      "--model",
      model,
      "--output-format",
      "text",
      "--approval-mode",
      "plan",
    ],
    modelClaimed: `gemini-cli/${model}`,
    spawnImpl,
  });
}

export function createCodexCliRunnerAdapter({
  command = "codex",
  model = process.env.CHUCK_CODEX_MODEL ?? "gpt-5.3-codex-spark",
  spawnImpl = spawn,
  cwd = process.cwd(),
}: CommandRunnerAdapterOptions = {}): RunnerAdapter {
  const reasoningEffort = process.env.CHUCK_CODEX_REASONING_EFFORT ?? "low";
  return commandRunnerAdapter({
    adapterId: "codex-cli",
    family: "openai",
    surface: "codex/exec",
    command,
    argsForPrompt: () => [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--ignore-rules",
      "-c",
      `model_reasoning_effort="${reasoningEffort}"`,
      "--model",
      model,
      "-",
    ],
    stdinForPrompt: buildCodexScoutPrompt,
    modelClaimed: `codex-cli/${model};reasoning=${reasoningEffort}`,
    spawnImpl,
    cwd,
  });
}

export function buildCodexScoutPrompt(prompt: string): string {
  return buildSealedCliScoutPrompt(prompt);
}

export function createCodexReviewRunnerAdapter({
  command = "codex",
  model = process.env.CHUCK_CODEX_REVIEW_MODEL ??
    process.env.CHUCK_CODEX_MODEL ??
    "gpt-5.3-codex-spark",
  spawnImpl = spawn,
  cwd = process.cwd(),
}: CommandRunnerAdapterOptions = {}): RunnerAdapter {
  const reasoningEffort = process.env.CHUCK_CODEX_REVIEW_REASONING_EFFORT ?? "low";
  return commandRunnerAdapter({
    adapterId: "codex-review-cli",
    family: "openai",
    surface: "codex-review/exec",
    command,
    argsForPrompt: () => [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--ignore-rules",
      "-c",
      `model_reasoning_effort="${reasoningEffort}"`,
      "--model",
      model,
      "-",
    ],
    stdinForPrompt: buildCodexReviewScoutPrompt,
    modelClaimed: `codex-review-cli/${model};reasoning=${reasoningEffort}`,
    spawnImpl,
    cwd,
  });
}

export function buildCodexReviewScoutPrompt(prompt: string): string {
  return [
    "You are the OpenAI same-family review surface for Chuck.",
    "Do not implement or inspect files. Critique the request as a sealed independent reviewer.",
    buildSealedCliScoutPrompt(prompt),
  ].join("\n\n");
}

export type ScriptRunnerAdapterOptions = CommandRunnerAdapterOptions & {
  scriptPath?: string;
};

export function createGrokWebRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-grok-chat.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "grok-web-primary",
    family: "xai",
    surface: "grok/web-or-app",
    async run(task) {
      const stdout = await runCommandWithTimeout(
        {
          command,
          args: [scriptPath, "--ask", "--json", buildSealedCliScoutPrompt(task.prompt)],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "grok/web-or-app",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_GROK_SCOUT_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      const parsed = parseJsonTextOutput(stdout);
      return {
        text: parsed.text,
        actualRunner: "grok-web-primary",
        actualFamily: "xai",
        modelClaimed: parsed.modelUsed ?? "grok/web-or-app",
        modelVerified: true,
        extractionMethod: "driver-json",
      };
    },
  };
}

export function createChatGptWebRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-chatgpt-chat.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "chatgpt-web-primary",
    family: "openai",
    surface: "chatgpt/web-chat",
    async run(task) {
      const stdout = await runCommandWithTimeout(
        {
          command,
          args: [scriptPath, "--ask", "--json", buildSealedCliScoutPrompt(task.prompt)],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "chatgpt/web-chat",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_CHATGPT_WEB_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      const parsed = parseJsonTextOutput(stdout);
      return {
        text: parsed.text,
        actualRunner: "chatgpt-web-primary",
        actualFamily: "openai",
        modelClaimed: parsed.modelUsed ?? "chatgpt/web-chat",
        modelVerified: true,
        extractionMethod: "driver-json",
      };
    },
  };
}

export function createChatGptMacRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-chatgpt-mac.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "chatgpt-mac-primary",
    family: "openai",
    surface: "chatgpt/mac-app",
    async run(task) {
      const text = await runCommandWithTimeout(
        {
          command,
          args: [scriptPath, "--prompt", buildSealedCliScoutPrompt(task.prompt)],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "chatgpt/mac-app",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_CHATGPT_MAC_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      return {
        text,
        actualRunner: "chatgpt-mac-primary",
        actualFamily: "openai",
        modelClaimed: "chatgpt/mac-app",
        modelVerified: true,
        extractionMethod: "app-driver-text",
      };
    },
  };
}

export function createClaudeWebRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-claude-ai-chat.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "claude-web-primary",
    family: "anthropic",
    surface: "claude/web-chat",
    async run(task) {
      const stdout = await runCommandWithTimeout(
        {
          command,
          args: [
            scriptPath,
            "--ask",
            "--json",
            "--web-only",
            buildSealedCliScoutPrompt(task.prompt),
          ],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "claude/web-chat",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_CLAUDE_WEB_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      const parsed = parseJsonTextOutput(stdout);
      return {
        text: parsed.text,
        actualRunner: "claude-web-primary",
        actualFamily: "anthropic",
        modelClaimed: parsed.modelUsed ?? "claude/web-chat",
        modelVerified: true,
        extractionMethod: "driver-json",
      };
    },
  };
}

export function createClaudeMacRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-claude-mac.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "claude-mac-primary",
    family: "anthropic",
    surface: "claude/mac-app",
    async run(task) {
      const text = await runCommandWithTimeout(
        {
          command,
          args: [scriptPath, "--prompt", buildSealedCliScoutPrompt(task.prompt)],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "claude/mac-app",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_CLAUDE_MAC_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      return {
        text,
        actualRunner: "claude-mac-primary",
        actualFamily: "anthropic",
        modelClaimed: "claude/mac-app",
        modelVerified: true,
        extractionMethod: "app-driver-text",
      };
    },
  };
}

export function createGeminiWebRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-gemini-chat.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "gemini-web-primary",
    family: "google",
    surface: "gemini/web-chat",
    async run(task) {
      const stdout = await runCommandWithTimeout(
        {
          command,
          args: [scriptPath, "--ask", "--json", buildSealedCliScoutPrompt(task.prompt)],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "gemini/web-chat",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_GEMINI_WEB_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      const parsed = parseJsonTextOutput(stdout);
      return {
        text: parsed.text,
        actualRunner: "gemini-web-primary",
        actualFamily: "google",
        modelClaimed: parsed.modelUsed ?? "gemini/web-chat",
        modelVerified: true,
        extractionMethod: "driver-json",
      };
    },
  };
}

export function createAiStudioWebRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-aistudio-chat.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "aistudio-web-primary",
    family: "google",
    surface: "aistudio/web",
    async run(task) {
      const stdout = await runCommandWithTimeout(
        {
          command,
          args: [scriptPath, "--ask", "--json", buildSealedCliScoutPrompt(task.prompt)],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "aistudio/web",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_AISTUDIO_WEB_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      const parsed = parseJsonTextOutput(stdout);
      return {
        text: parsed.text,
        actualRunner: "aistudio-web-primary",
        actualFamily: "google",
        modelClaimed: parsed.modelUsed ?? "aistudio/web",
        modelVerified: true,
        extractionMethod: "driver-json",
      };
    },
  };
}

export function createPerplexityMacRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-perplexity-mac.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "perplexity-mac-primary",
    family: "perplexity",
    surface: "perplexity/mac-app",
    async run(task) {
      const text = await runCommandWithTimeout(
        {
          command,
          args: [
            scriptPath,
            "--mode",
            "research",
            "--prompt",
            buildSealedCliScoutPrompt(task.prompt),
          ],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "perplexity/mac-app",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_PERPLEXITY_MAC_SCOUT_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      return {
        text,
        actualRunner: "perplexity-mac-primary",
        actualFamily: "perplexity",
        modelClaimed: "perplexity/mac-app (incognito)",
        modelVerified: true,
        extractionMethod: "app-driver-text",
      };
    },
  };
}

export function createPerplexityWebRunnerAdapter({
  command = process.execPath,
  scriptPath = join(
    process.cwd(),
    "extensions",
    "memory-graph",
    "scripts",
    "research-perplexity-chat.mjs",
  ),
  spawnImpl = spawn,
  cwd = process.cwd(),
}: ScriptRunnerAdapterOptions = {}): RunnerAdapter {
  return {
    adapterId: "perplexity-web-primary",
    family: "perplexity",
    surface: "perplexity/web",
    async run(task) {
      const stdout = await runCommandWithTimeout(
        {
          command,
          args: [scriptPath, "--ask", "--json", buildSealedCliScoutPrompt(task.prompt)],
          timeoutMs: computeRunnerTimeoutBudget({
            surface: "perplexity/web",
            baseTimeoutMs: task.timeoutMs,
            promptChars: task.prompt.length,
            envName: "CHUCK_PERPLEXITY_WEB_TIMEOUT_MS",
          }).timeoutMs,
          cwd,
          env: guiRunnerEnv(task),
        },
        spawnImpl,
      );
      const parsed = parseJsonTextOutput(stdout);
      return {
        text: parsed.text,
        actualRunner: "perplexity-web-primary",
        actualFamily: "perplexity",
        modelClaimed: parsed.modelUsed ?? "perplexity/web",
        modelVerified: true,
        extractionMethod: "driver-json",
      };
    },
  };
}

function buildSealedCliScoutPrompt(prompt: string): string {
  return [
    "Do not use tools. Do not inspect files. Answer only from this prompt.",
    "This is a sealed Scout pass, not a repository exploration or implementation task.",
    "Do not claim knowledge of repo state, build health, or external facts unless the prompt itself provides that evidence.",
    "Use this structure:",
    "CLAIMS:",
    "- ...",
    "RISKS:",
    "- ...",
    "MISSING_EVIDENCE:",
    "- ...",
    "DEEPEN_NEEDED: yes|no",
    "",
    prompt,
  ].join("\n");
}

export function defaultRunnerAdapters(): RunnerAdapter[] {
  return [
    ...defaultLoadBearingRunnerAdapters(),
    createChatGptWebRunnerAdapter(),
    createChatGptMacRunnerAdapter(),
    createCodexReviewRunnerAdapter(),
    createClaudeWebRunnerAdapter(),
    createClaudeMacRunnerAdapter(),
    createGeminiWebRunnerAdapter(),
    createAiStudioWebRunnerAdapter(),
    createPerplexityMacRunnerAdapter(),
    createGrokWebRunnerAdapter(),
  ];
}

export function defaultLoadBearingRunnerAdapters(): RunnerAdapter[] {
  return [
    createOllamaRunnerAdapter(),
    createClaudeCliRunnerAdapter(),
    createGeminiCliRunnerAdapter(),
    createCodexCliRunnerAdapter(),
  ];
}

export type RunnerTimeoutBudget = {
  surface: string;
  timeoutMs: number;
  hardCeilingMs: number;
  reasons: string[];
};

export function computeRunnerTimeoutBudget({
  surface,
  baseTimeoutMs,
  promptChars,
  envName,
}: {
  surface: string;
  baseTimeoutMs: number;
  promptChars: number;
  envName?: string;
}): RunnerTimeoutBudget {
  const profile = timeoutProfileForSurface(surface);
  const promptUnits = Math.ceil(Math.max(0, promptChars) / 1_000);
  const computed = Math.max(
    baseTimeoutMs,
    profile.minMs,
    profile.coldStartMs + promptUnits * profile.msPerPromptKChar,
  );
  const envOverride = envName ? Number(process.env[envName]) : NaN;
  const hasEnvOverride = Number.isFinite(envOverride) && envOverride > 0;
  const hardCeilingMs = hasEnvOverride ? envOverride : profile.hardCeilingMs;
  const timeoutMs = hasEnvOverride ? envOverride : Math.min(computed, hardCeilingMs);
  return {
    surface,
    timeoutMs,
    hardCeilingMs,
    reasons: [
      `profile:${profile.label}`,
      `base:${baseTimeoutMs}ms`,
      `prompt:${promptChars} chars`,
      `cold-start:${profile.coldStartMs}ms`,
      `slope:${profile.msPerPromptKChar}ms/1k chars`,
      `ceiling:${hardCeilingMs}ms`,
      ...(hasEnvOverride ? [`env-override:${envName}=${envOverride}ms`] : []),
    ],
  };
}

function timeoutProfileForSurface(surface: string): {
  label: string;
  minMs: number;
  coldStartMs: number;
  msPerPromptKChar: number;
  hardCeilingMs: number;
} {
  if (surface === "perplexity/mac-app") {
    return {
      label: "mac-app-gui-research",
      minMs: 150_000,
      coldStartMs: 90_000,
      msPerPromptKChar: 12_000,
      hardCeilingMs: 360_000,
    };
  }
  if (surface === "perplexity/web") {
    return {
      label: "browser-gui-perplexity-research",
      minMs: 150_000,
      coldStartMs: 90_000,
      msPerPromptKChar: 12_000,
      hardCeilingMs: 360_000,
    };
  }
  if (surface === "chatgpt/web-chat") {
    return {
      label: "browser-gui-chatgpt-pro",
      minMs: 120_000,
      coldStartMs: 75_000,
      msPerPromptKChar: 8_000,
      hardCeilingMs: 300_000,
    };
  }
  if (surface === "chatgpt/mac-app") {
    return {
      label: "mac-app-chatgpt",
      minMs: 150_000,
      coldStartMs: 90_000,
      msPerPromptKChar: 10_000,
      hardCeilingMs: 360_000,
    };
  }
  if (surface === "claude/web-chat") {
    return {
      label: "browser-gui-claude-max",
      minMs: 120_000,
      coldStartMs: 75_000,
      msPerPromptKChar: 8_000,
      hardCeilingMs: 300_000,
    };
  }
  if (surface === "claude/mac-app") {
    return {
      label: "mac-app-claude",
      minMs: 150_000,
      coldStartMs: 90_000,
      msPerPromptKChar: 10_000,
      hardCeilingMs: 360_000,
    };
  }
  if (surface === "ollama/localhost") {
    return {
      label: "local-llm-cold-load-scout",
      minMs: 90_000,
      coldStartMs: 75_000,
      msPerPromptKChar: 4_000,
      hardCeilingMs: 180_000,
    };
  }
  if (surface === "grok/web-or-app") {
    return {
      label: "browser-gui-social-research",
      minMs: 120_000,
      coldStartMs: 75_000,
      msPerPromptKChar: 10_000,
      hardCeilingMs: 300_000,
    };
  }
  if (surface === "gemini/web-chat") {
    return {
      label: "browser-gui-gemini-pro",
      minMs: 120_000,
      coldStartMs: 75_000,
      msPerPromptKChar: 8_000,
      hardCeilingMs: 300_000,
    };
  }
  if (surface === "aistudio/web") {
    return {
      label: "browser-gui-aistudio-run",
      minMs: 150_000,
      coldStartMs: 90_000,
      msPerPromptKChar: 12_000,
      hardCeilingMs: 360_000,
    };
  }
  if (surface === "gemini/cli") {
    return {
      label: "quota-sensitive-cli-scout",
      minMs: 75_000,
      coldStartMs: 45_000,
      msPerPromptKChar: 4_000,
      hardCeilingMs: 180_000,
    };
  }
  if (surface === "claude-cli/exec") {
    return {
      label: "subscription-cli-scout",
      minMs: 60_000,
      coldStartMs: 30_000,
      msPerPromptKChar: 3_000,
      hardCeilingMs: 150_000,
    };
  }
  return {
    label: "cli-fast-scout",
    minMs: 45_000,
    coldStartMs: 15_000,
    msPerPromptKChar: 2_000,
    hardCeilingMs: 120_000,
  };
}

function parseJsonTextOutput(stdout: string): { text: string; modelUsed?: string } {
  const parsed = JSON.parse(stdout) as { text?: unknown; modelUsed?: unknown };
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    throw new Error("script runner returned JSON without text");
  }
  const modelUsed = typeof parsed.modelUsed === "string" ? parsed.modelUsed : undefined;
  return { text, modelUsed };
}

function commandRunnerAdapter({
  adapterId,
  family,
  surface,
  command,
  argsForPrompt,
  stdinForPrompt,
  modelClaimed,
  spawnImpl,
  cwd,
}: {
  adapterId: string;
  family: FleetDispatchTask["family"];
  surface: string;
  command: string;
  argsForPrompt: (prompt: string) => string[];
  stdinForPrompt?: (prompt: string) => string;
  modelClaimed: string;
  spawnImpl: typeof spawn;
  cwd?: string;
}): RunnerAdapter {
  return {
    adapterId,
    family,
    surface,
    async run(task) {
      const timeoutBudget = computeRunnerTimeoutBudget({
        surface,
        baseTimeoutMs: task.timeoutMs,
        promptChars: task.prompt.length,
        envName: timeoutEnvNameForSurface(surface),
      });
      const text = await runCommandWithTimeout(
        {
          command,
          args: argsForPrompt(task.prompt),
          stdin: stdinForPrompt?.(task.prompt),
          timeoutMs: timeoutBudget.timeoutMs,
          cwd,
        },
        spawnImpl,
      );
      return {
        text,
        actualRunner: adapterId,
        actualFamily: family,
        modelClaimed,
        modelVerified: true,
        extractionMethod: "cli-stdout",
      };
    },
  };
}

function timeoutEnvNameForSurface(surface: string): string | undefined {
  if (surface === "claude-cli/exec") {
    return "CHUCK_CLAUDE_CLI_TIMEOUT_MS";
  }
  if (surface === "gemini/cli") {
    return "CHUCK_GEMINI_CLI_TIMEOUT_MS";
  }
  if (surface === "codex/exec") {
    return "CHUCK_CODEX_CLI_TIMEOUT_MS";
  }
  if (surface === "codex-review/exec") {
    return "CHUCK_CODEX_REVIEW_TIMEOUT_MS";
  }
  return undefined;
}

function runCommandWithTimeout(
  {
    command,
    args,
    stdin,
    timeoutMs,
    cwd,
    env,
  }: {
    command: string;
    args: string[];
    stdin?: string;
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
  spawnImpl: typeof spawn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      stdio: stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      settled = true;
      killChildProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChildProcess(child, "SIGKILL");
      }, 2_000);
      forceKillTimer.unref?.();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 500) || "(no stderr)"}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error(`${command} produced empty output`));
        return;
      }
      resolve(text);
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

function guiRunnerEnv(task: FleetDispatchTask): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CHUCK_RUN_ID: task.runId,
    CHUCK_WORKSTATION_REASON: task.surface,
  };
}

function killChildProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to direct child kill.
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort timeout cleanup.
  }
}

async function writeTranscript({
  transcriptDir,
  task,
  text,
}: {
  transcriptDir: string;
  task: FleetDispatchTask;
  text: string;
}): Promise<string> {
  const path = join(transcriptDir, `${sanitizeFilePart(task.taskId)}.txt`);
  await writeFile(path, text, "utf8");
  return path;
}

function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-z0-9._-]+/gi, "-").replaceAll(/^-|-$/g, "") || "runner";
}
