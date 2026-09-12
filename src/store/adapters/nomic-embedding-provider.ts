/**
 * Default {@link EmbeddingProvider}: `nomic-ai/nomic-embed-text-v1.5` running locally
 * through ONNX via transformers.js.
 *
 * @spec §11 — keeps the MCP server self-contained: no per-write network call, no API
 * key, no rate limit on the write path. The model is Matryoshka-trained, so the same
 * weights serve 768d, 512d, 256d, 128d or 64d as a dimension config knob rather than a
 * model swap. This adapter defaults to the widest of them, {@link RERANK_DIMENSIONS},
 * because that is the width the store persists and every narrower width is recoverable
 * from it by {@link truncateEmbedding} without the model — so narrowing the ANN index
 * later is an index rebuild, and only widening is the re-embed.
 *
 * @spec §5.10 — the write path budget is one embedding plus one small-model call in
 * roughly a second, which is why the model handle is created once and cached: a cold
 * `pipeline()` costs seconds, a warm `embed()` costs milliseconds.
 *
 * The dimension pins and the Matryoshka projection this adapter relies on live in
 * {@link ../nomic-dimensions.js}, a leaf module the store also imports directly so
 * that opening the store never pulls transformers.js into cold start. See that
 * module's docblock for why the split exists.
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

import type { EmbeddingProvider, EmbeddingTask } from '../ports/embedding-provider.js';
import {
  NOMIC_NATIVE_DIMENSIONS,
  NOMIC_SUPPORTED_DIMENSIONS,
  PINNED_DIMENSIONS,
  RERANK_DIMENSIONS,
  matryoshkaProject,
  truncateEmbedding,
} from '../nomic-dimensions.js';
import type { NomicDimensions } from '../nomic-dimensions.js';

export {
  NOMIC_NATIVE_DIMENSIONS,
  NOMIC_SUPPORTED_DIMENSIONS,
  PINNED_DIMENSIONS,
  RERANK_DIMENSIONS,
  matryoshkaProject,
  truncateEmbedding,
};
export type { NomicDimensions };

/** Hugging Face repo id of the default model. */
export const NOMIC_MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';

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
   * Matryoshka output width. Defaults to {@link RERANK_DIMENSIONS} — the width the
   * store persists — and deliberately not to {@link PINNED_DIMENSIONS}, which is
   * spike S2's pin for the *int8 ANN index* rather than for anything a provider
   * produces.
   *
   * The store is handed one vector and derives the index copy from it itself, by
   * Matryoshka slice and quantization. So a provider defaulting to the index width
   * hands over a vector that is already the derived form, and {@link truncateEmbedding}
   * only narrows: widening it back to the stored width needs the model again. At the
   * wider default every narrower width remains reachable for free, which is what
   * keeps the ANN width an index rebuild rather than a re-embed.
   *
   * Pass a narrower supported width explicitly to get one — measurement harnesses do.
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
 * Local ONNX embedding provider.
 *
 * The transformers.js pipeline is loaded lazily on first use and reused for the
 * lifetime of the instance, so a long-lived process pays the cold start once.
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
    const dimensions = options.dimensions ?? RERANK_DIMENSIONS;
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
