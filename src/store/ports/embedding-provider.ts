/**
 * Embedding provider port.
 *
 * @spec §11 — "Claim embeddings stored quantized (int8/PQ) as node properties for
 * SIMD-cheap in-traversal scoring; full precision retained for final rerank only."
 * This port is the *full precision* boundary: it always hands back f32. Quantization
 * is a store concern (the adapter never knows how its output will be packed), and
 * the rerank path reads the f32 copy the store kept alongside the quantized one.
 *
 * @spec §5.3 — Stage 2 embeds the incoming claim once, then runs ANN over claim
 * embeddings above a ~0.70 cosine floor. Every vector this port returns is
 * L2-normalized, so cosine similarity is a plain dot product and the floor is
 * directly comparable across providers.
 *
 * @spec §5.2 — Stage 1's resolution ladder ends in an embedding match against entity
 * glosses. That is an *asymmetric* retrieval (short query phrasing against a
 * name-plus-gloss document), which is why {@link EmbeddingTask} exists: providers
 * trained with task prefixes (nomic) or input types (Voyage, OpenAI) need to know
 * which side of the comparison they are embedding. Symmetric claim-to-claim dedupe
 * uses `'document'` on both sides.
 */

/**
 * Which side of a retrieval comparison a text sits on.
 *
 * - `document` — stored content: claim text, entity name + gloss. The default,
 *   and what symmetric claim-to-claim dedupe (§5.3) uses on *both* sides.
 * - `query` — a search phrasing looking for stored content: the scope target in
 *   the §5.2 resolution ladder, and the user question in §7.2 Mode B entry.
 *
 * Providers with no notion of asymmetry ignore this. Providers that have one MUST
 * honour it — using the wrong side costs measurable top-1 accuracy on §5.2.
 *
 * @spec §5.2, §5.3, §7.2
 */
export type EmbeddingTask = 'document' | 'query';

/**
 * Produces dense vectors for claim text and entity glosses.
 *
 * Implementations MUST guarantee:
 * - every returned vector has exactly {@link EmbeddingProvider.dimensions} elements;
 * - every returned vector is L2-normalized (cosine === dot product);
 * - `embedBatch` returns vectors positionally aligned with its input;
 * - the same `(text, task)` pair yields the same vector for the lifetime of a
 *   given `modelId` — the store persists these, so drift silently corrupts ANN.
 *
 * @spec §11
 */
export interface EmbeddingProvider {
  /**
   * Stable identity of the model *and* its output geometry, e.g.
   * `nomic-embed-text-v1.5@256`. Vectors from different `modelId`s are not
   * comparable, so the store records this against the vector index: changing it
   * is a re-embed migration, not a config tweak.
   *
   * @spec §11
   */
  readonly modelId: string;

  /**
   * Vector width. Fixed for the lifetime of the instance and pinned into the
   * store's vector index at migration time.
   *
   * @spec §11
   */
  readonly dimensions: number;

  /**
   * Embeds a single text. The write path's per-claim call (§5.3, one embedding
   * plus one small-model adjudication inside the ~1s budget).
   *
   * @spec §5.3
   */
  embed(text: string, task?: EmbeddingTask): Promise<Float32Array>;

  /**
   * Embeds many texts, positionally aligned with `texts`. Used by bulk spine
   * ingest, which embeds one gloss per parsed entity in a single pass.
   *
   * @spec §3.1, §5.2
   */
  embedBatch(texts: readonly string[], task?: EmbeddingTask): Promise<Float32Array[]>;
}
