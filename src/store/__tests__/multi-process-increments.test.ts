/**
 * §5.7 concurrency, the part that actually proves the claim.
 *
 * "Two agents updating the same claim concurrently must not drop evidence." In
 * v1 an agent *is* a process: the plan runs the MCP server as a stdio process
 * per session and has git hooks shell out to the same binary, all sharing one
 * SQLite file under WAL. So the lost-update row in the §12 registry is a
 * cross-process failure, and only cross-process pressure can rule it out — a
 * single Node process serializes every better-sqlite3 call, so in-process
 * "concurrency" passes trivially even for a read-modify-write implementation.
 *
 * The fixture spawns {@link WORKER_COUNT} real OS processes, waits for every one
 * of them to report itself warm and parked, releases them all at once, and
 * checks the final α against the exact arithmetic sum. `SELECT alpha` followed
 * by `UPDATE … SET alpha = ?` cannot survive it: two workers that read the same
 * value and each write back their own sum discard one contribution every time
 * their read windows overlap, and across {@link TOTAL_INCREMENTS} contended
 * writes they overlap constantly.
 *
 * Sized to stay a permanent fixture: a few hundred increments, seconds not
 * minutes.
 *
 * @spec §5.7, §11, §12
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Evidence } from '../../schema/index';
import { openGraphStore } from '../index';

import {
  CLAIM_ID,
  PRIOR_ALPHA,
  PRIOR_BETA,
  WORKER_GO,
  WORKER_READY,
  makeClaim,
  seedEntityAndClaim,
} from './fixtures';

/** How many real processes contend for the one claim. Three beats two: it also catches an implementation that only serializes pairs. @spec §5.7 */
export const WORKER_COUNT = 3;

/** Increments each worker applies. Enough contention to expose a lost update, short enough to keep the fixture fast. @spec §5.7 */
export const INCREMENTS_PER_WORKER = 150;

/**
 * The per-increment weight: an inferred-tier observation (§15). Exactly
 * representable in binary floating point, and so is every partial sum up to the
 * total, so the expected α is an exact equality rather than an epsilon compare —
 * a lost update of 0.5 cannot hide inside a tolerance.
 *
 * @spec §4.2, §15
 */
export const ALPHA_PER_INCREMENT = 0.5;

/** Total contended writes across all workers. @spec §5.7 */
export const TOTAL_INCREMENTS = WORKER_COUNT * INCREMENTS_PER_WORKER;

const workerPath = fileURLToPath(new URL('./increment-worker.ts', import.meta.url));

/** Exit code and captured stderr of one finished worker. @spec §5.7 */
export interface WorkerOutcome {
  readonly code: number | null;
  readonly stderr: string;
}

/** A spawned worker, parked at the barrier until {@link Worker.release} is called. @spec §5.7 */
export interface Worker {
  /** Resolves `true` once the worker parked, `false` if it died before getting there. */
  readonly ready: Promise<boolean>;
  /** Resolves when the worker exits. */
  readonly done: Promise<WorkerOutcome>;
  /** Releases the barrier. */
  release(): void;
}

/**
 * Spawns one worker process against the shared database file.
 *
 * `--import tsx` is what lets the worker import the same TypeScript
 * `GraphStore` the test does, so both sides exercise one implementation rather
 * than a compiled copy that could drift.
 *
 * @spec §5.7
 */
export const spawnWorker = (dbPath: string): Worker => {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      workerPath,
      dbPath,
      CLAIM_ID,
      String(INCREMENTS_PER_WORKER),
      String(ALPHA_PER_INCREMENT),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

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
      child.stdin.end(`${WORKER_GO}\n`);
    },
  };
};

/**
 * Runs the full barrier cycle: spawn, wait for every worker to park, release
 * them together, and collect their outcomes.
 *
 * @spec §5.7
 */
export const hammerConcurrently = async (dbPath: string): Promise<readonly WorkerOutcome[]> => {
  const workers = Array.from({ length: WORKER_COUNT }, () => spawnWorker(dbPath));

  const readiness = await Promise.all(workers.map((worker) => worker.ready));
  const outcomes = Promise.all(workers.map((worker) => worker.done));

  if (readiness.includes(false)) {
    const failures = await outcomes;
    throw new Error(`a worker died before the barrier: ${failures.map((f) => f.stderr).join('')}`);
  }

  for (const worker of workers) worker.release();
  return outcomes;
};

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-mcp-store-'));
  dbPath = join(directory, 'graph.db');

  const store = openGraphStore({ path: dbPath });
  seedEntityAndClaim(store, makeClaim({ evidence: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA } }));
  store.close();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('concurrent processes incrementing one claim', () => {
  it(
    'lands the exact arithmetic sum of every contribution, with zero lost updates',
    { timeout: 120_000 },
    async () => {
      const outcomes = await hammerConcurrently(dbPath);

      expect(outcomes.map((outcome) => outcome.stderr).join('')).toBe('');
      expect(outcomes.map((outcome) => outcome.code)).toStrictEqual(
        Array.from({ length: WORKER_COUNT }, () => 0),
      );

      const store = openGraphStore({ path: dbPath });
      try {
        expect(Evidence.parse(store.getEvidence(CLAIM_ID)).alpha).toBe(
          PRIOR_ALPHA + TOTAL_INCREMENTS * ALPHA_PER_INCREMENT,
        );
      } finally {
        store.close();
      }
    },
  );

  it(
    'leaves beta exactly where it was, since no worker touched it',
    { timeout: 120_000 },
    async () => {
      await hammerConcurrently(dbPath);

      const store = openGraphStore({ path: dbPath });
      try {
        expect(Evidence.parse(store.getEvidence(CLAIM_ID)).beta).toBe(PRIOR_BETA);
      } finally {
        store.close();
      }
    },
  );

  it(
    'never fails a writer with SQLITE_BUSY, because the store sets a busy timeout of its own',
    { timeout: 120_000 },
    async () => {
      const outcomes = await hammerConcurrently(dbPath);

      expect(outcomes.some((outcome) => outcome.stderr.includes('SQLITE_BUSY'))).toBe(false);
    },
  );
});

describe('the shared database file', () => {
  it('runs in WAL mode, which is what lets separate processes share it', () => {
    const store = openGraphStore({ path: dbPath });
    try {
      expect(store.journalMode).toBe('wal');
    } finally {
      store.close();
    }
  });

  it('makes a write from one connection visible to a connection opened afterwards', () => {
    const writer = openGraphStore({ path: dbPath });
    writer.incrementEvidence({ claimId: CLAIM_ID, alpha: 2.5 });
    writer.close();

    const reader = openGraphStore({ path: dbPath });
    try {
      expect(Evidence.parse(reader.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 2.5);
    } finally {
      reader.close();
    }
  });

  it('makes a write from one connection visible to a connection already open', () => {
    const reader = openGraphStore({ path: dbPath });
    const writer = openGraphStore({ path: dbPath });
    try {
      writer.incrementEvidence({ claimId: CLAIM_ID, alpha: 4 });

      expect(Evidence.parse(reader.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 4);
    } finally {
      writer.close();
      reader.close();
    }
  });
});
