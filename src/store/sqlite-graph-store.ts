/**
 * The better-sqlite3 adapter behind {@link GraphStore}.
 *
 * Three things in here are load-bearing rather than incidental.
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
 * @spec §3.1, §3.2, §3.3, §4.5, §5.1, §5.3, §5.7, §5.8, §6.1, §7.5, §11
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
  DuplicateClaimError,
  ReservedEdgeKindError,
  StoreBusyError,
  UnknownClaimError,
  UnknownEntityError,
  isBusyError,
} from './errors.js';
import type {
  ArchiveScope,
  ClaimEdge,
  ClaimSearch,
  ClaimSearchHit,
  ClaimStatusChange,
  EvidenceDecay,
  EvidenceIncrement,
  GraphStore,
  GraphStoreOptions,
  ObservationKey,
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

/** The three provenance axes, in the order they are persisted. @spec §3.5, §4.4, §4.5 */
const PROVENANCE_AXES = ['episode', 'commit', 'file'] as const;

type ProvenanceAxis = (typeof PROVENANCE_AXES)[number];

interface EntityRow {
  readonly id: string;
  readonly name: string;
  readonly aliases: string;
  readonly level: string;
  readonly origin: string;
  readonly ref_path: string | null;
  readonly ref_range: string | null;
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
  readonly alpha: number;
  readonly beta: number;
  readonly scope: string;
  readonly created_at: string;
  readonly last_corroborated: string | null;
  readonly invalidated_at: string | null;
  readonly last_churn_event: string | null;
  readonly canonical: number;
}

interface EvidenceRow {
  readonly alpha: number;
  readonly beta: number;
}

interface ProvenanceRow {
  readonly axis: string;
  readonly value: string;
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
        JSON.stringify(parsed.aliases),
        parsed.level,
        parsed.origin,
        parsed.ref?.path ?? null,
        parsed.ref?.symbolRange === undefined ? null : JSON.stringify(parsed.ref.symbolRange),
        encodeFloatVector(parsed.glossEmbedding),
        encodeFloatVectors(parsed.facets),
        now(),
      );
      // vec0 has no upsert: the previous gloss goes, the new one lands.
      s.deleteGlossVector.run(parsed.id);
      s.insertGlossVector.run(parsed.id, encodeInt8Vector(toAnnVector(gloss)));
    });
  }

  /** Reads a spine node. @spec §3.1 */
  getEntity(id: string): EntityShape | undefined {
    const row = this.#statements.selectEntity.get(id);
    if (row === undefined) return undefined;

    const base = {
      id: row.id,
      name: row.name,
      aliases: JSON.parse(row.aliases) as string[],
      level: row.level as EntityLevel,
      origin: row.origin as 'parsed' | 'asserted',
      glossEmbedding: Array.from(decodeFloatVector(row.gloss_embedding)),
      facets: decodeFloatVectors(row.facets).map((facet) => Array.from(facet)),
    };
    // The key is omitted rather than set to undefined: an absent optional that
    // comes back as an explicit `null` is what `.datetime()`-style refinements
    // reject, and what `toStrictEqual` notices.
    if (row.ref_path === null) return base;

    const symbolRange =
      row.ref_range === null ? undefined : (JSON.parse(row.ref_range) as [number, number]);
    return {
      ...base,
      ref: symbolRange === undefined ? { path: row.ref_path } : { path: row.ref_path, symbolRange },
    };
  }

  /**
   * Mints a claim: the row, its normalized provenance and both vector copies, or
   * none of them.
   *
   * @spec §3.2, §11
   */
  putClaim(claim: Claim): void {
    const parsed = Claim.parse(claim);
    assertStoredWidth('a claim embedding', parsed.embedding);

    const embedding = Float32Array.from(parsed.embedding);
    const s = this.#statements;

    this.#transaction('putClaim', () => {
      if (s.claimExists.get(parsed.id) !== undefined) throw new DuplicateClaimError(parsed.id);
      // Checked rather than left to the foreign key, so the caller learns *which*
      // anchor is missing. §5.2 never mints one eagerly to paper over it.
      if (s.entityExists.get(parsed.scope) === undefined)
        throw new UnknownEntityError(parsed.scope);

      s.insertClaim.run(
        parsed.id,
        parsed.text,
        encodeFloatVector(parsed.embedding),
        parsed.kind,
        parsed.tier,
        parsed.status,
        parsed.evidence.alpha,
        parsed.evidence.beta,
        parsed.scope,
        parsed.temporal.createdAt,
        parsed.temporal.lastCorroborated ?? null,
        parsed.temporal.invalidatedAt ?? null,
        parsed.temporal.lastChurnEvent ?? null,
        flag(parsed.canonical),
      );

      const axes: Record<ProvenanceAxis, readonly string[]> = {
        episode: parsed.provenance.episodes,
        commit: parsed.provenance.commits,
        file: parsed.provenance.files,
      };
      for (const axis of PROVENANCE_AXES)
        axes[axis].forEach((value, ordinal) => {
          s.insertProvenance.run(parsed.id, axis, value, ordinal);
        });

      s.insertClaimVector.run(
        parsed.id,
        encodeInt8Vector(toAnnVector(embedding)),
        flag(parsed.status === ARCHIVED),
      );
    });
  }

  /** Reads a claim by id, archived or not. @spec §3.2, §6.1 */
  getClaim(id: string): Claim | undefined {
    const row = this.#statements.selectClaim.get(id);
    if (row === undefined) return undefined;

    const provenanceRows = this.#statements.selectProvenance.all(id);
    return {
      id: row.id,
      text: row.text,
      embedding: Array.from(decodeFloatVector(row.embedding)),
      kind: row.kind as ClaimKind,
      tier: row.tier as ClaimTier,
      status: row.status as ClaimStatus,
      evidence: { alpha: row.alpha, beta: row.beta },
      scope: row.scope,
      temporal: {
        createdAt: row.created_at,
        ...(row.last_corroborated === null ? {} : { lastCorroborated: row.last_corroborated }),
        ...(row.invalidated_at === null ? {} : { invalidatedAt: row.invalidated_at }),
        ...(row.last_churn_event === null ? {} : { lastChurnEvent: row.last_churn_event }),
      },
      provenance: {
        episodes: axisValues(provenanceRows, 'episode'),
        commits: axisValues(provenanceRows, 'commit'),
        files: axisValues(provenanceRows, 'file'),
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

  /** Reads a claim's Beta-Bernoulli parameters. @spec §4.1 */
  getEvidence(claimId: string): Evidence | undefined {
    const row = this.#statements.selectEvidence.get(claimId);
    return row === undefined ? undefined : { alpha: row.alpha, beta: row.beta };
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
    if (info.changes === 0) throw new UnknownClaimError(increment.claimId);
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
    if (info.changes === 0) throw new UnknownClaimError(decay.claimId);
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

  /** The parsed structural edges leaving an entity. @spec §3.3 */
  getStructuralEdges(entityId: string): StructuralEdge[] {
    return this.#statements.selectStructuralEdges
      .all(entityId)
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
    [string, string, string, string, string, string | null, string | null, Buffer, Buffer, string]
  >(`
    INSERT INTO entities
      (id, name, aliases, level, origin, ref_path, ref_range, gloss_embedding, facets, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name            = excluded.name,
      aliases         = excluded.aliases,
      level           = excluded.level,
      origin          = excluded.origin,
      ref_path        = excluded.ref_path,
      ref_range       = excluded.ref_range,
      gloss_embedding = excluded.gloss_embedding,
      facets          = excluded.facets,
      updated_at      = excluded.updated_at
  `),

  selectEntity: db.prepare<[string], EntityRow>(`
    SELECT id, name, aliases, level, origin, ref_path, ref_range, gloss_embedding, facets
      FROM entities
     WHERE id = ?
  `),

  entityExists: db.prepare<[string], CountRow>(
    'SELECT 1 AS present FROM entities WHERE id = ?',
  ),

  deleteGlossVector: db.prepare<[string]>(
    'DELETE FROM entity_gloss_vectors WHERE entity_id = ?',
  ),

  insertGlossVector: db.prepare<[string, Buffer]>(
    'INSERT INTO entity_gloss_vectors (entity_id, gloss) VALUES (?, vec_int8(?))',
  ),

  insertClaim: db.prepare<
    [
      string,
      string,
      Buffer,
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      string | null,
      string | null,
      string | null,
      number,
    ]
  >(`
    INSERT INTO claims
      (id, text, embedding, kind, tier, status, alpha, beta, scope,
       created_at, last_corroborated, invalidated_at, last_churn_event, canonical)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  selectClaim: db.prepare<[string], ClaimRow>(`
    SELECT id, text, embedding, kind, tier, status, alpha, beta, scope,
           created_at, last_corroborated, invalidated_at, last_churn_event, canonical
      FROM claims
     WHERE id = ?
  `),

  claimExists: db.prepare<[string], CountRow>('SELECT 1 AS present FROM claims WHERE id = ?'),

  insertProvenance: db.prepare<[string, string, string, number]>(
    'INSERT INTO provenance (claim_id, axis, value, ordinal) VALUES (?, ?, ?, ?)',
  ),

  selectProvenance: db.prepare<[string], ProvenanceRow>(`
    SELECT axis, value FROM provenance WHERE claim_id = ? ORDER BY axis, ordinal
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
  incrementEvidence: db.prepare<[number, number, string]>(
    'UPDATE claims SET alpha = alpha + ?, beta = beta + ? WHERE id = ?',
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

  insertStructuralEdge: db.prepare<[string, string, string]>(
    'INSERT OR IGNORE INTO entity_edges (from_id, kind, to_id) VALUES (?, ?, ?)',
  ),

  selectStructuralEdges: db.prepare<[string], EdgeRow>(
    'SELECT from_id, kind, to_id FROM entity_edges WHERE from_id = ? ORDER BY id',
  ),

  ensureEpisode: db.prepare<[string]>('INSERT OR IGNORE INTO episodes (id) VALUES (?)'),

  insertEpisodeEvent: db.prepare<[string, string, string]>(
    'INSERT OR IGNORE INTO episode_events (episode_id, text_hash, at) VALUES (?, ?, ?)',
  ),

  insertTaint: db.prepare<[string, string, string]>(
    'INSERT OR IGNORE INTO taint (session_id, claim_id, at) VALUES (?, ?, ?)',
  ),

  selectTaint: db.prepare<[string, string], CountRow>(
    'SELECT 1 AS present FROM taint WHERE session_id = ? AND claim_id = ?',
  ),

  selectTaintSet: db.prepare<[string], ClaimIdRow>(
    'SELECT claim_id FROM taint WHERE session_id = ?',
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
