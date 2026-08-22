/**
 * The child process of the §5.7 multi-process concurrency fixture.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it. It is spawned by `multi-process-increments.test.ts` as a real OS
 * process with `node --import tsx`, opens the same file-backed database over
 * WAL, and hammers one claim's α.
 *
 * The handshake is the point. Opening the store, loading better-sqlite3 and
 * running migrations costs a few hundred milliseconds, and staggered start-ups
 * would let the workers finish one after another — which a read-modify-write
 * implementation survives comfortably. So each worker announces
 * {@link WORKER_READY} once it is warm and parked, and only starts writing when
 * the parent releases every worker at once.
 *
 * Once released, the loop is fully synchronous: better-sqlite3 blocks the event
 * loop, so the worker does nothing but contend for the write lock.
 *
 * Usage: `increment-worker.ts <dbPath> <claimId> <iterations> <alphaPerIncrement>`
 *
 * @spec §5.7, §11, §12
 */

import { openGraphStore } from '../index';

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
 * Announces readiness and blocks until the parent releases the barrier.
 *
 * @spec §5.7
 */
export const parkAtBarrier = async (): Promise<void> => {
  process.stdout.write(`${WORKER_READY}\n`);
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => {
      resolve();
    });
    process.stdin.once('end', () => {
      resolve();
    });
  });
};

const [dbPath, claimId, iterations, alphaPerIncrement] = process.argv.slice(2);

const target = requireStringArg(claimId, 'claimId');
const count = requireNumericArg(iterations, 'iterations');
const weight = requireNumericArg(alphaPerIncrement, 'alphaPerIncrement');
const store = openGraphStore({ path: requireStringArg(dbPath, 'dbPath') });

await parkAtBarrier();

for (let i = 0; i < count; i += 1) {
  store.incrementEvidence({ claimId: target, alpha: weight });
}

store.close();
