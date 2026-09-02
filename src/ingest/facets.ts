/**
 * §3.1's facet centroids, moved by the write path.
 *
 * §3.1 gives every referent *"1–4 facet centroids"* and §9 says how they move:
 * an incremental mean, O(1) per attached claim, with re-clustering left to a
 * calendar-clock job. They are the geometry Mode C retrieval reads, so a
 * referent whose facets stay empty however much is claimed about it is not a
 * cheap approximation of its geometry — it is none of it.
 *
 * Four decisions per attachment:
 *
 * ```
 * for which referents   every one the claim named, anchor or merely referenced
 * from which vector     the claim's own stored embedding, never the referent's gloss
 * into which centroid   the nearest above the floor; a new one below it while
 *                       fewer than four exist; the nearest unconditionally once
 *                       four do
 * how it moves          m ← m + (x − m)/(n + 1), with n read back from the store
 * ```
 *
 * Spine claims are excluded in principle: existence, naming and containment
 * payloads mint and place a referent; they are not knowledge *about* it, and a
 * facet set that absorbed them would summarize the scaffolding rather than the
 * subject. In practice none of those three ever reach this module by their own
 * path — they are written by the spine writer, and only a claim message runs
 * through here — so the guard below defends a narrower case: a claim whose
 * *text* happens to encode a spine envelope. See {@link attachClaimToFacets}.
 *
 * @spec §3.1, §5.3, §9, §13, §15
 */

import type { ClaimRecord, GraphStore } from '../store/index.js';
import { decodeSpineClaim } from '../referents/spine.js';

/**
 * §15's `facet_assign_floor`: below this, a claim is about something the
 * referent's existing facets do not cover.
 *
 * A floor, not a ranking — the nearest of four centroids is always *some*
 * centroid, and joining it regardless is how a referent's geometry becomes one
 * blurred mean of everything ever said. §3.1's remaining budget, when there is
 * any, is spent on a centroid of its own instead.
 *
 * ⚙ per §13: replays tune it, so it is a named constant in the module that owns
 * the decision it governs — the same reason `COSINE_FLOOR` and `TAU_PROMOTE` are
 * named constants. Unlike those two it is not yet threaded through
 * `openIngest`'s options as a per-call override; a retuning replay edits this
 * literal rather than an argument, until that wiring exists.
 *
 * @spec §3.1, §13, §15
 */
export const FACET_ASSIGN_FLOOR = 0.5;

/**
 * §3.1's ceiling: *"1–4 facet centroids"*.
 *
 * Restated rather than read off the store's schema, and safe to restate in only
 * one direction: `updateReferentFacets` refuses a fifth centroid, so a ceiling
 * that drifted *upwards* here would be a refused write rather than a silent
 * divergence, and one that drifted downwards spends less of a budget than §3.1
 * allows. Nothing about it can go quietly wrong.
 *
 * @spec §3.1
 */
const FACET_CEILING = 4;

/**
 * The cosine between two stored vectors, in full precision.
 *
 * Not the store's ANN cosine: that one is measured over int8 copies and is a
 * retrieval channel's answer. Assignment reads the f32 centroids themselves,
 * because the centroid it picks is the one it is about to rewrite.
 *
 * @spec §9, §11
 */
const cosine = (left: readonly number[], right: readonly number[]): number => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [at, value] of left.entries()) {
    const other = right[at] ?? 0;
    dot += value * other;
    leftNorm += value * value;
    rightNorm += other * other;
  }
  const scale = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return scale === 0 ? 0 : dot / scale;
};

/** Which of a referent's centroids sits nearest a claim, and how near. @spec §3.1 */
interface Nearest {
  readonly at: number;
  readonly cosine: number;
}

/**
 * The nearest centroid, or `undefined` for a referent that has none yet.
 *
 * Ties keep the earlier centroid, which is the older one: the comparison is
 * strict, so an exact tie is decided by arrival rather than by nothing at all.
 * No arrangement in this system produces one on purpose.
 *
 * @spec §3.1
 */
const nearestCentroid = (
  centroids: readonly (readonly number[])[],
  embedding: readonly number[],
): Nearest | undefined =>
  centroids.reduce<Nearest | undefined>((best, centroid, at) => {
    const measured = cosine(centroid, embedding);
    return best === undefined || measured > best.cosine ? { at, cosine: measured } : best;
  }, undefined);

/**
 * Folds one claim into one referent's facets.
 *
 * The counts are re-derived from the centroids rather than trusted by length:
 * {@link GraphStore.getFacetCounts} answers with nothing at all when what it read
 * does not line up, and a centroid whose count cannot be read is honestly the
 * mean of one claim — the same default the store itself takes when a caller
 * offers no counts.
 *
 * @spec §3.1, §9
 */
const foldIntoFacets = (
  store: GraphStore,
  referentId: string,
  embedding: readonly number[],
): void => {
  const entity = store.getEntity(referentId);
  if (entity === undefined) return;

  const centroids = entity.facets;
  const stored = store.getFacetCounts(referentId);
  const counts = centroids.map((_, at) => stored[at] ?? 1);

  const nearest = nearestCentroid(centroids, embedding);
  const joins =
    nearest !== undefined &&
    (nearest.cosine >= FACET_ASSIGN_FLOOR || centroids.length >= FACET_CEILING);

  if (!joins) {
    store.updateReferentFacets(referentId, [...centroids, [...embedding]], [...counts, 1]);
    return;
  }

  const joined = nearest.at;
  const n = counts[joined]!;
  const moved = centroids[joined]!.map(
    (value, at) => value + ((embedding[at] ?? 0) - value) / (n + 1),
  );
  store.updateReferentFacets(
    referentId,
    centroids.map((centroid, at) => (at === joined ? moved : centroid)),
    counts.map((count, at) => (at === joined ? count + 1 : count)),
  );
};

/**
 * Moves the facets of every referent one claim attached to.
 *
 * Called once the claim's `ABOUT` edges are down, and reading the claim's own
 * stored embedding: §5.3 embeds an incoming claim exactly once, and the vector a
 * facet mean is computed from has to be the vector the ledger kept, or the mean
 * summarizes a claim nobody can read back.
 *
 * The `decodeSpineClaim` guard below is not what keeps attestations, naming and
 * containment claims out of a referent's facets — none of those ever reach this
 * function. They are written through the spine writer, and the only caller here
 * is `submitClaim`, so the guard's one reachable input is an ordinary claim
 * message whose *text* happens to decode as a spine envelope: indistinguishable
 * from a real one once it is a ledger row. That case is worth defending because
 * `rebuild-index` decodes text across the *whole* ledger with no memory of which
 * message type wrote a row — without this guard, such a row would be knowledge
 * on the way in (folded into facets here) and scaffolding on the way back
 * (skipped by every rebuild pass), the two disagreeing about what the row is.
 *
 * A retired claim's contribution is not backed out either — §9 hands that
 * repair to the calendar-clock re-clustering, and an O(1) mean has no members
 * to subtract one from.
 *
 * @spec §3.1, §5.3, §6.1, §9
 */
export const attachClaimToFacets = (
  store: GraphStore,
  claim: ClaimRecord,
  referentIds: Iterable<string>,
): void => {
  if (decodeSpineClaim(claim.text) !== undefined) return;
  for (const referentId of referentIds) foldIntoFacets(store, referentId, claim.embedding);
};
