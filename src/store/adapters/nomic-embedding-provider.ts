/**
 * Default {@link EmbeddingProvider}: `nomic-ai/nomic-embed-text-v1.5` running locally
 * as ONNX through transformers.js.
 *
 * @spec §11 — keeps the MCP server self-contained: no per-write network call, no API
 * key, no rate limit on the write path. The model is Matryoshka-trained, so the same
 * weights serve 768d, 256d or 128d and the dimension is a config knob rather than a
 * model swap — but the store pins it at migration time, so changing it after the fact
 * is a re-embed.
 *
 * @spec §5.10 — the write path budget is one embedding plus one small-model call in
 * roughly a second, which is why the model handle is created once and cached: a cold
 * `pipeline()` costs seconds, a warm `embed()` costs milliseconds.
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

import type { EmbeddingProvider, EmbeddingTask } from '../ports/embedding-provider.js';

/** Hugging Face repo id of the default model. */
export const NOMIC_MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';

/** Native output width of the model, before Matryoshka truncation. */
export const NOMIC_NATIVE_DIMENSIONS = 768;

/**
 * Widths the Matryoshka objective was trained for. Truncating to an untrained width
 * is not an error the model reports — it just degrades quietly — so the constructor
 * rejects anything outside this set.
 */
export const NOMIC_SUPPORTED_DIMENSIONS = [768, 512, 256, 128, 64] as const;

export type NomicDimensions = (typeof NOMIC_SUPPORTED_DIMENSIONS)[number];

/**
 * Task prefixes the model was trained with. Omitting them, or using the wrong one,
 * costs measurable accuracy on the §5.2 gloss-resolution rung — the prefix is what
 * tells the model whether it is embedding a short lookup phrase or stored content.
 */
const TASK_PREFIX: Readonly<Record<EmbeddingTask, string>> = {
  document: 'search_document: ',
  query: 'search_query: ',
};

export interface NomicEmbeddingProviderOptions {
  /**
   * Matryoshka output width. Defaults to the value pinned by spike S2.
   *
   * @spec §11
   */
  readonly dimensions?: NomicDimensions;
  /**
   * Directory the ONNX weights and tokenizer are cached in. Defaults to `models/`
   * at the repository root, which is gitignored.
   */
  readonly cacheDir?: string;
  /** ONNX weight precision. `fp32` is the reference; `q8` trades accuracy for size. */
  readonly dtype?: 'fp32' | 'fp16' | 'q8';
}

/** Repository-root-relative cache directory. Gitignored as `/models/`. */
const DEFAULT_CACHE_DIR = new URL('../../../models/', import.meta.url).pathname;

/**
 * The width spike S2 pinned. Reproduce with `pnpm exec tsx scripts/spike-s2-embeddings.ts`.
 *
 * 512, not the 256 the v1 plan assumed. The measurement that decided it is the rate
 * at which unrelated same-repository text clears the §5.3 candidate floor of 0.70
 * cosine — the junk every write pays the adjudicator to reject:
 *
 *     768d  7.1%   512d  8.3%   256d  12.3%   128d  24.4%   64d  40.4%
 *
 * 512 is indistinguishable from full width (and marginally better on §5.2 gloss
 * resolution, MRR 0.968 vs 0.963), while 256 admits ~50% more distractors for a
 * storage saving that is irrelevant at this corpus size.
 *
 * This number is *not* irreversible, despite the plan's premise. Matryoshka
 * projection is layer-norm, slice, normalize — so slicing a stored 768d f32 vector
 * and renormalizing reproduces any narrower width exactly (verified to float32
 * epsilon, spike Table 10). Provided the store keeps its §11 f32 rerank copy at
 * {@link NOMIC_NATIVE_DIMENSIONS}, narrowing the ANN index later is an index rebuild,
 * not a re-embed. Widening is not: that direction does need the model.
 *
 * @spec §11, §5.3
 */
export const PINNED_DIMENSIONS = 512 satisfies NomicDimensions;

/**
 * The width to persist the §11 full-precision rerank copy at. Always native: it costs
 * ~1 KB per claim over storing it at {@link PINNED_DIMENSIONS} and it is what keeps
 * the ANN width a reversible decision.
 *
 * @spec §11
 */
export const RERANK_DIMENSIONS = NOMIC_NATIVE_DIMENSIONS satisfies NomicDimensions;

/**
 * Applies the model's documented Matryoshka recipe: layer-norm the mean-pooled
 * vector across its full native width, truncate to `dimensions`, then L2-normalize.
 *
 * The order matters. Layer-norm runs over all 768 components *before* the slice —
 * normalizing after truncation gives a different (and worse) vector, because the
 * statistics the Matryoshka objective trained against are the full-width ones.
 */
export const matryoshkaProject = (pooled: Float32Array, dimensions: number): Float32Array => {
  const n = pooled.length;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += pooled[i]!;
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i += 1) {
    const d = pooled[i]! - mean;
    variance += d * d;
  }
  const invStd = 1 / Math.sqrt(variance / n + 1e-5);

  const out = new Float32Array(dimensions);
  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const v = (pooled[i]! - mean) * invStd;
    out[i] = v;
    norm += v * v;
  }
  const invNorm = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  for (let i = 0; i < dimensions; i += 1) out[i] = out[i]! * invNorm;
  return out;
};

/**
 * Narrows an already-embedded vector to a smaller Matryoshka width without touching
 * the model. Exact to float32 epsilon (spike Table 10), which is what makes the ANN
 * index width a rebuildable decision rather than a re-embed: read the stored f32
 * rerank copies, truncate, requantize.
 *
 * Only narrows. Widening needs the model, and throws here rather than silently
 * zero-padding into a vector that would score plausibly and mean nothing.
 *
 * @spec §11
 */
export const truncateEmbedding = (vector: Float32Array, dimensions: NomicDimensions): Float32Array => {
  if (dimensions > vector.length) {
    throw new RangeError(
      `cannot widen a ${String(vector.length)}d vector to ${String(dimensions)}d — re-embed with the model instead`,
    );
  }
  const out = new Float32Array(dimensions);
  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    out[i] = vector[i]!;
    norm += vector[i]! * vector[i]!;
  }
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  for (let i = 0; i < dimensions; i += 1) out[i] = out[i]! * inv;
  return out;
};

/**
 * Local ONNX embedding provider.
 *
 * The transformers.js pipeline is loaded lazily on first use and reused for the
 * lifetime of the instance, so a long-lived process pays cold start once.
 *
 * @spec §11
 */
export class NomicEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelId: string;

  readonly #cacheDir: string;
  readonly #dtype: 'fp32' | 'fp16' | 'q8';
  #pipeline: Promise<FeatureExtractionPipeline> | undefined;

  constructor(options: NomicEmbeddingProviderOptions = {}) {
    const dimensions = options.dimensions ?? PINNED_DIMENSIONS;
    if (!NOMIC_SUPPORTED_DIMENSIONS.includes(dimensions)) {
      throw new RangeError(
        `${NOMIC_MODEL_ID} was Matryoshka-trained for ${NOMIC_SUPPORTED_DIMENSIONS.join('/')} only, got ${String(dimensions)}`,
      );
    }
    this.dimensions = dimensions;
    this.#cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.#dtype = options.dtype ?? 'fp32';
    this.modelId = `nomic-embed-text-v1.5@${String(dimensions)}/${this.#dtype}`;
  }

  /**
   * Loads and caches the ONNX pipeline. Idempotent and safe to call concurrently —
   * the promise itself is the cache, so two simultaneous first calls share one load.
   */
  async warm(): Promise<void> {
    await this.#load();
  }

  async embed(text: string, task: EmbeddingTask = 'document'): Promise<Float32Array> {
    const [only] = await this.embedBatch([text], task);
    if (only === undefined) throw new Error('embedBatch returned no vector for a single input');
    return only;
  }

  async embedBatch(texts: readonly string[], task: EmbeddingTask = 'document'): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.#load();
    const prefix = TASK_PREFIX[task];
    const tensor = await extractor(
      texts.map((t) => prefix + t),
      { pooling: 'mean', normalize: false },
    );
    const flat = tensor.data as Float32Array;
    const width = tensor.dims[tensor.dims.length - 1] ?? NOMIC_NATIVE_DIMENSIONS;
    return texts.map((_, i) => matryoshkaProject(flat.subarray(i * width, (i + 1) * width), this.dimensions));
  }

  #load(): Promise<FeatureExtractionPipeline> {
    if (this.#pipeline === undefined) {
      env.cacheDir = this.#cacheDir;
      env.allowLocalModels = false;
      this.#pipeline = pipeline('feature-extraction', NOMIC_MODEL_ID, { dtype: this.#dtype });
    }
    return this.#pipeline;
  }
}
