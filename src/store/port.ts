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
  DocumentNode,
  Entity,
  Evidence,
  ExtractionRejectionReason,
  JobState,
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
 * A claim's lifecycle state and its stored text — nothing else.
 *
 * {@link GraphStore.getClaim}'s narrow sibling, for a caller that has to
 * decide whether a claim still speaks (§6.1) and, when it does, decode what it
 * says, and has no use for the rest of a {@link ClaimRecord} — an embedding
 * blob decoded to a `Float32Array`, a zod parse, three provenance axes. No
 * existing narrow read on this port is shaped for a scan rather than a single
 * lookup, so this one is modeled on {@link GraphStore.getClaim} itself
 * (same key, same "row or `undefined`" contract) with everything trimmed off
 * that the ledger-scan case in `spine-writer.ts` never reads.
 *
 * @spec §3.2, §6.1
 */
export interface ClaimSummary {
  readonly status: ClaimStatus;
  readonly text: string;
}

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

/**
 * Which of §3.6's two provenances a document has.
 *
 * Read off {@link DocumentNode} rather than restated, for the reason
 * {@link Regime} is read off {@link Entity}. The two arms are the whole of
 * §5.10's extraction rule — authored documents are extracted from, materialized
 * ones never are, *"because re-extracting them would launder canonicals back in
 * as fresh testimony"* — and a second declaration of that pair is a pair that
 * can drift into admitting a third arm on one side only.
 *
 * @spec §3.6, §5.10
 */
export type DocumentOrigin = DocumentNode['origin'];

/**
 * A document row: §3.6's discursive node as the store holds it.
 *
 * Not {@link DocumentNode}. Two of the divergences are unresolved rather than
 * decided — the schema declares a required closed `docKind` the table has no
 * column for, and the table requires a `title` the schema does not declare — and
 * this shape follows the table, which is what is storable. Which of the two
 * declarations is authoritative is a ruling of its own.
 *
 * What this is *not* is anywhere for evidence to land: no α, no β, no status and
 * no tier. §3.6's *"documents hold no evidence of their own ... a document is a
 * bundle of propositions with different truth values, and whole-document
 * evidence recreates the attractor/shielding failures"* is a shape claim before
 * it is a policy one.
 *
 * @spec §3.6, §5.10
 */
export interface DocumentRecord {
  readonly id: string;
  /** How the document names itself. Free text; the store neither parses nor derives it. */
  readonly title: string;
  /** §5.10's extraction gate, recorded here and acted on above. @spec §5.10 */
  readonly origin: DocumentOrigin;
  /** Full text or a pointer to it — §3.6 leaves the choice to the caller. @spec §3.6 */
  readonly contentRef: string;
  /**
   * The referent the document is anchored at, or `null` while it has none.
   *
   * Nullable where `claims.scope` is `NOT NULL`, and the asymmetry is the point:
   * §5.10 resolves a document's anchor through the §5.2 ladder at ingest, and a
   * document that arrives before its anchor resolves is still a document that
   * serves. §3.6 demotes the anchor to a hint besides — *"the document's anchor
   * is a prior, not an inheritance"* — since members re-resolve their own
   * entities, so an absent one costs a member nothing.
   *
   * Not checked against the referent index, for the reason
   * {@link GraphStore.putMention}'s referent is not: that index is a view.
   *
   * @spec §3.6, §5.2, §5.10
   */
  readonly scope: string | null;
  /** When it was ingested, or `null` if nothing stamped it. @spec §3.6 */
  readonly createdAt: string | null;
}

/**
 * One chunk of one document: a position, an anchor, and optionally the geometry
 * that makes it retrievable.
 *
 * Four fields, and the absence of a fifth is load-bearing. There is no `start`,
 * no `end` and no `length` — §3.6 anchors a chunk by *"hash + fuzzy-quote
 * anchoring, never raw offsets"*, and §12 files span rot as the named failure a
 * byte offset causes: *"document edits break anchors"*. There is no `id` either:
 * the autoincrement key is storage's business, and exposing it would hand the
 * caller a second, positional identity for something anchored by content.
 *
 * @spec §3.6, §5.10, §12
 */
export interface DocumentChunk {
  readonly documentId: string;
  /**
   * Where the chunk sits in the document, counting from zero.
   *
   * A sequence position and not an anchor: an edit above a chunk renumbers it,
   * which is exactly why §3.6 anchors by hash instead. It keys the chunk within
   * its document and orders {@link GraphStore.getChunks}, and it does nothing
   * else.
   *
   * "Counting from zero" is enforced, not only described: migration 0 checks
   * `typeof(ordinal) = 'integer' AND ordinal >= 0`, the same guard
   * `provenance.ordinal` carries, so a fractional or negative ordinal is refused
   * at the table rather than silently reordering a document under
   * {@link GraphStore.getChunks}.
   *
   * @spec §3.6
   */
  readonly ordinal: number;
  /**
   * The chunk's anchor: a hash of its text, byte for byte as the caller wrote
   * it.
   *
   * Not normalized and not case-folded — the store hashes nothing and compares
   * nothing here, exactly as {@link Mention}'s surface form is kept as it was
   * written. Not unique within a document either: a document that repeats a
   * paragraph has two chunks with one hash, and collapsing them would lose an
   * occurrence §5.10's re-anchor pass has to find.
   *
   * @spec §3.6, §5.10
   */
  readonly hash: string;
  /**
   * The chunk's retrieval geometry, or `null` if it has not been embedded.
   *
   * Nullable where `entities.gloss_embedding` is `NOT NULL`, and the asymmetry
   * is earned rather than inherited: a referent with no gloss vector cannot be
   * reached by §5.2's last rung and has lost the only thing that column is for,
   * while a chunk with no vector is still anchored, still ordered, still served
   * with its document and still extractable from.
   *
   * `null` and `[]` are different answers. An empty array is a zero-width vector
   * a cosine will happily score against a full-width one; `null` is a chunk the
   * ANN channel has nothing to say about. Full width when present, like every
   * other f32 vector crossing this boundary.
   *
   * @spec §5.10, §11
   */
  readonly embedding: readonly number[] | null;
}

/**
 * Where a job is in its one pass through the queue.
 *
 * Derived from `src/schema/`'s {@link JobState} rather than restated: it is
 * {@link ReservedEdgeKind}'s precedent again — a store-owned closed vocabulary
 * that belongs to no entity, and a second declaration of it is a second thing
 * that can drift out of step with the table CHECK and the runtime refusal.
 *
 * @spec §9
 */
export type { JobState };

/**
 * A unit of deferred work, as a caller hands it to the queue.
 *
 * @spec §5.9, §5.10, §9
 */
export interface JobSubmission {
  /**
   * Which drain the job belongs to.
   *
   * Open text, and deliberately: §9 hangs four clocks off this table —
   * consolidation, re-clustering, re-verification sampling, churn decay — §5.10
   * adds extraction beside them, and plan §7's deferred seams name several more
   * that do not exist yet. A closed vocabulary would make each of those a
   * migration.
   *
   * @spec §5.10, §9
   */
  readonly kind: string;
  /**
   * What the drain is told, kept whole and never read by the store.
   *
   * The same kind of value as `entities.locator` and `stage_log.inputs`: opaque
   * JSON the store persists and hands back. An absent payload is the empty
   * object the column already declares; an explicit `null` is a payload, and
   * stays one.
   *
   * @spec §5.10
   */
  readonly payload?: unknown;
  /**
   * The instant the job becomes claimable — a not-before, not a priority.
   *
   * Two things §9 needs are expressible only through this reading. The calendar
   * clock itself: a nightly consolidation enqueued at 18:00 and run by the 18:05
   * sweep is not a nightly consolidation. And retry backoff: a job handed back
   * with an instant in the future is the only way a drain loop does not
   * immediately re-take the job that just killed it.
   *
   * @spec §9
   */
  readonly scheduledAt?: string | null;
}

/**
 * One chunk of a {@link DocumentSubmission}, carrying the job that rides on it.
 *
 * No `documentId`: the submission names the document once, and a chunk free to
 * name a different one would be a second place for the two to disagree.
 *
 * `enqueue` is **required and nullable**, never optional. A chunk whose job was
 * forgotten and a chunk that legitimately needs none — a paragraph no edit
 * touched, every chunk of a materialized document §5.10 refuses to mine — are
 * the defect and the ordinary case, and an optional field spells them
 * identically. Required and nullable makes the caller decide, per chunk, at the
 * one site that knows.
 *
 * @spec §3.6, §5.10, §9
 */
export type ChunkSubmission = Omit<DocumentChunk, 'documentId'> & {
  /** The work this chunk defers, or `null` if it defers none. @spec §5.10, §9 */
  readonly enqueue: JobSubmission | null;
};

/**
 * One document as §5.10's ingest has it at the end: the row, every chunk it now
 * has, each chunk's job, and the §5.8 entry recording the decision.
 *
 * The job rides on its chunk rather than travelling in a parallel list, because
 * two collections related by a rule neither of them carries is the shape of the
 * defect {@link GraphStore.submitDocument} exists to close: written as separate
 * calls, a store that stops answering partway through commits the chunks it
 * reached and drops the queue rows it did not, and re-ingesting finds those
 * chunks already stored and parks nothing for them. Permanently.
 *
 * @spec §3.6, §5.8, §5.10, §9
 */
export interface DocumentSubmission {
  readonly document: DocumentRecord;
  /**
   * Every chunk the document has at commit — a total list, not a patch.
   *
   * What this holds is what the document holds afterwards: an ordinal left out
   * is an ordinal gone, which is what a revision with fewer paragraphs needs
   * and what no per-ordinal upsert can express.
   *
   * @spec §3.6, §5.10
   */
  readonly chunks: readonly ChunkSubmission[];
  /** §5.8's replay entry for this ingest, written in the same transaction. @spec §5.8 */
  readonly log: StageLogEntry;
}

/**
 * A job row, as the queue holds it.
 *
 * The row id is public here, where {@link DocumentChunk}'s deliberately is not,
 * and the asymmetry is earned: a chunk is identified by its content — document,
 * ordinal, hash — while a job has no such identity. Two `extract` jobs naming one
 * chunk are two units of work, legitimately, and the row is the only thing that
 * tells them apart. So the row *is* the job.
 *
 * @spec §9
 */
export interface Job {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly state: JobState;
  readonly scheduledAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** How many attempts have died on this job. Moved by {@link GraphStore.failJob} alone. @spec §9 */
  readonly attempts: number;
  /** Why the latest attempt died, or `null` while none has. @spec §9, §12 */
  readonly lastError: string | null;
}

/**
 * A drain reporting that an attempt died, and saying whether to try again.
 *
 * Whether a failed job comes back is the *caller's* decision and not the store's.
 * A backoff schedule is a ⚙ constant (§15), tuned offline against logs (§5.8)
 * rather than hard-coded in a persistence layer, and the two automatic readings
 * are both wrong on their own: a failure that always requeues turns a poison job
 * into a drain that spins on it forever, and one that never requeues loses every
 * job that hit a transient timeout. So the store supplies the mechanism and the
 * caller supplies the policy.
 *
 * @spec §9, §15
 */
export interface JobFailure {
  readonly id: number;
  /** What went wrong, as an operator would want to read it. @spec §9, §12 */
  readonly error: string;
  /**
   * When the job may be claimed again, or absent to park it.
   *
   * An instant returns the job to `pending` with its attempt counted; an absent
   * one leaves it `failed`, readable but not claimable.
   *
   * @spec §9
   */
  readonly retryAt?: string | null;
}

/**
 * Why the extraction gate refused a proposed member.
 *
 * Derived from `src/schema/`'s {@link ExtractionRejectionReason} rather than
 * restated, for {@link JobState}'s reason above: this vocabulary used to be a
 * bare union here plus a hand-written runtime copy in `sqlite-graph-store.ts`,
 * which is two declarations of one set with nothing forcing them to agree —
 * `entailmentBelowFloor` sits in the vocabulary ahead of the gate that writes
 * it, exactly as `RESERVED_EDGE_KINDS` does, so the next arm added here is the
 * one landing that gate.
 *
 * @spec §5.10, §12, §13, §15
 */
export type { ExtractionRejectionReason };

/**
 * One assertion the extractor proposed and the gate refused.
 *
 * §5.10 sends failures here *"never the graph"*, and the shape carries that:
 * no α, no β, no status, no tier and no id in the ledger's namespace. §3.6 keeps
 * evidence off documents because *"a document is a bundle of propositions with
 * different truth values"*; a rejection is one proposition, refused, and is
 * further still from anything that carries a posterior.
 *
 * What it does carry is what an audit reads. Somebody reviewing a month of
 * rejections needs, for each one: what the model proposed, what it cited, where
 * it claimed to have read it, why it was refused, which model said it, and when.
 *
 * @spec §3.6, §5.10, §12, §13
 */
export interface ExtractionRejection {
  /** The document the extractor was pointed at. Must exist; see {@link GraphStore.recordExtractionRejection}. @spec §3.6 */
  readonly documentId: string;
  /**
   * Where in the document the claim was attributed, or `null` when nothing
   * located it.
   *
   * A `quoteAbsent` rejection has no span to anchor: the extractor returned a
   * claim with no quote at all, so there is nothing to attribute a chunk by.
   *
   * @spec §3.6, §5.10
   */
  readonly chunkOrdinal: number | null;
  /**
   * The chunk's anchor, which is what survives an edit that renumbers it.
   *
   * Recorded beside the ordinal rather than instead of it, and for §3.6's reason:
   * the ordinal is where the paragraph sat at the time, the hash is what ties the
   * rejection to the text after a re-chunk moves it.
   *
   * @spec §3.6, §5.10
   */
  readonly chunkHash: string | null;
  /** The assertion the document never made — the phantom under audit. @spec §5.10, §12 */
  readonly claimText: string;
  /**
   * What the model cited, byte for byte as it offered it, or `null` if it cited
   * nothing.
   *
   * Neither trimmed nor folded. A quote that fails the verbatim check only on
   * whitespace is a different diagnosis from one the paragraph never contained,
   * and normalizing on the way in would erase the difference before anyone could
   * read it.
   *
   * @spec §5.10, §13
   */
  readonly quote: string | null;
  readonly reason: ExtractionRejectionReason;
  /** The model under audit — the grouping key the whole instrument exists for. @spec §13, §15 */
  readonly modelId: string | null;
  /**
   * Whatever the gate recorded beside its verdict, kept whole and never read.
   *
   * Opaque JSON, so the deferred entailment gate's score, floor and parameters
   * land without a migration on either axis.
   *
   * @spec §5.10, §15
   */
  readonly detail: unknown;
  /**
   * When the extraction ran.
   *
   * Caller-supplied, following {@link StageLogEntry} rather than
   * {@link GraphStore.recordTaint}: this is a record of when a *model* was run,
   * which is the axis §13 groups an audit along, and a clock read at write time
   * would stamp when the store heard about it instead.
   *
   * @spec §5.10, §13
   */
  readonly at: string;
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

/**
 * The claims one served response put into an episode's retrieval context.
 *
 * Taint follows serving, and it is recorded per *episode*, not per host
 * session. v1 maps one host session to one episode (A17), so at this grain the
 * two coincide; where they diverge, chained sessions collapse into a single
 * episode and therefore share one taint set — which is precisely the §4.3
 * semantics, since a chained continuation saw everything its predecessor was
 * served. The episode is also the unit §4.2's caps and §4.4's independence
 * accounting already count in.
 *
 * @spec §4.3, §7.5
 */
export interface TaintRecord {
  readonly episodeId: string;
  readonly claimIds: readonly string[];
}

/** A membership question against an episode's taint set. @spec §4.3, §7.5 */
export interface TaintQuery {
  readonly episodeId: string;
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
   * Removes one containment edge, if it is there. Silent when it is not.
   *
   * The other half of immediate materialization. §3.3 makes this index the
   * materialization of *live* containment claims — `rebuild-index` skips a claim
   * §6.1 has retired — so an edge whose last live claim has left the set has to
   * go, or the live index and a rebuilt one hold different spines.
   *
   * Keyed by the pair and not by a claim, because the pair is all this table
   * holds. Deciding *whether* an edge has lost its last claim needs a containment
   * payload decoded out of a claim's text, which §3.1 reserves to spine code; the
   * store is told, never asked.
   *
   * @spec §3.1, §3.3, §6.1, §11
   */
  deleteContainment(containment: Containment): void;

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
   * A claim's status and text, or `undefined` if there is no such claim.
   *
   * See {@link ClaimSummary} for why this exists and how it earns its keep: a
   * ledger scan that has to decide liveness and decode a spine payload for
   * every row it visits pays this instead of {@link GraphStore.getClaim} — the
   * same row, two columns instead of the whole claim.
   *
   * Archived and all, exactly as {@link GraphStore.getClaim} reads — a caller
   * asking "is this still live" needs to see the claims that are not.
   *
   * @spec §3.2, §6.1
   */
  getClaimSummary(id: string): ClaimSummary | undefined;

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
   * Writes a document, replacing the row already at that id.
   *
   * An upsert, like {@link GraphStore.putEntity} and unlike
   * {@link GraphStore.putClaim}: a document is §3.6 discursive knowledge holding
   * no evidence, not a ledger entry, and §5.10's testimony decay presumes a
   * document that is *edited* rather than one superseded by a second copy under
   * a new id.
   *
   * Replacing the row leaves the chunks hanging off it exactly where they are.
   * They are `ON DELETE CASCADE`, so an upsert that deleted first would take
   * every chunk of every document it re-ingested — silently, and one statement
   * before anything noticed.
   *
   * Refuses an origin that is neither of {@link DocumentOrigin}'s two, and
   * refuses it before writing anything: §5.10's rule has two arms and a third
   * value satisfies neither, so a stored one would be a document no extractor
   * could classify. Nothing else is checked — the anchor is not, for the reason
   * {@link GraphStore.putMention}'s referent is not.
   *
   * @spec §3.6, §5.10
   */
  putDocument(document: DocumentRecord): void;

  /** Reads a document, or `undefined` if nothing has written one at that id. @spec §3.6 */
  getDocument(id: string): DocumentRecord | undefined;

  /**
   * Removes a document and, with it, its chunks.
   *
   * Silent about an id nothing holds, exactly as
   * {@link GraphStore.deleteContainment} is: the caller asked for the row to be
   * gone, and it is.
   *
   * @spec §3.6
   */
  deleteDocument(id: string): void;

  /**
   * Writes one chunk, replacing whatever chunk that document already had at that
   * ordinal.
   *
   * Replace rather than refuse, which is the reading
   * {@link GraphStore.putMention} and {@link GraphStore.putContainment} already
   * take of a repeated key. Refusing would make the ordinary case —
   * re-ingesting an edited document, whose ordinal 3 now holds different text —
   * into an error the caller has to clear a document's chunks to get past, and
   * there is no reading of §5.10 under which a re-chunk is a fault.
   *
   * The document must exist. Unlike the mention index, which is keyed by
   * referent id and checked against nothing, a chunk without its document is not
   * a fact about anything: `documents` is the row this one is a part of, not a
   * view it points at.
   *
   * Not the ingest path: this is the one remaining way to write a chunk without
   * deciding whether its extraction is parked, so §5.10's ingest goes through
   * {@link GraphStore.submitDocument} and this stays for the callers writing a
   * chunk on its own.
   *
   * @spec §3.6, §5.10
   */
  putChunk(chunk: DocumentChunk): void;

  /**
   * A document's chunks in ordinal order.
   *
   * Ordinal order and not insertion order: the sequence is what makes the chunks
   * a document rather than a bag of paragraphs, and a re-ingest that rewrites
   * one chunk in the middle must not move it to the end.
   *
   * Empty for a document with no chunks, and for one that does not exist — a
   * missing document has no chunks, which is not a different answer from having
   * none.
   *
   * @spec §3.6, §5.10
   */
  getChunks(documentId: string): DocumentChunk[];

  /**
   * Writes one whole document — its row, its chunks, their jobs and its §5.8 log
   * entry — in one transaction, and hands back the ids of the jobs it parked.
   *
   * §5.10 makes ingest cheap and extraction lazy, which makes the queue the
   * *promise*: a chunk is stored now on the understanding that a job parked
   * beside it mines the paragraph later. Spelled as
   * {@link GraphStore.putDocument} then a {@link GraphStore.putChunk} per
   * paragraph then a {@link GraphStore.enqueueJob} per changed one, a store that
   * stops answering partway commits every row it reached and drops the rest —
   * measured under six concurrent ingests as `chunks=7 jobs=0` beside siblings
   * that got `chunks=8 jobs=8`. The re-run exits zero and repairs nothing,
   * because a job is parked only for a chunk whose anchor the previous chunking
   * did not hold and those seven anchors are now held. So the promise is only a
   * promise if the chunk and its job commit together, which is this method.
   *
   * **The chunks are total.** {@link DocumentSubmission.chunks} is what the
   * document has when this returns, not a patch over what it had: the chunk rows
   * go and the named ones are written. **The document row never goes.** That is
   * narrower than {@link GraphStore.deleteDocument}'s cascade on purpose — a
   * revision with fewer paragraphs needed the old tail gone, and deleting the
   * document to get it opened an instant in which a reader finds no document at
   * all, which {@link GraphStore.getJob}'s consumers read as "extract from
   * nothing" and park for good.
   *
   * **Not a transaction primitive, and it cannot become one.** It takes values,
   * not a body, so no caller can wrap arbitrary writes in it. It satisfies "each
   * write method is its own transaction" rather than excepting it.
   *
   * **Its scope is the tail of ingest and no more.** §5.2's ladder mints
   * referents and writes naming claims and mentions for a document's anchor
   * *before* this call and outside it. A failure there leaves a provisional
   * referent with no document, which §5.2 already renders invisible until
   * something corroborates it — so "atomic ingest" means this call, not the
   * pipeline in front of it.
   *
   * Refuses before the transaction opens, never inside it: an unknown origin, a
   * chunk embedding that is not the stored width, two chunks at one ordinal.
   * Refusing before the write lock is ever taken is the right order on its own
   * terms — but it is not what keeps this call off `SQLITE_BUSY_SNAPSHOT`, and
   * moving the three checks inside the transaction would not change that
   * either: none of them touches the database, so moved in they would just wait
   * out a held lock and land, like any other write. What that protection rests
   * on is that the transaction's own first statement is a write, because every
   * check this method makes is against the argument and never against the
   * database — nothing inside it reads. In WAL a deferred transaction that reads
   * before it writes pins its snapshot at that read, and a write that then finds
   * another connection has committed since is refused `SQLITE_BUSY_SNAPSHOT`
   * *immediately* — `busy_timeout` cannot wait a stale snapshot current.
   *
   * Answers with the id of each parked job, in submission order, for the chunks
   * that named one and no others — so an unchanged document and a materialized
   * one both come back empty.
   *
   * @spec §3.6, §5.2, §5.7, §5.8, §5.10, §9, §11
   */
  submitDocument(submission: DocumentSubmission): number[];

  /**
   * Parks a unit of deferred work, and hands back the id it landed under.
   *
   * §5.9 makes capture enqueue-only — *"PostToolUse hooks append the event to the
   * episode log and return immediately; adjudication and reflection run on the
   * daemon, off the agent's critical path"* — so what the store owes this path is
   * a write that finishes and a row that survives it. §5.10 makes extraction lazy
   * for the mirror reason: ingest chunks, embeds and anchors, and the forty
   * inline adjudications a 3,000-word ADR would otherwise pay are parked here.
   *
   * A second identical submission is a second job, not a deduplication: two
   * extractions of one chunk are two units of work.
   *
   * @spec §5.9, §5.10, §9
   */
  enqueueJob(job: JobSubmission): number;

  /** Reads a job, or `undefined` if nothing was enqueued under that id. @spec §9 */
  getJob(id: number): Job | undefined;

  /**
   * Takes the next due job of one kind, or answers with nothing.
   *
   * One statement, never a `SELECT` followed by an `UPDATE`. §5.7 makes the
   * argument for posteriors — *"atomic increments in the database, never
   * read-modify-write"* — and a claim off this queue is the same shape with the
   * sign flipped: instead of dropping a contribution it duplicates a unit of
   * work, so one chunk is extracted twice and §5.10's *"a document is one
   * episode"* cap is applied twice to what was one source. In v1 several
   * processes share one file by construction, so the window between a read and
   * its write is a window another process writes into.
   *
   * Scoped to a kind, because §9's clocks are drained by different callers on
   * different schedules: a drain that took whatever was at the head of the queue
   * would run the consolidator inside a reflection and the extractor inside a
   * cron sweep.
   *
   * Due-ness is {@link JobSubmission.scheduledAt}'s reading — a not-before —
   * and among due jobs the earliest schedule goes first, so a schedule is not
   * merely advisory.
   *
   * @spec §5.7, §5.10, §9
   */
  claimJob(kind: string): Job | undefined;

  /**
   * Marks a job finished.
   *
   * Refuses an id the queue does not hold, where the delete paths are silent
   * about one — see {@link UnknownJobError}.
   *
   * @spec §9
   */
  completeJob(id: number): void;

  /**
   * Counts an attempt against a job, records what killed it, and either parks it
   * or hands it back to the queue.
   *
   * `attempts` moves here and nowhere else: a claim is not an attempt, since a
   * drain that took a job and was killed before it ran anything has not tried.
   *
   * @spec §9, §12, §15
   */
  failJob(failure: JobFailure): void;

  /**
   * Returns a job nothing is coming for to the queue, due at once.
   *
   * The other half of {@link GraphStore.failJob}'s policy. `failJob` parks a job
   * as `failed` and `claimJob` selects `pending` and nothing else, so parking is
   * terminal by construction — which is only tolerable if there is a way back,
   * and this is it. A caller's retry budget is worth having precisely because
   * exhausting it costs one deliberate call to undo rather than the work itself.
   *
   * Two things it does not do, and both are the point:
   *
   * **`attempts` is preserved.** The count is the diagnosis — it is what says
   * this job has died five times rather than once — and a requeue that reset it
   * would hand a poison job an unbounded budget for the price of one call, since
   * every requeue would buy a full fresh run. A requeued job that is still broken
   * therefore parks again on its very next failure, which is the intended shape:
   * the requeue is a human asserting the outage is over, and if it is not the
   * drain should stop again at once rather than restart the storm the budget
   * exists to end.
   *
   * **`scheduled_at` is cleared, not restamped.** `failJob`'s parking arm leaves
   * whatever not-before the last backoff wrote, so a job parked after a retry
   * carries a stale instant in the future; moving `state` alone would produce a
   * `pending` row no drain can claim until that instant arrives. SQL NULL is
   * already {@link JobSubmission.scheduledAt}'s "at once", so clearing it says
   * *now* without inventing an instant.
   *
   * A `pending` job is permitted and means exactly that — an operator overriding
   * a schedule. `done` and `running` are refused by class; see
   * {@link JobNotRequeueableError}. An id the queue never minted is refused as
   * {@link GraphStore.completeJob} refuses one.
   *
   * @spec §9, §12, §15
   */
  requeueJob(id: number): void;

  /**
   * Logs a member the extraction gate refused.
   *
   * The document must exist, for {@link GraphStore.putChunk}'s reason: a
   * rejection whose document was never ingested is a record of an extraction that
   * could not have happened, and unreadable besides, since the only read this
   * port offers is keyed by document. The rejection nonetheless *survives* that
   * document's deletion — it is an audit row, and `adjudication_log` already made
   * this choice in SQL by carrying no foreign key at all.
   *
   * Refuses a reason outside {@link ExtractionRejectionReason} before writing
   * anything, so a refusal never leaves behind the uncountable row the vocabulary
   * exists to prevent.
   *
   * @spec §3.6, §5.10, §12, §13
   */
  recordExtractionRejection(rejection: ExtractionRejection): void;

  /**
   * What a document's extraction refused, in the order it was logged.
   *
   * Narrowed to one chunk when an ordinal is named, because a paragraph the
   * extractor keeps inventing assertions about is a different signal from a
   * document that produced one bad member, and only a narrowed read separates
   * them. A rejection that named no chunk belongs to the document read and to no
   * chunk read.
   *
   * @spec §5.10, §13
   */
  readExtractionRejections(documentId: string, ordinal?: number): ExtractionRejection[];

  /**
   * The §5.1 stage-0 gate. `true` the first time an episode sees a piece of
   * text, `false` for every replay of it — agents retry tool calls, and without
   * this every network blip double-counts evidence.
   *
   * @spec §5.1, §12
   */
  admitObservation(observation: ObservationKey): boolean;

  /**
   * Records the claims an episode was served. Taint follows serving: agents
   * never manage this, the server records it at serving time, on every
   * transport (§7.5). v1 maps one host session to one episode (A17), and
   * chained sessions collapse to one episode — so they share a taint set.
   *
   * @spec §4.3, §7.5
   */
  recordTaint(record: TaintRecord): void;

  /** Whether this episode already had this claim in its retrieval context. @spec §4.3 */
  isTainted(query: TaintQuery): boolean;

  /** A snapshot of an episode's taint set. Mutating it cannot corrupt the ledger. @spec §4.3, §7.5 */
  getTaintSet(episodeId: string): ReadonlySet<string>;

  /** Appends one §5.8 replay-log entry. @spec §5.8, §13 */
  appendStageLog(entry: StageLogEntry): void;

  /** An episode's log entries, in the order they were appended. @spec §5.8, §13 */
  readStageLog(episodeId: string): StageLogEntry[];

  /** Closes the connection. @spec §11 */
  close(): void;
}
