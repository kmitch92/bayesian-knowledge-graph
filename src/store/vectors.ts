/**
 * §11 vector plumbing: two copies of every embedding, at two widths, for two jobs.
 *
 * "Claim embeddings stored quantized (int8/PQ) as node properties for SIMD-cheap
 * in-traversal scoring; full precision retained for final rerank only."
 *
 * The full-precision copy is persisted as a raw little-endian f32 blob at
 * {@link STORED_VECTOR_DIMENSIONS}; migration 0 is final on that width. The
 * narrow copy is derived from it — Matryoshka slice, then int8 quantize — at
 * {@link ANN_INDEX_DIMENSIONS}, and is *rebuildable*: slicing the stored f32
 * copy reproduces it exactly, so the ANN width stays a reversible decision.
 *
 * Quantization uses a per-vector max-abs scale rather than a fixed [-1, 1] one.
 * A 512d unit vector's components sit around 0.04, so a fixed scale would spend
 * six of the 127 available levels and the dequantized copy would land near 0.9987
 * cosine of its source — inside the letter of the int8 tolerance but well below
 * what the §5.3 candidate floor deserves. Max-abs scaling uses the full range and
 * lands at ~0.99997. The scale is deliberately *not* persisted: `truncateEmbedding`
 * (in {@link ./nomic-dimensions.js}) L2-normalizes unconditionally after slicing,
 * so every source vector reaching this module is unit-norm by enforcement, not by
 * an unchecked assumption about the `EmbeddingProvider` contract — renormalizing
 * the int8 copy recovers it, which is also what keeps the reported cosine honest.
 *
 * @spec §5.3, §11
 */

import { PINNED_DIMENSIONS, RERANK_DIMENSIONS, truncateEmbedding } from './nomic-dimensions.js';
import { DimensionMismatchError } from './errors.js';

/**
 * Width of the full-precision copy every vector arrives and leaves by, and the
 * width migration 0 pins its f32 column at. Spike S2's rerank pin.
 *
 * @spec §11
 */
export const STORED_VECTOR_DIMENSIONS = RERANK_DIMENSIONS;

/**
 * Width of the int8 ANN index. Spike S2's retrieval pin, and rebuildable from
 * {@link STORED_VECTOR_DIMENSIONS} by Matryoshka slice.
 *
 * @spec §5.3, §11
 */
export const ANN_INDEX_DIMENSIONS = PINNED_DIMENSIONS;

/** The largest magnitude a signed byte can carry, and so the max-abs target. */
const INT8_MAX = 127;

/**
 * Refuses a vector at any width but the one migration 0 pinned.
 *
 * The schema deliberately leaves `embedding` unconstrained (A22), so this is the
 * only place a wrong-width vector can be caught before it reaches an index that
 * would score it against vectors it has no geometric relationship with.
 *
 * @spec §11
 */
export const assertStoredWidth = (
  what: string,
  vector: ArrayLike<number>,
): void => {
  if (vector.length !== STORED_VECTOR_DIMENSIONS)
    throw new DimensionMismatchError(what, STORED_VECTOR_DIMENSIONS, vector.length);
};

/**
 * Packs a vector as a little-endian f32 blob, which is how the rerank copy is
 * persisted. Widening f32 to f64 is exact, so a `number[]` that came from a
 * `Float32Array` survives this round trip bit-for-bit.
 *
 * @spec §11
 */
export const encodeFloatVector = (vector: ArrayLike<number>): Buffer => {
  const floats = Float32Array.from(vector as ArrayLike<number>);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
};

/**
 * Unpacks a little-endian f32 blob. Copies rather than viewing the blob in
 * place: better-sqlite3 hands back pooled buffers whose byte offset carries no
 * alignment guarantee, and a `Float32Array` view needs one.
 *
 * @spec §11
 */
export const decodeFloatVector = (blob: Uint8Array): Float32Array => {
  const bytes = new Uint8Array(blob.byteLength);
  bytes.set(blob);
  return new Float32Array(bytes.buffer);
};

/**
 * Packs several equal-width vectors end to end, which is how an entity's 1–4
 * facet centroids are persisted in one column.
 *
 * @spec §3.1
 */
export const encodeFloatVectors = (vectors: readonly ArrayLike<number>[]): Buffer =>
  Buffer.concat(vectors.map((vector) => encodeFloatVector(vector)));

/**
 * Splits a concatenated facet blob back into one vector per centroid.
 *
 * @spec §3.1
 */
export const decodeFloatVectors = (blob: Uint8Array): Float32Array[] => {
  const flat = decodeFloatVector(blob);
  const out: Float32Array[] = [];
  for (let offset = 0; offset < flat.length; offset += STORED_VECTOR_DIMENSIONS)
    out.push(flat.slice(offset, offset + STORED_VECTOR_DIMENSIONS));
  return out;
};

/**
 * Quantizes a vector to int8 on a per-vector max-abs scale.
 *
 * The scale is not recorded anywhere. Cosine is scale-invariant, and
 * {@link dequantizeAnnVector} recovers the unit-norm original by renormalizing,
 * so nothing downstream needs it.
 *
 * @spec §11
 */
export const quantizeToInt8 = (vector: Float32Array): Int8Array => {
  const out = new Int8Array(vector.length);
  let maxAbs = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const magnitude = Math.abs(vector[i]!);
    if (magnitude > maxAbs) maxAbs = magnitude;
  }
  if (maxAbs === 0) return out;

  const scale = INT8_MAX / maxAbs;
  for (let i = 0; i < vector.length; i += 1) {
    const level = Math.round(vector[i]! * scale);
    out[i] = level > INT8_MAX ? INT8_MAX : level < -INT8_MAX ? -INT8_MAX : level;
  }
  return out;
};

/**
 * Recovers the unit-norm vector an int8 ANN copy was quantized from.
 *
 * Renormalization, not division by a stored scale: the source is unit-norm by
 * the `EmbeddingProvider` contract, so the int8 copy's own norm *is* the scale.
 * This is also the §11 clamp's other half — a dequantized int8 vector is not
 * unit-norm, and scoring it as though it were is what produces the similarities
 * above 1.0 that silently break every cosine threshold in §15.
 *
 * @spec §11
 */
export const dequantizeAnnVector = (quantized: Int8Array): Float32Array => {
  const out = new Float32Array(quantized.length);
  let norm = 0;
  for (let i = 0; i < quantized.length; i += 1) norm += quantized[i]! * quantized[i]!;
  if (norm === 0) return out;

  const inverse = 1 / Math.sqrt(norm);
  for (let i = 0; i < quantized.length; i += 1) out[i] = quantized[i]! * inverse;
  return out;
};

/**
 * Derives the narrow in-graph copy from a full-precision vector: Matryoshka
 * slice to {@link ANN_INDEX_DIMENSIONS}, then int8 quantize.
 *
 * @spec §5.3, §11
 */
export const toAnnVector = (vector: Float32Array): Int8Array =>
  quantizeToInt8(truncateEmbedding(vector, ANN_INDEX_DIMENSIONS));

/**
 * Copies an int8 blob out of a pooled buffer into a standalone `Int8Array`.
 *
 * @spec §11
 */
export const decodeInt8Vector = (blob: Uint8Array): Int8Array => {
  const bytes = new Int8Array(blob.byteLength);
  bytes.set(new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength));
  return bytes;
};

/**
 * Packs an int8 vector for binding into a `vec0` column.
 *
 * @spec §11
 */
export const encodeInt8Vector = (vector: Int8Array): Buffer =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

/**
 * Holds a reported similarity inside the closed interval a cosine can occupy.
 *
 * A score outside [-1, 1] breaks the §5.3 candidate floor, the §8.2 diameter cap
 * δ_max and every §15 threshold expressed as a cosine — quietly, because such a
 * score reads as an unusually confident match rather than as an error.
 *
 * @spec §5.3, §8.2, §11, §15
 */
export const clampCosine = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
};
