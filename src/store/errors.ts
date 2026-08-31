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
 * The last three are a different species from the first six. Those name a
 * caller's mistake; these name a *situation* — the file is not a database,
 * another process will not let go of the write lock, the store was written by a
 * build that knows a schema this one does not. None is anybody's programming
 * error, and each is something a caller has to be able to act on: retry a
 * contended write, refuse to start against a corrupt file, tell the user to
 * upgrade. Acting on any of them means telling them apart from an ordinary
 * refusal *by type*, which is why they are declared here rather than left as the
 * driver's `SqliteError` and a message string a dependency is free to reword.
 *
 * @spec §3.3, §5.5, §5.7, §11
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
