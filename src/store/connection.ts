/**
 * Opening the database: extension, pragmas, migration.
 *
 * The pragmas are not housekeeping. §5.7 requires that two agents updating one
 * claim concurrently must not drop evidence, and in v1 an agent *is* a process —
 * one MCP server per session, git hooks shelling out to the same binary, all
 * sharing one SQLite file. WAL is what lets those processes read while one
 * writes; the busy timeout is what turns a collision into a short wait instead
 * of an `SQLITE_BUSY` a caller would have to retry (and, in practice, wouldn't).
 *
 * Opening is therefore itself a contended operation, and the one place where the
 * busy timeout does *not* apply on its own — see {@link enterWalMode}. Two
 * sessions starting against a fresh graph in the same instant is the ordinary
 * case here, not a corner one, and §7.6 asks the read side to fail open; a store
 * that threw on a startup race would be the opposite.
 *
 * @spec §5.7, §7.6, §11
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import {
  CorruptStoreError,
  StoreBusyError,
  UnsupportedSchemaVersionError,
  isBusyError,
  isCorruptError,
} from './errors.js';
import { ANN_INDEX_DIMENSIONS } from './vectors.js';

/** `PRAGMA user_version` after migration 0. Bump per migration. @spec §11 */
export const SCHEMA_VERSION = 1;

/**
 * How long a writer waits for the lock before giving up.
 *
 * Generous on purpose. Under the §5.7 fixture three processes contend for one
 * claim several hundred times; every one of those collisions has to resolve as a
 * wait, because a writer that surfaces `SQLITE_BUSY` has dropped evidence just
 * as surely as a lost update would have.
 *
 * @spec §5.7
 */
export const BUSY_TIMEOUT_MS = 30_000;

/** First pause between retries of a lock SQLite will not wait on for us. @spec §5.7 */
const RETRY_BACKOFF_START_MS = 1;

/**
 * Longest pause between those retries.
 *
 * Capped low: the contended window is a journal-mode conversion or one process's
 * migration 0, both of which are milliseconds long, so a doubling backoff that
 * ran away would spend most of its wait asleep after the lock had already been
 * handed back.
 *
 * @spec §5.7
 */
const RETRY_BACKOFF_CEILING_MS = 25;

/**
 * The journal modes that satisfy a request for WAL.
 *
 * `memory` and `off` are what an in-memory database settles into — SQLite
 * documents that it *ignores* a journal-mode change there rather than failing —
 * and that is the right answer, not a degraded one: there is no second process
 * to share a `:memory:` database with.
 *
 * The `: undefined` arm below exists because `PRAGMA journal_mode` is documented
 * as able to silently return the mode it could not leave, rather than raising —
 * so a mode outside this set has to be treated as "not yet converted", not
 * accepted. In practice that silent return is not what protects this store:
 * every contended-open shape actually exercised (a foreign write lock, a
 * foreign shared read lock, a read-only file, this same connection already
 * mid-transaction) makes the pragma throw — `SQLITE_BUSY`, `SQLITE_READONLY`,
 * `SQLITE_ERROR` — and it is {@link awaitLock}'s `SQLITE_BUSY` catch that does
 * the actual work of stopping a contended open from being accepted mid-`delete`.
 * The set below is retained as the defensive backstop the pragma's own
 * documentation calls for, not as the mechanism observed to fire.
 *
 * @spec §5.7
 */
const WAL_EQUIVALENT_MODES: ReadonlySet<string> = new Set(['wal', 'memory', 'off']);

const MIGRATION_PATH = fileURLToPath(new URL('./migrations/0000_initial.sql', import.meta.url));

/**
 * Reads migration 0, substituting the pinned ANN width so the number spike S2
 * decided is declared in exactly one place.
 *
 * @spec §11
 */
export const readMigration = (): string =>
  readFileSync(MIGRATION_PATH, 'utf8').replaceAll(
    '{{ANN_DIMENSIONS}}',
    String(ANN_INDEX_DIMENSIONS),
  );

/**
 * The wait a store will actually use: the caller's, or §5.7's default.
 *
 * Resolved once, at the port boundary, so the number that reaches
 * `PRAGMA busy_timeout` is the same number a {@link StoreBusyError} reports.
 *
 * @spec §5.7
 */
export const resolveBusyTimeoutMs = (requested: number | undefined): number => {
  if (requested === undefined) return BUSY_TIMEOUT_MS;
  if (!Number.isFinite(requested) || requested < 0)
    throw new RangeError(
      `busyTimeoutMs must be a non-negative number of milliseconds, got ${String(requested)}`,
    );
  return requested;
};

/**
 * Blocks this thread for `ms`.
 *
 * better-sqlite3 is synchronous, so a retry between two of its calls has nowhere
 * to yield to: there is no continuation to resume and no other work on the loop
 * that could release the lock we are waiting for — the holder is another OS
 * process. `Atomics.wait` parks the thread outright rather than spinning it.
 *
 * @spec §5.7
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Retries an operation SQLite will not wait on for us, until the wait expires.
 *
 * `attempt` returns `undefined` to mean "not yet"; anything else is the result.
 * Both signals matter, because SQLite reports this kind of contention two ways —
 * an `SQLITE_BUSY` result code, and, for `PRAGMA journal_mode`, silently
 * returning the mode it could not leave.
 *
 * This is the busy handler's job, done by hand. SQLite deliberately declines it
 * in one case: "If SQLite determines that invoking the busy handler could result
 * in a deadlock, it will go ahead and return SQLITE_BUSY to the application
 * instead of invoking the busy handler" — the promotion of a read lock to a
 * write lock, which is exactly what {@link enterWalMode} needs. The C API's own
 * advice is that an application must still be prepared to handle an immediate
 * `SQLITE_BUSY`, and being prepared means retrying.
 *
 * @spec §5.7
 */
const awaitLock = <T>(what: string, timeoutMs: number, attempt: () => T | undefined): T => {
  const deadline = Date.now() + timeoutMs;
  let backoff = RETRY_BACKOFF_START_MS;

  for (;;) {
    let outcome: T | undefined;
    try {
      outcome = attempt();
    } catch (error) {
      if (!isBusyError(error)) throw error;
    }
    if (outcome !== undefined) return outcome;
    // No `cause` here, and not an oversight: the deadline is this loop's own
    // decision, not a code the driver just handed back. Whatever the previous
    // attempt() threw (if anything — a silent non-conversion throws nothing) was
    // already caught and discarded above, several retries and up to
    // RETRY_BACKOFF_CEILING_MS ago, so surfacing it as the cause of *this*
    // timeout would claim a specificity the refusal does not have. See
    // {@link StoreBusyError} for the fuller contrast with the write and open
    // paths, which do have a live driver error at hand and forward it.
    if (Date.now() >= deadline) throw new StoreBusyError(what, timeoutMs);

    sleepSync(backoff);
    backoff = Math.min(backoff * 2, RETRY_BACKOFF_CEILING_MS);
  }
};

/**
 * Reads the schema stamp on the file, waiting out a writer that has it locked.
 *
 * Read before anything is written, and before WAL conversion, because a file
 * from a newer build has to be refused without being touched — and a
 * journal-mode conversion is a write to its header.
 *
 * @spec §11
 */
const readUserVersion = (db: Database.Database, what: string, busyTimeoutMs: number): number =>
  awaitLock(what, busyTimeoutMs, () => Number(db.pragma('user_version', { simple: true })));

/**
 * Refuses a store this build is too old to write to.
 *
 * `>` and not `>=`: an equal stamp is this build's own schema. Anything above it
 * was written by a build that knows a migration this one does not, and the
 * failure from opening it anyway is silent — the tables this build expects are
 * all present, so it migrates nothing, writes happily, and populates none of the
 * columns the newer schema added.
 *
 * @spec §11
 */
const assertSupportedSchemaVersion = (found: number): void => {
  if (found > SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(found, SCHEMA_VERSION);
};

/**
 * Converts the database to WAL, waiting out any process that has it locked.
 *
 * The retry is the whole point. `PRAGMA journal_mode = WAL` needs an exclusive
 * lock on a file this connection is already reading, so it is precisely the
 * read-to-write promotion SQLite refuses to run the busy handler for: with
 * another process holding the write lock it fails in a millisecond or two and
 * the configured timeout never gets a chance to apply. Measured, that made
 * concurrent first-opens fail a quarter to a half of the time — and two sessions
 * starting against a fresh graph at once is the ordinary case in v1, not a
 * corner one. Waiting here is what turns that race back into the §5.7 collision
 * it always was.
 *
 * A `:memory:` database quietly stays in `memory` mode, which is correct — there
 * is no second process to share it with.
 *
 * @spec §5.7, §7.6, §11
 */
const enterWalMode = (db: Database.Database, what: string, busyTimeoutMs: number): void => {
  awaitLock(what, busyTimeoutMs, () => {
    const mode = String(db.pragma('journal_mode = WAL', { simple: true }));
    return WAL_EQUIVALENT_MODES.has(mode) ? mode : undefined;
  });
};

/**
 * Applies migration 0 if this database has not seen it.
 *
 * Guarded by `BEGIN IMMEDIATE` and a re-read of `user_version` inside it: several
 * processes may open a fresh database at once, and the loser of that race must
 * find the schema already there rather than try to create it twice.
 *
 * `BEGIN IMMEDIATE` takes the write lock from an unlocked connection, so unlike
 * the journal-mode conversion above it is a case SQLite *does* run the busy
 * handler for — `PRAGMA busy_timeout` covers the wait, and this needs no retry
 * of its own.
 *
 * @spec §11
 */
export const migrate = (db: Database.Database): void => {
  if (Number(db.pragma('user_version', { simple: true })) >= SCHEMA_VERSION) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (Number(db.pragma('user_version', { simple: true })) < SCHEMA_VERSION) {
      db.exec(readMigration());
      db.pragma(`user_version = ${String(SCHEMA_VERSION)}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

/**
 * Opens a migrated connection with sqlite-vec loaded and the §5.7 pragmas set.
 *
 * The order is load-bearing. The busy timeout goes on before anything that can
 * contend, so every wait below is the caller's wait rather than better-sqlite3's
 * default. The version guard comes before WAL conversion, because refusing a
 * newer build's store "without writing anything" has to include not rewriting
 * its journal mode. And the connection is closed on the way out of any failure:
 * a caller that never received a store has nothing to close it with.
 *
 * @spec §5.7, §11
 */
export const openDatabase = (
  path: string,
  busyTimeoutMs: number = BUSY_TIMEOUT_MS,
): Database.Database => {
  const db = new Database(path, { timeout: busyTimeoutMs });
  const what = `opening ${path}`;

  try {
    sqliteVec.load(db);
    db.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);

    assertSupportedSchemaVersion(readUserVersion(db, what, busyTimeoutMs));
    enterWalMode(db, what, busyTimeoutMs);
    // NORMAL is the standard WAL pairing: durable across process crashes, which is
    // the failure this store can actually suffer, without an fsync per increment.
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    migrate(db);
  } catch (error) {
    db.close();
    throw translateOpenFailure(error, path, busyTimeoutMs);
  }

  return db;
};

/**
 * Puts a failed open into the store's own vocabulary.
 *
 * Only the two situations the store owns are rewritten. Everything else — a
 * missing extension, a permission error, a bug in migration 0 — is rethrown
 * exactly as it arrived, because renaming an error the store did not anticipate
 * would hide it rather than explain it.
 *
 * The busy arm is narrow. Both {@link readUserVersion} and {@link enterWalMode}
 * run through {@link awaitLock}, and a lock wait that runs out there already
 * throws a {@link StoreBusyError} of its own — which carries no `code`, so
 * `isBusyError` is false for it and it falls straight through to `return
 * error` below, already in the store's vocabulary and untouched by this arm.
 * What this arm actually catches is a *raw* `SQLITE_BUSY`: {@link migrate}'s
 * `BEGIN IMMEDIATE` does not go through `awaitLock` — by design, since
 * `PRAGMA busy_timeout` already covers that wait — so if the write lock is
 * still held when that timeout expires, the driver's own `SQLITE_BUSY`
 * propagates straight out of `migrate` and lands here. Kept rather than
 * removed: that is a real, if narrow, way for an open to lose a race, and this
 * is the only place it would otherwise surface as an untranslated driver error.
 *
 * @spec §5.7, §11
 */
const translateOpenFailure = (error: unknown, path: string, busyTimeoutMs: number): unknown => {
  if (isCorruptError(error)) return new CorruptStoreError(path, error);
  if (isBusyError(error)) return new StoreBusyError(`opening ${path}`, busyTimeoutMs, error);
  return error;
};

/** The journal mode the connection settled into. @spec §5.7 */
export const readJournalMode = (db: Database.Database): string =>
  String(db.pragma('journal_mode', { simple: true }));
