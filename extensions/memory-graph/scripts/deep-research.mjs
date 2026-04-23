#!/usr/bin/env node
// Deep-research orchestrator — N-plex workers + reconciliation.
//
// The Sovereign Gateway's research layer dispatches every subordinate
// research worker in parallel via apex-dispatch:
//   - research-claude.mjs           (Claude Max + WebSearch)
//   - research-gemini.mjs           (Gemini CLI OAuth + Google grounding)
//   - research-chatgpt-chat.mjs     (ChatGPT Plus via chatgpt.com, Chrome)
//   - research-perplexity-chat.mjs  (Perplexity Pro via perplexity.ai, Chrome)
// Add a new worker to the array → the whole fleet compounds. Same URL
// merge logic; "consensus" becomes stronger with more witnesses.
//
// Reconciliation is code-based, not LLM-based: faster, deterministic, free.
// We match items by normalized URL. If we want LLM synthesis later, drop
// it in as an optional `--synthesize` flag without breaking the contract.
//
// Graceful degradation: if one worker fails (Gemini OAuth not yet set up,
// network hiccup, quota exhausted), we continue with the other and tag
// the bundle `confidence: "degraded"`. Never fail a beat because one
// subordinate worker is offline.
//
// Usage:
//   node deep-research.mjs --beats "Uganda economy last 7 days" --items 5 --json
//   node deep-research.mjs --edition sunday --json
//
// Library:
//   import { deepResearchBeat, deepResearchBundle } from "./deep-research.mjs";
//   const bundle = await deepResearchBundle(beats, { itemsPerBeat: 5 });

import { beatsFor } from "./apex-beats.mjs";
import { dispatch } from "./apex-dispatch.mjs";
import { researchBeat as aistudioResearch } from "./research-aistudio-chat.mjs";
import { withCache } from "./research-cache.mjs";
import { researchBeat as chatgptResearch } from "./research-chatgpt-chat.mjs";
import { researchBeat as claudeAiResearch } from "./research-claude-ai-chat.mjs";
import { researchBeat as claudeResearch } from "./research-claude.mjs";
import { enrichItemsWithDominance } from "./research-enrich.mjs";
import { researchBeat as geminiResearch } from "./research-gemini.mjs";
import { researchBeat as grokResearch } from "./research-grok-chat.mjs";
import { researchBeat as perplexityResearch } from "./research-perplexity-chat.mjs";

function normalizeUrl(raw) {
  if (!raw) {
    return "";
  }
  try {
    const u = new URL(raw);
    // Strip common tracking params that cause false URL divergence.
    const drop = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "ref",
      "ref_src",
      "mc_cid",
      "mc_eid",
    ];
    for (const k of drop) {
      u.searchParams.delete(k);
    }
    // Normalize host (lowercase) + drop trailing slash + drop default port.
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith("/")) {
      s = s.slice(0, -1);
    }
    return s;
  } catch {
    return String(raw).trim().toLowerCase();
  }
}

function mergeItems(sourceBuckets) {
  // sourceBuckets: { [sourceId]: items[] }
  const byUrl = new Map();
  for (const src of Object.keys(sourceBuckets)) {
    const list = sourceBuckets[src] ?? [];
    for (const it of list) {
      const key = normalizeUrl(it.url);
      if (!key) {
        continue;
      }
      const cur = byUrl.get(key);
      if (!cur) {
        byUrl.set(key, { ...it, sources: [src], normalizedUrl: key });
      } else {
        if (!cur.sources.includes(src)) {
          cur.sources.push(src);
        }
        // Prefer the longer / more descriptive summary.
        if ((it.summary ?? "").length > (cur.summary ?? "").length) {
          cur.summary = it.summary;
        }
        if ((it.title ?? "").length > (cur.title ?? "").length) {
          cur.title = it.title;
        }
        if (!cur.publishedHint && it.publishedHint) {
          cur.publishedHint = it.publishedHint;
        }
      }
    }
  }
  const all = [...byUrl.values()];
  const consensus = all.filter((x) => x.sources.length >= 2);
  const divergences = all.filter((x) => x.sources.length === 1);
  // Consensus first, then divergences. Within each group, preserve insertion order.
  const unified = [...consensus, ...divergences];
  return { consensus, divergences, unified };
}

function scoreConfidence({ consensus, workersUsed, errors }) {
  if (workersUsed.length === 1) {
    return "degraded";
  }
  if (consensus.length >= 3) {
    return "high";
  }
  if (consensus.length >= 1) {
    return "medium";
  }
  return errors.length > 0 ? "degraded" : "low";
}

export async function deepResearchBeat(
  beat,
  { items = 5, forceRefresh = false, deep = false, deepConcurrency = 3 } = {},
) {
  // Incisive + untraceable: cache-first. Same beat + same itemCount on
  // the same UTC day returns the prior bundle — no outbound calls. This
  // also softens Gemini's 60/day Pro gate: repeated magazine runs hit
  // the cache, leaving live quota for genuinely new beats.
  //
  // Cache key includes deep=true/false separately so a shallow run isn't
  // served to a deep caller.
  const cached = await withCache(
    {
      beat,
      itemCount: items,
      variant: deep ? "deep-research-dominated" : "deep-research",
      forceRefresh,
    },
    async () => {
      const raw = await dispatchWorkers(beat, items);
      if (deep && raw.unified?.length > 0) {
        // Dominate every cited URL via apex-dominance and attach fullContent.
        raw.unified = await enrichItemsWithDominance(raw.unified, {
          concurrency: deepConcurrency,
        });
        // Re-derive consensus/divergences view preserving new fields.
        const byUrl = new Map(raw.unified.map((x) => [x.normalizedUrl ?? x.url, x]));
        raw.consensus = raw.consensus.map((x) => byUrl.get(x.normalizedUrl ?? x.url) ?? x);
        raw.divergences = raw.divergences.map((x) => byUrl.get(x.normalizedUrl ?? x.url) ?? x);
        raw.deepDominance = {
          enriched: raw.unified.filter((it) => it.fullContent).length,
          attempted: raw.unified.length,
        };
      }
      return raw;
    },
  );
  return { ...cached.payload, cached: cached.cached };
}

// The fleet. New workers land by adding one entry here; merge logic,
// confidence scoring, cache keys, and downstream consumers compound
// automatically.
const RESEARCH_WORKERS = [
  { id: "claude", run: claudeResearch },
  { id: "gemini", run: geminiResearch },
  { id: "chatgpt", run: chatgptResearch },
  { id: "perplexity", run: perplexityResearch },
  { id: "claude-ai", run: claudeAiResearch },
  { id: "aistudio", run: aistudioResearch },
  { id: "grok", run: grokResearch },
];

async function dispatchWorkers(beat, items) {
  const workers = RESEARCH_WORKERS.map((w) => ({
    id: w.id,
    ask: async ({ prompt }) => await w.run(prompt, { items }),
  }));
  // merge:"raw" — apex-dispatch runs the fan-out; URL-consensus merge
  // is the caller's job since research payloads are structured items,
  // not free-text.
  const dispatchResult = await dispatch({ prompt: beat, workers, merge: "raw" });
  const byId = new Map(dispatchResult.workerResults.map((r) => [r.id, r]));
  const buckets = {};
  const modelUsed = {};
  for (const w of RESEARCH_WORKERS) {
    const r = byId.get(w.id);
    buckets[w.id] = Array.isArray(r?.payload?.items) ? r.payload.items : [];
    modelUsed[w.id] = r?.payload?.modelUsed ?? null;
  }
  const { consensus, divergences, unified } = mergeItems(buckets);
  const confidence = scoreConfidence({
    consensus,
    workersUsed: dispatchResult.workersUsed,
    errors: dispatchResult.errors,
  });
  return {
    beat,
    consensus,
    divergences,
    unified,
    confidence,
    workersUsed: dispatchResult.workersUsed,
    errors: dispatchResult.errors,
    modelUsed,
  };
}

export async function deepResearchBundle(
  beats,
  { itemsPerBeat = 5, forceRefresh = false, deep = false, deepConcurrency = 3 } = {},
) {
  const runAt = new Date().toISOString();
  // Parallel across beats. Each beat internally runs claude+gemini in parallel,
  // so the whole fan-out completes in roughly the time of the slowest single
  // beat + slowest worker.
  const results = await Promise.all(
    beats.map(async (b) => {
      const beatText = typeof b === "string" ? b : b.beat;
      const items = typeof b === "object" && b.items ? b.items : itemsPerBeat;
      const beatId = typeof b === "object" && b.id ? b.id : null;
      const circle = typeof b === "object" && b.circle ? b.circle : null;
      const res = await deepResearchBeat(beatText, {
        items,
        forceRefresh,
        deep,
        deepConcurrency,
      });
      return { ...res, beatId, circle };
    }),
  );
  const stats = {
    beats: results.length,
    consensusTotal: results.reduce((n, r) => n + r.consensus.length, 0),
    divergenceTotal: results.reduce((n, r) => n + r.divergences.length, 0),
    unifiedTotal: results.reduce((n, r) => n + r.unified.length, 0),
    degradedCount: results.filter((r) => r.confidence === "degraded").length,
    cachedCount: results.filter((r) => r.cached === true).length,
    deepEnriched: deep ? results.reduce((n, r) => n + (r.deepDominance?.enriched ?? 0), 0) : 0,
    deepAttempted: deep ? results.reduce((n, r) => n + (r.deepDominance?.attempted ?? 0), 0) : 0,
  };
  return { runAt, beats: results, stats };
}

// ---- CLI ----

function parseArgs(argv) {
  const out = {
    beats: [],
    items: 5,
    asJson: false,
    edition: null,
    endDate: null,
    deep: false,
    deepConcurrency: 3,
    forceRefresh: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--json") {
      out.asJson = true;
    } else if (t === "--deep") {
      out.deep = true;
    } else if (t === "--deep-concurrency") {
      out.deepConcurrency = Number.parseInt(argv[i + 1] ?? "3", 10);
      i += 1;
    } else if (t === "--refresh" || t === "--force-refresh") {
      out.forceRefresh = true;
    } else if (t === "--items") {
      out.items = Number.parseInt(argv[i + 1] ?? "5", 10);
      i += 1;
    } else if (t === "--beats") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out.beats.push(argv[i + 1]);
        i += 1;
      }
    } else if (t === "--edition") {
      out.edition = String(argv[i + 1] ?? "");
      i += 1;
    } else if (t === "--end-date") {
      out.endDate = String(argv[i + 1] ?? "");
      i += 1;
    } else if (t === "-h" || t === "--help") {
      console.log(
        "usage: deep-research.mjs [--json] [--items N] [--deep] [--deep-concurrency 3] [--refresh] (--beats 'b1' 'b2' ... | --edition daily|friday|weekend|sunday [--end-date YYYY-MM-DD])",
      );
      process.exit(0);
    }
  }
  return out;
}

async function mainCli() {
  const args = parseArgs(process.argv.slice(2));
  let beats = args.beats;
  if (args.edition) {
    const endDate = args.endDate ?? new Date().toISOString().slice(0, 10);
    beats = beatsFor(args.edition, endDate);
  }
  if (!beats || beats.length === 0) {
    console.error("error: pass --beats or --edition");
    process.exit(2);
  }
  const bundle = await deepResearchBundle(beats, {
    itemsPerBeat: args.items,
    deep: args.deep,
    deepConcurrency: args.deepConcurrency,
    forceRefresh: args.forceRefresh,
  });
  if (args.asJson) {
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }
  console.log(`# Deep research · ${bundle.runAt}`);
  console.log(
    `# stats: ${bundle.stats.beats} beats, ${bundle.stats.consensusTotal} consensus, ${bundle.stats.divergenceTotal} divergences, ${bundle.stats.degradedCount} degraded${args.deep ? `, deepEnriched=${bundle.stats.deepEnriched}/${bundle.stats.deepAttempted}` : ""}\n`,
  );
  for (const r of bundle.beats) {
    console.log(`## ${r.beat}`);
    console.log(
      `confidence=${r.confidence}  workers=${r.workersUsed.join(",")}${
        r.errors.length ? `  errors=${r.errors.map((e) => e.worker).join(",")}` : ""
      }`,
    );
    console.log(
      `consensus=${r.consensus.length}  divergences=${r.divergences.length}  unified=${r.unified.length}`,
    );
    if (r.errors.length > 0) {
      for (const e of r.errors) {
        console.log(`  [${e.worker}] ${e.error.slice(0, 180)}`);
      }
    }
    for (const it of r.unified) {
      const tag = it.sources.length >= 2 ? "★" : "·";
      const phaseTag = it.phaseUsed ? `  [phase ${it.phaseUsed}]` : "";
      console.log(`  ${tag} ${it.title}  (${it.source} · ${it.publishedHint})${phaseTag}`);
      console.log(`    → ${it.url}`);
      if (it.fullContent) {
        const preview = it.fullContent.slice(0, 240).replace(/\s+/g, " ").trim();
        console.log(`    full: ${preview}${it.fullContent.length > 240 ? "..." : ""}`);
      } else if (it.dominanceError) {
        console.log(`    deep: FAILED — ${it.dominanceError.slice(0, 120)}`);
      }
    }
    console.log("");
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[deep-research] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
