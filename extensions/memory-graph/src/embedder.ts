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

export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

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
