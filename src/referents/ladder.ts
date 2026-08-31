/**
 * §5.2's resolution ladder.
 *
 * ```
 * exact name → mention index → embedding match → LLM tiebreak
 * ```
 *
 * The ladder is a cost claim as much as a correctness one. §5 budgets one
 * embedding and one small-model call for the entire write path, so each rung
 * must be *reached* only when the rung above it declined: a mention the index
 * already answers costs zero model calls, and a ladder that embedded eagerly
 * would spend the budget on questions nobody asked. Every rung below is
 * therefore behind an early return, not behind a filter.
 *
 * The two model-shaped steps are ports, never imports. The embedding provider
 * arrives as {@link EmbeddingProvider} and the tiebreak as {@link Adjudicator},
 * which is what keeps `@huggingface/transformers` — 250MB and most of a second —
 * off this module's import path and out of every process that only writes.
 *
 * @spec §5.2, §5.3, §11, §15
 */

import type { EmbeddingProvider } from '../store/ports/embedding-provider.js';
import type { GraphStore } from '../store/index.js';

/**
 * §15's `cos_floor`: below this, a gloss hit is not a match.
 *
 * A floor, not a ranking. The nearest referent in the index is always *some*
 * referent, and resolving to it regardless is how one graph becomes one node.
 *
 * @spec §5.2, §15
 */
export const COSINE_FLOOR = 0.7;

/** §15's `cand_cap`: how many gloss neighbours the ladder will look at. @spec §5.2, §15 */
export const CANDIDATE_CAP = 15;

/** Which rung of §5.2's ladder answered — `minted` when none of them did. @spec §5.2 */
export type ResolutionRung = 'exact' | 'mention-index' | 'gloss-embedding' | 'tiebreak' | 'minted';

/**
 * How one noun in one message resolved.
 *
 * Reported per mention rather than per message because §5.2 runs the ladder per
 * noun, and a claim naming three nouns can answer at three different rungs.
 *
 * @spec §5.2
 */
export interface Resolution {
  readonly surfaceForm: string;
  readonly referentId: string;
  readonly rung: ResolutionRung;
}

/** One referent the gloss channel could not rule out. @spec §5.2 */
export interface TiebreakCandidate {
  readonly referentId: string;
  /** The referent's derived name, which is what the model can actually judge. @spec §3.1 */
  readonly name: string;
  /** Cosine against the surface form. Always at or above {@link COSINE_FLOOR}. @spec §15 */
  readonly cosine: number;
}

/**
 * §5.2's last rung, as a question.
 *
 * The claim text travels as `context` because coreference is not decidable from
 * a noun phrase alone: "the retry knob" picks out different referents in a claim
 * about budgets than in one about policies.
 *
 * @spec §5.2
 */
export interface TiebreakRequest {
  readonly surfaceForm: string;
  readonly context: string;
  readonly candidates: readonly TiebreakCandidate[];
}

/**
 * The model's answer, and its right to decline.
 *
 * `unresolved` is not a failure: §5.2 answers fragmentation by minting into a
 * lifecycle, so a model that cannot choose leaves the ladder to mint a
 * provisional referent rather than forcing a wrong merge that §8.4 would then
 * have to split.
 *
 * @spec §5.2, §8.4
 */
export type TiebreakVerdict =
  | { readonly outcome: 'resolved'; readonly referentId: string }
  | { readonly outcome: 'unresolved' };

/**
 * The small-model call §5.2 escalates to when the embedding cannot choose.
 *
 * A port, so the write path can run with no model at all — a graph with no
 * adjudicator resolves three rungs and mints on the fourth, which is a humbler
 * graph and not a broken one.
 *
 * @spec §5.2, §11
 */
export interface Adjudicator {
  tiebreakReferent(request: TiebreakRequest): Promise<TiebreakVerdict>;
}

/** What the ladder found, before anything is written. @spec §5.2 */
export type LadderOutcome =
  | { readonly rung: Exclude<ResolutionRung, 'minted'>; readonly referentId: string }
  | { readonly rung: 'minted' };

/** Everything the ladder needs, and nothing it could use to write. @spec §5.2 */
export interface LadderContext {
  readonly store: GraphStore;
  readonly embeddings: EmbeddingProvider;
  readonly adjudicator: Adjudicator;
  /** §15's `cos_floor`, overridable because §13 replay is what tunes it. @spec §15 */
  readonly cosineFloor?: number | undefined;
}

/**
 * Climbs the ladder for one surface form.
 *
 * Read-only: resolving decides nothing about the ledger, and the caller that
 * records the outcome is the caller that knows whether the claim it belongs to
 * survived. What comes back is a rung and a referent, or the news that four
 * rungs declined.
 *
 * @spec §5.2
 */
export const resolveSurfaceForm = async (
  context: LadderContext,
  surfaceForm: string,
  claimText: string,
): Promise<LadderOutcome> => {
  const { store, embeddings, adjudicator } = context;
  const floor = context.cosineFloor ?? COSINE_FLOOR;

  // Rung 1 and 2 share one read: the store reports canonical-name matches first
  // and flags which of the two happened, so the ladder need not ask twice.
  const [mentioned] = store.findReferentsByMention(surfaceForm);
  if (mentioned !== undefined)
    return {
      rung: mentioned.canonicalName ? 'exact' : 'mention-index',
      referentId: mentioned.referentId,
    };

  // Rung 3. The surface form is a *query* against stored glosses — §5.2's read is
  // asymmetric, and the task is the only signal a provider gets about that.
  const probe = await embeddings.embed(surfaceForm, 'query');
  const near = store
    .searchReferentGlosses({ embedding: probe, limit: CANDIDATE_CAP })
    .filter((hit) => hit.cosine >= floor);
  if (near.length === 0) return { rung: 'minted' };
  if (near.length === 1) return { rung: 'gloss-embedding', referentId: near[0]!.referentId };

  // Rung 4, and only here: two candidates clearing the floor is the one question
  // an embedding has already failed to answer.
  const candidates: TiebreakCandidate[] = near.map((hit) => ({
    referentId: hit.referentId,
    name: store.getEntity(hit.referentId)?.name ?? hit.referentId,
    cosine: hit.cosine,
  }));
  const verdict = await adjudicator.tiebreakReferent({
    surfaceForm,
    context: claimText,
    candidates,
  });
  return verdict.outcome === 'resolved'
    ? { rung: 'tiebreak', referentId: verdict.referentId }
    : { rung: 'minted' };
};
