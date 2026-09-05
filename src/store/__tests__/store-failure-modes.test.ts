/**
 * The failures the store can suffer that are nobody's programming error, and
 * the write that has to survive them whole.
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
 * ── The write those two failures are survivable *by* ────────────────────────
 *
 * A refusal a caller can act on is only half of it. The other half is what the
 * store leaves behind when it refuses partway through a write that is really
 * several — and §5.10's ingest is exactly that shape: a document row, one chunk
 * row per paragraph, and one queue row per chunk that has to be mined. Written
 * as separate calls, a contended store commits every row it reached before the
 * lock ran out, and the queue rows that never landed are the ones nothing will
 * ever park again: re-ingesting finds those chunks already stored and parks
 * nothing for them. Measured under six concurrent ingests, that is `chunks=7
 * jobs=0` beside siblings that got `chunks=8 jobs=8`, and no retry repairs it.
 *
 * So {@link GraphStore.submitDocument} is one document, one transaction. The
 * sections below pin what that buys, in the two currencies a partial write is
 * paid in: what a *refused* submission leaves (nothing, ever, including no job)
 * and what a *successful* one exposes to anyone else reading the file (one
 * commit, and never an instant in which the document row is missing).
 *
 * Three of those assertions need an instrument the port does not offer, and
 * each uses the one this suite already established. Commit counting reads the
 * write-ahead log's own frame headers — see {@link committedTransactions} —
 * because `PRAGMA data_version` reports *that* another connection committed and
 * not how often. The document row's survival is watched by a real trigger
 * installed through a second connection, which is `transaction-rollback.test.ts`'s
 * technique pointed at observation rather than fault injection. And a chunk is
 * made to fail deterministically by giving it an ordinal `document_chunks`'
 * own `CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0)` refuses, so the
 * failure lands on a chosen chunk rather than on a race the test would have to
 * win. The store is never faked and neither is the driver.
 *
 * @spec §3.6, §5.7, §5.10, §9, §11, §12
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Evidence } from '../../schema/index';
import {
  CorruptStoreError,
  DimensionMismatchError,
  StoreBusyError,
  UnknownDocumentOriginError,
  openGraphStore,
  type DocumentOrigin,
  type DocumentRecord,
  type GraphStore,
  type JobSubmission,
  type StageLogEntry,
} from '../index';

import {
  CLAIM_ID,
  CREATED_AT,
  PRIOR_ALPHA,
  STORE_RERANK_WIDTH,
  makeClaim,
  makeEntity,
  testUlid,
  unitVectorArray,
} from './fixtures';
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

/**
 * The slack allowed when asserting that a writer really did wait out a hold.
 *
 * The hold is timed in the holder's process and the wait in this one, so the two
 * clocks are only as aligned as two Node processes' timers are. The assertion it
 * guards is coarse on purpose — "waited hundreds of milliseconds" rather than
 * "waited exactly {@link BRIEF_HOLD_MS}" — because what it is distinguishing is a
 * wait from an *immediate* refusal, and those differ by the whole hold.
 *
 * @spec §5.7
 */
const HOLD_TOLERANCE_MS = 100;

const holderPath = fileURLToPath(new URL('./lock-holder-worker.ts', import.meta.url));

const committerPath = fileURLToPath(new URL('./commit-during-hold-worker.ts', import.meta.url));

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

/*
 * ---------------------------------------------------------------------------
 * One document, one transaction.
 * ---------------------------------------------------------------------------
 */

/** The document being submitted. @spec §3.6 */
const DOCUMENT_ID = testUlid('DOC-ADR-0011-ATOMIC');

/** A document already in the store beside it, so no refusal here is satisfied by an empty table. @spec §3.6 */
const NEIGHBOUR_ID = testUlid('DOC-RUNBOOK-BESIDE-IT');

/** @spec §3.6 */
const TITLE = 'ADR 0011 — the submission is the transaction';

/** @spec §3.6 */
const NEIGHBOUR_TITLE = 'Runbook — what to do when the lock is held';

/** §3.6's content column, as `submitText` writes it: the document, whole. @spec §3.6 */
const CONTENT = 'The document, whole, exactly as its author wrote it.';

/** The queue §5.10 parks the expensive half in. Open text on the store's side. @spec §9 */
const JOB_KIND = 'extract';

/**
 * An ordinal `document_chunks` refuses.
 *
 * Migration 0's `CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0)`, used as
 * an instrument: it puts a genuine constraint failure on a chunk of the test's
 * choosing, so "the submission died partway through its chunks" is a fact about
 * the schema rather than a race a test has to win. Nothing about *this* value is
 * load-bearing — a negative ordinal or a string one would do the same.
 *
 * @spec §3.6
 */
const BAD_ORDINAL = 1.5;

/**
 * The paragraph count the queue-row loss was actually measured at.
 *
 * Six concurrent `kgmem ingest` processes over eight-paragraph notebooks is what
 * produced `chunks=7 jobs=0`, so the commit count is pinned at that size rather
 * than at a size chosen to make the number tidy.
 *
 * @spec §5.7, §5.10
 */
const MEASURED_PARAGRAPHS = 8;

/**
 * An origin neither arm of §5.10's rule matches.
 *
 * Reachable: `submitDocument` is a port method, and the ingress that feeds it
 * parses what an agent or a CLI handed over.
 *
 * @spec §5.10
 */
const THIRD_ORIGIN = 'parsed' as unknown as DocumentOrigin;

/** The anchor a chunk carries. The store hashes nothing, so these are the caller's convention. @spec §3.6 */
const hashAt = (ordinal: number): string => `sha256:chunk-${String(ordinal)}`;

/** The same paragraph, edited: a different anchor at the same position. @spec §3.6 */
const revisedHashAt = (ordinal: number): string => `${hashAt(ordinal)}-revised`;

/** The extraction §5.10 defers for one chunk. @spec §5.10, §9 */
const extractJob = (ordinal: number, documentId: string = DOCUMENT_ID): JobSubmission => ({
  kind: JOB_KIND,
  payload: { documentId, ordinal, hash: hashAt(ordinal) },
});

/**
 * One chunk offered with the job that rides on it.
 *
 * `enqueue` is passed at every call site, never defaulted: E6's whole argument
 * for the field being required and nullable is that a forgotten job and a chunk
 * that legitimately needs none must not be spelled the same way, and a fixture
 * with a default would spell them the same way here.
 *
 * @spec §3.6, §5.10, §9
 */
const chunkAt = (ordinal: number, enqueue: JobSubmission | null) => ({
  ordinal,
  hash: hashAt(ordinal),
  embedding: unitVectorArray(ordinal + 1),
  enqueue,
});

/** §5.8's replay entry for one ingest, which E6 makes part of the same transaction. @spec §5.8 */
const stageLog = (documentId: string): StageLogEntry => ({
  episodeId: `document:${documentId}`,
  stage: 'text-ingest',
  inputs: { documentId },
  decision: { origin: 'authored' },
  at: CREATED_AT,
});

/** A whole submission: the row, the chunks it has *now*, and the log of the decision. @spec §3.6, §5.8, §5.10 */
const submissionOf = (
  chunks: readonly ReturnType<typeof chunkAt>[],
  overrides: Partial<DocumentRecord> = {},
) => {
  const document: DocumentRecord = {
    id: DOCUMENT_ID,
    title: TITLE,
    origin: 'authored',
    contentRef: CONTENT,
    scope: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
  return { document, chunks, log: stageLog(document.id) };
};

/**
 * The one place this file names the method E6 adds.
 *
 * Called through a helper rather than inline so the port's absence is one
 * compile error and one failure message — `store.submitDocument is not a
 * function` — rather than one per call site.
 *
 * @spec §3.6, §5.10, §11
 */
const submitDocument = (
  target: GraphStore,
  submission: ReturnType<typeof submissionOf>,
): number[] => target.submitDocument(submission);

/** A document's chunks as (ordinal, anchor) pairs, in the order the store served them. @spec §3.6 */
const chunksOf = (target: GraphStore, documentId: string): (readonly [number, string])[] =>
  target.getChunks(documentId).map((chunk) => [chunk.ordinal, chunk.hash] as const);

/** The WAL's fixed header, ahead of the first frame. */
const WAL_HEADER_BYTES = 32;

/** Each frame's header, ahead of the page image it carries. */
const WAL_FRAME_HEADER_BYTES = 24;

/**
 * How many transactions have committed to this database.
 *
 * A WAL frame header carries the database size in pages *after* the commit for
 * the last frame of a transaction, and zero for every other frame, so counting
 * the non-zero ones counts commits. This is the only reading of "one
 * transaction, not four" available from outside the connection: `PRAGMA
 * data_version` says *that* another connection committed since this one last
 * looked, not how many times — three separate `putChunk` calls move it by one.
 *
 * @spec §5.7
 */
const committedTransactions = (): number => {
  const path = `${dbPath}-wal`;
  if (!existsSync(path)) return 0;
  const wal = readFileSync(path);
  if (wal.length < WAL_HEADER_BYTES) return 0;
  const frameBytes = WAL_FRAME_HEADER_BYTES + wal.readUInt32BE(8);
  let commits = 0;
  for (let at = WAL_HEADER_BYTES; at + frameBytes <= wal.length; at += frameBytes)
    if (wal.readUInt32BE(at + 4) !== 0) commits += 1;
  return commits;
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

describe('a document submission that cannot get the lock before the wait runs out', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = openGraphStore({ path: dbPath, busyTimeoutMs: IMPATIENT_TIMEOUT_MS });
  });

  afterEach(() => {
    store.close();
  });

  /** Two chunks, each with the extraction §5.10 defers for it. @spec §5.10, §9 */
  const contendedSubmission = (): ReturnType<typeof submissionOf> =>
    submissionOf([chunkAt(0, extractJob(0)), chunkAt(1, extractJob(1))]);

  it('refuses the submission under a name the store owns, rather than one the driver owns', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);

    const refusal = refusalFromWriting(() => {
      submitDocument(store, contendedSubmission());
    });

    expect((refusal as Error | undefined)?.name).toBe('StoreBusyError');
  });

  it('leaves no document row and no chunk, so nothing of the ingest survives the contention', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);
    const refusal = refusalFromWriting(() => {
      submitDocument(store, contendedSubmission());
    });

    await releaseWriteLock();

    expect({
      refusal: (refusal as Error | undefined)?.name,
      document: store.getDocument(DOCUMENT_ID),
      chunks: chunksOf(store, DOCUMENT_ID),
    }).toStrictEqual({ refusal: 'StoreBusyError', document: undefined, chunks: [] });
  });

  it('parks no job either, which is what keeps a stored chunk implying a parked extraction', async () => {
    await holdWriteLock(HOLD_PAST_TIMEOUT_MS);
    const refusal = refusalFromWriting(() => {
      submitDocument(store, contendedSubmission());
    });

    await releaseWriteLock();

    expect({
      refusal: (refusal as Error | undefined)?.name,
      job: store.claimJob(JOB_KIND),
    }).toStrictEqual({ refusal: 'StoreBusyError', job: undefined });
  });
});

describe('a document submission that fails on its last chunk', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = openGraphStore({ path: dbPath });
    submitDocument(
      store,
      submissionOf([chunkAt(0, null), chunkAt(1, null)], {
        id: NEIGHBOUR_ID,
        title: NEIGHBOUR_TITLE,
      }),
    );
  });

  afterEach(() => {
    store.close();
  });

  /**
   * Two chunks the table accepts and a third it does not.
   *
   * The measured defect's exact shape: the rows before the failure are the ones
   * that used to survive it, and there is no way to write this submission today
   * that does not commit them, because no port method spans the loop.
   *
   * @spec §3.6, §5.10
   */
  const doomedSubmission = (): ReturnType<typeof submissionOf> =>
    submissionOf([
      chunkAt(0, extractJob(0)),
      chunkAt(1, extractJob(1)),
      chunkAt(BAD_ORDINAL, extractJob(BAD_ORDINAL)),
    ]);

  it('writes no document row for the document it could not finish', () => {
    const refusal = refusalFromWriting(() => {
      submitDocument(store, doomedSubmission());
    });

    expect({
      refused: refusal !== undefined,
      document: store.getDocument(DOCUMENT_ID),
    }).toStrictEqual({ refused: true, document: undefined });
  });

  it('writes none of the chunks that came before the one it refused', () => {
    const refusal = refusalFromWriting(() => {
      submitDocument(store, doomedSubmission());
    });

    expect({ refused: refusal !== undefined, chunks: chunksOf(store, DOCUMENT_ID) }).toStrictEqual({
      refused: true,
      chunks: [],
    });
  });

  it('parks no job for the chunks it had already reached, so no chunk is stored with its extraction unqueued', () => {
    const refusal = refusalFromWriting(() => {
      submitDocument(store, doomedSubmission());
    });

    expect({ refused: refusal !== undefined, job: store.claimJob(JOB_KIND) }).toStrictEqual({
      refused: true,
      job: undefined,
    });
  });

  it('leaves a document it already held exactly as it was, chunk for chunk', () => {
    submitDocument(store, submissionOf([chunkAt(0, null), chunkAt(1, null)]));

    const refusal = refusalFromWriting(() => {
      submitDocument(
        store,
        submissionOf([
          { ...chunkAt(0, null), hash: revisedHashAt(0) },
          { ...chunkAt(1, null), hash: revisedHashAt(1) },
          chunkAt(BAD_ORDINAL, null),
        ]),
      );
    });

    expect({ refused: refusal !== undefined, chunks: chunksOf(store, DOCUMENT_ID) }).toStrictEqual({
      refused: true,
      chunks: [
        [0, hashAt(0)],
        [1, hashAt(1)],
      ],
    });
  });

  it('touches no other document on its way out', () => {
    refusalFromWriting(() => {
      submitDocument(store, doomedSubmission());
    });

    expect(chunksOf(store, NEIGHBOUR_ID)).toStrictEqual([
      [0, hashAt(0)],
      [1, hashAt(1)],
    ]);
  });
});

describe('a document submission whose lock comes back after someone else committed', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = openGraphStore({ path: dbPath, busyTimeoutMs: PATIENT_TIMEOUT_MS });
  });

  afterEach(() => {
    store.close();
  });

  /**
   * Takes the write lock in a second process and commits a change while this one
   * is still waiting for it.
   *
   * The discriminator for "the transaction body reads nothing before it writes",
   * measured rather than read off the source. A deferred transaction pins its
   * read snapshot at its first statement: if that is a read, the snapshot is
   * older than the holder's commit and the write that follows is refused
   * `SQLITE_BUSY_SNAPSHOT` *at once*, because `busy_timeout` cannot wait a stale
   * snapshot current. If it is a write, snapshot and write lock are taken
   * together, the busy handler covers the wait, and the submission lands.
   *
   * @spec §5.7, §11
   */
  const commitWriteLockAfter = async (holdMs: number): Promise<void> => {
    const worker = spawnWorker(committerPath, [dbPath, String(holdMs)]);
    holder = worker;
    if (!(await worker.ready))
      throw new Error(`the lock committer died: ${(await worker.done).stderr}`);
  };

  it('lands rather than being refused, because it took no snapshot the other commit could stale', async () => {
    await commitWriteLockAfter(BRIEF_HOLD_MS);

    const refusal = refusalFromWriting(() => {
      submitDocument(store, submissionOf([chunkAt(0, extractJob(0)), chunkAt(1, extractJob(1))]));
    });

    expect({
      refusal: (refusal as Error | undefined)?.name,
      chunks: chunksOf(store, DOCUMENT_ID),
    }).toStrictEqual({
      refusal: undefined,
      chunks: [
        [0, hashAt(0)],
        [1, hashAt(1)],
      ],
    });
  });

  it('waited for that lock rather than racing past it, so the landing is the busy handler doing its job', async () => {
    await commitWriteLockAfter(BRIEF_HOLD_MS);

    const startedAt = Date.now();
    submitDocument(store, submissionOf([chunkAt(0, extractJob(0))]));
    const waited = Date.now() - startedAt;

    expect(waited).toBeGreaterThanOrEqual(BRIEF_HOLD_MS - HOLD_TOLERANCE_MS);
  });
});

describe('a document submission that lands', () => {
  let store: GraphStore;
  let control: Database.Database;

  beforeEach(() => {
    store = openGraphStore({ path: dbPath });
    control = new Database(dbPath);
  });

  afterEach(() => {
    control.close();
    store.close();
  });

  /**
   * Starts recording every row deleted from `documents`, through a second
   * connection.
   *
   * Observation rather than fault injection, but the same instrument
   * `transaction-rollback.test.ts` uses and for the same reason: it is the only
   * way to reach a statement *inside* the store's transaction from outside it.
   *
   * @spec §3.6
   */
  const watchDocumentDeletions = (): void => {
    control.exec('CREATE TABLE probe_document_deletions (id TEXT NOT NULL)');
    control.exec(
      `CREATE TRIGGER probe_document_delete AFTER DELETE ON documents
         BEGIN INSERT INTO probe_document_deletions (id) VALUES (old.id); END`,
    );
  };

  /** Every document row deleted since the watch was installed, in the order they went. @spec §3.6 */
  const documentDeletions = (): string[] =>
    control
      .prepare('SELECT id FROM probe_document_deletions ORDER BY rowid')
      .all()
      .map((row) => (row as { id: string }).id);

  it('commits once, not once per row, so no reader can catch a document half-written', () => {
    const before = committedTransactions();

    submitDocument(
      store,
      submissionOf([chunkAt(0, extractJob(0)), chunkAt(1, extractJob(1)), chunkAt(2, extractJob(2))]),
    );

    expect(committedTransactions() - before).toBe(1);
  });

  it('still commits once at the size the defect was measured at, where the same rows written call by call commit seventeen times', () => {
    const paragraphs = [...Array(MEASURED_PARAGRAPHS).keys()];

    const beforeSubmission = committedTransactions();
    submitDocument(
      store,
      submissionOf(paragraphs.map((ordinal) => chunkAt(ordinal, extractJob(ordinal)))),
    );
    const submitted = committedTransactions() - beforeSubmission;

    // The same rows, through the port methods §5.10's ingest used before E6.
    // Not a claim about those methods — they are each their own transaction by
    // design — but the counter's own positive control: a measurement that reads
    // one for a single commit has to read more than one for many.
    const beforeCallByCall = committedTransactions();
    store.putDocument({
      id: NEIGHBOUR_ID,
      title: NEIGHBOUR_TITLE,
      origin: 'authored',
      contentRef: CONTENT,
      scope: null,
      createdAt: CREATED_AT,
    });
    for (const ordinal of paragraphs)
      store.putChunk({
        documentId: NEIGHBOUR_ID,
        ordinal,
        hash: hashAt(ordinal),
        embedding: unitVectorArray(ordinal + 1),
      });
    for (const ordinal of paragraphs) store.enqueueJob(extractJob(ordinal, NEIGHBOUR_ID));
    const callByCall = committedTransactions() - beforeCallByCall;

    expect({ submitted, callByCall }).toStrictEqual({
      submitted: 1,
      callByCall: 1 + MEASURED_PARAGRAPHS * 2,
    });
  });

  it('hands back the id of every job it parked, in submission order and for those chunks only', () => {
    const parked = submitDocument(
      store,
      submissionOf([chunkAt(0, extractJob(0)), chunkAt(1, null), chunkAt(2, extractJob(2))]),
    );

    expect(parked.map((id) => store.getJob(id)?.payload)).toStrictEqual([
      extractJob(0).payload,
      extractJob(2).payload,
    ]);
  });

  it('hands back nothing when no chunk named a job, as an unchanged or materialized document does not', () => {
    const parked = submitDocument(store, submissionOf([chunkAt(0, null), chunkAt(1, null)]));

    expect({ parked, job: store.claimJob(JOB_KIND) }).toStrictEqual({ parked: [], job: undefined });
  });

  it('is total: a submission naming fewer chunks than the document held leaves exactly the ones it named', () => {
    submitDocument(
      store,
      submissionOf([chunkAt(0, extractJob(0)), chunkAt(1, extractJob(1)), chunkAt(2, extractJob(2))]),
    );

    submitDocument(store, submissionOf([chunkAt(0, null)]));

    expect(chunksOf(store, DOCUMENT_ID)).toStrictEqual([[0, hashAt(0)]]);
  });

  it('drops those chunks without ever deleting the document row, so no reader finds the document missing', () => {
    submitDocument(
      store,
      submissionOf([chunkAt(0, extractJob(0)), chunkAt(1, extractJob(1)), chunkAt(2, extractJob(2))]),
    );
    watchDocumentDeletions();

    submitDocument(store, submissionOf([chunkAt(0, null)]));

    expect({
      deleted: documentDeletions(),
      document: store.getDocument(DOCUMENT_ID)?.id,
    }).toStrictEqual({ deleted: [], document: DOCUMENT_ID });
  });
});

describe('a document submission the store refuses before it writes anything', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = openGraphStore({ path: dbPath });
    submitDocument(store, submissionOf([chunkAt(0, null), chunkAt(1, null)]));
  });

  afterEach(() => {
    store.close();
  });

  /** What the document holds when a refusal has left it alone. @spec §3.6 */
  const UNTOUCHED = [
    [0, hashAt(0)],
    [1, hashAt(1)],
  ];

  it("refuses an origin that is neither of §5.10's two, since a third value satisfies neither arm", () => {
    const refusal = refusalFromWriting(() => {
      submitDocument(store, submissionOf([chunkAt(0, extractJob(0))], { origin: THIRD_ORIGIN }));
    });

    expect(refusal).toBeInstanceOf(UnknownDocumentOriginError);
  });

  it('and leaves the chunks that document already had, because the refusal comes before the first delete', () => {
    refusalFromWriting(() => {
      submitDocument(store, submissionOf([chunkAt(0, extractJob(0))], { origin: THIRD_ORIGIN }));
    });

    expect({ chunks: chunksOf(store, DOCUMENT_ID), job: store.claimJob(JOB_KIND) }).toStrictEqual({
      chunks: UNTOUCHED,
      job: undefined,
    });
  });

  it('refuses a chunk embedding that is not the stored width', () => {
    const refusal = refusalFromWriting(() => {
      submitDocument(
        store,
        submissionOf([
          { ...chunkAt(0, extractJob(0)), embedding: unitVectorArray(7, STORE_RERANK_WIDTH - 1) },
        ]),
      );
    });

    expect(refusal).toBeInstanceOf(DimensionMismatchError);
  });

  it('and leaves the chunks that document already had, rather than the narrower document it was offered', () => {
    refusalFromWriting(() => {
      submitDocument(
        store,
        submissionOf([
          { ...chunkAt(0, extractJob(0)), embedding: unitVectorArray(7, STORE_RERANK_WIDTH - 1) },
        ]),
      );
    });

    expect({ chunks: chunksOf(store, DOCUMENT_ID), job: store.claimJob(JOB_KIND) }).toStrictEqual({
      chunks: UNTOUCHED,
      job: undefined,
    });
  });

  it('refuses two chunks at one ordinal rather than letting the second silently replace the first', () => {
    const refusal = refusalFromWriting(() => {
      submitDocument(
        store,
        submissionOf([
          { ...chunkAt(0, extractJob(0)), hash: revisedHashAt(0) },
          { ...chunkAt(0, extractJob(0)), hash: revisedHashAt(1) },
        ]),
      );
    });

    expect({
      refused: refusal !== undefined,
      chunks: chunksOf(store, DOCUMENT_ID),
      job: store.claimJob(JOB_KIND),
    }).toStrictEqual({ refused: true, chunks: UNTOUCHED, job: undefined });
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
