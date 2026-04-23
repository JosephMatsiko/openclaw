#!/usr/bin/env node
// Apex Dispatch — universal N-plex parallel-worker primitive.
//
// One dispatcher for every ask/research/brief/synthesis path. Callers
// supply a prompt and a list of workers; dispatch runs them in parallel,
// collects results, and merges via the chosen strategy.
//
// Contract:
//
//   Worker: { id: string, ask: (args: { prompt: string }) => Promise<{ text: string, modelUsed?: string }> }
//
//   dispatch({
//     prompt: string,
//     workers: Worker[],
//     merge: "synthesize" | "vote" | "best" | "raw",
//     synthesisContext?: { claims?: Array, summaries?: Array, meta?: string },
//     perWorkerTimeoutMs?: number,
//     onProgress?: (event: { worker: string, status: string, error?: string }) => void,
//   }) => Promise<{
//     answer: string,
//     mode: string,                     // "single" | "n-degraded" | "n-partial" | "n-synthesized" | "n-raw"
//     workersUsed: string[],
//     errors: Array<{ worker: string, error: string }>,
//     workerResults: Array<{ id: string, text: string | null, modelUsed: string | null, error: string | null, latencyMs: number }>,
//     meta: { N: number, elapsed: number, mergeStrategy: string },
//   }>
//
// Merge strategies:
//   "synthesize" — spawn Claude Opus with all worker outputs + optional
//                  grounding context; Opus produces the unified reply.
//   "vote"       — shortest-edit-distance median pick; cheap, no LLM.
//   "best"       — worker with highest "confidence" score if provided,
//                  else first non-empty fulfilled result.
//   "raw"        — return workerResults without merging; caller decides.
//
// Downstream consumers: apex-route (handleAsk), deep-research (per-beat
// dispatch), magazine.mjs, morning-brief.mjs. Every surface becomes
// N-plex by dropping new workers into its workers array.

import { spawn } from "node:child_process";

function spawnCli(bin, args, { timeoutMs = 240_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function runWorker(w, prompt, { perWorkerTimeoutMs } = {}) {
  const t0 = Date.now();
  try {
    const timed = perWorkerTimeoutMs
      ? await Promise.race([
          w.ask({ prompt }),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`worker ${w.id} exceeded perWorkerTimeoutMs=${perWorkerTimeoutMs}`),
                ),
              perWorkerTimeoutMs,
            ),
          ),
        ])
      : await w.ask({ prompt });
    const payload = timed ?? {};
    const isString = typeof payload === "string";
    const text = isString ? payload : String(payload.text ?? "");
    const modelUsed = isString ? "" : String(payload.modelUsed ?? "");
    return {
      id: w.id,
      text: text || null,
      modelUsed: modelUsed || null,
      // Raw worker payload for callers that need structured output
      // (research beats returning { items: [] }, tool results, etc.).
      payload: isString ? payload : payload,
      error: null,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      id: w.id,
      text: null,
      modelUsed: null,
      payload: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - t0,
    };
  }
}

function buildSynthesisPrompt({ prompt, workerResults, synthesisContext }) {
  const ctx = synthesisContext ?? {};
  const witnessBlock = workerResults
    .map((r, i) => {
      const label = String.fromCharCode(65 + i);
      const model = r.modelUsed ? ` (${r.modelUsed})` : "";
      const body = r.text ?? "(worker offline)";
      return `=== WITNESS ${label}: ${r.id}${model} ===\n${body}`;
    })
    .join("\n\n");
  return [
    `You are the Sovereign Apex Gateway's synthesis worker — Claude Opus 4.7, 1M context. ${workerResults.length} subordinate witnesses drafted answers to Joseph's request. Reconcile them into ONE final reply.`,
    ``,
    `Do not concatenate. Extract the strongest substance from each, cross-check factual claims, resolve contradictions (prefer the witness with better grounding + verifiable citations), and compress into a tight Apex-voice reply. If witnesses agree on X, state X with confidence. When they split, surface the split briefly and give your judgment with reasoning.`,
    ``,
    `American spelling. No filler. No meta-commentary about being a synthesis worker — speak as the Apex directly. No emojis.`,
    ``,
    `=== JOSEPH'S REQUEST ===`,
    prompt,
    ``,
    Array.isArray(ctx.claims) && ctx.claims.length
      ? `=== DURABLE CLAIMS ===\n${ctx.claims.map((c) => `- [${c.kind}] ${c.summary}`).join("\n")}\n`
      : "",
    Array.isArray(ctx.summaries) && ctx.summaries.length
      ? `=== RECENT DAILY SUMMARIES ===\n${ctx.summaries.map((s) => `--- ${s.date} ---\n${s.body}`).join("\n\n")}\n`
      : "",
    ctx.meta ? `=== ADDITIONAL CONTEXT ===\n${ctx.meta}\n` : "",
    witnessBlock,
    ``,
    `Produce the unified final reply now.`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function synthesize({ prompt, workerResults, synthesisContext, timeoutMs = 300_000 }) {
  const synthPrompt = buildSynthesisPrompt({ prompt, workerResults, synthesisContext });
  return await spawnCli(
    "claude",
    ["-p", synthPrompt, "--model", "opus", "--fallback-model", "sonnet", "--output-format", "text"],
    { timeoutMs },
  );
}

function pickBest(workerResults) {
  // Future: score by confidence/citation density. For now: first non-empty.
  for (const r of workerResults) {
    if (r.text && r.text.trim().length > 0) {
      return r.text;
    }
  }
  return null;
}

function pickVote(workerResults) {
  // Shortest-edit-distance median. Bucket by normalized lowercase text,
  // return the most-popular bucket. Tie → longest answer (most
  // informative). Zero-hit → first non-empty.
  const buckets = new Map();
  for (const r of workerResults) {
    if (!r.text) {
      continue;
    }
    const key = r.text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 400);
    const cur = buckets.get(key) ?? { count: 0, text: r.text };
    cur.count += 1;
    if (r.text.length > cur.text.length) {
      cur.text = r.text;
    }
    buckets.set(key, cur);
  }
  let best = null;
  for (const b of buckets.values()) {
    if (
      !best ||
      b.count > best.count ||
      (b.count === best.count && b.text.length > best.text.length)
    ) {
      best = b;
    }
  }
  return best?.text ?? pickBest(workerResults);
}

export async function dispatch({
  prompt,
  workers,
  merge = "synthesize",
  synthesisContext,
  perWorkerTimeoutMs,
  onProgress,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("dispatch: prompt required");
  }
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new Error("dispatch: workers[] required");
  }
  const t0 = Date.now();
  const N = workers.length;

  onProgress?.({ worker: "*", status: "dispatch-start", error: undefined });
  const workerResults = await Promise.all(
    workers.map(async (w) => {
      onProgress?.({ worker: w.id, status: "started" });
      const r = await runWorker(w, prompt, { perWorkerTimeoutMs });
      onProgress?.({
        worker: w.id,
        status: r.error ? "failed" : "ok",
        error: r.error ?? undefined,
      });
      return r;
    }),
  );

  const errors = workerResults
    .filter((r) => r.error)
    .map((r) => ({ worker: r.id, error: String(r.error) }));
  const workersUsed = workerResults.filter((r) => r.text).map((r) => r.id);

  if (workersUsed.length === 0) {
    throw new Error(
      `dispatch: all workers offline: ${errors.map((e) => `${e.worker}:${e.error}`).join(" | ")}`,
    );
  }

  let answer = null;
  let mode = "raw";
  if (merge === "raw") {
    answer = null;
    mode = "n-raw";
  } else if (workersUsed.length === 1) {
    answer = workerResults.find((r) => r.text)?.text ?? null;
    mode = N === 1 ? "single" : "n-degraded";
  } else if (merge === "vote") {
    answer = pickVote(workerResults);
    mode = workersUsed.length === N ? "n-vote" : "n-partial-vote";
  } else if (merge === "best") {
    answer = pickBest(workerResults);
    mode = workersUsed.length === N ? "n-best" : "n-partial-best";
  } else {
    answer = await synthesize({ prompt, workerResults, synthesisContext });
    mode = workersUsed.length === N ? "n-synthesized" : "n-partial-synthesized";
  }

  return {
    answer,
    mode,
    workersUsed,
    errors,
    workerResults,
    meta: { N, elapsed: Date.now() - t0, mergeStrategy: merge },
  };
}

// ---- CLI (smoke test — not meant as primary entry point) --------------

function parseArgs(argv) {
  const out = { json: false, merge: "synthesize", positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--json") {
      out.json = true;
    } else if (t === "--merge") {
      out.merge = String(argv[i + 1] ?? "synthesize");
      i += 1;
    } else if (t === "-h" || t === "--help") {
      console.log("apex-dispatch.mjs [--json] [--merge synthesize|vote|best|raw] <prompt>");
      console.log("(smoke test with a single echo worker for plumbing verification)");
      process.exit(0);
    } else {
      out.positional.push(t);
    }
  }
  return out;
}

async function mainCli() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.positional.join(" ").trim();
  if (!prompt) {
    console.error('usage: apex-dispatch.mjs "your prompt"');
    process.exit(2);
  }
  // Plumbing smoke: one echo worker. Real callers import `dispatch`.
  const echoWorker = {
    id: "echo",
    ask: async ({ prompt }) => ({ text: `echo: ${prompt}`, modelUsed: "local/echo" }),
  };
  const result = await dispatch({
    prompt,
    workers: [echoWorker],
    merge: args.merge,
  });
  console.log(args.json ? JSON.stringify(result, null, 2) : result.answer);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[apex-dispatch] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
