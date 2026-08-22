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
 * @spec §5.7, §11
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

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
 * Applies migration 0 if this database has not seen it.
 *
 * Guarded by `BEGIN IMMEDIATE` and a re-read of `user_version` inside it: several
 * processes may open a fresh database at once, and the loser of that race must
 * find the schema already there rather than try to create it twice.
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
 * @spec §5.7, §11
 */
export const openDatabase = (path: string): Database.Database => {
  const db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
  sqliteVec.load(db);

  // WAL first: it is what makes the file shareable across processes at all.
  // A `:memory:` database quietly stays in `memory` mode, which is correct —
  // there is no second process to share it with.
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  // NORMAL is the standard WAL pairing: durable across process crashes, which is
  // the failure this store can actually suffer, without an fsync per increment.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
};

/** The journal mode the connection settled into. @spec §5.7 */
export const readJournalMode = (db: Database.Database): string =>
  String(db.pragma('journal_mode', { simple: true }));
