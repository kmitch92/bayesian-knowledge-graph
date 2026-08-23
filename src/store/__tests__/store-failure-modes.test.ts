/**
 * The two failures the store can suffer that are nobody's programming error.
 *
 * Every refusal the store owns today names a promise the *caller* broke — a
 * width it did not pin, an id it never minted, an edge kind v1 refuses. These
 * two are different: the file on disk is not a database, or another process is
 * holding the write lock and will not let go. Neither is a caller mistake, and
 * both are things a caller has to be able to *act* on — retry a contended
 * write, refuse to start against a corrupt store — which means both have to be
 * distinguishable by type.
 *
 * Today neither is. A corrupt file surfaces better-sqlite3's own
 * `SqliteError: file is not a database`, and a lock held past
 * {@link BUSY_TIMEOUT_MS} surfaces `SqliteError: database is locked`. A caller
 * that wants to tell either apart from an ordinary refusal has to match on a
 * driver's message string, which makes the store's failure vocabulary a
 * function of a dependency's wording.
 *
 * Each refusal is asserted twice on purpose: once on the class, and once on the
 * error's `name`. The name assertion is the one that reads properly when the
 * class does not exist yet — "expected 'SqliteError' to be 'StoreBusyError'" is
 * the whole gap in one line.
 *
 * The busy case also pins the option that makes it testable at all. §5.7 sets a
 * deliberately generous 30 s wait, and a fixture that actually reached it would
 * cost thirty seconds per run. The timeout is therefore per-store rather than a
 * constant: the default stays §5.7's, and a caller that wants to fail fast — a
 * test, a health check, a git hook that must not stall a commit — says so.
 *
 * Nothing here is stubbed. The corrupt file is real bytes on disk; the lock is
 * held by a real second OS process.
 *
 * @spec §5.7, §11, §12
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Evidence } from '../../schema/index';
import { CorruptStoreError, StoreBusyError, openGraphStore, type GraphStore } from '../index';

import { CLAIM_ID, PRIOR_ALPHA, makeClaim, makeEntity } from './fixtures';
import { spawnWorker, type Worker } from './worker-harness';

/**
 * The fail-fast wait the busy tests open their store with.
 *
 * Long enough that a loaded machine does not report contention that is not
 * there, short enough that expiry costs a quarter of a second rather than
 * §5.7's thirty.
 *
 * @spec §5.7
 */
const IMPATIENT_TIMEOUT_MS = 250;

/** A wait no test here intends to exhaust, for the case where the lock comes back in time. @spec §5.7 */
const PATIENT_TIMEOUT_MS = 10_000;

/** How long the holder keeps the lock when the test means the wait to come back in time. @spec §5.7 */
const BRIEF_HOLD_MS = 400;

/**
 * How long the holder keeps the lock when the test means the wait to run out.
 *
 * Sits between {@link IMPATIENT_TIMEOUT_MS} and {@link BUSY_TIMEOUT_MS} on
 * purpose. A store that honours its own timeout gives up at 250 ms while the
 * lock is still held; a store that ignores it waits, gets the lock when the
 * holder lets go, and completes the write — which is a *fast, legible* failure
 * of these tests rather than a thirty-second stall.
 *
 * @spec §5.7
 */
const HOLD_PAST_TIMEOUT_MS = 1_500;

/** Bytes that are not a SQLite database by any reading. */
const GARBAGE = Buffer.from('this file is prose, not a page cache\n'.repeat(200), 'utf8');

/**
 * Bytes that open with SQLite's magic string and then stop making sense.
 *
 * The nastier shape of the two: anything sniffing the header alone concludes
 * this is a database, so the refusal has to come from actually reading it.
 */
const FAKE_HEADER = Buffer.concat([
  Buffer.from('SQLite format 3 ', 'binary'),
  Buffer.alloc(8192, 0xab),
]);

const holderPath = fileURLToPath(new URL('./lock-holder-worker.ts', import.meta.url));

let directory: string;
let dbPath: string;
let holder: Worker | undefined;

/**
 * Opens a store that is expected to be refused, and hands back the refusal.
 *
 * `undefined` when the open succeeded, which is itself a failure every
 * assertion below reports.
 *
 * @spec §11
 */
const refusalFromOpening = (path: string, busyTimeoutMs?: number): unknown => {
  try {
    openGraphStore(busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs }).close();
  } catch (error) {
    return error;
  }
  return undefined;
};

/** Runs a write that is expected to be refused, and hands back the refusal. @spec §5.7 */
const refusalFromWriting = (write: () => void): unknown => {
  try {
    write();
  } catch (error) {
    return error;
  }
  return undefined;
};

/** Spawns the lock holder and waits until the write lock is genuinely taken. @spec §5.7 */
const holdWriteLock = async (holdMs: number, path: string = dbPath): Promise<void> => {
  const worker = spawnWorker(holderPath, [path, String(holdMs)]);
  holder = worker;
  if (!(await worker.ready)) throw new Error(`the lock holder died: ${(await worker.done).stderr}`);
};

/** Hands the write lock back, for the assertions that have to read after a refusal. @spec §5.7 */
const releaseWriteLock = async (): Promise<void> => {
  holder?.kill();
  await holder?.done;
  holder = undefined;
};

/** Writes a file of the given bytes into the temporary directory and returns its path. */
const writeBytes = (name: string, bytes: Buffer): string => {
  const path = join(directory, name);
  writeFileSync(path, bytes);
  return path;
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-mcp-failure-'));
  dbPath = join(directory, 'graph.db');
  holder = undefined;

  const seed = openGraphStore({ path: dbPath });
  seed.putEntity(makeEntity());
  seed.putClaim(makeClaim());
  seed.close();
});

afterEach(async () => {
  await releaseWriteLock();
  rmSync(directory, { recursive: true, force: true });
});

describe('opening a file that is not a database', () => {
  it('refuses it under a name the store owns, rather than one the driver owns', () => {
    const refusal = refusalFromOpening(writeBytes('prose.db', GARBAGE));

    expect((refusal as Error | undefined)?.name).toBe('CorruptStoreError');
  });

  it('refuses a file of ordinary bytes', () => {
    const refusal = refusalFromOpening(writeBytes('prose.db', GARBAGE));

    expect(refusal).toBeInstanceOf(CorruptStoreError);
  });

  it('refuses a file that only pretends to carry a SQLite header', () => {
    const refusal = refusalFromOpening(writeBytes('pretend.db', FAKE_HEADER));

    expect(refusal).toBeInstanceOf(CorruptStoreError);
  });

  it('names the path it could not open, since a caller may be holding several', () => {
    const path = writeBytes('prose.db', GARBAGE);

    const refusal = refusalFromOpening(path);

    expect((refusal as CorruptStoreError | undefined)?.path).toBe(path);
  });

  it('leaves the unreadable file exactly as it found it, rather than migrating over it', () => {
    const path = writeBytes('prose.db', GARBAGE);

    refusalFromOpening(path);

    expect(readFileSync(path)).toStrictEqual(GARBAGE);
  });

  it('still opens a real database at a path beside it', () => {
    writeBytes('prose.db', GARBAGE);

    const store = openGraphStore({ path: dbPath });
    try {
      expect(store.getClaim(CLAIM_ID)).toStrictEqual(makeClaim());
    } finally {
      store.close();
    }
  });
});

describe('a write that cannot get the lock before the wait runs out', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = openGraphStore({ path: dbPath, busyTimeoutMs: IMPATIENT_TIMEOUT_MS });
  });

  afterEach(() => {
    store.close();
  });

  it('refuses the write under a name the store owns, rather than one the driver owns', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);

    const refusal = refusalFromWriting(() => {
      store.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });
    });

    expect((refusal as Error | undefined)?.name).toBe('StoreBusyError');
  });

  it('refuses an evidence increment it could not apply', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);

    const refusal = refusalFromWriting(() => {
      store.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });
    });

    expect(refusal).toBeInstanceOf(StoreBusyError);
  });

  it('reports the wait it gave up after, so a caller can decide whether to wait longer', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);

    const refusal = refusalFromWriting(() => {
      store.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });
    });

    expect((refusal as StoreBusyError | undefined)?.timeoutMs).toBe(IMPATIENT_TIMEOUT_MS);
  });

  it('leaves the contribution unapplied, so a caller that retries does not double-count', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);
    refusalFromWriting(() => {
      store.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });
    });

    await releaseWriteLock();

    expect(Evidence.parse(store.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA);
  });

  it('refuses a status change under the same contention rather than half-applying it', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);

    const refusal = refusalFromWriting(() => {
      store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });
    });

    expect(refusal).toBeInstanceOf(StoreBusyError);
  });

  it('leaves that claim active, since the transition never landed', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);
    refusalFromWriting(() => {
      store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });
    });

    await releaseWriteLock();

    expect(store.getClaim(CLAIM_ID)?.status).toBe('active');
  });
});

describe('an open that cannot get the lock before the wait runs out', () => {
  it('refuses the open as contention rather than as a driver error', async () => {
    const contended = join(directory, 'contended.db');
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS, contended);

    const refusal = refusalFromOpening(contended, IMPATIENT_TIMEOUT_MS);

    expect((refusal as Error | undefined)?.name).toBe('StoreBusyError');
  });

  it('reports the wait it gave up after, the same way a refused write does', async () => {
    const contended = join(directory, 'contended.db');
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS, contended);

    const refusal = refusalFromOpening(contended, IMPATIENT_TIMEOUT_MS);

    expect((refusal as StoreBusyError | undefined)?.timeoutMs).toBe(IMPATIENT_TIMEOUT_MS);
  });
});

describe('a write whose lock comes back inside the wait', () => {
  it('waits it out and applies the contribution, because §5.7 makes a collision a wait', async () => {
    const store = openGraphStore({ path: dbPath, busyTimeoutMs: PATIENT_TIMEOUT_MS });
    try {
      await holdWriteLock(BRIEF_HOLD_MS);

      store.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });

      expect(Evidence.parse(store.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 1);
    } finally {
      store.close();
    }
  });
});
