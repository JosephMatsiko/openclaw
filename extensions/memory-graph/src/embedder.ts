import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Local sentence-embedder for memory-graph semantic retrieval. Uses
// `@xenova/transformers` (pure-JS + ONNX Runtime) so we keep the zero-API-
// credit invariant — the model is downloaded once to a user cache and then
// every recall is local.
//
// all-MiniLM-L6-v2 is the canonical small-and-decent sentence model:
// 384-dim, fast on Apple Silicon, ~90MB quantized. Model id is recorded on
// each row so a future swap invalidates stale vectors cleanly.
//
// SHA pinning (added 2026-04-28 per Opus 4.7's "embedding coupling = one-way
// door" warning from the LocalModelRole panel): the ONNX bytes are
// fingerprinted at first load. Subsequent loads verify the file SHA against
// EMBEDDING_MODEL_HASH; mismatch refuses to load (env override:
// APEX_ALLOW_EMBED_DRIFT=1 for explicit migration). Catches CDN swaps,
// silent vendor weight changes, and ensures the same vectors retrieved
// today match the vectors stored yesterday.

export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;
// SHA256 of the cached ONNX bytes pinned at 2026-04-28.
// Source: ~/.cache/openclaw-embeddings/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx
// 22,972,370 bytes; modified 2026-04-21T20:57.
// To rotate: bump this constant, run with APEX_ALLOW_EMBED_DRIFT=1 once,
// then re-embed any rows that need to be re-encoded against new bytes.
export const EMBEDDING_MODEL_HASH =
  "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1";

export function verifyEmbeddingModelHash(): {
  ok: boolean;
  actual: string | null;
  reason?: string;
} {
  const onnxPath = join(
    homedir(),
    ".cache",
    "openclaw-embeddings",
    "Xenova",
    "all-MiniLM-L6-v2",
    "onnx",
    "model_quantized.onnx",
  );
  if (!existsSync(onnxPath)) {
    return { ok: false, actual: null, reason: "ONNX bytes not yet cached" };
  }
  const bytes = readFileSync(onnxPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual === EMBEDDING_MODEL_HASH) {
    return { ok: true, actual };
  }
  return {
    ok: false,
    actual,
    reason: `SHA mismatch: pinned=${EMBEDDING_MODEL_HASH}, actual=${actual}`,
  };
}

type TransformersPipeline = (
  input: string,
  opts?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array | number[] }>;

type EmbedderState = {
  pipeline: TransformersPipeline;
};

let embedderPromise: Promise<EmbedderState> | null = null;

async function createEmbedder(): Promise<EmbedderState> {
  const transformers = (await import("@xenova/transformers")) as unknown as {
    env: {
      allowLocalModels: boolean;
      cacheDir: string;
    };
    pipeline: (
      task: string,
      model: string,
      opts?: { quantized?: boolean },
    ) => Promise<TransformersPipeline>;
  };
  transformers.env.allowLocalModels = false;
  transformers.env.cacheDir = join(homedir(), ".cache", "openclaw-embeddings");
  const pipeline = await transformers.pipeline("feature-extraction", EMBEDDING_MODEL_ID, {
    quantized: true,
  });

  // Verify SHA pin AFTER pipeline load — the pipeline call is what fetches
  // the ONNX bytes if they aren't cached yet, so verification on a cold
  // start needs to wait until the cache exists.
  const verify = verifyEmbeddingModelHash();
  if (!verify.ok) {
    if (process.env.APEX_ALLOW_EMBED_DRIFT === "1") {
      process.stderr.write(
        `[embedder] SHA drift accepted via APEX_ALLOW_EMBED_DRIFT=1: ${verify.reason}\n` +
          `[embedder] new hash for pinning: ${verify.actual}\n`,
      );
    } else {
      throw new Error(
        `Embedding model SHA mismatch — refused to load (set APEX_ALLOW_EMBED_DRIFT=1 to override). ${verify.reason}`,
      );
    }
  }

  return { pipeline };
}

export async function getEmbedder(): Promise<EmbedderState> {
  if (!embedderPromise) {
    embedderPromise = createEmbedder();
  }
  return embedderPromise;
}

// Compute a normalized 384-dim embedding for `text`. Returns a Float32Array
// so callers can blob-store it directly.
export async function embedText(text: string): Promise<Float32Array> {
  const trimmed = text.trim();
  if (!trimmed) {
    return new Float32Array(EMBEDDING_DIM);
  }
  const { pipeline } = await getEmbedder();
  const result = await pipeline(trimmed, { pooling: "mean", normalize: true });
  return new Float32Array(result.data);
}

// Cosine similarity for two NORMALIZED vectors == dot product. The embedder
// normalizes on our behalf, so the caller does not need to re-normalize.
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function deserializeEmbedding(raw: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}
