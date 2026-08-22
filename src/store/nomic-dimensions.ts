/**
 * Nomic embedding dimension pins and the Matryoshka projection.
 *
 * Split out of {@link ./adapters/nomic-embedding-provider.ts} so a process that
 * only opens the store — {@link ./vectors.ts} needs {@link PINNED_DIMENSIONS},
 * {@link RERANK_DIMENSIONS} and {@link truncateEmbedding} on every open — never
 * pays for the `@huggingface/transformers` import the adapter also carries.
 * Before this split, opening the store dragged an ONNX runtime into cold start
 * for a lookup that never embeds anything. §7.6 requires the PreToolUse ambient
 * path to be a pure index lookup — no LLM call, no embedding call — and spike S3
 * gates it under 15ms; a store that pays transformers.js's load cost cannot meet
 * that gate.
 *
 * This module imports nothing beyond the standard library, so both the store and
 * the adapter can sit on top of it without either paying for the other's
 * dependency. The adapter re-exports everything here for its existing callers;
 * there remains exactly one implementation of each.
 *
 * @spec §5.10, §7.6, §11
 */

/** Native output width of the model, before Matryoshka truncation. */
export const NOMIC_NATIVE_DIMENSIONS = 768;

/**
 * Widths the Matryoshka objective was trained for. Truncating to an untrained width
 * is not an error the model reports — it just degrades quietly — so the adapter's
 * constructor rejects anything outside this set.
 */
export const NOMIC_SUPPORTED_DIMENSIONS = [768, 512, 256, 128, 64] as const;

export type NomicDimensions = (typeof NOMIC_SUPPORTED_DIMENSIONS)[number];

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
 * L2-normalizes unconditionally after slicing, regardless of the source vector's
 * norm — this is an enforcement, not a pass-through of an assumption the caller is
 * trusted to have met. {@link ./vectors.ts}'s unpersisted int8 quantization scale
 * depends on this: it recovers the original by renormalizing the quantized copy,
 * which is only safe because every vector reaching it left here unit-norm.
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
