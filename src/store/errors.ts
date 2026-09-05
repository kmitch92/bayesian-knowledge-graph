/**
 * Store-owned failure vocabulary.
 *
 * These are *boundary* errors, not domain errors: each one names a promise the
 * persistence layer makes that a caller has just broken. They live here rather
 * than in `src/schema/` because none of them is a shape violation — the schemas
 * accept every value below (a four-element embedding parses fine, §11 / A22),
 * and the store is the only place that knows the width it pinned, which ids it
 * has minted, and which edge kinds v1 refuses to write.
 *
 * The last four are a different species from everything above them. The ones
 * above name a caller's mistake; these four name a *situation* — a column
 * holds bytes no caller of this store put there, the file is not a database,
 * another process will not let go of the write lock, the store was written by
 * a build that knows a schema this one does not. None is anybody's
 * programming error, and each is something a caller has to be able to act on:
 * repair the row §13 replay would otherwise misread, retry a contended write,
 * refuse to start against a corrupt file, tell the user to upgrade. Acting on
 * any of them means telling them apart from an ordinary refusal *by type*,
 * which is why they are declared here rather than left as the driver's
 * `SqliteError` and a message string a dependency is free to reword.
 *
 * @spec §3.3, §3.6, §5.5, §5.7, §5.8, §5.10, §11, §12, §13
 */

/**
 * A vector arrived at a width the store did not pin.
 *
 * `Claim.embedding` and `Entity.glossEmbedding` are bare `z.array(z.number())`
 * by design (back-annotation A22), so this boundary is the only thing standing
 * between a wrong-width vector and an ANN index that scores nonsense.
 *
 * @spec §11
 */
export class DimensionMismatchError extends Error {
  /** The width the store requires. */
  readonly expected: number;
  /** The width that actually arrived. */
  readonly received: number;

  constructor(what: string, expected: number, received: number) {
    super(
      `${what} must have exactly ${String(expected)} components, got ${String(received)}`,
    );
    this.name = 'DimensionMismatchError';
    this.expected = expected;
    this.received = received;
  }
}

/**
 * An operation named a claim the ledger has never minted.
 *
 * Also what an entity id gets when it is offered somewhere a claim id belongs:
 * entities carry no posterior at all (§3.1, principle 2), so "not a claim" and
 * "no such claim" are the same refusal.
 *
 * @spec §3.2, §5.7
 */
export class UnknownClaimError extends Error {
  /** The id that did not resolve. */
  readonly claimId: string;

  constructor(claimId: string) {
    super(`no claim ${claimId} in the ledger`);
    this.name = 'UnknownClaimError';
    this.claimId = claimId;
  }
}

/**
 * An operation named a spine entity that does not exist.
 *
 * Never minted eagerly to make the caller's life easier: eager entity creation
 * on a failed resolution is exactly how the graph fragments (§5.2, §12).
 *
 * @spec §3.1, §5.2
 */
export class UnknownEntityError extends Error {
  /** The id that did not resolve. */
  readonly entityId: string;

  constructor(entityId: string) {
    super(`no entity ${entityId} on the spine`);
    this.name = 'UnknownEntityError';
    this.entityId = entityId;
  }
}

/**
 * A chunk named a document the store does not hold.
 *
 * The sibling of {@link UnknownEntityError}, and refused for a stricter reason
 * than that one is. A mention is keyed by referent id and checked against
 * nothing because the referent index is a *view* a naming may outlive; a chunk
 * is not a fact pointing at a document, it is a part of one. `document_chunks`
 * says so in SQL — `REFERENCES documents (id) ON DELETE CASCADE` — and a row
 * whose parent never existed is a row the cascade will never collect.
 *
 * Named rather than left as the driver's `SQLITE_CONSTRAINT_FOREIGNKEY`, for two
 * reasons and not this file's usual one alone. First, enforcement is a
 * *per-connection switch*, not a property of the file: a caller sharing this
 * database can open its own connection, run `PRAGMA foreign_keys = OFF`, and
 * write the very orphan `document_chunks` forbids — measured, the insert
 * reports `changes = 1` and no cascade will ever collect the row, because the
 * parent it would have cascaded from never existed. `documentExists` is a plain
 * `SELECT`; it has no pragma to answer to and nothing for a caller to switch
 * off. Second, even on a connection that does enforce the key, the extended
 * result code says a foreign key failed and not which id failed to resolve —
 * this error carries `documentId`, and `SQLITE_CONSTRAINT_FOREIGNKEY` never
 * does.
 *
 * @spec §3.6, §5.10
 */
export class UnknownDocumentError extends Error {
  /** The id that did not resolve. */
  readonly documentId: string;

  constructor(documentId: string) {
    super(`no document ${documentId} in the store`);
    this.name = 'UnknownDocumentError';
    this.documentId = documentId;
  }
}

/**
 * A document arrived under an origin that is neither of §3.6's two.
 *
 * §5.10 permits extraction from authored documents only, *"because
 * re-extracting [materialized ones] would launder canonicals back in as fresh
 * testimony"* — the graph's own conclusions returning as independent
 * corroboration of themselves, which §12 files as an attack in its own right.
 * Every arm of that rule is written as "authored" or "not authored", so a
 * document whose origin is `'generated'` satisfies neither arm's intent while
 * satisfying one of them by accident: an extractor filtering on
 * `origin != 'materialized'` extracts from it.
 *
 * A refusal rather than a repair, and rather than a default. The store cannot
 * know which arm was meant, and guessing `'authored'` opens the laundering path
 * while guessing `'materialized'` silently makes a document unextractable —
 * both are decisions the caller has to make with the document in front of it.
 *
 * Distinct in type from {@link UnknownDocumentError} because the two are
 * different mistakes: that one names a document the store has not got, this one
 * describes a document in a vocabulary the store does not have.
 *
 * @spec §3.6, §5.10, §12
 */
export class UnknownDocumentOriginError extends Error {
  /** The origin that was refused, exactly as it arrived. */
  readonly origin: string;

  constructor(origin: string, permitted: readonly string[]) {
    super(
      `${JSON.stringify(origin)} is not a document origin — §5.10's extraction rule is written for ${permitted.join(' and ')} and for nothing else`,
    );
    this.name = 'UnknownDocumentOriginError';
    this.origin = origin;
  }
}

/**
 * A drain reported on a job the queue does not hold.
 *
 * Not silent, where {@link UnknownDocumentError}'s siblings `deleteDocument` and
 * `deleteContainment` are. Those are asked to make a row absent and the row is
 * already absent, so the caller's request is satisfied. Completing or failing a
 * job is a *report about work*: a drain saying "job 7 finished" when there is no
 * job 7 has reported into nothing, and swallowing it means a drain whose row
 * vanished — a crash and restart holding a stale id, a sweep that collected the
 * row — never accumulates an attempt, never records an error, and looks from the
 * outside like a queue that is working.
 *
 * @spec §9, §12
 */
export class UnknownJobError extends Error {
  /** The id that did not resolve. */
  readonly jobId: number;

  constructor(jobId: number) {
    super(`no job ${String(jobId)} in the queue`);
    this.name = 'UnknownJobError';
    this.jobId = jobId;
  }
}

/**
 * A requeue named a job that is not waiting for one.
 *
 * `requeueJob` exists for the two states a job sits in when nothing is coming
 * for it on its own: `failed`, which `claimJob` never selects, and `pending`
 * behind a not-before that has not arrived. `done` and `running` are neither. A
 * finished job is finished — redoing that work is a *fresh* job, and quietly
 * relabelling this one would rewrite the record of the run that succeeded — and
 * a running job is in some drain's hands right now, so returning it to the queue
 * is the one thing `claimJob`'s single-statement atomicity exists to prevent,
 * arriving through the front door instead of through a race.
 *
 * A refusal by class rather than a `false` or a silent no-op, and for a reason
 * particular to this call: it is a recovery tool, reached for by an operator or
 * a script when something has already gone wrong. A return value nobody checks
 * would report "your parked job is back" for a job that is not back, which is
 * the failure mode a recovery tool cannot have.
 *
 * Distinct in type from {@link UnknownJobError}, which the same call raises for
 * an id the queue never minted: "no such job" and "that job, but not from here"
 * are different diagnoses and lead to different next moves.
 *
 * @spec §9, §12
 */
export class JobNotRequeueableError extends Error {
  /** The job that was refused. */
  readonly jobId: number;
  /** The state it was found in, exactly as the column holds it. */
  readonly state: string;

  constructor(jobId: number, state: string) {
    super(
      `job ${String(jobId)} is ${state} and cannot be requeued — a requeue returns a job that is waiting for someone to look at it, and neither finished work nor work a drain is holding is that`,
    );
    this.name = 'JobNotRequeueableError';
    this.jobId = jobId;
    this.state = state;
  }
}

/**
 * A rejection was logged under a reason no audit could count.
 *
 * §13's drift audits and §15's verifier tuning both ask how often a model failed
 * *this way*, and a count over prose written by whichever caller logged the row
 * is a count over nothing. The vocabulary is closed for that reason, and this is
 * the refusal that names the value rather than leaving the table's
 * `SQLITE_CONSTRAINT_CHECK` to say only that some constraint somewhere failed.
 *
 * Distinct in type from {@link UnknownDocumentOriginError} for that one's reason:
 * two closed vocabularies are two different mistakes, and a caller catching one
 * is not catching the other.
 *
 * @spec §5.10, §12, §13, §15
 */
export class UnknownRejectionReasonError extends Error {
  /** The reason that was refused, exactly as it arrived. */
  readonly reason: string;

  constructor(reason: string, permitted: readonly string[]) {
    super(
      `${JSON.stringify(reason)} is not an extraction-rejection reason — §13's audit counts ${permitted.join(', ')} and nothing else`,
    );
    this.name = 'UnknownRejectionReasonError';
    this.reason = reason;
  }
}

/**
 * A second claim arrived under an id the ledger already holds.
 *
 * `putClaim` mints; it does not upsert. Every mutation of a live claim runs on
 * the atomic single-statement path (§5.7) and the ledger is append-only, so
 * overwriting a whole claim row is not an operation this store offers.
 *
 * @spec §3.2, §5.7
 */
export class DuplicateClaimError extends Error {
  /** The id already in the ledger. */
  readonly claimId: string;

  constructor(claimId: string) {
    super(`claim ${claimId} is already in the ledger — minting is not upserting`);
    this.name = 'DuplicateClaimError';
    this.claimId = claimId;
  }
}

/**
 * A write named one of the four edge kinds v1 reserves but does not use.
 *
 * `MERGES`, `STATED_IN`, `INSTANCE_OF` and `SPECIALIZES` belong to the
 * consolidator, documents and the conceptual vertical — all v1 non-goals. The
 * vocabulary admits them so migration 0 needs no change when they land; this
 * refusal is what stops v1 quietly minting them in the meantime.
 *
 * @spec §3.3, §5.5
 */
export class ReservedEdgeKindError extends Error {
  /** The reserved kind that was refused. */
  readonly kind: string;

  constructor(kind: string) {
    super(`${kind} is reserved for a deferred feature and cannot be written in v1`);
    this.name = 'ReservedEdgeKindError';
    this.kind = kind;
  }
}

/**
 * A write put a claim on the wrong side of the regime rule.
 *
 * Diagram §6: same node type, two truth-maintenance regimes, and *"nothing is
 * ever both"*. A view-regime claim is maintained by re-parsing the source that
 * attests it, so it carries no posterior at all — one that arrives with α and β
 * is a parser vote being counted as corroboration, and re-running the parser
 * would inflate it. An evidence-regime claim with no posterior is the mirror
 * mistake: a belief with no belief in it, invisible to every §4 operation that
 * moves, decays or reads one.
 *
 * A refusal rather than a repair. The store cannot know which half of the pair
 * was meant — dropping the posterior would silently discard evidence, and
 * seeding one would invent a prior nobody asked for — so the caller is told.
 *
 * Distinct in type from a shape violation for the same reason the rest of this
 * file is: `RegimeViolationError` says the regime rule was broken, where a
 * `ZodError` on the same write would only say some field somewhere was wrong.
 *
 * @spec §3.2, §3.5, §4.1
 */
export class RegimeViolationError extends Error {
  /** The claim that was refused. */
  readonly claimId: string;
  /** The regime it declared. */
  readonly regime: string;

  constructor(claimId: string, regime: string, problem: string) {
    super(
      `claim ${claimId} is in the ${regime} regime and ${problem} — nothing is ever both, and nothing is ever neither`,
    );
    this.name = 'RegimeViolationError';
    this.claimId = claimId;
    this.regime = regime;
  }
}

/**
 * A write carried an A15 pathway signature that no provenance axis can hold.
 *
 * `channel` and `agent` are stored per provenance *row*, and a claim naming no
 * episode, change event or artifact has no rows — so a signature on one would be
 * dropped on the way in and read back absent, with nothing anywhere saying so.
 *
 * A refusal rather than a repair, and for §4.7's sake. Pathway saturation groups
 * corroborations by channel and agent to notice that ten "independent"
 * confirmations all arrived over one pathway; a claim whose signature was
 * discarded looks like it arrived by no known pathway, which is exactly the shape
 * the check exempts. Dropping it silently under-counts the inflation §4.7 exists
 * to catch.
 *
 * No valid write is refused by this. `writeClaim` is `putClaim`'s only production
 * caller and always builds `episodes: [draft.origin.episodeId]` from an
 * `Origin.episodeId` the schema requires, so every claim arriving through ingest
 * names an episode. A signed claim with three empty axes can only come from a
 * caller that went around ingest.
 *
 * Declared here rather than in `src/schema/` for this file's usual reason:
 * `Provenance` leaves `channel` and `agent` independently optional beside three
 * plain array axes and nothing couples them, so a shape check has nothing to say.
 * The coupling is the store's, because the row layout that creates it is.
 *
 * @spec §3.5, §4.7
 */
export class OrphanedSignatureError extends Error {
  /** The claim that was refused. */
  readonly claimId: string;

  constructor(claimId: string) {
    super(
      `claim ${claimId} carries a pathway signature but names no episode, change event or artifact — the signature would have nowhere to live, and §4.7 could never group on it`,
    );
    this.name = 'OrphanedSignatureError';
    this.claimId = claimId;
  }
}

/** Which of the stage log's two JSON payload columns a refusal is about. @spec §5.8 */
export type StageLogPayloadColumn = 'inputs' | 'decision';

/**
 * A stage-log payload column holds bytes that are not JSON.
 *
 * A refusal rather than a degrade, which is the opposite of what the read path
 * does for a referent's locator, and the asymmetry is deliberate. §5.8's log
 * exists so §13 can replay a corpus and tune every ⚙ constant in §15 against it,
 * and §12 names exactly that logging as the mitigation for threshold
 * brittleness. `appendStageLog` writes a JSON `null` decision for a stage that
 * decided nothing — a dedupe rejection is the ordinary case — so an entry whose
 * corrupt payload quietly came back empty would be indistinguishable from a
 * stage that honestly recorded nothing. Degrading there does not tolerate the
 * corruption, it launders it into a data point the constants then get tuned
 * against.
 *
 * Dropping the row instead is no better: §5.8 promises order and §13 replays it,
 * so a log with a hole in it misrepresents everything after the hole while still
 * looking ordered.
 *
 * The caller can afford a refusal. `readStageLog` serves an offline audit that
 * can be re-run against a repaired file, not §7.6's ambient hook that has to
 * answer now.
 *
 * Named rather than left as the `SyntaxError` `JSON.parse` raises, for this
 * file's usual reason: nothing about a `SyntaxError` says which store, which
 * column or which row, so no caller can branch on it and no operator can find
 * the damage. The row is named down to its primary key, because `episode_id` and
 * `stage` together do not identify one — a stage may run more than once in an
 * episode.
 *
 * @spec §5.8, §11, §12, §13
 */
export class CorruptStageLogError extends Error {
  /** The `stage_log` primary key of the row that could not be read. */
  readonly rowId: number;
  /** The episode whose replay log holds it. */
  readonly episodeId: string;
  /** The stage that wrote it. */
  readonly stage: string;
  /** Which payload column holds the unreadable bytes. */
  readonly column: StageLogPayloadColumn;

  constructor(
    rowId: number,
    episodeId: string,
    stage: string,
    column: StageLogPayloadColumn,
    cause: unknown,
  ) {
    super(
      `stage_log row ${String(rowId)} (episode ${episodeId}, stage ${stage}) holds a ${column} payload that is not JSON — §13 replay would read it as a stage that logged nothing`,
      { cause },
    );
    this.name = 'CorruptStageLogError';
    this.rowId = rowId;
    this.episodeId = episodeId;
    this.stage = stage;
    this.column = column;
  }
}

/**
 * The file at this path is not a database SQLite can read.
 *
 * The store refuses it and leaves it exactly as it found it. A corrupt file is
 * *evidence* — of a half-written copy, a truncated sync, a path that was never a
 * database — and migrating over it would replace the one artefact anybody could
 * diagnose with an empty schema. Recovery is the operator's call, not the
 * store's.
 *
 * The driver's own error is kept as `cause` for the same reason: the extended
 * result code is the difference between "these bytes were never a database" and
 * "this database rotted", and only the driver knows which.
 *
 * @spec §11
 */
export class CorruptStoreError extends Error {
  /** The path that could not be opened. Named because a caller may hold several. */
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`${path} is not a database SQLite can read — it has been left untouched`, {
      cause,
    });
    this.name = 'CorruptStoreError';
    this.path = path;
  }
}

/**
 * A lock wait ran out with another process still holding the write lock.
 *
 * §5.7 turns a collision into a wait rather than an `SQLITE_BUSY` a caller would
 * have to retry — but a wait has to end somewhere, and this is what the end of
 * one looks like. The wait that was actually used travels with the refusal
 * rather than being read back off {@link BUSY_TIMEOUT_MS}, because the whole
 * point of a per-store timeout is that a health check or a git hook may have
 * asked for a much shorter one, and "give up after 250 ms" and "give up after
 * thirty seconds" call for different responses.
 *
 * `cause` is populated the same way {@link CorruptStoreError}'s is, wherever a
 * live driver error is actually in hand at the point of translation — a write
 * or an open refused by a raw `SQLITE_BUSY` carries the driver's error forward.
 * It is deliberately absent when {@link BUSY_TIMEOUT_MS}'s own retry loop is
 * what gives up: that deadline is this code's decision, not a code SQLite
 * handed back, and whatever driver error the last poll happened to throw (if
 * any — a silent non-conversion throws nothing at all) is discarded well before
 * the deadline is checked, so attaching it would suggest a specific cause where
 * there honestly is only "ran out of patience." Two refusals, two different
 * relationships to a driver error — not an oversight.
 *
 * @spec §5.7, §12
 */
export class StoreBusyError extends Error {
  /** The wait this operation actually used, in milliseconds. */
  readonly timeoutMs: number;

  constructor(what: string, timeoutMs: number, cause?: unknown) {
    super(
      `${what} gave up after ${String(timeoutMs)}ms — another process is holding the write lock`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'StoreBusyError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The store on disk carries a schema stamp above the one this build knows.
 *
 * Refused, and refused *before anything is written*. A `user_version` above
 * {@link SCHEMA_VERSION} means a newer build wrote this file, and every column
 * that build added is one this build never populates while every constraint it
 * added is one this build never satisfies. The damage from opening it anyway is
 * not a crash anybody sees — it is a ledger that quietly stops meaning what the
 * newer build thinks it means. Refusing to open is recoverable; half-writing a
 * future schema is not, and neither is stamping the version back down to hide
 * the evidence.
 *
 * @spec §11
 */
export class UnsupportedSchemaVersionError extends Error {
  /** The schema version stamped on the file. */
  readonly found: number;
  /** The highest schema version this build knows how to write. */
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `store is at schema version ${String(found)}, which is newer than the ${String(supported)} this build supports — upgrade rather than write to it`,
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.found = found;
    this.supported = supported;
  }
}

/**
 * The driver's SQLite result code, or `''` for anything that is not one.
 *
 * Read off the error rather than parsed out of its message. `SQLITE_BUSY` and
 * `SQLITE_NOTADB` are SQLite's own, fixed by the C API and stable across
 * versions; "database is locked" and "file is not a database" are
 * better-sqlite3's wording, and a dependency is free to reword them in a patch
 * release. Only one of those two is something to build a refusal on.
 *
 * @spec §5.7, §11
 */
const sqliteCode = (error: unknown): string => {
  if (!(error instanceof Error) || !('code' in error)) return '';
  const { code } = error as { readonly code: unknown };
  return typeof code === 'string' ? code : '';
};

/**
 * Whether a driver error is SQLite refusing on lock contention.
 *
 * The prefix test picks up the extended codes (`SQLITE_BUSY_SNAPSHOT`,
 * `SQLITE_BUSY_TIMEOUT`, …), all of which mean the same thing to a caller:
 * somebody else has it.
 *
 * @spec §5.7
 */
export const isBusyError = (error: unknown): boolean =>
  sqliteCode(error).startsWith('SQLITE_BUSY');

/**
 * Whether a driver error is SQLite refusing to read the file as a database.
 *
 * `SQLITE_NOTADB` is "these bytes never were one"; the `SQLITE_CORRUPT` family is
 * "this one has rotted". The store cannot fix either, and its response to both is
 * the same: refuse, and change nothing.
 *
 * @spec §11
 */
export const isCorruptError = (error: unknown): boolean => {
  const code = sqliteCode(error);
  return code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT');
};
