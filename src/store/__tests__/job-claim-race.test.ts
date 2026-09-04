/**
 * Two drains, one queue: the claim that decides whether this table is a queue at
 * all.
 *
 * §5.7 states the rule for posteriors — *"α/β updates are atomic increments in
 * the database, never read-modify-write in the MCP server. Two agents updating
 * the same claim concurrently must not drop evidence."* The store's own
 * `incrementEvidence` docblock puts it as *"never a read, then a write"*, and
 * `multi-process-increments.test.ts` is the fixture that proves it.
 *
 * A claim off this queue is the identical argument with the sign flipped. A
 * `SELECT id FROM jobs WHERE state = 'pending' LIMIT 1` followed by an
 * `UPDATE jobs SET state = 'running' WHERE id = ?` is a read, then a write: two
 * drains whose reads land in the same window both see the same row and both
 * write it, and the second write succeeds because there is nothing in it that
 * depends on the first not having happened. The lost update becomes a *duplicated*
 * one — one unit of work handed out twice.
 *
 * What that costs is not wasted compute. §5.10 makes a document one episode
 * (*"forty assertions from one ADR are one source, not forty observations"*), and
 * §4.2's episode cap is applied per contribution: a chunk extracted twice
 * contributes twice, from one source, through two apparently separate runs. That
 * is the §4.4 independence failure the caps exist to prevent, arriving through
 * the queue rather than through the ingest path everything else guards.
 *
 * ── Why this cannot be an in-process test ───────────────────────────────────
 *
 * better-sqlite3 is synchronous. A single Node process serializes every call it
 * makes, so two in-process "drains" never overlap and a read-then-write claim
 * passes trivially — the same reasoning `worker-harness.ts` gives for spawning
 * real processes, and the same reason v1's concurrency is cross-process by
 * construction: an MCP server per session, git hooks shelling out to the same
 * binary, `kgmem jobs run` under cron, all on one SQLite file under WAL.
 *
 * ── Why this fixture would actually catch one ───────────────────────────────
 *
 * Three real processes, released together from a barrier, each draining the same
 * kind in a tight loop with no I/O between claims, over a queue deep enough that
 * no worker can empty it during another's start-up jitter. Every claimed id is
 * reported and the union is checked three ways — total, distinct, and by
 * enumerating the ids handed out more than once — so a double claim is named
 * rather than inferred from a count. A claim that raised instead of racing shows
 * in the exit codes and stderr, which are asserted before the ids are: an
 * implementation that answers contention with `SQLITE_BUSY` or a snapshot error
 * is not an atomic claim either, and would otherwise look like a queue that
 * simply had fewer jobs in it.
 *
 * ── Why the workers take shares rather than draining ───────────────────────
 *
 * Measured, not assumed. A worker that drains until the queue answers with
 * nothing does not share a queue with anyone: an atomic claim is one write
 * statement, and a process that holds SQLite's write lock re-takes it faster than
 * a peer can be scheduled, so over ten thousand jobs one worker took all ten
 * thousand and the other two took none. Every assertion below would have passed,
 * and none of them would have meant anything — there was only ever one drain.
 *
 * So each worker claims a fixed share and the queue holds exactly
 * {@link WORKER_COUNT} shares. No worker can finish before the others have taken
 * theirs, which puts all three inside the claim loop for the whole run and makes
 * the shares themselves an assertion: three equal shares is what a queue that was
 * genuinely drained by three processes looks like.
 *
 * The same probe, against a `SELECT ... LIMIT 1` then `UPDATE` claim under this
 * fixture, produced duplicate ids on six runs out of six — between three and
 * nineteen jobs handed to two workers each time.
 *
 * Sized to stay a permanent fixture: this is a few thousand write transactions on
 * WAL with `synchronous = NORMAL`, measured at well under a second.
 *
 * @spec §4.2, §4.4, §5.7, §5.10, §9, §11, §12
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openGraphStore } from '../index';

import { WORKER_GO, WORKER_READY } from './fixtures';

/** How many real processes contend for the queue. Three beats two: it also catches an implementation that only serializes pairs. @spec §5.7 */
const WORKER_COUNT = 3;

/**
 * How many jobs each worker claims before it stops asking.
 *
 * Deep enough that the three loops overlap for thousands of claim windows rather
 * than for the tail of one worker's run, and shallow enough to stay a fixture.
 *
 * @spec §5.7, §5.10
 */
const SHARE_PER_WORKER = 500;

/**
 * How many extraction jobs are queued: exactly one share each, and not one more.
 *
 * The equality is the mechanism. With a surplus, a worker could take its share
 * out of jobs nobody else wanted and never contend; with a shortfall, a worker
 * would give up short through no fault of the store. Exactly `n` shares means
 * every worker is still asking while every other worker is still answering.
 *
 * @spec §5.7
 */
const EXTRACT_JOBS = WORKER_COUNT * SHARE_PER_WORKER;

/** Jobs of another kind, queued so the kind scoping is under contention too rather than only under a single caller. @spec §9 */
const CONSOLIDATE_JOBS = 12;

/** §5.10's lazy half — the kind every worker drains. @spec §5.10 */
const EXTRACT = 'extract';

/** §8.2's consolidator — the kind no worker asks for. @spec §8.2, §9 */
const CONSOLIDATE = 'consolidate';

const workerPath = fileURLToPath(new URL('./job-drain-worker.ts', import.meta.url));

/** Exit code, captured stdout and captured stderr of one finished worker. @spec §5.7 */
interface WorkerOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A spawned worker, parked at the barrier until {@link Worker.release} is called. @spec §5.7 */
interface Worker {
  /** Resolves `true` once the worker parked, `false` if it died before getting there. */
  readonly ready: Promise<boolean>;
  /** Resolves when the worker exits. */
  readonly done: Promise<WorkerOutcome>;
  /** Releases the barrier. */
  release(): void;
}

let directory: string;
let dbPath: string;

/**
 * Spawns one drain against the shared database file.
 *
 * `--import tsx` is what lets the worker import the same TypeScript `GraphStore`
 * the test does, so both sides exercise one implementation rather than a compiled
 * copy that could drift.
 *
 * @spec §5.7
 */
const spawnWorker = (): Worker => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', workerPath, dbPath, EXTRACT, String(SHARE_PER_WORKER)],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<boolean>((resolve) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(WORKER_READY)) resolve(true);
    });
    child.on('error', () => {
      resolve(false);
    });
    child.on('close', () => {
      resolve(false);
    });
  });

  const done = new Promise<WorkerOutcome>((resolve) => {
    child.on('error', (error: Error) => {
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

  return {
    ready,
    done,
    release: () => {
      child.stdin.end(`${WORKER_GO}\n`);
    },
  };
};

/**
 * Runs the full barrier cycle: spawn, wait for every worker to park, release them
 * together, and collect their outcomes.
 *
 * @spec §5.7
 */
const drainConcurrently = async (): Promise<readonly WorkerOutcome[]> => {
  const workers = Array.from({ length: WORKER_COUNT }, () => spawnWorker());

  const readiness = await Promise.all(workers.map((worker) => worker.ready));
  const outcomes = Promise.all(workers.map((worker) => worker.done));

  if (readiness.includes(false)) {
    const failures = await outcomes;
    throw new Error(
      `a worker died before the barrier: ${failures.map((failure) => failure.stderr).join('')}`,
    );
  }

  for (const worker of workers) worker.release();
  return outcomes;
};

/**
 * The ids one worker reported claiming.
 *
 * Defensive about the parse rather than trusting it: a worker that died mid-drain
 * reports nothing, and a `JSON.parse` throwing here would replace a legible
 * assertion failure — exit code, stderr, missing ids — with a parse error that
 * says none of it.
 *
 * @spec §5.7
 */
const claimedBy = (outcome: WorkerOutcome): readonly number[] => {
  const reported = outcome.stdout.replace(WORKER_READY, '').trim();
  try {
    const parsed: unknown = JSON.parse(reported);
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
};

/** Every id claimed, across every worker, in no particular order. @spec §5.7 */
const allClaims = (outcomes: readonly WorkerOutcome[]): readonly number[] =>
  outcomes.flatMap((outcome) => [...claimedBy(outcome)]);

/** The ids handed out more than once, so a failure names the jobs rather than a count. @spec §5.7, §12 */
const claimedTwice = (claims: readonly number[]): number[] => {
  const seen = new Set<number>();
  const duplicated = new Set<number>();
  for (const id of claims) {
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }
  return [...duplicated].sort((left, right) => left - right);
};

/** How many jobs of one kind sit in one state, read straight off the file. @spec §9 */
const jobsInState = (kind: string, state: string): number => {
  const db = new Database(dbPath);
  try {
    return (
      db
        .prepare('SELECT COUNT(*) AS n FROM jobs WHERE kind = ? AND state = ?')
        .get(kind, state) as { readonly n: number }
    ).n;
  } finally {
    db.close();
  }
};

/**
 * The one drain every assertion in this file reads.
 *
 * Run once rather than per test. Six barriers, six sets of three processes and
 * six drains of a queue this deep would be the slowest fixture in the suite by a
 * wide margin, and the assertions are all about *the same* run: what came out of
 * one contended drain, checked from six directions. Nothing here mutates it.
 *
 * @spec §5.7
 */
let outcomes: readonly WorkerOutcome[];

/** Every id the drain handed out, across every worker. @spec §5.7 */
let claims: readonly number[];

/**
 * Fills the queue on a plain driver connection, after a store has migrated the
 * file.
 *
 * Seeded rather than enqueued through the port, for two reasons that point the
 * same way. The behaviour under test is what happens when two drains reach for
 * one row; the enqueue path has nothing to do with it, and is pinned in
 * `jobs-queue.test.ts` where it belongs. And a fixture built out of the port
 * would put the whole file behind `enqueueJob` — one missing method, and six
 * assertions about claiming report as a suite that never ran rather than as six
 * failures.
 *
 * `scheduled_at` is written explicitly and in the past, so the rows are due under
 * either reading of that column: an implementation that treats SQL NULL as "at
 * once" and one that compares `scheduled_at <= now()` both claim these.
 *
 * @spec §9, §11
 */
const seedQueue = (): void => {
  const store = openGraphStore({ path: dbPath });
  store.close();

  const db = new Database(dbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO jobs (kind, payload, state, scheduled_at)
       VALUES (?, ?, 'pending', '2020-01-01T00:00:00.000Z')`,
    );
    db.transaction(() => {
      for (let i = 0; i < EXTRACT_JOBS; i += 1)
        insert.run(EXTRACT, JSON.stringify({ chunk: i }));
      for (let i = 0; i < CONSOLIDATE_JOBS; i += 1)
        insert.run(CONSOLIDATE, JSON.stringify({ sweep: i }));
    })();
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'kg-job-claim-race-'));
  dbPath = join(directory, 'graph.db');

  seedQueue();

  outcomes = await drainConcurrently();
  claims = allClaims(outcomes);
}, 120_000);

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('three processes draining one queue', () => {
  /*
   * The duplicate list and the count are one assertion on purpose. A drain that
   * claimed nothing at all has no duplicates in it either, so the list alone
   * passes hardest exactly where the fixture has stopped working.
   */
  it('never hands one job to two drains', () => {
    expect({ claimedTwice: claimedTwice(claims), handedOut: claims.length }).toStrictEqual({
      claimedTwice: [],
      handedOut: EXTRACT_JOBS,
    });
  });

  it('hands out every queued job exactly once, with none lost and none invented', () => {
    expect({ claims: claims.length, distinct: new Set(claims).size }).toStrictEqual({
      claims: EXTRACT_JOBS,
      distinct: EXTRACT_JOBS,
    });
  });

  it('answers contention by waiting rather than by failing a drain', () => {
    expect(outcomes.map((outcome) => outcome.stderr).join('')).toBe('');
    expect(outcomes.map((outcome) => outcome.code)).toStrictEqual(
      Array.from({ length: WORKER_COUNT }, () => 0),
    );
  });

  it('leaves every extraction job done, none still running and none still waiting', () => {
    expect({
      done: jobsInState(EXTRACT, 'done'),
      running: jobsInState(EXTRACT, 'running'),
      pending: jobsInState(EXTRACT, 'pending'),
    }).toStrictEqual({ done: EXTRACT_JOBS, running: 0, pending: 0 });
  });

  /*
   * Both halves, because the consolidation half alone is the state the queue was
   * seeded in: a drain that never ran leaves those twelve rows pending too.
   */
  it('leaves the jobs of another kind untouched, since a drain asks for one kind', () => {
    expect({
      consolidationsWaiting: jobsInState(CONSOLIDATE, 'pending'),
      extractionsWaiting: jobsInState(EXTRACT, 'pending'),
    }).toStrictEqual({ consolidationsWaiting: CONSOLIDATE_JOBS, extractionsWaiting: 0 });
  });

  /*
   * Insurance on the fixture, and the reason the shares exist. A worker short of
   * its share gave up against an empty queue, which — with exactly one share per
   * worker in the table — can only happen if some job went to two workers and
   * some job therefore went to none. A worker with nothing at all never ran, and
   * a fixture in that state would pass every assertion above for reasons that
   * have nothing to do with atomicity.
   */
  it('gives every worker its whole share, which is what makes the assertions above mean anything', () => {
    expect(outcomes.map((outcome) => claimedBy(outcome).length)).toStrictEqual(
      Array.from({ length: WORKER_COUNT }, () => SHARE_PER_WORKER),
    );
  });
});
