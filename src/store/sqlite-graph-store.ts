/**
 * The better-sqlite3 adapter behind {@link GraphStore}.
 *
 * Five things in here are load-bearing rather than incidental.
 *
 * **A claim is in one regime or the other** (diagram §6). A view claim is
 * maintained by re-parsing the source that attests it and carries no posterior;
 * an evidence claim carries α and β. The rule is enforced twice on purpose —
 * here, as a `RegimeViolationError` that says which half is wrong, and in the
 * schema as a table CHECK that holds against every writer, including the UPDATE
 * paths and including anything that is not this store.
 *
 * **Nothing the ledger writes depends on a view** (diagram §4). `claims.scope`
 * has no foreign key, `putClaim` checks no anchor, and {@link
 * SqliteGraphStore.clearViews} drops the referent, mention and containment
 * indexes with every claim left standing. That is what `rebuild-index` needs,
 * and it is only true while no write path quietly reintroduces the dependency.
 *
 * **Every α/β movement is one statement.** `UPDATE claims SET alpha = alpha + ?`
 * and `SET alpha = ? + ? * (alpha - ?)`, never a `SELECT` followed by an
 * `UPDATE`. §5.7 is explicit that increments are atomic in the database and not
 * in the server, and §12 files lost updates as a day-one mitigation: in v1 an
 * agent is a process, so the read window between a select and its write is a
 * window another *process* writes into.
 *
 * **Vectors are stored twice** (§11): an f32 blob on the claim row for rerank,
 * and an int8 `vec0` row for in-traversal scoring. The narrow copy is derived,
 * so the two can never disagree.
 *
 * **Archived claims are filtered inside the KNN scan**, not after it (§6.1).
 *
 * @spec §3.1, §3.2, §3.3, §3.5, §4.5, §5.1, §5.2, §5.3, §5.7, §5.8, §6.1, §7.5, §11
 */

import { createHash } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import {
  Claim,
  Entity,
  RESERVED_EDGE_KINDS,
  type ClaimEdgeKind,
  type ClaimKind,
  type ClaimStatus,
  type ClaimTier,
  type Entity as EntityShape,
  type EntityLevel,
  type Evidence,
} from '../schema/index.js';

import { openDatabase, readJournalMode, resolveBusyTimeoutMs } from './connection.js';
import {
  DimensionMismatchError,
  DuplicateClaimError,
  RegimeViolationError,
  ReservedEdgeKindError,
  StoreBusyError,
  UnknownClaimError,
  UnknownEntityError,
  isBusyError,
} from './errors.js';
import type {
  ArchiveScope,
  ClaimEdge,
  ClaimRecord,
  ClaimSearch,
  ClaimSearchHit,
  ClaimStatusChange,
  Containment,
  EvidenceDecay,
  EvidenceIncrement,
  GraphStore,
  GraphStoreOptions,
  Mention,
  MentionCandidate,
  MentionTally,
  ObservationKey,
  ReferentGlossHit,
  ReferentGlossSearch,
  Regime,
  StageLogEntry,
  StructuralEdge,
  StructuralEdgeInput,
  TaintQuery,
  TaintRecord,
} from './port.js';
import {
  assertStoredWidth,
  clampCosine,
  decodeFloatVector,
  decodeFloatVectors,
  decodeInt8Vector,
  encodeFloatVector,
  encodeFloatVectors,
  encodeInt8Vector,
  toAnnVector,
} from './vectors.js';

/** The one status §6.1 takes out of candidate retrieval entirely. @spec §6.1 */
const ARCHIVED: ClaimStatus = 'archived';

/** The claim-to-entity edge; the other five live kinds target claims. @spec §3.3 */
const ABOUT: ClaimEdgeKind = 'ABOUT';

/** §3.3 writes this one as `claim ↔ claim`, so it reads from either end. @spec §3.3, §7.4 */
const CONTRADICTS: ClaimEdgeKind = 'CONTRADICTS';

/**
 * The kind the containment index is presented as by
 * {@link SqliteGraphStore.getStructuralEdges}.
 *
 * A string and not a `ClaimEdgeKind`: containment is a spine relation between
 * two referents, not one of §3.3's six claim-to-claim kinds, and the structural
 * vocabulary is the parser's to extend.
 *
 * @spec §3.1, §3.3
 */
const CONTAINS = 'CONTAINS';

/** The three provenance axes, in the order they are persisted (A16). @spec §3.5, §4.4, §4.5 */
const PROVENANCE_AXES = ['episode', 'changeEvent', 'artifact'] as const;

type ProvenanceAxis = (typeof PROVENANCE_AXES)[number];

/** The regime a referent a noun source attests is maintained under. @spec §3.2, §3.5 */
const VIEW: Regime = 'view';

/** The regime a referent nothing attests is maintained under. @spec §3.2, §3.5 */
const EVIDENCE: Regime = 'evidence';

/**
 * The ledger row's shape, minus the one rule a shape cannot state.
 *
 * §3.5's `Claim` with its posterior lifted out and the regime added, so a view
 * claim's absent α/β is not a shape violation. The exclusivity itself —
 * "nothing is ever both, nothing is ever neither" — is checked by
 * {@link readPosterior}, because it is a refusal the store owns by type
 * (`RegimeViolationError`) rather than a field a `ZodError` would name.
 *
 * Derived from the schema layer rather than restated beside it: `Entity`'s own
 * regime enum is reused, so the vocabulary exists once.
 *
 * @spec §3.2, §3.5
 */
const LedgerClaim = Claim.omit({ evidence: true }).extend({ regime: Entity.shape.regime });

interface EntityRow {
  readonly id: string;
  readonly name: string;
  readonly level: string | null;
  readonly regime: string;
  readonly locator: string | null;
  readonly gloss_embedding: Buffer;
  readonly facets: Buffer;
}

interface ClaimRow {
  readonly id: string;
  readonly text: string;
  readonly embedding: Buffer;
  readonly kind: string;
  readonly tier: string;
  readonly status: string;
  readonly regime: string;
  readonly alpha: number | null;
  readonly beta: number | null;
  readonly scope: string;
  readonly created_at: string;
  readonly last_corroborated: string | null;
  readonly invalidated_at: string | null;
  readonly last_churn_event: string | null;
  readonly canonical: number;
}

interface EvidenceRow {
  readonly alpha: number | null;
  readonly beta: number | null;
}

interface ProvenanceRow {
  readonly axis: string;
  readonly value: string;
  readonly channel: string | null;
  readonly agent: string | null;
}

interface ReferentRow {
  readonly referent_id: string;
}

interface MentionCandidateRow {
  readonly referent_id: string;
  /** 1 when the queried form is the referent's own `name`; SQLite has no boolean. */
  readonly canonical: number;
}

interface MentionTallyRow {
  readonly surface_form: string;
  readonly n: number;
}

interface FacetCountsRow {
  /**
   * The packed centroids the counts are a parallel vector to. Read alongside them
   * because "how many counts should there be" is a fact about this blob and about
   * nothing else.
   */
  readonly facets: Buffer;
  readonly facet_counts: string;
}

interface ChildRow {
  readonly child_id: string;
}

interface EdgeRow {
  readonly from_id: string;
  readonly kind: string;
  readonly to_id: string;
}

interface HitRow {
  readonly claim_id: string;
  readonly distance: number;
}

interface GlossHitRow {
  readonly entity_id: string;
  readonly distance: number;
}

interface StageLogRow {
  readonly episode_id: string;
  readonly stage: string;
  readonly inputs: string;
  readonly decision: string | null;
}

interface StageLogAtRow extends StageLogRow {
  readonly at: string;
}

interface BlobRow {
  readonly value: Buffer;
}

interface CountRow {
  readonly present: number;
}

interface ClaimIdRow {
  readonly claim_id: string;
}

/** The instant a bookkeeping row was written. Distinct from the domain instants §3.2 carries. */
const now = (): string => new Date().toISOString();

/** SQLite has no boolean; the store speaks 0/1 at the boundary and never leaks it. */
const flag = (value: boolean): number => (value ? 1 : 0);

/**
 * The §5.1 dedupe key's first half: a content hash, so an equal string built at
 * runtime dedupes and an object identity never enters into it.
 *
 * @spec §5.1
 */
const hashText = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Refuses a contribution that would move evidence down or poison the posterior.
 *
 * Decay is the only path that moves evidence downward (§4.5), and it has its own
 * operation with its own guards. A NaN reaching `alpha = alpha + ?` would make
 * every future read of that claim's posterior NaN, unrecoverably.
 *
 * @spec §4.2, §5.7
 */
const assertContribution = (name: string, value: number): void => {
  if (!Number.isFinite(value))
    throw new RangeError(`${name} must be a finite number, got ${String(value)}`);
  if (value < 0)
    throw new RangeError(
      `${name} must be non-negative — churn decay (§4.5) is the only path that moves evidence down, got ${String(value)}`,
    );
};

/** Reconstructs an ordered provenance axis from its normalized rows. @spec §3.5 */
const axisValues = (rows: readonly ProvenanceRow[], axis: ProvenanceAxis): string[] =>
  rows.filter((row) => row.axis === axis).map((row) => row.value);

/** A Beta parameter is a strictly positive real. Half a Beta is not a distribution. @spec §4.1 */
const isBetaParameter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The posterior a claim may be written with, under the regime it declared.
 *
 * Diagram §6, both halves of it. `view` returns `null` — a referent a noun
 * source attests is invalidated by the change feed, so a re-parse must find
 * nothing to inflate. `evidence` returns the pair, and refuses anything that is
 * not one: an absent posterior is a belief with no belief in it, and a pair with
 * one parameter missing is not a distribution at all.
 *
 * Refused before the first statement runs, so a refusal writes nothing.
 *
 * @spec §3.2, §3.5, §4.1
 */
const readPosterior = (id: string, regime: Regime, evidence: unknown): Evidence | null => {
  if (regime === VIEW) {
    if (evidence === null || evidence === undefined) return null;
    throw new RegimeViolationError(id, VIEW, 'arrived carrying a posterior');
  }
  if (evidence === null || evidence === undefined)
    throw new RegimeViolationError(id, EVIDENCE, 'arrived with no posterior');

  const { alpha, beta } = evidence as Partial<Evidence>;
  if (!isBetaParameter(alpha) || !isBetaParameter(beta))
    throw new RegimeViolationError(
      id,
      EVIDENCE,
      `arrived with α = ${String(alpha)} and β = ${String(beta)}, which is not a Beta distribution`,
    );
  return { alpha, beta };
};

/**
 * A locator on its way into the one column that never reads it.
 *
 * Two nulls have to stay apart here: a referent that carries no locator at all
 * (SQL NULL) and one whose locator *is* null (the JSON text `null`). The schema
 * makes the key optional and nullable separately, so collapsing them would
 * quietly rewrite one absence into the other.
 *
 * @spec §3.5
 */
const encodeLocator = (locator: unknown): string | null => JSON.stringify(locator) ?? null;

/**
 * §3.1's one-to-four centroid rule, borrowed from the schema rather than
 * restated: `updateReferentFacets` and `putEntity` have to refuse the same fifth
 * centroid, and two spellings of "at most four" are two rules that can drift.
 *
 * @spec §3.1
 */
const Facets = Entity.shape.facets;

/**
 * How many claims each centroid is the mean of, as JSON.
 *
 * JSON rather than a packed blob: there are at most four of them, they are read
 * by humans debugging a mean that moved the wrong way, and nothing scores them.
 *
 * @spec §3.1, §9
 */
const encodeFacetCounts = (counts: readonly number[]): string => JSON.stringify(counts);

/** A stored entry a centroid could actually be the mean of that many claims. @spec §3.1 */
const isFacetCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Reads the counts back, treating anything that is not one readable count per
 * centroid as no counts at all.
 *
 * All or nothing, rather than whichever entries survive a filter. §3.1 promises
 * the counts are "positionally aligned with `facets`", and a filtered vector
 * keeps the shape of that promise while breaking its content: `[1,-1,2]` reduced
 * to `[1,2]` makes `counts[1]` describe the second centroid, so the next O(1)
 * mean update re-weights a centroid nobody attached a claim to. An absent count
 * vector is a mean that has to be re-derived; a misaligned one is a mean that is
 * quietly wrong from here on.
 *
 * Degrading rather than throwing all the same. This is a view column on a view
 * table, `rebuild-index` restores it, and taking a referent read down over a
 * number nothing believes would be the larger failure. Reachable only from a
 * writer that is not this store — {@link alignedCounts} refuses everything here
 * on the way in — which is the threat model migration 0's claim CHECK already
 * accepts as real.
 *
 * @spec §3.1, §9
 */
const decodeFacetCounts = (json: string, centroids: number): number[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length !== centroids) return [];
  // One unreadable entry moves every entry after it off its centroid, so there is
  // no prefix worth keeping: a short survivor list is discarded rather than read.
  const counts: number[] = parsed.filter(isFacetCount);
  return counts.length === centroids ? counts : [];
};

/**
 * Refuses a count vector that does not line up with the centroids it counts.
 *
 * Reported as a dimension mismatch because that is what it is: the counts are a
 * vector parallel to the facet set, and one of the wrong length would silently
 * re-weight some other centroid's mean on the next update.
 *
 * @spec §3.1, §9
 */
const alignedCounts = (
  facets: readonly (readonly number[])[],
  counts: readonly number[] | undefined,
): number[] => {
  // A caller with no counts to offer is asserting fresh means: each centroid is
  // the mean of the one claim that produced it, which is the only weight that
  // cannot make the next incremental update wrong in an unrecoverable direction.
  if (counts === undefined) return facets.map(() => 1);
  if (counts.length !== facets.length)
    throw new DimensionMismatchError('facet counts', facets.length, counts.length);
  for (const count of counts)
    if (!Number.isFinite(count) || count < 0)
      throw new RangeError(
        `a facet count must be a non-negative finite number, got ${String(count)}`,
      );
  return [...counts];
};

/**
 * The SQLite-backed graph store.
 *
 * @spec §11
 */
class SqliteGraphStore implements GraphStore {
  readonly #db: BetterSqlite3.Database;
  readonly #statements: ReturnType<typeof prepareStatements>;
  readonly #busyTimeoutMs: number;

  readonly journalMode: string;

  constructor(db: BetterSqlite3.Database, busyTimeoutMs: number) {
    this.#db = db;
    this.#statements = prepareStatements(db);
    this.#busyTimeoutMs = busyTimeoutMs;
    this.journalMode = readJournalMode(db);
  }

  /**
   * Runs a write, turning a lock wait that ran out into a refusal the store owns.
   *
   * Only writes go through this. §5.7 puts the store in WAL precisely so readers
   * never queue behind a writer, and a read that could not have been contended
   * has nothing to report. The wait itself is SQLite's — `PRAGMA busy_timeout`
   * has already blocked for {@link SqliteGraphStore.#busyTimeoutMs} by the time
   * the driver raises — so this translates the outcome rather than doing any
   * waiting of its own.
   *
   * @spec §5.7, §12
   */
  #write<T>(what: string, run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (isBusyError(error)) throw new StoreBusyError(what, this.#busyTimeoutMs, error);
      throw error;
    }
  }

  /**
   * Runs a multi-statement write in one transaction, under the same refusal.
   *
   * @spec §5.7
   */
  #transaction(what: string, body: () => void): void {
    this.#write(what, this.#db.transaction(body));
  }

  /**
   * Upserts a spine node, refreshing its gloss vector alongside it.
   *
   * Facet counts are reset to one per centroid, because `Entity` does not carry
   * them: an upsert asserts the facet set whole, and the only weight this layer
   * can honestly record for a centroid it was handed is "one claim's worth".
   * {@link SqliteGraphStore.updateReferentFacets} is the path that keeps them.
   *
   * @spec §3.1
   */
  putEntity(entity: EntityShape): void {
    const parsed = Entity.parse(entity);
    assertStoredWidth('an entity gloss embedding', parsed.glossEmbedding);
    for (const facet of parsed.facets) assertStoredWidth('a facet centroid', facet);

    const gloss = Float32Array.from(parsed.glossEmbedding);
    const s = this.#statements;

    this.#transaction('putEntity', () => {
      s.upsertEntity.run(
        parsed.id,
        parsed.name,
        parsed.level,
        parsed.regime,
        encodeLocator(parsed.locator),
        encodeFloatVector(parsed.glossEmbedding),
        encodeFloatVectors(parsed.facets),
        encodeFacetCounts(parsed.facets.map(() => 1)),
        now(),
      );
      // vec0 has no upsert: the previous gloss goes, the new one lands.
      s.deleteGlossVector.run(parsed.id);
      s.insertGlossVector.run(parsed.id, encodeInt8Vector(toAnnVector(gloss)));
    });
  }

  /** Reads a referent-index row. @spec §3.1 */
  getEntity(id: string): EntityShape | undefined {
    const row = this.#statements.selectEntity.get(id);
    if (row === undefined) return undefined;

    return {
      id: row.id,
      name: row.name,
      level: row.level as EntityLevel | null,
      regime: row.regime as Regime,
      // The key is omitted rather than set to undefined when the column is SQL
      // NULL: `locator` is optional *and* nullable, so an absent locator that
      // came back as an explicit `null` would be a different referent — and one
      // `toStrictEqual` notices.
      ...(row.locator === null ? {} : { locator: JSON.parse(row.locator) as unknown }),
      glossEmbedding: Array.from(decodeFloatVector(row.gloss_embedding)),
      facets: decodeFloatVectors(row.facets).map((facet) => Array.from(facet)),
    };
  }

  /**
   * Records one surface form for one referent.
   *
   * An UPSERT on the pair, so an episode naming `auth-service` nine times leaves
   * one row with `n = 9`. The index stays a set of pairs — the count rides on the
   * row rather than multiplying it — and the count is not a second corroboration
   * channel: it reaches §3.1's name derivation and nothing that §4 weighs, so no
   * episode cap and no independence discount apply to it.
   *
   * `at` keeps the first naming. It marks when the pair entered the set, and a
   * column that meant "first" on Monday and "latest" on Tuesday would be worse
   * than no column.
   *
   * The referent is not checked. The mention index is a view keyed by referent
   * id, and a view that could refuse a naming is a view deciding what the ledger
   * is allowed to have resolved.
   *
   * @spec §3.1, §3.5, §5.2
   */
  putMention(mention: Mention): void {
    this.#write('putMention', () =>
      this.#statements.insertMention.run(mention.surfaceForm, mention.referentId, now()),
    );
  }

  /**
   * The referent a surface form names.
   *
   * Oldest naming first when a form has been recorded against more than one
   * referent: the index is many forms to one referent, and a form that has
   * genuinely become ambiguous is §5.2's problem to adjudicate, not a tie this
   * layer should break by recency.
   *
   * @spec §3.1, §5.2
   */
  resolveMention(surfaceForm: string): string | undefined {
    return this.#statements.selectMention.get(surfaceForm)?.referent_id;
  }

  /**
   * Every referent a surface form has been recorded as naming.
   *
   * Canonical-name matches first, then oldest naming first, because §5.2 climbs
   * the ladder in that order and a candidate list that arrived sorted the other
   * way would make rung 2 look like rung 1.
   *
   * The comparison is SQLite's default BINARY collation on an uncollated column,
   * so `AuthService` and `authservice` are two forms. Folding them is a
   * coreference decision, and it needs the episode this layer cannot see.
   *
   * @spec §3.1, §5.2
   */
  findReferentsByMention(surfaceForm: string): MentionCandidate[] {
    return this.#statements.selectMentionCandidates.all(surfaceForm).map((row) => ({
      referentId: row.referent_id,
      canonicalName: row.canonical === 1,
    }));
  }

  /**
   * Every surface form recorded for a referent, most-corroborated first.
   *
   * @spec §3.1, §5.2
   */
  getMentionTally(referentId: string): MentionTally[] {
    return this.#statements.selectMentionTally
      .all(referentId)
      .map((row) => ({ surfaceForm: row.surface_form, n: row.n }));
  }

  /**
   * Drops all three views: the referent index, the mention index and the
   * containment index — gloss vectors with them, since those are the referent
   * index's own ANN copy.
   *
   * The ledger is not touched, and nothing here can touch it: no foreign key
   * points this way (diagram §4), so every claim, its posterior and its regime
   * survive a rebuild of everything derived from them.
   *
   * Parsed structural edges go with them, and the delete is written out rather
   * than left to the cascade off `entities`. They are not rebuilt from claims —
   * their emitter re-derives them — but they are keyed by referent ids, and
   * those ids are exactly what this drops. Rows kept past that point would name
   * a spine that no longer exists.
   *
   * @spec §3.1, §3.5, §11
   */
  clearViews(): void {
    const s = this.#statements;
    this.#transaction('clearViews', () => {
      s.deleteAllContainment.run();
      s.deleteAllStructuralEdges.run();
      s.deleteAllMentions.run();
      s.deleteAllGlossVectors.run();
      s.deleteAllEntities.run();
    });
  }

  /**
   * The §5.2 ladder's last rung: ANN over referent gloss embeddings.
   *
   * Narrowed and quantized exactly as {@link SqliteGraphStore.searchClaims} is,
   * so both indexes score in the same geometry, and clamped for the same reason.
   *
   * No floor. §15's `cos_floor` is where §5.2 stops trusting a match, and
   * applying it here would both decide the ladder's question and hide the
   * rejected candidates from the §13 replay that tunes the number.
   *
   * @spec §5.2, §11, §15
   */
  searchReferentGlosses(query: ReferentGlossSearch): ReferentGlossHit[] {
    assertStoredWidth('a gloss query embedding', query.embedding);
    const k = Math.floor(query.limit);
    if (!Number.isFinite(k) || k <= 0) return [];

    const probe = encodeInt8Vector(toAnnVector(query.embedding));
    return this.#statements.searchGlosses.all(probe, k).map((row) => ({
      referentId: row.entity_id,
      cosine: clampCosine(1 - row.distance),
    }));
  }

  /**
   * Replaces a referent's facet centroids, and touches nothing else on the row.
   *
   * Everything is checked before the write: the §3.1 count comes from the schema,
   * the width from §11's pin, and the referent from the index. A refusal leaves
   * the centroids that were already there, which matters because the caller that
   * gets refused is mid-update and its next move is to retry with the old mean.
   *
   * The gloss vector is deliberately not rewritten. A facet mean moving is not
   * the referent being re-embedded, and re-inserting the `vec0` row here would
   * make every claim attachment pay for an ANN write nothing asked for.
   *
   * @spec §3.1, §9, §11
   */
  updateReferentFacets(
    referentId: string,
    facets: readonly (readonly number[])[],
    counts?: readonly number[] | undefined,
  ): void {
    const parsed = Facets.parse(facets);
    for (const facet of parsed) assertStoredWidth('a facet centroid', facet);
    const weights = alignedCounts(parsed, counts);

    const s = this.#statements;
    this.#transaction('updateReferentFacets', () => {
      if (s.entityExists.get(referentId) === undefined) throw new UnknownEntityError(referentId);
      s.updateFacets.run(
        encodeFloatVectors(parsed),
        encodeFacetCounts(weights),
        now(),
        referentId,
      );
    });
  }

  /**
   * How many claims each of a referent's centroids is the mean of.
   *
   * The centroids are read alongside the counts so the positional promise can be
   * checked rather than assumed: `facet_counts` is a plain TEXT column on a table
   * `rebuild-index` regenerates wholesale, so a count vector of the wrong length
   * is not a shorter answer to give back but a wrong one to refuse. Counted the
   * same way {@link GraphStore.getEntity} counts them, so the two cannot disagree
   * about how many centroids a referent has.
   *
   * @spec §3.1, §9
   */
  getFacetCounts(referentId: string): number[] {
    const row = this.#statements.selectFacetCounts.get(referentId);
    if (row === undefined) return [];
    return decodeFacetCounts(row.facet_counts, decodeFloatVectors(row.facets).length);
  }

  /**
   * Records one containment edge, idempotently on the pair.
   *
   * Both ends are checked, as they are for a structural edge: this index is a
   * view over another view, and an edge to a referent the spine does not hold is
   * an emitter bug rather than a fact to keep. The containment *claim* is
   * already in the ledger by then and is refused nothing.
   *
   * @spec §3.1, §3.3
   */
  putContainment(containment: Containment): void {
    const s = this.#statements;
    this.#transaction('putContainment', () => {
      if (s.entityExists.get(containment.parent) === undefined)
        throw new UnknownEntityError(containment.parent);
      if (s.entityExists.get(containment.child) === undefined)
        throw new UnknownEntityError(containment.child);

      s.insertContainment.run(containment.parent, containment.child);
    });
  }

  /** A referent's direct children, in the order they were recorded. @spec §3.1, §3.3 */
  getChildren(parentId: string): string[] {
    return this.#statements.selectChildren.all(parentId).map((row) => row.child_id);
  }

  /**
   * Mints a claim: the row, its normalized provenance and both vector copies, or
   * none of them.
   *
   * Nothing checks `scope`. It names a referent, and the referent index is a
   * view over existence claims (diagram §4) — a ledger row a view could refuse
   * is a ledger the view constrains, and `clearViews` would then be able to
   * invalidate history. Anchor integrity belongs to the pipeline that resolves
   * the anchor, which is also the only layer that could do something about it.
   *
   * @spec §3.2, §3.5, §11
   */
  putClaim(claim: ClaimRecord): void {
    const parsed = LedgerClaim.parse(claim);
    const evidence = readPosterior(parsed.id, parsed.regime, claim.evidence);
    assertStoredWidth('a claim embedding', parsed.embedding);

    const embedding = Float32Array.from(parsed.embedding);
    const s = this.#statements;

    this.#transaction('putClaim', () => {
      if (s.claimExists.get(parsed.id) !== undefined) throw new DuplicateClaimError(parsed.id);

      s.insertClaim.run(
        parsed.id,
        parsed.text,
        encodeFloatVector(parsed.embedding),
        parsed.kind,
        parsed.tier,
        parsed.status,
        parsed.regime,
        evidence?.alpha ?? null,
        evidence?.beta ?? null,
        parsed.scope,
        parsed.temporal.createdAt,
        parsed.temporal.lastCorroborated ?? null,
        parsed.temporal.invalidatedAt ?? null,
        parsed.temporal.lastChurnEvent ?? null,
        flag(parsed.canonical),
      );

      const axes: Record<ProvenanceAxis, readonly string[]> = {
        episode: parsed.provenance.episodes,
        changeEvent: parsed.provenance.changeEvents,
        artifact: parsed.provenance.artifacts,
      };
      // The A15 pathway signature rides on every backing row rather than on the
      // claim: a counter is keyed by (channel, agent) *and* by the axis values
      // the corroboration came in on, so the two have to be readable together.
      const channel = parsed.provenance.channel ?? null;
      const agent = parsed.provenance.agent ?? null;
      for (const axis of PROVENANCE_AXES)
        axes[axis].forEach((value, ordinal) => {
          s.insertProvenance.run(parsed.id, axis, value, ordinal, channel, agent);
        });

      s.insertClaimVector.run(
        parsed.id,
        encodeInt8Vector(toAnnVector(embedding)),
        flag(parsed.status === ARCHIVED),
      );
    });
  }

  /** Reads a claim by id, archived or not. @spec §3.2, §6.1 */
  getClaim(id: string): ClaimRecord | undefined {
    const row = this.#statements.selectClaim.get(id);
    if (row === undefined) return undefined;

    const provenanceRows = this.#statements.selectProvenance.all(id);
    // The A15 signature is identical on every backing row of one claim, so the
    // first row carrying each half carries the claim's.
    const channel = provenanceRows.find((provenance) => provenance.channel !== null)?.channel;
    const agent = provenanceRows.find((provenance) => provenance.agent !== null)?.agent;
    return {
      id: row.id,
      text: row.text,
      embedding: Array.from(decodeFloatVector(row.embedding)),
      kind: row.kind as ClaimKind,
      tier: row.tier as ClaimTier,
      status: row.status as ClaimStatus,
      regime: row.regime as Regime,
      evidence: row.alpha === null || row.beta === null ? null : { alpha: row.alpha, beta: row.beta },
      scope: row.scope,
      temporal: {
        createdAt: row.created_at,
        ...(row.last_corroborated === null ? {} : { lastCorroborated: row.last_corroborated }),
        ...(row.invalidated_at === null ? {} : { invalidatedAt: row.invalidated_at }),
        ...(row.last_churn_event === null ? {} : { lastChurnEvent: row.last_churn_event }),
      },
      provenance: {
        episodes: axisValues(provenanceRows, 'episode'),
        changeEvents: axisValues(provenanceRows, 'changeEvent'),
        artifacts: axisValues(provenanceRows, 'artifact'),
        ...(channel === undefined || channel === null ? {} : { channel }),
        ...(agent === undefined || agent === null ? {} : { agent }),
      },
      canonical: row.canonical === 1,
    };
  }

  /**
   * Moves a claim to a new lifecycle state.
   *
   * The posterior is not touched: a status change is not evidence. The ANN
   * index's `archived` flag moves with it, because §6.1's exclusion has to hold
   * inside the KNN scan and not merely in a filter afterwards.
   *
   * @spec §6.1
   */
  setClaimStatus(change: ClaimStatusChange): void {
    const s = this.#statements;
    this.#transaction('setClaimStatus', () => {
      const info = s.updateClaimStatus.run(
        change.status,
        change.invalidatedAt ?? null,
        change.claimId,
      );
      if (info.changes === 0) throw new UnknownClaimError(change.claimId);
      s.updateClaimVectorArchived.run(flag(change.status === ARCHIVED), change.claimId);
    });
  }

  /**
   * Reads a claim's Beta-Bernoulli parameters, and distinguishes "this claim has
   * no posterior" from "there is no such claim".
   *
   * @spec §3.2, §4.1
   */
  getEvidence(claimId: string): Evidence | null | undefined {
    const row = this.#statements.selectEvidence.get(claimId);
    if (row === undefined) return undefined;
    return row.alpha === null || row.beta === null ? null : { alpha: row.alpha, beta: row.beta };
  }

  /**
   * Adds a contribution to a claim's posterior.
   *
   * One `UPDATE claims SET alpha = alpha + ?, beta = beta + ?`. The addition
   * happens inside SQLite, under the write lock, so two processes contending for
   * one claim serialize into two additions rather than racing to overwrite each
   * other's read.
   *
   * @spec §4.2, §5.7, §12
   */
  incrementEvidence(increment: EvidenceIncrement): void {
    const alpha = increment.alpha ?? 0;
    const beta = increment.beta ?? 0;
    assertContribution('alpha', alpha);
    assertContribution('beta', beta);

    const info = this.#write('incrementEvidence', () =>
      this.#statements.incrementEvidence.run(alpha, beta, increment.claimId),
    );
    if (info.changes === 0) this.#refuseEvidenceMutation(increment.claimId);
  }

  /**
   * Names why an α/β mutation matched no row.
   *
   * Only ever reached on the failure path, which is what keeps the mutation
   * itself a single statement: the `WHERE ... AND regime = 'evidence'` clause is
   * what actually protects a view claim, and this read only says which of the
   * two reasons the clause matched nothing. It cannot be folded into the update,
   * because "no such claim" and "that claim has no posterior" are the same zero
   * rows to SQLite and two different refusals to a caller.
   *
   * A view claim would otherwise be mutated silently and pointlessly:
   * `alpha = alpha + 1` over a NULL is NULL, which satisfies the view arm of the
   * table CHECK and reports one row changed.
   *
   * @spec §3.2, §4.2, §4.5
   */
  #refuseEvidenceMutation(claimId: string): never {
    if (this.#statements.claimExists.get(claimId) === undefined)
      throw new UnknownClaimError(claimId);
    throw new RegimeViolationError(
      claimId,
      VIEW,
      'has no posterior to move — an attested referent is maintained by re-parsing its source',
    );
  }

  /**
   * Applies one commit's churn decay.
   *
   * Written as `prior + γ(x − prior)` rather than the algebraically equal
   * `γx + (1 − γ)prior`. Not because the fixture's constants drift under the
   * second form — at γ = 0.8 and prior = 1 both forms land on the prior exactly,
   * so no test here discriminates them. The first form is chosen on principle: when
   * `x` already equals `prior`, `x − prior` is `0` regardless of rounding, so
   * `prior + γ·0` is an *unconditional* fixed point, exact for every `(γ, prior)`
   * pair, not just this fixture's. The second form has no such guarantee — computing
   * `1 − γ` and `γx + (1 − γ)prior` separately rounds twice, and drifts for some
   * `(γ, prior)` pairs (e.g. γ = 0.2, prior = 3). The first form is never worse and
   * sometimes better, so it wins without needing an observed failure to justify it.
   * Still one statement — decay contends with increments for the same rows.
   *
   * @spec §4.5, §5.7
   */
  decayEvidence(decay: EvidenceDecay): void {
    if (!Number.isFinite(decay.gamma) || decay.gamma < 0 || decay.gamma > 1)
      throw new RangeError(
        `gamma must be a retention factor in [0, 1] — outside it decay pushes evidence away from the prior — got ${String(decay.gamma)}`,
      );
    for (const [name, value] of [
      ['prior.alpha', decay.prior.alpha],
      ['prior.beta', decay.prior.beta],
    ] as const)
      if (!Number.isFinite(value) || value <= 0)
        throw new RangeError(
          `${name} must be a strictly positive Beta parameter, got ${String(value)}`,
        );

    const info = this.#write('decayEvidence', () =>
      this.#statements.decayEvidence.run(
        decay.prior.alpha,
        decay.gamma,
        decay.prior.alpha,
        decay.prior.beta,
        decay.gamma,
        decay.prior.beta,
        decay.at,
        decay.claimId,
      ),
    );
    if (info.changes === 0) this.#refuseEvidenceMutation(decay.claimId);
  }

  /** The §11 full-precision copy. @spec §11 */
  getRerankVector(claimId: string): Float32Array | undefined {
    const row = this.#statements.selectRerankVector.get(claimId);
    return row === undefined ? undefined : decodeFloatVector(row.value);
  }

  /** The §11 quantized copy. @spec §11 */
  getAnnVector(claimId: string): Int8Array | undefined {
    const row = this.#statements.selectAnnVector.get(claimId);
    return row === undefined ? undefined : decodeInt8Vector(row.value);
  }

  /**
   * The §5.3 semantic candidate channel.
   *
   * The query is narrowed and quantized the same way the stored copies were, so
   * both sides of the comparison live in the same geometry. The reported score is
   * a true cosine — sqlite-vec divides by both norms — and is clamped anyway:
   * §15's thresholds are all expressed as cosines, and a score of 1.001 reads as
   * an unusually good match rather than as the arithmetic error it is.
   *
   * @spec §5.3, §6.1, §11
   */
  searchClaims(query: ClaimSearch): ClaimSearchHit[] {
    assertStoredWidth('a query embedding', query.embedding);
    const k = Math.floor(query.limit);
    if (!Number.isFinite(k) || k <= 0) return [];

    const probe = encodeInt8Vector(toAnnVector(query.embedding));
    const rows =
      query.includeArchived === true
        ? this.#statements.searchClaimsAll.all(probe, k)
        : this.#statements.searchClaimsLive.all(probe, k);

    return rows.map((row) => ({
      claimId: row.claim_id,
      cosine: clampCosine(1 - row.distance),
    }));
  }

  /**
   * Writes one §3.3 claim edge.
   *
   * The reserved kinds are refused before anything is looked up: they are seams
   * for deferred features, and the point of the refusal is that nothing in v1 can
   * quietly start minting them.
   *
   * @spec §3.3, §5.5
   */
  putClaimEdge(edge: ClaimEdge): void {
    if ((RESERVED_EDGE_KINDS as readonly string[]).includes(edge.kind))
      throw new ReservedEdgeKindError(edge.kind);

    const s = this.#statements;
    if (s.claimExists.get(edge.from) === undefined) throw new UnknownClaimError(edge.from);
    if (edge.kind === ABOUT) {
      if (s.entityExists.get(edge.to) === undefined) throw new UnknownEntityError(edge.to);
    } else if (s.claimExists.get(edge.to) === undefined) {
      throw new UnknownClaimError(edge.to);
    }

    // A re-resolve writes the same ABOUT edge every time it runs; the edge set is
    // a set, so the second write is a no-op rather than a duplicate.
    this.#write('putClaimEdge', () => s.insertClaimEdge.run(edge.from, edge.kind, edge.to, now()));
  }

  /**
   * Every edge this claim carries, in the order they were written, with
   * `CONTRADICTS` folded in from the far end and presented from the caller's.
   *
   * @spec §3.3, §7.4
   */
  getClaimEdges(claimId: string): ClaimEdge[] {
    return this.#statements.selectClaimEdges.all(claimId, claimId).map((row) => ({
      from: row.from_id,
      kind: row.kind as ClaimEdgeKind,
      to: row.to_id,
    }));
  }

  /** The §5.3 structural candidate channel. @spec §5.3, §6.1 */
  getClaimsAbout(entityId: string, scope: ArchiveScope = {}): string[] {
    return this.#statements.selectClaimsAbout
      .all(entityId, flag(scope.includeArchived === true))
      .map((row) => row.claim_id);
  }

  /**
   * Replaces every parsed structural edge leaving an entity.
   *
   * Validated before the delete, so a parse naming an entity that does not exist
   * leaves the previous set standing rather than clearing it and then failing.
   *
   * The delete reaches `entity_edges` only. Containment lives in its own index
   * (see {@link SqliteGraphStore.putContainment}) precisely so that an emitter
   * re-emitting one module's `CALLS` cannot take that module's spine with it.
   *
   * @spec §3.3
   */
  putStructuralEdges(entityId: string, edges: readonly StructuralEdgeInput[]): void {
    const s = this.#statements;
    this.#transaction('putStructuralEdges', () => {
      if (s.entityExists.get(entityId) === undefined) throw new UnknownEntityError(entityId);
      for (const edge of edges)
        if (s.entityExists.get(edge.to) === undefined) throw new UnknownEntityError(edge.to);

      s.deleteStructuralEdges.run(entityId);
      for (const edge of edges) s.insertStructuralEdge.run(entityId, edge.kind, edge.to);
    });
  }

  /**
   * The structural edges leaving an entity: the parse's own, then containment.
   *
   * One read over the two tables, so a traversal sees the spine and the call
   * graph together without knowing which clock re-derives which. A pair a parser
   * and a containment claim both assert is reported once.
   *
   * @spec §3.3
   */
  getStructuralEdges(entityId: string): StructuralEdge[] {
    return this.#statements.selectStructuralEdges
      .all(entityId, entityId)
      .map((row) => ({ from: row.from_id, kind: row.kind, to: row.to_id }));
  }

  /**
   * The §5.1 stage-0 gate.
   *
   * `INSERT OR IGNORE` against a `(episode_id, text_hash)` unique index: the
   * admission decision *is* the insert, so a retry racing its own original
   * cannot have both copies admitted.
   *
   * @spec §5.1, §12
   */
  admitObservation(observation: ObservationKey): boolean {
    const s = this.#statements;
    return this.#write('admitObservation', () => {
      s.ensureEpisode.run(observation.episodeId);
      const info = s.insertEpisodeEvent.run(
        observation.episodeId,
        hashText(observation.normalizedText),
        now(),
      );
      return info.changes === 1;
    });
  }

  /** Records the claims a session was served. @spec §4.3, §7.5 */
  recordTaint(record: TaintRecord): void {
    const s = this.#statements;
    this.#transaction('recordTaint', () => {
      const at = now();
      for (const claimId of record.claimIds) {
        if (s.claimExists.get(claimId) === undefined) throw new UnknownClaimError(claimId);
        s.insertTaint.run(record.sessionId, claimId, at);
      }
    });
  }

  /** Whether this session already had this claim in its retrieval context. @spec §4.3 */
  isTainted(query: TaintQuery): boolean {
    return this.#statements.selectTaint.get(query.sessionId, query.claimId) !== undefined;
  }

  /** A fresh snapshot of a session's taint set. @spec §4.3, §7.5 */
  getTaintSet(sessionId: string): ReadonlySet<string> {
    return new Set(this.#statements.selectTaintSet.all(sessionId).map((row) => row.claim_id));
  }

  /** Appends one §5.8 replay-log entry. @spec §5.8, §13 */
  appendStageLog(entry: StageLogEntry): void {
    const s = this.#statements;
    this.#write('appendStageLog', () => {
      s.ensureEpisode.run(entry.episodeId);
      s.insertStageLog.run(
        entry.episodeId,
        entry.stage,
        JSON.stringify(entry.inputs ?? null),
        entry.decision === undefined ? null : JSON.stringify(entry.decision),
        entry.at,
      );
    });
  }

  /** An episode's log entries, in the order they were appended. @spec §5.8, §13 */
  readStageLog(episodeId: string): StageLogEntry[] {
    return this.#statements.selectStageLog.all(episodeId).map((row) => ({
      episodeId: row.episode_id,
      stage: row.stage,
      inputs: JSON.parse(row.inputs) as unknown,
      decision: row.decision === null ? null : (JSON.parse(row.decision) as unknown),
      at: row.at,
    }));
  }

  /** Closes the connection. @spec §11 */
  close(): void {
    this.#db.close();
  }
}

/**
 * Prepares every statement the store uses, once per connection.
 *
 * Kept in one place so the SQL surface is readable as a whole — and so the §5.7
 * claim that evidence never round-trips through the server is checkable by
 * reading two statements rather than by auditing the class.
 *
 * @spec §5.7, §11
 */
const prepareStatements = (db: BetterSqlite3.Database) => ({
  upsertEntity: db.prepare<
    [string, string, string | null, string, string | null, Buffer, Buffer, string, string]
  >(`
    INSERT INTO entities
      (id, name, level, regime, locator, gloss_embedding, facets, facet_counts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name            = excluded.name,
      level           = excluded.level,
      regime          = excluded.regime,
      locator         = excluded.locator,
      gloss_embedding = excluded.gloss_embedding,
      facets          = excluded.facets,
      facet_counts    = excluded.facet_counts,
      updated_at      = excluded.updated_at
  `),

  selectEntity: db.prepare<[string], EntityRow>(`
    SELECT id, name, level, regime, locator, gloss_embedding, facets
      FROM entities
     WHERE id = ?
  `),

  // Facets and their counts move together and nothing else on the row moves with
  // them: §3.1's mean update is not a re-embedding, and the gloss vector must
  // survive it untouched.
  updateFacets: db.prepare<[Buffer, string, string, string]>(`
    UPDATE entities
       SET facets = ?, facet_counts = ?, updated_at = ?
     WHERE id = ?
  `),

  // The centroids come back with the counts, because §3.1's promise is positional
  // and a reader that cannot see the facet blob cannot tell an aligned count
  // vector from a prefix of one.
  selectFacetCounts: db.prepare<[string], FacetCountsRow>(
    'SELECT facets, facet_counts FROM entities WHERE id = ?',
  ),

  entityExists: db.prepare<[string], CountRow>(
    'SELECT 1 AS present FROM entities WHERE id = ?',
  ),

  deleteAllEntities: db.prepare('DELETE FROM entities'),

  deleteGlossVector: db.prepare<[string]>(
    'DELETE FROM entity_gloss_vectors WHERE entity_id = ?',
  ),

  deleteAllGlossVectors: db.prepare('DELETE FROM entity_gloss_vectors'),

  insertGlossVector: db.prepare<[string, Buffer]>(
    'INSERT INTO entity_gloss_vectors (entity_id, gloss) VALUES (?, vec_int8(?))',
  ),

  // §5.2's last rung. No metadata filter to match `searchClaimsLive`'s: a
  // referent has no lifecycle status to be excluded by.
  searchGlosses: db.prepare<[Buffer, number], GlossHitRow>(`
    SELECT entity_id, distance
      FROM entity_gloss_vectors
     WHERE gloss MATCH vec_int8(?)
       AND k = ?
     ORDER BY distance
  `),

  // The pair is the key, so a form recorded twice for one referent is one row —
  // and a form that has come to name two referents keeps both, for §5.2 to sort
  // out rather than for this layer to overwrite. The repeat naming lands on `n`
  // instead of on a second row, which is what §3.1's "most-corroborated surface
  // form" is counted from; `at` stays at the first naming.
  insertMention: db.prepare<[string, string, string]>(`
    INSERT INTO mentions (surface_form, referent_id, at, n)
    VALUES (?, ?, ?, 1)
    ON CONFLICT (surface_form, referent_id) DO UPDATE SET n = n + 1
  `),

  selectMention: db.prepare<[string], ReferentRow>(`
    SELECT referent_id FROM mentions WHERE surface_form = ? ORDER BY rowid LIMIT 1
  `),

  // Canonical-name matches first, then oldest naming first — §5.2 climbs its
  // ladder in that order. The join is LEFT because the mention index is keyed by
  // referent id and never checked against the referent index (that index is a
  // view), so a form can outlive the row it names; such a candidate is reported,
  // and reported as not canonical.
  selectMentionCandidates: db.prepare<[string], MentionCandidateRow>(`
    SELECT m.referent_id AS referent_id,
           CASE WHEN e.name = m.surface_form THEN 1 ELSE 0 END AS canonical
      FROM mentions m
      LEFT JOIN entities e ON e.id = m.referent_id
     WHERE m.surface_form = ?
     ORDER BY canonical DESC, m.rowid
  `),

  selectMentionTally: db.prepare<[string], MentionTallyRow>(`
    SELECT surface_form, n
      FROM mentions
     WHERE referent_id = ?
     ORDER BY n DESC, rowid
  `),

  deleteAllMentions: db.prepare('DELETE FROM mentions'),

  insertClaim: db.prepare<
    [
      string,
      string,
      Buffer,
      string,
      string,
      string,
      string,
      number | null,
      number | null,
      string,
      string,
      string | null,
      string | null,
      string | null,
      number,
    ]
  >(`
    INSERT INTO claims
      (id, text, embedding, kind, tier, status, regime, alpha, beta, scope,
       created_at, last_corroborated, invalidated_at, last_churn_event, canonical)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  selectClaim: db.prepare<[string], ClaimRow>(`
    SELECT id, text, embedding, kind, tier, status, regime, alpha, beta, scope,
           created_at, last_corroborated, invalidated_at, last_churn_event, canonical
      FROM claims
     WHERE id = ?
  `),

  claimExists: db.prepare<[string], CountRow>('SELECT 1 AS present FROM claims WHERE id = ?'),

  insertProvenance: db.prepare<[string, string, string, number, string | null, string | null]>(
    'INSERT INTO provenance (claim_id, axis, value, ordinal, channel, agent) VALUES (?, ?, ?, ?, ?, ?)',
  ),

  selectProvenance: db.prepare<[string], ProvenanceRow>(`
    SELECT axis, value, channel, agent
      FROM provenance
     WHERE claim_id = ?
     ORDER BY axis, ordinal
  `),

  updateClaimStatus: db.prepare<[string, string | null, string]>(`
    UPDATE claims
       SET status = ?,
           -- Left standing when the transition supplies no instant: a claim that
           -- was deprecated once keeps the instant it was deprecated at.
           invalidated_at = COALESCE(?, invalidated_at)
     WHERE id = ?
  `),

  selectEvidence: db.prepare<[string], EvidenceRow>(
    'SELECT alpha, beta FROM claims WHERE id = ?',
  ),

  // §5.7. The whole mitigation for the §12 lost-update row is that the `+` is on
  // this side of the boundary. Read it, then write it back, and three processes
  // hammering one claim silently discard a third of their contributions.
  //
  // The regime predicate is on the same statement for the same reason: SQLite
  // evaluates `NULL + 1` as NULL, which passes the table CHECK's view arm, so a
  // view claim would be "incremented" into exactly the state it was already in
  // and the caller would be told it worked.
  incrementEvidence: db.prepare<[number, number, string]>(
    `UPDATE claims SET alpha = alpha + ?, beta = beta + ?
      WHERE id = ? AND regime = '${EVIDENCE}'`,
  ),

  // §4.5, `x ← prior + γ(x − prior)`. Toward the prior, never toward zero:
  // churn makes the graph uncertain again, it does not make claims false.
  decayEvidence: db.prepare<
    [number, number, number, number, number, number, string, string]
  >(`
    UPDATE claims
       SET alpha = ? + ? * (alpha - ?),
           beta  = ? + ? * (beta  - ?),
           last_churn_event = ?
     WHERE id = ?
       AND regime = '${EVIDENCE}'
  `),

  selectRerankVector: db.prepare<[string], BlobRow>(
    'SELECT embedding AS value FROM claims WHERE id = ?',
  ),

  selectAnnVector: db.prepare<[string], BlobRow>(
    'SELECT embedding AS value FROM claim_vectors WHERE claim_id = ?',
  ),

  insertClaimVector: db.prepare<[string, Buffer, number]>(`
    INSERT INTO claim_vectors (claim_id, embedding, archived)
    VALUES (?, vec_int8(?), CAST(? AS INTEGER))
  `),

  updateClaimVectorArchived: db.prepare<[number, string]>(
    'UPDATE claim_vectors SET archived = CAST(? AS INTEGER) WHERE claim_id = ?',
  ),

  // §6.1: the archived filter rides inside the KNN scan as a vec0 metadata
  // constraint. Filtering the result set afterwards would quietly return fewer
  // than `k` live neighbours whenever an archived one ranked above them.
  searchClaimsLive: db.prepare<[Buffer, number], HitRow>(`
    SELECT claim_id, distance
      FROM claim_vectors
     WHERE embedding MATCH vec_int8(?)
       AND k = ?
       AND archived = CAST(0 AS INTEGER)
     ORDER BY distance
  `),

  searchClaimsAll: db.prepare<[Buffer, number], HitRow>(`
    SELECT claim_id, distance
      FROM claim_vectors
     WHERE embedding MATCH vec_int8(?)
       AND k = ?
     ORDER BY distance
  `),

  insertClaimEdge: db.prepare<[string, string, string, string]>(
    'INSERT OR IGNORE INTO claim_edges (from_id, kind, to_id, created_at) VALUES (?, ?, ?, ?)',
  ),

  // §3.3 writes CONTRADICTS as `claim ↔ claim`, so the second leg reads it
  // backwards and presents the queried claim as the source — §7.4's
  // rivals-travel-together rule needs a reverse lookup to stand on. The NOT
  // EXISTS keeps a rivalry written from both ends from being reported twice.
  selectClaimEdges: db.prepare<[string, string], EdgeRow>(`
    SELECT from_id, kind, to_id, id AS ord
      FROM claim_edges
     WHERE from_id = ?
    UNION ALL
    SELECT x.to_id AS from_id, x.kind AS kind, x.from_id AS to_id, x.id AS ord
      FROM claim_edges x
     WHERE x.kind = '${CONTRADICTS}'
       AND x.to_id = ?
       AND NOT EXISTS (
             SELECT 1 FROM claim_edges r
              WHERE r.from_id = x.to_id AND r.kind = x.kind AND r.to_id = x.from_id
           )
     ORDER BY ord
  `),

  selectClaimsAbout: db.prepare<[string, number], ClaimIdRow>(`
    SELECT e.from_id AS claim_id
      FROM claim_edges e
      JOIN claims c ON c.id = e.from_id
     WHERE e.kind = '${ABOUT}'
       AND e.to_id = ?
       AND (? = 1 OR c.status <> '${ARCHIVED}')
     ORDER BY e.id
  `),

  deleteStructuralEdges: db.prepare<[string]>('DELETE FROM entity_edges WHERE from_id = ?'),

  deleteAllStructuralEdges: db.prepare('DELETE FROM entity_edges'),

  insertStructuralEdge: db.prepare<[string, string, string]>(
    'INSERT OR IGNORE INTO entity_edges (from_id, kind, to_id) VALUES (?, ?, ?)',
  ),

  // Two tables, one read: the parse's edges in parse order, then containment in
  // the order it was recorded. `NOT EXISTS` keeps a pair that a parser and a
  // containment claim both assert from being reported twice — the same shape the
  // CONTRADICTS reverse leg above uses, and for the same reason.
  selectStructuralEdges: db.prepare<[string, string], EdgeRow>(`
    SELECT from_id, kind, to_id, 0 AS source, id AS ord
      FROM entity_edges
     WHERE from_id = ?
    UNION ALL
    SELECT c.parent_id AS from_id, '${CONTAINS}' AS kind, c.child_id AS to_id,
           1 AS source, c.id AS ord
      FROM contains_index c
     WHERE c.parent_id = ?
       AND NOT EXISTS (
             SELECT 1 FROM entity_edges e
              WHERE e.from_id = c.parent_id AND e.kind = '${CONTAINS}' AND e.to_id = c.child_id
           )
     ORDER BY source, ord
  `),

  insertContainment: db.prepare<[string, string]>(
    'INSERT OR IGNORE INTO contains_index (parent_id, child_id) VALUES (?, ?)',
  ),

  selectChildren: db.prepare<[string], ChildRow>(
    'SELECT child_id FROM contains_index WHERE parent_id = ? ORDER BY id',
  ),

  deleteAllContainment: db.prepare('DELETE FROM contains_index'),

  ensureEpisode: db.prepare<[string]>('INSERT OR IGNORE INTO episodes (id) VALUES (?)'),

  insertEpisodeEvent: db.prepare<[string, string, string]>(
    'INSERT OR IGNORE INTO episode_events (episode_id, text_hash, at) VALUES (?, ?, ?)',
  ),

  // Keyed by `episode_id` (diagram §4). The port still calls the key a session
  // id, and that rename is a change of its own with its own tests; what the
  // column names is the unit §4.2 caps and §4.4 discounting already count in.
  insertTaint: db.prepare<[string, string, string]>(
    'INSERT OR IGNORE INTO taint (episode_id, claim_id, at) VALUES (?, ?, ?)',
  ),

  selectTaint: db.prepare<[string, string], CountRow>(
    'SELECT 1 AS present FROM taint WHERE episode_id = ? AND claim_id = ?',
  ),

  selectTaintSet: db.prepare<[string], ClaimIdRow>(
    'SELECT claim_id FROM taint WHERE episode_id = ?',
  ),

  insertStageLog: db.prepare<[string, string, string, string | null, string]>(
    'INSERT INTO stage_log (episode_id, stage, inputs, decision, at) VALUES (?, ?, ?, ?, ?)',
  ),

  selectStageLog: db.prepare<[string], StageLogAtRow>(`
    SELECT episode_id, stage, inputs, decision, at
      FROM stage_log
     WHERE episode_id = ?
     ORDER BY id
  `),
});

/**
 * Opens the graph store, migrating the database if it has not been migrated.
 *
 * The wait is resolved once, here, and handed to both the connection and the
 * store: the number `PRAGMA busy_timeout` blocks for has to be the same number a
 * {@link StoreBusyError} reports, or a caller deciding whether to wait longer is
 * deciding against a figure nothing honoured.
 *
 * @spec §5.7, §11
 */
export const openGraphStore = (options: GraphStoreOptions): GraphStore => {
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  return new SqliteGraphStore(openDatabase(options.path, busyTimeoutMs), busyTimeoutMs);
};
