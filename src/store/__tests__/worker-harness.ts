/**
 * Spawning real OS processes for the store's cross-process fixtures.
 *
 * §5.7's concurrency claims are cross-*process* claims — in v1 an agent is a
 * process, and one SQLite file is shared by an MCP server per session plus
 * whatever git hooks shell out to the same binary. A second connection inside
 * one Node process cannot stand in for that: better-sqlite3 is synchronous, so
 * two in-process connections never actually collide on the write lock in a way
 * the caller can observe, and a single process cannot race itself through
 * migration 0.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * The barrier is the point. Loading better-sqlite3 and opening a store costs a
 * few hundred milliseconds, so processes started one after another finish one
 * after another — and a staggered run passes even when a genuine race is
 * present. Each worker announces {@link WORKER_READY} once it is warm, and the
 * parent releases every worker at once.
 *
 * @spec §5.7, §11
 */

import { spawn } from 'node:child_process';

import { WORKER_GO, WORKER_READY } from './fixtures';

/** Exit code and captured stderr of one finished worker. @spec §5.7 */
export interface WorkerOutcome {
  readonly code: number | null;
  readonly stderr: string;
}

/** A spawned worker, parked at the barrier until it is released or killed. @spec §5.7 */
export interface Worker {
  /** Resolves `true` once the worker parked, `false` if it died before getting there. */
  readonly ready: Promise<boolean>;
  /** Resolves when the worker exits. */
  readonly done: Promise<WorkerOutcome>;
  /** Releases the barrier by closing the worker's stdin with the go-ahead. */
  release(): void;
  /** Ends the worker outright, for the tests that never want it to finish its own way. */
  kill(): void;
}

/**
 * Spawns one worker process.
 *
 * `--import tsx` is what lets the worker import the same TypeScript modules the
 * test does, so both sides exercise one implementation rather than a compiled
 * copy that could drift.
 *
 * @spec §5.7
 */
export const spawnWorker = (scriptPath: string, args: readonly string[]): Worker => {
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<boolean>((resolve) => {
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.includes(WORKER_READY)) resolve(true);
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
      resolve({ code: null, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });

  return {
    ready,
    done,
    release: () => {
      if (child.stdin.writable) child.stdin.end(`${WORKER_GO}\n`);
    },
    kill: () => {
      child.kill('SIGKILL');
    },
  };
};

/**
 * Waits for every worker to park, then releases them together and collects
 * their outcomes.
 *
 * @spec §5.7
 */
export const releaseTogether = async (
  workers: readonly Worker[],
): Promise<readonly WorkerOutcome[]> => {
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
