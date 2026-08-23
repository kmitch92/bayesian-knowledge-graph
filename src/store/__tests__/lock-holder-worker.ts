/**
 * A second real process that holds the SQLite write lock.
 *
 * §5.7 turns a collision into a wait rather than an `SQLITE_BUSY`, and
 * {@link BUSY_TIMEOUT_MS} is how long that wait lasts. What no test has ever
 * driven is what happens when the wait *runs out*: a writer that gives up
 * surfaces a raw driver error today, and a caller cannot tell "the store is
 * contended" from "you named a claim that does not exist" by type.
 *
 * This worker exists to make the lock genuinely unavailable. It opens a plain
 * better-sqlite3 connection rather than a {@link GraphStore}, because the port
 * offers no "hold the write lock" operation and should not — this process is
 * standing in for any other writer on the machine (another MCP session, a git
 * hook), not for a store API.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * `BEGIN IMMEDIATE` takes the write lock at once rather than on first write, so
 * by the time {@link WORKER_READY} is printed the lock is genuinely held. The
 * worker then releases on whichever comes first: the parent's go-ahead on
 * stdin, or `holdMs` elapsing — the parent is blocked inside a synchronous
 * better-sqlite3 call for the tests that need the lock to be handed back
 * mid-wait, so it cannot release the worker itself.
 *
 * Usage: `lock-holder-worker.ts <dbPath> <holdMs>`
 *
 * @spec §5.7, §11
 */

import Database from 'better-sqlite3';

import { WORKER_READY } from './fixtures';

/** Parses one positional argument as a finite number, failing loudly rather than yielding NaN. @spec §5.7 */
export const requireNumericArg = (raw: string | undefined, name: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new TypeError(`${name} must be a finite number, got ${String(raw)}`);
  return value;
};

/** Parses one positional argument as a non-empty string. @spec §5.7 */
export const requireStringArg = (raw: string | undefined, name: string): string => {
  if (raw === undefined || raw === '') throw new TypeError(`${name} is required`);
  return raw;
};

/**
 * Announces readiness and blocks until either the parent releases the barrier
 * or the hold expires.
 *
 * @spec §5.7
 */
export const holdUntilReleased = async (holdMs: number): Promise<void> => {
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
db.exec('BEGIN IMMEDIATE');

await holdUntilReleased(requireNumericArg(holdMs, 'holdMs'));

db.exec('ROLLBACK');
db.close();

// A resumed stdin keeps the event loop alive; the hold may have ended on the
// timer rather than on the parent's go-ahead, so let go of it explicitly.
process.stdin.pause();
