/**
 * The child process of the job-claim race fixture.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it. It is spawned by `job-claim-race.test.ts` as a real OS process with
 * `node --import tsx`, opens the same file-backed database over WAL, and claims
 * its share of one kind of job.
 *
 * Four things about the loop are load-bearing.
 *
 * **The barrier.** Loading better-sqlite3 and opening a store costs a few hundred
 * milliseconds, and staggered start-ups let the workers drain one after another —
 * which a read-then-write claim survives comfortably, because a queue drained
 * sequentially is a queue with no contention in it. Each worker announces
 * {@link WORKER_READY} once it is warm and parked, and the parent releases them
 * all at once.
 *
 * **A quota, rather than draining until empty.** This is the difference between a
 * fixture that contends and one that only might, and it was measured rather than
 * guessed. A worker that drains until the queue answers with nothing does not
 * share the queue: an atomic claim is a single write statement, so a worker that
 * has the write lock re-takes it immediately and the other two starve — over a
 * queue of ten thousand, one worker took all ten thousand and its peers took none
 * between them. A fixture in that state proves nothing about two drains, because
 * there was only ever one. Given `n` workers and exactly `n × quota` jobs, no
 * worker can finish before every other worker has had its share, so all three are
 * inside the claim loop for the whole run.
 *
 * **No I/O inside the loop.** The claimed ids are accumulated in memory and
 * written once, at the end. A `process.stdout.write` per claim would put a
 * syscall between every pair of claims and pull the claim windows apart — the
 * fixture would then be measuring how fast a pipe drains rather than whether two
 * drains can take one job.
 *
 * **Nothing is skipped on a duplicate.** A worker handed a job another worker
 * already had has no way to know, and this one does not try: it records every id
 * it was given and completes it. Deciding whether two drains took one job is the
 * parent's business, over the union of what the children report.
 *
 * The empty-claim bound is the escape hatch and never fires against a working
 * store: with `n × quota` jobs and every worker capped at `quota`, at least
 * `quota` jobs are still pending whenever a worker is still short, so a claim can
 * only come back empty if something else took a job twice. When that happens the
 * worker gives up rather than spinning, and the shortfall is what the parent sees.
 *
 * The report is a JSON array on stdout, so the parent needs no protocol constant
 * beyond the {@link WORKER_READY} token it already strips.
 *
 * Usage: `job-drain-worker.ts <dbPath> <kind> <quota>`
 *
 * @spec §5.7, §9, §11, §12
 */

import { openGraphStore } from '../index';

import { WORKER_READY } from './fixtures';

/** Consecutive empty claims a worker still short of its quota tolerates before giving up. @spec §5.7 */
const EMPTY_CLAIM_LIMIT = 500;

/** Parses one positional argument as a non-empty string. @spec §5.7 */
export const requireStringArg = (raw: string | undefined, name: string): string => {
  if (raw === undefined || raw === '') throw new TypeError(`${name} is required`);
  return raw;
};

/** Parses one positional argument as a finite number, failing loudly rather than yielding NaN. @spec §5.7 */
export const requireNumericArg = (raw: string | undefined, name: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new TypeError(`${name} must be a finite number, got ${String(raw)}`);
  return value;
};

/** Announces readiness and blocks until the parent releases the barrier. @spec §5.7 */
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

const [dbPath, kind, quota] = process.argv.slice(2);

const wanted = requireStringArg(kind, 'kind');
const share = requireNumericArg(quota, 'quota');
const store = openGraphStore({ path: requireStringArg(dbPath, 'dbPath') });

await parkAtBarrier();

const claimed: number[] = [];
let empties = 0;

while (claimed.length < share && empties < EMPTY_CLAIM_LIMIT) {
  const job = store.claimJob(wanted);
  if (job === undefined) {
    empties += 1;
    continue;
  }
  claimed.push(job.id);
  store.completeJob(job.id);
}

store.close();

process.stdout.write(`${JSON.stringify(claimed)}\n`);
