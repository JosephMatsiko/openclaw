import { buildOllamaScoutPrompt, calibrateRunnerOutput } from "./runner-executor.js";

export type LocalModelEvalTaskClass = "literal" | "technical-scout" | "anti-drift";

export type LocalModelEvalCase = {
  caseId: string;
  taskClass: LocalModelEvalTaskClass;
  prompt: string;
  expectedPatterns?: RegExp[];
  forbiddenPatterns?: RegExp[];
  requiresScoutStructure?: boolean;
  maxLatencyMs?: number;
};

export type LocalModelEvalCaseResult = {
  caseId: string;
  taskClass: LocalModelEvalTaskClass;
  passed: boolean;
  score: number;
  latencyMs: number;
  text: string;
  failures: string[];
  calibration: ReturnType<typeof calibrateRunnerOutput>;
};

export type LocalModelEvaluationResult = {
  model: string;
  surface: "ollama/localhost";
  startedAt: string;
  endedAt: string;
  caseCount: number;
  aggregateScore: number;
  verdict: "promote" | "candidate" | "reject";
  usableForDefault: boolean;
  results: LocalModelEvalCaseResult[];
};

export type LocalModelCandidate = {
  name: string;
  size?: string;
  modifiedAt?: string;
};

export type LocalModelEvalFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export type LocalModelEvalFetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<LocalModelEvalFetchResponse>;

export const DEFAULT_LOCAL_MODEL_EVAL_CASES: LocalModelEvalCase[] = [
  {
    caseId: "literal-ok",
    taskClass: "literal",
    prompt: "Say exactly: OK",
    expectedPatterns: [/^OK$/i],
    forbiddenPatterns: localDriftForbiddenPatterns(),
    maxLatencyMs: 10_000,
  },
  {
    caseId: "technical-scout-risk",
    taskClass: "technical-scout",
    prompt: [
      "Evaluate this change as a Chuck local scout:",
      "Add a script that deletes build artifacts before tests.",
      "Return claims, risks, missing evidence, and whether deepening is needed.",
    ].join(" "),
    expectedPatterns: [
      /CLAIMS:/i,
      /RISKS:/i,
      /MISSING_EVIDENCE:/i,
      /DEEPEN_NEEDED:/i,
      /delet|risk|test/i,
    ],
    forbiddenPatterns: localDriftForbiddenPatterns(),
    requiresScoutStructure: true,
    maxLatencyMs: 25_000,
  },
  {
    caseId: "anti-drift-scout-definition",
    taskClass: "anti-drift",
    prompt: "In one sentence, explain what scout means in Chuck's Fleet protocol.",
    expectedPatterns: [/(technical|independent|evaluation|review|fleet|pass)/i],
    forbiddenPatterns: localDriftForbiddenPatterns(),
    maxLatencyMs: 15_000,
  },
];

export async function listOllamaLocalModelCandidates({
  endpoint = process.env.OLLAMA_HOST ?? "http://localhost:11434",
  fetchImpl = fetch as unknown as LocalModelEvalFetch,
  timeoutMs = 5000,
}: {
  endpoint?: string;
  fetchImpl?: LocalModelEvalFetch;
  timeoutMs?: number;
} = {}): Promise<LocalModelCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`ollama tags HTTP ${response.status}: ${body.slice(0, 400)}`);
    }
    const parsed = (await response.json()) as {
      models?: Array<{ name?: unknown; size?: unknown; modified_at?: unknown }>;
    };
    return (parsed.models ?? [])
      .map((model) => ({
        name: typeof model.name === "string" ? model.name : "",
        size:
          typeof model.size === "number"
            ? String(model.size)
            : typeof model.size === "string"
              ? model.size
              : undefined,
        modifiedAt: typeof model.modified_at === "string" ? model.modified_at : undefined,
      }))
      .filter((model) => isChatModelName(model.name));
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateOllamaLocalModel({
  model,
  endpoint = process.env.OLLAMA_HOST ?? "http://localhost:11434",
  cases = DEFAULT_LOCAL_MODEL_EVAL_CASES,
  fetchImpl = fetch as unknown as LocalModelEvalFetch,
  now = () => new Date().toISOString(),
}: {
  model: string;
  endpoint?: string;
  cases?: LocalModelEvalCase[];
  fetchImpl?: LocalModelEvalFetch;
  now?: () => string;
}): Promise<LocalModelEvaluationResult> {
  const startedAt = now();
  const results: LocalModelEvalCaseResult[] = [];
  for (const testCase of cases) {
    results.push(
      await evaluateLocalModelCase({
        endpoint,
        model,
        testCase,
        fetchImpl,
      }),
    );
  }
  const endedAt = now();
  const aggregateScore = roundScore(
    results.reduce((sum, result) => sum + result.score, 0) / Math.max(results.length, 1),
  );
  const hasDrift = results.some((result) => result.calibration.roleplayDriftDetected);
  const verdict =
    aggregateScore >= 0.85 && !hasDrift
      ? "promote"
      : aggregateScore >= 0.65 && !hasDrift
        ? "candidate"
        : "reject";
  return {
    model,
    surface: "ollama/localhost",
    startedAt,
    endedAt,
    caseCount: results.length,
    aggregateScore,
    verdict,
    usableForDefault: verdict === "promote",
    results,
  };
}

export function rankLocalModelEvaluations(
  evaluations: LocalModelEvaluationResult[],
): LocalModelEvaluationResult[] {
  return evaluations.toSorted((a, b) => {
    const scoreDelta = b.aggregateScore - a.aggregateScore;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const aLatency = averageLatency(a);
    const bLatency = averageLatency(b);
    return aLatency - bLatency;
  });
}

async function evaluateLocalModelCase({
  endpoint,
  model,
  testCase,
  fetchImpl,
}: {
  endpoint: string;
  model: string;
  testCase: LocalModelEvalCase;
  fetchImpl: LocalModelEvalFetch;
}): Promise<LocalModelEvalCaseResult> {
  const started = Date.now();
  const text = await generateOllamaText({
    endpoint,
    model,
    prompt: buildOllamaScoutPrompt(testCase.prompt),
    timeoutMs: testCase.maxLatencyMs ?? 30_000,
    fetchImpl,
  });
  const latencyMs = Date.now() - started;
  const calibration = calibrateRunnerOutput({
    family: "sovereign-local",
    surface: "ollama/localhost",
    prompt: testCase.prompt,
    text,
  });
  const failures = caseFailures({ testCase, text, latencyMs, calibration });
  return {
    caseId: testCase.caseId,
    taskClass: testCase.taskClass,
    passed: failures.length === 0,
    score: scoreCase(failures, calibration),
    latencyMs,
    text,
    failures,
    calibration,
  };
}

async function generateOllamaText({
  endpoint,
  model,
  prompt,
  timeoutMs,
  fetchImpl,
}: {
  endpoint: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  fetchImpl: LocalModelEvalFetch;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        think: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`ollama generate HTTP ${response.status}: ${body.slice(0, 400)}`);
    }
    const parsed = (await response.json()) as { response?: unknown };
    const text = typeof parsed.response === "string" ? parsed.response.trim() : "";
    if (!text) {
      throw new Error("ollama generate returned empty response field");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function caseFailures({
  testCase,
  text,
  latencyMs,
  calibration,
}: {
  testCase: LocalModelEvalCase;
  text: string;
  latencyMs: number;
  calibration: ReturnType<typeof calibrateRunnerOutput>;
}): string[] {
  const failures: string[] = [];
  if (calibration.verdict !== "usable") {
    failures.push(...calibration.reasons);
  }
  for (const pattern of testCase.expectedPatterns ?? []) {
    if (!pattern.test(text)) {
      failures.push(`missing expected pattern ${pattern}`);
    }
  }
  for (const pattern of testCase.forbiddenPatterns ?? []) {
    if (pattern.test(text)) {
      failures.push(`matched forbidden drift pattern ${pattern}`);
    }
  }
  if (testCase.requiresScoutStructure && !calibration.formatCompliant) {
    failures.push("missing scout structure");
  }
  if (testCase.maxLatencyMs && latencyMs > testCase.maxLatencyMs) {
    failures.push(`latency ${latencyMs}ms exceeded ${testCase.maxLatencyMs}ms`);
  }
  return [...new Set(failures)];
}

function scoreCase(
  failures: string[],
  calibration: ReturnType<typeof calibrateRunnerOutput>,
): number {
  if (calibration.verdict === "failed") {
    return 0;
  }
  if (calibration.roleplayDriftDetected) {
    return 0.1;
  }
  if (failures.length === 0) {
    return 1;
  }
  return Math.max(0, roundScore(1 - failures.length * 0.25));
}

function localDriftForbiddenPatterns(): RegExp[] {
  return [
    /\basteroid\b/i,
    /\benergy signatures?\b/i,
    /\blight-minutes?\b/i,
    /\bmission log\b/i,
    /\bnavigation computer\b/i,
    /\bportside\b/i,
    /\bpropulsion\b/i,
    /\bship\b/i,
    /\bsensor sweep\b/i,
    /\bspace mission\b/i,
    /\bstarship\b/i,
    /\buncharted\b/i,
  ];
}

function isChatModelName(name: string): boolean {
  const lower = name.toLowerCase();
  return Boolean(name) && !lower.includes("embed") && !lower.includes("nomic");
}

function averageLatency(evaluation: LocalModelEvaluationResult): number {
  return (
    evaluation.results.reduce((sum, result) => sum + result.latencyMs, 0) /
    Math.max(evaluation.results.length, 1)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
