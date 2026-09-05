/**
 * A second real process that takes the write lock, then *commits* while another
 * writer is waiting for it.
 *
 * {@link ./lock-holder-worker.ts} rolls back, which is the right shape for "the
 * wait ran out" — a holder that changes nothing leaves every other connection's
 * view of the database exactly where it was. This worker is the opposite shape,
 * and it exists to make one specific WAL behaviour reachable from a test.
 *
 * In WAL a deferred transaction takes its read snapshot at its *first statement*.
 * If that statement is a read, the snapshot is pinned to whatever had committed
 * by then; a later write from the same transaction, arriving after some other
 * connection has committed, cannot be applied to a stale snapshot and SQLite
 * answers `SQLITE_BUSY_SNAPSHOT` — *immediately*, because no amount of waiting
 * can make a stale snapshot current, so `busy_timeout` never applies to it. If
 * instead the first statement is a write, the snapshot and the write lock are
 * taken together, the busy handler covers the wait, and the transaction proceeds
 * against a current view once the lock comes back.
 *
 * So one setup separates the two: hold the write lock, commit a change, release.
 * A write-first transaction waits and lands. A read-first one is refused. That
 * is the only reading of "no read in the transaction body" available from
 * outside the connection, and it is a behavioural one rather than an inspection
 * of the source.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * Usage: `commit-during-hold-worker.ts <dbPath> <holdMs>`
 *
 * @spec §5.7, §11
 */

import Database from 'better-sqlite3';

import { WORKER_READY } from './fixtures';

/**
 * Parses one positional argument as a finite number, failing loudly rather than
 * yielding NaN.
 *
 * Spelled out again rather than imported from {@link ./lock-holder-worker.ts},
 * which exports the same two parsers: that module opens a database and takes the
 * write lock in its *module body*, so importing it runs a second holder in this
 * process. It announced its own readiness, the parent released on that, and the
 * hold under test never happened.
 *
 * @spec §5.7
 */
const requireNumericArg = (raw: string | undefined, name: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new TypeError(`${name} must be a finite number, got ${String(raw)}`);
  return value;
};

/** Parses one positional argument as a non-empty string. @spec §5.7 */
const requireStringArg = (raw: string | undefined, name: string): string => {
  if (raw === undefined || raw === '') throw new TypeError(`${name} is required`);
  return raw;
};

/**
 * Announces readiness and blocks until either the parent releases the barrier or
 * the hold expires.
 *
 * The timer is the one that matters here: the parent is blocked inside a
 * synchronous better-sqlite3 call for the whole hold, so it cannot release this
 * worker itself, and the commit has to happen while that call is still waiting.
 *
 * @spec §5.7
 */
const holdThenCommit = async (holdMs: number): Promise<void> => {
  process.stdout.write(`${WORKER_READY}\n`);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, holdMs);
    timer.unref();
    process.stdin.once('data', () => {
      resolve();
    });
    process.stdin.once('end', () => {
      resolve();
    });
  });
};

const [dbPath, holdMs] = process.argv.slice(2);

const db = new Database(requireStringArg(dbPath, 'dbPath'));

// Out of the way of the held transaction, so the hold itself is one ordinary
// row change rather than a schema change racing the writer under test.
db.exec('CREATE TABLE IF NOT EXISTS probe_holder_commits (n INTEGER NOT NULL)');

// `BEGIN IMMEDIATE` takes the write lock at once rather than on first write, so
// by the time the barrier is announced the lock is genuinely held.
db.exec('BEGIN IMMEDIATE');
db.exec('INSERT INTO probe_holder_commits (n) VALUES (1)');

await holdThenCommit(requireNumericArg(holdMs, 'holdMs'));

// The commit, not a rollback: this is what moves the database on past any
// snapshot another connection pinned before it.
db.exec('COMMIT');
db.close();

process.stdin.pause();
