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
   * @spec §3.1
   */
  putEntity(entity: Entity): void;

  /** Reads a spine node, or `undefined` if it was never written. @spec §3.1 */
  getEntity(id: string): Entity | undefined;

  /**
   * Records one surface form for one referent, idempotently: an episode that
   * names `auth-service` nine times records it once.
   *
   * @spec §3.1, §3.5, §5.2
   */
  putMention(mention: Mention): void;

  /**
   * The referent a surface form names, or `undefined` if nothing has been named
   * by it.
   *
   * @spec §3.1, §5.2
   */
  resolveMention(surfaceForm: string): string | undefined;

  /**
   * Drops the referent index, the mention index and the containment index,
   * leaving every claim exactly where it was.
   *
   * What `rebuild-index` stands on, and the operation that makes "no foreign
   * keys point from the ledger onto views" (diagram §4) a fact rather than a
   * slogan: a ledger that survives this genuinely does not depend on the three
   * projections it can be regenerated into.
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
   * @spec §3.2, §4.2, §5.7, §12
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
   * @spec §3.3
   */
  putStructuralEdges(entityId: string, edges: readonly StructuralEdgeInput[]): void;

  /** The parsed structural edges leaving an entity. @spec §3.3 */
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
