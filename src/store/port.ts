/**
 * The `GraphStore` port: everything the rest of kg-mcp is allowed to know about
 * persistence.
 *
 * The port is deliberately **mechanical**. It records and it reports; it does
 * not decide. No tier is turned into a prior here, no taint is turned into a
 * weight, no `w = tier × episode_cap × taint` (§4.2) is computed — those are
 * write-path policy (§5), and baking them into the storage layer would put the
 * numbers §5.8 exists to tune offline somewhere no replay log can reach them.
 * {@link GraphStore.decayEvidence} takes the prior as a parameter for exactly
 * this reason: §4.5 says decay pulls toward the prior, and which prior a claim
 * has is the write path's business.
 *
 * @spec §3.1, §3.2, §3.3, §3.5, §4.5, §5.1, §5.2, §5.7, §5.8, §6.1, §7.5, §11
 */

import type {
  Claim,
  ClaimEdgeKind,
  ClaimStatus,
  Entity,
  Evidence,
} from '../schema/index.js';

/**
 * Which truth-maintenance machinery maintains a node (diagram §6).
 *
 * Derived from {@link Entity} rather than restated: the referent index
 * materializes the regime its existence claim was written under, and two
 * declarations of one vocabulary are two things that can drift apart.
 *
 * @spec §3.1, §3.2, §3.5
 */
export type Regime = Entity['regime'];

/**
 * The ledger row: §3.5's claim, plus the regime that decides whether it has a
 * posterior at all.
 *
 * Declared here rather than in `src/schema/` because the exclusivity is a
 * *storage* rule — "nothing is ever both, nothing is ever neither" is enforced
 * by a table CHECK and by {@link GraphStore.putClaim}, not by a shape. §3.5's
 * `Claim` keeps its required `Evidence`, and a consumer that needs to tell a
 * view claim from an evidence one reads the store rather than parsing.
 *
 * The regime rides on the claim rather than being read off its referent: the
 * referent index is a view the ledger is forbidden to depend on, so a claim has
 * to still know its own regime after {@link GraphStore.clearViews}.
 *
 * @spec §3.2, §3.5
 */
export type ClaimRecord = Omit<Claim, 'evidence'> & {
  readonly regime: Regime;
  /** `null` in the view regime, where re-running the source must inflate nothing. */
  readonly evidence: Evidence | null;
};

/**
 * One surface form a referent has been named by.
 *
 * Many to one, and deliberately not one to many: §5.2 resolution asks "which
 * referent is this called?", and an alias list on the referent row could only
 * answer the other question.
 *
 * @spec §3.1, §3.5, §5.2
 */
export interface Mention {
  /** The text as it was written — not normalized, not folded, not deduped by case. */
  readonly surfaceForm: string;
  /** The referent it names. Not checked against the referent index: that index is a view. */
  readonly referentId: string;
  /**
   * The support behind the naming, as the caller read it off the naming claim.
   *
   * Absolute, never a delta — see {@link GraphStore.putMention}. Non-negative and
   * finite; a sum of §4.2 observation weights is neither negative nor infinite,
   * and a zero is what a tainted episode contributes.
   *
   * @spec §3.1, §4.2
   */
  readonly weight: number;
}

/**
 * One referent a surface form has been recorded as naming, and whether that form
 * is the referent's own derived name.
 *
 * The flag is what separates §5.2's first rung from its second: an exact hit on
 * `entities.name` is a canonical-name match, an exact hit anywhere else in the
 * mention index is an alias match, and the ladder treats them differently. The
 * store reports which of the two happened; it does not rank them into an answer.
 *
 * @spec §3.1, §5.2
 */
export interface MentionCandidate {
  readonly referentId: string;
  /** `true` when the queried form is exactly this referent's `name`. */
  readonly canonicalName: boolean;
}

/**
 * One surface form a referent has been named by, with the support behind it.
 *
 * §3.1 makes `entities.name` "the most-corroborated surface form", and calls this
 * index the materialization of "identity claims over names" — so the number is a
 * claim's support, not a count of uses. The derivation still belongs above the
 * store: this hands over the tally it needs rather than the verdict.
 *
 * The weight *is* evidence, which is the reversal F2 made. It is the α of the
 * naming claim for this pair, so §4.2's episode cap, §4.4's independence discount
 * and §5.1's replay-zero have all already been applied to it by the time it
 * reaches this row. Naming something nine times in one episode makes a name
 * insisted upon, and this column is what stops insistence outranking four namings
 * from four separate episodes.
 *
 * The store does not compute it and cannot check it. Every weight here is a cache
 * of a number the ledger holds, refilled from the naming claims by
 * `rebuild-index`.
 *
 * @spec §3.1, §4.2, §4.4, §5.2
 */
export interface MentionTally {
  readonly surfaceForm: string;
  /** The naming claim's support for this pair. Non-negative; fractional in general. @spec §4.2 */
  readonly weight: number;
}

/**
 * One edge of the containment spine: a parent referent and a direct child.
 *
 * Materialized from containment claims, and kept apart from
 * {@link StructuralEdge} on purpose — see {@link GraphStore.putContainment}.
 *
 * @spec §3.1, §3.3
 */
export interface Containment {
  readonly parent: string;
  readonly child: string;
}

/** Where the graph lives. `:memory:` opens a private, unshared database. @spec §11 */
export interface GraphStoreOptions {
  /** SQLite database path, or `:memory:`. */
  readonly path: string;
  /**
   * How long this store waits for another process's write lock before giving up
   * with a `StoreBusyError`. Defaults to {@link BUSY_TIMEOUT_MS}.
   *
   * Per-store rather than a constant because §5.7's generous default is chosen
   * for the write path, where a collision has to resolve as a wait or evidence
   * is dropped — and that is the wrong trade for a caller that must not stall.
   * A git hook that would block a commit, a health check, a test fixture: each
   * would rather be told it is contended than wait thirty seconds to find out.
   *
   * @spec §5.7
   */
  readonly busyTimeoutMs?: number | undefined;
}

/** A lifecycle transition, optionally stamping the instant it invalidated the claim. @spec §6.1 */
export interface ClaimStatusChange {
  readonly claimId: string;
  readonly status: ClaimStatus;
  /** Set when the transition retires the claim; left alone otherwise. @spec §3.2, §6.1 */
  readonly invalidatedAt?: string | undefined;
}

/**
 * Which episode moved a posterior, and over what pathway.
 *
 * §4.2 weighs an observation by `tier × episode_cap × taint`, and the episode cap
 * is a function of how many times this episode has already contributed to *this
 * claim*. For a claim the ingest port can reach through an `ABOUT` edge that
 * count is answerable by walking `getClaimsAbout`; for a naming claim, which
 * carries no `ABOUT` edge at all (§5.3's structural channel retrieves knowledge
 * *about* a referent, and what a referent is called is not that), it is not.
 *
 * So the count comes off the claim's own provenance instead, and this is what
 * puts it there: an increment that names its episode appends a provenance row
 * saying so, and the next increment from that episode reads its own cap off the
 * ledger rather than off a counter no rebuild could reproduce.
 *
 * @spec §3.5, §4.2, §4.4, §4.7
 */
export interface EvidenceWitness {
  /** The episode this contribution belongs to — §4.4's unit of independence. @spec §4.4 */
  readonly episodeId: string;
  /** §4.7's pathway half, when the contribution has one. @spec §3.5, §4.7 */
  readonly channel?: string | undefined;
  /** The other pathway half. @spec §3.5, §4.7 */
  readonly agent?: string | undefined;
}

/**
 * One weighted contribution to a claim's posterior.
 *
 * Both parameters are optional and both are non-negative: §4.5 decay is the only
 * path that moves evidence downward, and it has its own operation.
 *
 * @spec §4.1, §4.2, §5.7
 */
export interface EvidenceIncrement {
  readonly claimId: string;
  /** Non-negative, finite. Fractional — §15 tier weights and episode caps are not integers. */
  readonly alpha?: number | undefined;
  /** Non-negative, finite. */
  readonly beta?: number | undefined;
  /**
   * Who is contributing, when the caller wants the contribution counted.
   *
   * Optional, and its absence is not a defect: an increment with no witness moves
   * the posterior and records nothing, which is every increment written before
   * F2. What a witness buys is the provenance row {@link EvidenceWitness}
   * explains, written in the same transaction as the α.
   *
   * @spec §3.5, §4.2
   */
  readonly witness?: EvidenceWitness | undefined;
}

/**
 * One commit's worth of §4.5 churn decay.
 *
 * `prior` is supplied, never derived: the store does not know that inferred-tier
 * claims seed a skeptical β₀ = 2 (§3.2), and it is not the layer that should.
 *
 * @spec §4.5
 */
export interface EvidenceDecay {
  readonly claimId: string;
  /** Retention factor γ ∈ [0, 1]. 1 forgets nothing; 0 collapses straight onto the prior. */
  readonly gamma: number;
  /** The pair decay pulls toward. Both parameters strictly positive. */
  readonly prior: Evidence;
  /** The commit instant, stamped onto the claim as `lastChurnEvent`. */
  readonly at: string;
}

/** An ANN query over claim embeddings. @spec §5.3, §11 */
export interface ClaimSearch {
  /** Full-width query vector, at {@link ANN_INDEX_DIMENSIONS}'s wider sibling. */
  readonly embedding: Float32Array;
  /** Candidate cap. §5.3 unions and dedupes both channels to about fifteen. */
  readonly limit: number;
  /**
   * Audit opt-in. Off by default, because §6.1 takes archived claims out of
   * candidate retrieval entirely — "if ANN surfaces one, that is a bug".
   */
  readonly includeArchived?: boolean | undefined;
}

/** One ANN hit: a claim id and a similarity that is always a real cosine. @spec §5.3, §11 */
export interface ClaimSearchHit {
  readonly claimId: string;
  /** Clamped into [-1, 1]; see {@link clampCosine}. */
  readonly cosine: number;
}

/**
 * An ANN query over referent gloss embeddings — §5.2's last rung.
 *
 * No archive scope, because a referent has no lifecycle to be archived out of:
 * §6.1 statuses live on claims. Its own type rather than a reuse of
 * {@link ClaimSearch} for exactly that reason.
 *
 * @spec §5.2, §11
 */
export interface ReferentGlossSearch {
  /** Full-width query vector, at {@link ANN_INDEX_DIMENSIONS}'s wider sibling. */
  readonly embedding: Float32Array;
  /** Candidate cap. */
  readonly limit: number;
}

/**
 * One gloss hit: a referent id and a similarity that is always a real cosine.
 *
 * No floor is applied here. §15's `cos_floor` is where the resolution ladder
 * stops trusting a match, and a store that pre-filtered by it would be deciding
 * §5.2's question — and would make the floor untunable by §13 replay, since the
 * rejected candidates would never have been recorded.
 *
 * @spec §5.2, §11, §15
 */
export interface ReferentGlossHit {
  readonly referentId: string;
  /** Clamped into [-1, 1]; see {@link clampCosine}. */
  readonly cosine: number;
}

/** Reads that the §6.1 archived filter can be opted out of. @spec §6.1 */
export interface ArchiveScope {
  readonly includeArchived?: boolean | undefined;
}

/** One §3.3 claim edge. `ABOUT` targets an entity; the other five target claims. @spec §3.3 */
export interface ClaimEdge {
  readonly from: string;
  readonly kind: ClaimEdgeKind;
  readonly to: string;
}

/**
 * A parsed entity-to-entity edge as the parser offers it, before the store
 * stamps the source on.
 *
 * `kind` is an open string, not the closed claim-edge vocabulary: structural
 * edges "come deterministically from tree-sitter/LSP, carry no confidence
 * machinery, and are true until the next parse" (principle 2), so the parser's
 * vocabulary is the parser's to extend.
 *
 * @spec §3.3
 */
export interface StructuralEdgeInput {
  readonly kind: string;
  readonly to: string;
}

/** A parsed structural edge. Three fields, and deliberately no fourth: no α, no β. @spec §3.3 */
export interface StructuralEdge {
  readonly from: string;
  readonly kind: string;
  readonly to: string;
}

/** The §5.1 stage-0 dedupe key: hashed normalized text plus the episode it arrived in. @spec §5.1 */
export interface ObservationKey {
  readonly episodeId: string;
  /**
   * The text exactly as Stage 1 normalized it. The store hashes what it is
   * given — collapsing two spellings of one idea is §5.2's job, not this one's.
   */
  readonly normalizedText: string;
}

/** The claims one served response put into a session's retrieval context. @spec §4.3, §7.5 */
export interface TaintRecord {
  readonly sessionId: string;
  readonly claimIds: readonly string[];
}

/** A membership question against a session's taint set. @spec §4.3, §7.5 */
export interface TaintQuery {
  readonly sessionId: string;
  readonly claimId: string;
}

/**
 * One §5.8 replay-log entry.
 *
 * `inputs` and `decision` are opaque to the store. Which stages log what — and
 * the adjudication verdict's obligation to record both claim texts — are
 * write-path decisions; the store's job is to accept a payload, keep it, and
 * hand it back in the order it arrived.
 *
 * @spec §5.8, §13
 */
export interface StageLogEntry {
  readonly episodeId: string;
  readonly stage: string;
  readonly inputs: unknown;
  readonly decision: unknown;
  readonly at: string;
}

/**
 * The persistence boundary for the knowledge graph.
 *
 * @spec §11
 */
export interface GraphStore {
  /**
   * The journal mode the connection actually ended up in. `wal` for a
   * file-backed database — which is what lets separate OS processes share it
   * (§5.7) — and `memory` for `:memory:`, where there is nothing to share.
   *
   * @spec §5.7, §11
   */
  readonly journalMode: string;

  /**
   * Upserts a spine node. An upsert by design: the parser re-derives the
   * structural floor on every parse (§3.3, principle 2).
   *
   * {@link Entity} carries facet centroids but no counts, so a write that changes
   * the centroids records each as a fresh mean of one claim — the only weight it
   * has been told anything about. A write that hands back the centroids already
   * stored leaves the counts alone: it is patching some other field and carrying
   * the facets through, not asserting a new facet set, and §9's incremental mean
   * would be wrong from there on if its denominator quietly reset.
   * {@link GraphStore.updateReferentFacets} is the only caller that sets counts
   * deliberately.
   *
   * @spec §3.1, §9
   */
  putEntity(entity: Entity): void;

  /** Reads a spine node, or `undefined` if it was never written. @spec §3.1 */
  getEntity(id: string): Entity | undefined;

  /**
   * The referent index's ids above `afterId`, ascending, at most `limit` of
   * them.
   *
   * The referent-index half of {@link GraphStore.listClaimIds}, keyset-paginated
   * on the same terms and for the same reason: `rebuild-index` finishes by
   * re-deriving every referent's name from its restored mention cluster, and a
   * rebuild that could only see the first page would leave every referent past
   * it named whatever its minting claim happened to say.
   *
   * @spec §3.1, §11
   */
  listEntityIds(afterId?: string, limit?: number): string[];

  /**
   * Records one surface form for one referent, at the support standing behind it.
   *
   * The weight is **absolute, never a delta**. The naming claim's posterior is
   * where a naming's support lives (see {@link MentionTally}); this row is a cache
   * of it, so a live write refreshes the row *from* that posterior rather than
   * adding to what the row already held. An incrementing API would let the cache
   * and the ledger drift, which is the whole failure this shape exists to remove —
   * a number that only the projection knows is a number `rebuild-index` cannot
   * reproduce.
   *
   * Idempotent on the pair: an episode that names `auth-service` nine times leaves
   * one row, at whatever weight §4.2 left the naming claim on the ninth naming.
   *
   * The referent is not checked. The mention index is a view keyed by referent id,
   * and a view that could refuse a naming is a view deciding what the ledger is
   * allowed to have resolved.
   *
   * @spec §3.1, §3.5, §4.2, §5.2
   */
  putMention(mention: Mention): void;

  /**
   * The referent a surface form names, or `undefined` if nothing has been named
   * by it.
   *
   * Answers with one referent, so it cannot describe an ambiguous form. Reach
   * for {@link GraphStore.findReferentsByMention} on any path where "two things
   * are called this" is a case rather than an accident.
   *
   * @spec §3.1, §5.2
   */
  resolveMention(surfaceForm: string): string | undefined;

  /**
   * Every referent a surface form has been recorded as naming, canonical-name
   * matches first.
   *
   * The plural read {@link GraphStore.resolveMention} is not: the mention index
   * is keyed `(surface_form, referent_id)` precisely so a form that has come to
   * name two referents keeps both, and answering with one of them throws away
   * the ambiguity §5.2 exists to adjudicate.
   *
   * Exact match, byte for byte. `AuthService` and `authservice` are two forms
   * here; deciding they are one is coreference, which is §5.2's judgment and
   * needs the surrounding episode this layer cannot see.
   *
   * @spec §3.1, §5.2
   */
  findReferentsByMention(surfaceForm: string): MentionCandidate[];

  /**
   * Every surface form recorded for a referent, most-corroborated first.
   *
   * The tally §3.1's derived `name` is a function of. Ties keep first-naming
   * order, so the read itself is deterministic rather than dependent on which row
   * the query planner reached first — but arrival order is not what breaks a tie
   * for the *name*: that is `deriveName`'s business, and it breaks one on the
   * surface forms themselves, which are the same two strings in every database
   * that saw the same naming claims.
   *
   * @spec §3.1, §5.2
   */
  getMentionTally(referentId: string): MentionTally[];

  /**
   * The §5.2 ladder's last rung: ANN over referent gloss embeddings, nearest
   * first, with every cosine reported and none of them judged.
   *
   * @spec §5.2, §11
   */
  searchReferentGlosses(query: ReferentGlossSearch): ReferentGlossHit[];

  /**
   * Replaces a referent's §3.1 facet centroids, and nothing else on the row.
   *
   * Replacement rather than accumulation: an incremental mean update rewrites a
   * centroid in place, so a caller that appended would be storing the referent's
   * history of opinions rather than its current one. Name, level, regime,
   * locator and the gloss embedding — including its ANN copy — are untouched,
   * because moving a facet mean is not a re-embedding.
   *
   * `counts` carries how many claims each centroid is the mean of, positionally
   * aligned with `facets`, and is what keeps §3.1's update O(1). Omit it and each
   * centroid is recorded as a fresh mean of one; supply a different length and
   * the write is refused, since a count that does not line up with a centroid is
   * worse than no count at all.
   *
   * Refuses more than four centroids (§3.1), a centroid at any width but the
   * stored one, and a referent the index does not hold.
   *
   * @spec §3.1, §9
   */
  updateReferentFacets(
    referentId: string,
    facets: readonly (readonly number[])[],
    counts?: readonly number[] | undefined,
  ): void;

  /**
   * How many claims each of a referent's facet centroids is the mean of.
   *
   * Empty for a referent with no facets, and for one the index does not hold —
   * a missing referent has no centroids, which is not a different answer from
   * having none.
   *
   * @spec §3.1, §9
   */
  getFacetCounts(referentId: string): number[];

  /**
   * Records one containment edge: `parent` directly contains `child`.
   *
   * Idempotent on the pair, and kept in its own index rather than as a `kind` in
   * {@link GraphStore.putStructuralEdges}' set. That set is replaced wholesale
   * per source entity on every parse, so containment sharing it meant a parser
   * re-emitting a module's call graph deleted that module's spine — silently,
   * because deleting edges is exactly what a re-parse does.
   *
   * Both ends must already be in the referent index. That is a view constraining
   * a view, never the ledger: a containment *claim* is written regardless, and
   * this index is what gets rebuilt from it.
   *
   * @spec §3.1, §3.3
   */
  putContainment(containment: Containment): void;

  /**
   * A referent's direct children, in the order they were recorded.
   *
   * Direct, not transitive. The closure is a traversal with a depth budget and a
   * cycle guard, and materializing it here would put a graph algorithm behind a
   * read that looks like a column.
   *
   * @spec §3.1, §3.3
   */
  getChildren(parentId: string): string[];

  /**
   * Drops the referent index, the mention index and the containment index,
   * leaving every claim exactly where it was.
   *
   * What `rebuild-index` stands on, and the operation that makes "no foreign
   * keys point from the ledger onto views" (diagram §4) a fact rather than a
   * slogan: a ledger that survives this genuinely does not depend on the three
   * projections it can be regenerated into.
   *
   * Parsed structural edges go too, and not because `rebuild-index` regenerates
   * them — their emitter does. They are keyed by referent id, and the referent
   * ids are precisely what this drops; edges left behind would be rows pointing
   * at a spine that no longer exists, waiting to be served the moment an id was
   * minted again.
   *
   * @spec §3.1, §3.5, §11
   */
  clearViews(): void;

  /**
   * Mints a claim. Not an upsert: §5.7 keeps every mutation of a live claim on
   * an atomic single-statement path and the ledger is append-only.
   *
   * Refuses a regime/evidence mismatch with a `RegimeViolationError`, and
   * refuses nothing about `scope`: an anchor naming a referent no index row
   * holds is written as it stands, because the index is a view (diagram §4).
   *
   * @spec §3.2, §3.5, §5.7
   */
  putClaim(claim: ClaimRecord): void;

  /**
   * Reads a claim by id, archived or not — lineage and audit reads must never
   * break (§6.1, principle 4).
   *
   * @spec §3.2, §6.1
   */
  getClaim(id: string): ClaimRecord | undefined;

  /**
   * The ledger's claim ids above `afterId`, ascending, at most `limit` of them.
   *
   * The enumeration `rebuild-index` stands on, and deliberately the dullest read
   * on this port: ids only, in id order, no joins and no filters. Keyset-
   * paginated on the primary key rather than by offset, so walking a large ledger
   * costs one index seek per page and never re-scans what it has already served.
   *
   * `afterId` says *where* to resume, never *which row* to resume from. It is a
   * bound, not a lookup: a caller paging a §16-sized ledger will hand back an id
   * that was archived or rewritten between pages, and a scan that resolved the
   * row first would find nothing and report the ledger exhausted.
   *
   * `limit` is an upper bound and not a promise. A short page is ordinary; only
   * an empty one means exhausted, so a caller pages until it gets one. Omit it
   * and the store serves {@link LEDGER_SCAN_PAGE} ids.
   *
   * No archive scope, unlike {@link GraphStore.searchClaims}, and not for want of
   * one. §6.1's filter is a *retrieval* policy — it keeps dead claims out of
   * candidates. This is the opposite kind of read: it enumerates rows so a view
   * can be rebuilt from them, and a rebuild blind to the retired claims would
   * regenerate an index that had forgotten every referent ever withdrawn. The
   * scan reports rows; lifecycle is somebody else's question.
   *
   * @spec §3.2, §6.1, §11, §16
   */
  listClaimIds(afterId?: string, limit?: number): string[];

  /** Moves a claim to a new lifecycle state, touching nothing else. @spec §6.1 */
  setClaimStatus(change: ClaimStatusChange): void;

  /**
   * Reads a claim's Beta-Bernoulli parameters.
   *
   * Three-valued on purpose. `null` is a claim that exists and has no posterior
   * because it is maintained by re-parsing its source; `undefined` is no such
   * claim. Collapsing the two would make a view claim indistinguishable from a
   * typo, and would let a caller "seed" a prior onto a claim that must never
   * have one.
   *
   * @spec §3.2, §4.1
   */
  getEvidence(claimId: string): Evidence | null | undefined;

  /**
   * Adds a contribution to a claim's posterior as a single atomic database
   * increment — never a read, then a write. Two agents updating one claim
   * concurrently must not drop evidence.
   *
   * Refuses a view-regime claim with a `RegimeViolationError`: there is no
   * posterior there to add to, and inventing one is exactly the parser-vote
   * inflation the two regimes exist to prevent.
   *
   * A witnessed increment additionally appends one provenance row, in the same
   * transaction as the α. Both writes or neither, in both directions: a posterior
   * that moved without its provenance row is a contribution no §4.2 cap can ever
   * discount again, and a provenance row without its posterior credits an episode
   * with evidence it never supplied. §12 files both as lost updates.
   *
   * @spec §3.2, §3.5, §4.2, §5.7, §12
   */
  incrementEvidence(increment: EvidenceIncrement): void;

  /**
   * Applies one change event's churn decay: `x ← prior + γ(x − prior)`, toward
   * the prior and never toward zero, and stamps the instant it happened.
   *
   * Refuses a view-regime claim, for the same reason increments do: churn
   * invalidates an attested referent by re-parsing its source, not by pulling a
   * posterior it does not have toward a prior it never had.
   *
   * @spec §3.2, §4.5
   */
  decayEvidence(decay: EvidenceDecay): void;

  /** The §11 full-precision copy, for final rerank. @spec §11 */
  getRerankVector(claimId: string): Float32Array | undefined;

  /** The §11 quantized copy, for SIMD-cheap in-traversal scoring. @spec §11 */
  getAnnVector(claimId: string): Int8Array | undefined;

  /**
   * The §5.3 semantic candidate channel: ANN over claim embeddings, nearest
   * first, archived claims excluded unless explicitly opted in.
   *
   * @spec §5.3, §6.1, §11
   */
  searchClaims(query: ClaimSearch): ClaimSearchHit[];

  /** Writes one §3.3 claim edge. Idempotent, and refuses the reserved kinds. @spec §3.3, §5.5 */
  putClaimEdge(edge: ClaimEdge): void;

  /**
   * Every edge this claim carries. `CONTRADICTS` reads from either end, because
   * §3.3 writes it as `claim ↔ claim` and §7.4's rivals-travel-together rule
   * needs the reverse lookup.
   *
   * @spec §3.3, §7.4
   */
  getClaimEdges(claimId: string): ClaimEdge[];

  /**
   * The §5.3 structural candidate channel: claims attached to an entity via
   * `ABOUT`, regardless of cosine. Archived claims are filtered here too — this
   * is the path no cosine floor could have protected.
   *
   * @spec §5.3, §6.1
   */
  getClaimsAbout(entityId: string, scope?: ArchiveScope): string[];

  /**
   * Replaces every parsed structural edge leaving an entity. Replacement rather
   * than accumulation: the parse is the truth, and it is true only until the
   * next one.
   *
   * Reaches the parse's own edges only. Containment recorded by
   * {@link GraphStore.putContainment} survives a re-parse that never mentions
   * it, which is the whole reason the two live in separate tables.
   *
   * @spec §3.3
   */
  putStructuralEdges(entityId: string, edges: readonly StructuralEdgeInput[]): void;

  /**
   * The structural edges leaving an entity: the parse's own, then containment
   * presented as `CONTAINS`.
   *
   * One read over two tables, because a traversal wants the spine and the call
   * graph together and should not have to know which clock re-derives which. A
   * pair recorded on both sides is reported once.
   *
   * @spec §3.3
   */
  getStructuralEdges(entityId: string): StructuralEdge[];

  /**
   * The §5.1 stage-0 gate. `true` the first time an episode sees a piece of
   * text, `false` for every replay of it — agents retry tool calls, and without
   * this every network blip double-counts evidence.
   *
   * @spec §5.1, §12
   */
  admitObservation(observation: ObservationKey): boolean;

  /**
   * Records the claims a session was served. Agents never manage this; the
   * server records it at serving time, on every transport (§7.5).
   *
   * @spec §4.3, §7.5
   */
  recordTaint(record: TaintRecord): void;

  /** Whether this session already had this claim in its retrieval context. @spec §4.3 */
  isTainted(query: TaintQuery): boolean;

  /** A snapshot of a session's taint set. Mutating it cannot corrupt the ledger. @spec §4.3, §7.5 */
  getTaintSet(sessionId: string): ReadonlySet<string>;

  /** Appends one §5.8 replay-log entry. @spec §5.8, §13 */
  appendStageLog(entry: StageLogEntry): void;

  /** An episode's log entries, in the order they were appended. @spec §5.8, §13 */
  readStageLog(episodeId: string): StageLogEntry[];

  /** Closes the connection. @spec §11 */
  close(): void;
}
