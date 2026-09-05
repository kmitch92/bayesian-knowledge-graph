/**
 * The jobs queue: §9's deferred work, and the surface that finally writes to it.
 *
 * `jobs` has been in migration 0 since it was written and has never had a
 * writer. Plan §7 is explicit about why the table was there first — *"a table
 * that exists from migration 0 is a feature that slots in rather than one that
 * bolts on"* — and E1b is where it stops being a seam.
 *
 * Two sections of the spec meet on this table.
 *
 * **§5.9 makes capture enqueue-only.** *"PostToolUse hooks append the event to
 * the episode log and return immediately; adjudication and reflection run on the
 * daemon, off the agent's critical path."* An enqueue that adjudicated inline
 * would be the thing that rule exists to forbid, so what the store owes the
 * capture path is a write that finishes and a row that survives it.
 *
 * **§5.10 makes extraction lazy.** *"Ingest is cheap: chunk, embed, anchor —
 * the document serves whole immediately. Extraction is lazy: a 3,000-word ADR
 * never pays forty inline adjudications."* E1a built the cheap half. This is
 * where the expensive half is *parked*: `submitText` chunks, embeds, anchors and
 * enqueues, and `kgmem reflect` drains.
 *
 * ── The property that carries the rest ──────────────────────────────────────
 *
 * **A claim is atomic.** Two drains must never take one job. §5.7 already makes
 * this argument about posteriors — *"atomic increments in the database, never
 * read-modify-write"*, since *"two agents updating the same claim concurrently
 * must not drop evidence"* — and the plan puts several processes on one SQLite
 * file by construction: an MCP server per session, git hooks shelling out to the
 * same binary, `kgmem jobs run` under cron. A `SELECT ... LIMIT 1` followed by an
 * `UPDATE` is the same lost-update shape with the sign flipped: instead of
 * dropping a contribution it duplicates a unit of work, so one chunk is
 * extracted twice, and §5.10's *"a document is one episode"* episode cap is
 * applied twice to what was one source.
 *
 * That claim cannot be tested here, and this file does not pretend otherwise.
 * better-sqlite3 is synchronous, so a single Node process serializes every call
 * it makes and a read-then-write claim passes any in-process test comfortably —
 * exactly the reasoning `multi-process-increments.test.ts` gives for spawning
 * real processes. `job-claim-race.test.ts` is where the atomicity is actually
 * decided. What *is* pinned here is the part a single process can decide: that a
 * claimed job is not offered again, that a claim scopes to a kind, that a
 * schedule is a not-before, that a failure is counted and explained, and that a
 * job a failure parked has exactly one way back.
 *
 * Real SQLite, `:memory:`, no mocks — as every store test here does.
 *
 * @spec §5.7, §5.9, §5.10, §9, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  JobNotRequeueableError,
  openGraphStore,
  UnknownJobError,
  type GraphStore,
  type Job,
  type JobSubmission,
} from '../index';

/** §5.10's lazy half: one chunk to mine for member claims. @spec §5.10 */
const EXTRACT = 'extract';

/** §8.2's consolidator, one of §9's other clocks — queued here only to be left alone. @spec §8.2, §9 */
const CONSOLIDATE = 'consolidate';

/**
 * The payload an extraction job carries: which chunk of which document.
 *
 * Nested on purpose. The store persists this blob without reading a field of it,
 * so a layer that quietly flattened or re-keyed it would still pass an
 * assertion written against a flat object — the argument the `LOCATOR` fixture
 * makes one table over.
 *
 * @spec §5.10
 */
const EXTRACT_PAYLOAD = {
  documentId: 'DOC-ADR-0007',
  chunk: { ordinal: 3, hash: 'sha256:1f0a9c4d2b6e8f3a' },
  gate: { verbatim: true },
} as const;

/** An instant already past, so a job scheduled at it is due the moment it lands. @spec §9 */
const DUE_LONG_AGO = '2020-01-01T00:00:00.000Z';

/** A second past instant, later than {@link DUE_LONG_AGO}, for schedule ordering. @spec §9 */
const DUE_LATER = '2020-06-01T00:00:00.000Z';

/** A third, later still. @spec §9 */
const DUE_LATEST = '2020-12-01T00:00:00.000Z';

/**
 * An instant no test run reaches.
 *
 * A literal rather than `Date.now() + n`, so the assertion is about the store's
 * comparison and not about how long the suite took to get here.
 *
 * @spec §9
 */
const NOT_YET_DUE = '2099-01-01T00:00:00.000Z';

/** Why an extraction attempt died, as a drain would report it. @spec §9, §12 */
const FIRST_FAILURE = 'extractor timed out after 30s';

/** A second, different reason, so "records the latest" is distinguishable from "records the first". @spec §9 */
const SECOND_FAILURE = 'extractor returned malformed JSON';

/** A job id nothing ever minted. Above any autoincrement this suite reaches. @spec §9 */
const UNMINTED_JOB_ID = 987_654;

let store: GraphStore;

/** What a claim did: whether it raised, and what it handed back if it did not. @spec §9 */
interface ClaimOutcome {
  readonly threw: boolean;
  readonly job: Job | undefined;
}

/**
 * Enqueues one job, defaulting to an extraction of {@link EXTRACT_PAYLOAD}.
 *
 * Returns the id, because the id is what a caller has afterwards. A chunk is
 * identified by its content — document, ordinal, hash — and E1a deliberately
 * kept the autoincrement key off `DocumentChunk` for that reason. A job has no
 * such identity: two `extract` jobs naming one chunk are two units of work,
 * legitimately, and the row is the only thing that tells them apart. So the row
 * id *is* the job's identity here, and handing it back is not leaking storage.
 *
 * @spec §9
 */
const enqueue = (overrides: Partial<JobSubmission> = {}): number =>
  store.enqueueJob({ kind: EXTRACT, payload: EXTRACT_PAYLOAD, ...overrides });

/**
 * Claims one job, reporting whether the call raised rather than letting it
 * escape.
 *
 * The empty-queue case is *"answers with nothing"*, and `expect(...).toBeUndefined()`
 * cannot tell that from a method that does not exist: in a red run the call
 * throws a `TypeError` and the assertion never runs. Reporting the raise is what
 * separates the two — the same argument `refusalFrom` makes in
 * `pathway-signature.test.ts` and `document-store.test.ts`, in the direction
 * where the expected answer is *not* a refusal.
 *
 * @spec §9
 */
const claimOutcome = (kind: string = EXTRACT): ClaimOutcome => {
  try {
    return { threw: false, job: store.claimJob(kind) };
  } catch {
    return { threw: true, job: undefined };
  }
};

/** The job a claim handed back, or `undefined`. Raises rather than reporting, for the assertions that want the job. @spec §9 */
const claim = (kind: string = EXTRACT): Job | undefined => store.claimJob(kind);

/**
 * The refusal a write produced, or `undefined` if it did not refuse.
 *
 * Returned rather than matched with `toThrow`, for the reason the pathway,
 * regime and document suites give: *"a store that refuses for an unrelated
 * reason satisfies `toThrow` just as well and never shows which rule did the
 * refusing"*. In a red run that is not hypothetical — every method under test is
 * missing, so every call throws a `TypeError`.
 *
 * @spec §9
 */
const refusalFrom = (write: () => void): unknown => {
  try {
    write();
    return undefined;
  } catch (error) {
    return error;
  }
};

/** Whether a stamped column holds an instant, rather than any non-null placeholder. @spec §9 */
const isInstant = (value: string | null | undefined): boolean =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('a job round-trips through the queue', () => {
  it('hands back an id that resolves to the job that was enqueued', () => {
    const id = enqueue();

    expect(store.getJob(id)).toMatchObject({ id, kind: EXTRACT, payload: EXTRACT_PAYLOAD });
  });

  it('mints a second id for an identical job, since two extractions are two units of work', () => {
    const first = enqueue();
    const second = enqueue();

    expect(second).not.toBe(first);
  });

  it('answers undefined for a job id nothing enqueued', () => {
    expect(store.getJob(UNMINTED_JOB_ID)).toBeUndefined();
  });

  it('starts a job pending, unstarted, unfinished, with no attempt behind it and no error', () => {
    const id = enqueue();

    expect(store.getJob(id)).toMatchObject({
      state: 'pending',
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      lastError: null,
    });
  });

  it('keeps the instant the job was scheduled for', () => {
    const id = enqueue({ scheduledAt: DUE_LATER });

    expect(store.getJob(id)?.scheduledAt).toBe(DUE_LATER);
  });

  it('keeps two jobs of different kinds apart', () => {
    const extraction = enqueue();
    const consolidation = enqueue({ kind: CONSOLIDATE });

    expect([store.getJob(extraction)?.kind, store.getJob(consolidation)?.kind]).toStrictEqual([
      EXTRACT,
      CONSOLIDATE,
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The payload, which is the whole of what a drain is told.
 * ---------------------------------------------------------------------------
 *
 * `payload` is `TEXT NOT NULL DEFAULT '{}'` and the store reads nothing inside
 * it. That makes it the same kind of column as `entities.locator` and
 * `stage_log.inputs`: opaque bytes the store keeps whole, and the assertions are
 * about keeping rather than about interpreting.
 */

describe('the payload a job carries', () => {
  it('round-trips a nested payload without flattening it', () => {
    const id = enqueue();

    expect(store.getJob(id)?.payload).toStrictEqual(EXTRACT_PAYLOAD);
  });

  it('round-trips an array payload, since JSON is not only objects', () => {
    const id = enqueue({ payload: ['DOC-ADR-0007', 3] });

    expect(store.getJob(id)?.payload).toStrictEqual(['DOC-ADR-0007', 3]);
  });

  it('gives a job with nothing to say the empty object the column already declares', () => {
    const id = store.enqueueJob({ kind: CONSOLIDATE });

    expect(store.getJob(id)?.payload).toStrictEqual({});
  });

  it('keeps a JSON null payload apart from a payload that was never given', () => {
    const absent = store.enqueueJob({ kind: EXTRACT });
    const explicit = store.enqueueJob({ kind: EXTRACT, payload: null });

    expect([store.getJob(absent)?.payload, store.getJob(explicit)?.payload]).toStrictEqual([
      {},
      null,
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Claiming.
 * ---------------------------------------------------------------------------
 *
 * The single-process half of §5.7's argument. None of these would catch a
 * read-then-write claim — one process cannot race itself through a synchronous
 * driver — but each catches a claim that forgot to write anything down, which is
 * the same bug with the contention removed.
 */

describe('claiming a job off the queue', () => {
  it('hands the drain the job that was waiting', () => {
    const id = enqueue();

    expect(claim()).toMatchObject({ id, kind: EXTRACT, payload: EXTRACT_PAYLOAD });
  });

  it('marks the claimed job running and stamps when it started', () => {
    const id = enqueue();

    claim();

    const job = store.getJob(id);
    expect({ state: job?.state, started: isInstant(job?.startedAt) }).toStrictEqual({
      state: 'running',
      started: true,
    });
  });

  it('does not hand one job to a second drain', () => {
    enqueue();
    claim();

    expect(claimOutcome()).toStrictEqual({ threw: false, job: undefined });
  });

  it('hands out two different jobs rather than the same one twice', () => {
    enqueue();
    enqueue();

    const first = claim();
    const second = claim();

    expect({
      handedOut: [first, second].filter((job) => job !== undefined).length,
      same: first?.id === second?.id,
    }).toStrictEqual({ handedOut: 2, same: false });
  });

  it('gives each of two queued jobs to exactly one claim', () => {
    const first = enqueue();
    const second = enqueue();

    expect([claim()?.id, claim()?.id]).toStrictEqual([first, second]);
  });

  it('answers with nothing rather than raising when the queue is empty', () => {
    expect(claimOutcome()).toStrictEqual({ threw: false, job: undefined });
  });

  it('answers with nothing rather than raising when every job is already claimed', () => {
    enqueue();
    claim();

    expect(claimOutcome()).toStrictEqual({ threw: false, job: undefined });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The kind, which scopes a drain.
 * ---------------------------------------------------------------------------
 *
 * §9 hangs several clocks off one table: consolidation, re-clustering,
 * re-verification sampling and churn decay, with §5.10's extraction now beside
 * them. They are drained by different callers on different schedules — `kgmem
 * reflect` mines documents, `kgmem jobs run` sweeps TTLs — and a drain that took
 * whatever was at the head of the queue would run the consolidator inside a
 * reflection and the extractor inside a cron sweep.
 *
 * The vocabulary is deliberately *not* closed. Kinds arrive with features (§7's
 * deferred seams name several that do not exist yet), and a CHECK on `kind`
 * would make each of them a migration.
 */

describe('the kind a drain asks for', () => {
  it('never hands a drain a job of another kind', () => {
    enqueue({ kind: CONSOLIDATE });

    expect(claimOutcome(EXTRACT)).toStrictEqual({ threw: false, job: undefined });
  });

  it('leaves the job of another kind pending and unstarted', () => {
    const id = enqueue({ kind: CONSOLIDATE });

    claim(EXTRACT);

    expect(store.getJob(id)).toMatchObject({ state: 'pending', startedAt: null });
  });

  it('reaches past a job of another kind queued ahead of it', () => {
    enqueue({ kind: CONSOLIDATE, scheduledAt: DUE_LONG_AGO });
    const extraction = enqueue({ kind: EXTRACT, scheduledAt: DUE_LATEST });

    expect(claim(EXTRACT)?.id).toBe(extraction);
  });

  it('lets each kind be drained by its own caller', () => {
    const extraction = enqueue({ kind: EXTRACT });
    const consolidation = enqueue({ kind: CONSOLIDATE });

    expect([claim(EXTRACT)?.id, claim(CONSOLIDATE)?.id]).toStrictEqual([extraction, consolidation]);
  });

  it('takes no job for a kind nothing ever enqueued', () => {
    enqueue();

    expect(claimOutcome('recluster')).toStrictEqual({ threw: false, job: undefined });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The schedule, which is a not-before and not a priority.
 * ---------------------------------------------------------------------------
 *
 * `scheduled_at` is read here as the instant a job becomes claimable, and the
 * reading is what makes two things expressible that §9 needs.
 *
 * The first is the calendar clock itself. §9's consolidation and re-verification
 * arrive as *"deferred work on the write path"*, and the plan runs them as
 * `kgmem jobs run` under cron — a nightly consolidation enqueued at 18:00 and
 * run by the 18:05 sweep is not a nightly consolidation. The second is retry
 * backoff: a job handed back to the queue with an instant in the future is the
 * only way a drain loop does not immediately re-take the job that just killed
 * it, and the failure section below leans on it.
 *
 * The index migration 0 already built — `(state, scheduled_at)` — is the index
 * exactly this reading wants, which is some evidence the column was meant this
 * way when it was written.
 *
 * Ordering *among* due jobs is pinned too, since a queue that ran its work in an
 * arbitrary order would make a schedule advisory.
 */

describe('the schedule a job was queued under', () => {
  it('claims the job scheduled first, whatever order they were enqueued in', () => {
    enqueue({ scheduledAt: DUE_LATEST });
    const earliest = enqueue({ scheduledAt: DUE_LONG_AGO });

    expect(claim()?.id).toBe(earliest);
  });

  it('drains due jobs in schedule order across successive claims', () => {
    const latest = enqueue({ scheduledAt: DUE_LATEST });
    const earliest = enqueue({ scheduledAt: DUE_LONG_AGO });
    const middle = enqueue({ scheduledAt: DUE_LATER });

    expect([claim()?.id, claim()?.id, claim()?.id]).toStrictEqual([earliest, middle, latest]);
  });

  it('holds a job scheduled for the future rather than running it early', () => {
    enqueue({ scheduledAt: NOT_YET_DUE });

    expect(claimOutcome()).toStrictEqual({ threw: false, job: undefined });
  });

  it('leaves the job it held pending and unstarted', () => {
    const id = enqueue({ scheduledAt: NOT_YET_DUE });

    claim();

    expect(store.getJob(id)).toMatchObject({ state: 'pending', startedAt: null });
  });

  it('passes over a job that is not due yet to take one that is', () => {
    enqueue({ scheduledAt: NOT_YET_DUE });
    const due = enqueue({ scheduledAt: DUE_LATEST });

    expect(claim()?.id).toBe(due);
  });

  it('drains jobs queued with no schedule in the order they were enqueued', () => {
    const first = enqueue();
    const second = enqueue();
    const third = enqueue();

    expect([claim()?.id, claim()?.id, claim()?.id]).toStrictEqual([first, second, third]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Finishing.
 * ---------------------------------------------------------------------------
 */

describe('completing a job a drain has finished', () => {
  it('marks it done and stamps when it finished', () => {
    const id = enqueue();
    claim();

    store.completeJob(id);

    const job = store.getJob(id);
    expect({ state: job?.state, finished: isInstant(job?.finishedAt) }).toStrictEqual({
      state: 'done',
      finished: true,
    });
  });

  it('does not offer a completed job to another drain', () => {
    const id = enqueue();
    claim();

    store.completeJob(id);

    expect(claimOutcome()).toStrictEqual({ threw: false, job: undefined });
  });

  it('leaves a job that succeeded first time carrying no attempt and no error', () => {
    const id = enqueue();
    claim();

    store.completeJob(id);

    expect(store.getJob(id)).toMatchObject({ attempts: 0, lastError: null });
  });

  /*
   * Not silent, where `deleteDocument` and `deleteContainment` are. Those are
   * asked to make a row absent and the row is already absent, so the caller's
   * request is satisfied. This is a *report about work*: a drain saying "job 7
   * finished" when there is no job 7 has reported into nothing, and swallowing
   * it means a drain whose row vanished — a crash and restart holding a stale
   * id, a sweep that collected the row — never accumulates an attempt, never
   * records an error, and looks from the outside like a queue that is working.
   */
  it('refuses to complete a job nothing enqueued, rather than reporting into a void', () => {
    const refusal = refusalFrom(() => {
      store.completeJob(UNMINTED_JOB_ID);
    });

    expect({ refused: refusal !== undefined, job: store.getJob(UNMINTED_JOB_ID) }).toStrictEqual({
      refused: true,
      job: undefined,
    });
  });

  it('names the job that did not resolve rather than failing unexplained', () => {
    const refusal = refusalFrom(() => {
      store.completeJob(UNMINTED_JOB_ID);
    });

    expect(refusal).toBeInstanceOf(UnknownJobError);
    expect((refusal as UnknownJobError).jobId).toBe(UNMINTED_JOB_ID);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Failing, counting, and coming back.
 * ---------------------------------------------------------------------------
 *
 * `attempts` and `last_error` are the two columns migration 0 put here for this,
 * and between them they answer the operator's question — how many times has this
 * been tried, and what went wrong the last time.
 *
 * Whether a failed job comes back is the *caller's* decision and not the
 * store's. A backoff schedule is a ⚙ constant (§15), tuned offline against logs
 * (§5.8) rather than hard-coded in a persistence layer, and the two automatic
 * readings are both wrong on their own: a failure that always requeues turns a
 * poison job into a drain that spins on it forever, and a failure that never
 * requeues loses every job that hit a transient timeout. So the caller says when
 * — or says nothing, and the job parks.
 */

describe('failing a job', () => {
  it('counts the attempt and records what went wrong', () => {
    const id = enqueue();
    claim();

    store.failJob({ id, error: FIRST_FAILURE });

    expect(store.getJob(id)).toMatchObject({ attempts: 1, lastError: FIRST_FAILURE });
  });

  it('counts a second attempt on top of the first', () => {
    const id = enqueue();
    claim();
    store.failJob({ id, error: FIRST_FAILURE, retryAt: DUE_LONG_AGO });
    claim();

    store.failJob({ id, error: SECOND_FAILURE, retryAt: DUE_LONG_AGO });

    expect(store.getJob(id)?.attempts).toBe(2);
  });

  it('records the reason the latest attempt died, not the first', () => {
    const id = enqueue();
    claim();
    store.failJob({ id, error: FIRST_FAILURE, retryAt: DUE_LONG_AGO });
    claim();

    store.failJob({ id, error: SECOND_FAILURE, retryAt: DUE_LONG_AGO });

    expect(store.getJob(id)?.lastError).toBe(SECOND_FAILURE);
  });

  it('hands the job back to the queue when the caller names an instant already past', () => {
    const id = enqueue();
    claim();

    store.failJob({ id, error: FIRST_FAILURE, retryAt: DUE_LONG_AGO });

    expect(claim()?.id).toBe(id);
  });

  it('gives the retried job back with the attempt behind it still counted', () => {
    const id = enqueue();
    claim();
    store.failJob({ id, error: FIRST_FAILURE, retryAt: DUE_LONG_AGO });

    expect(claim()?.attempts).toBe(1);
  });

  it('keeps the previous error on a retried job, so an operator sees why it came back', () => {
    const id = enqueue();
    claim();
    store.failJob({ id, error: FIRST_FAILURE, retryAt: DUE_LONG_AGO });

    expect(claim()?.lastError).toBe(FIRST_FAILURE);
  });

  it('holds a retry until the instant the caller named', () => {
    const id = enqueue();
    claim();

    store.failJob({ id, error: FIRST_FAILURE, retryAt: NOT_YET_DUE });

    expect(claimOutcome()).toStrictEqual({ threw: false, job: undefined });
  });

  it('parks a job the caller gave no retry instant, rather than spinning a drain on it', () => {
    const id = enqueue();
    claim();

    store.failJob({ id, error: FIRST_FAILURE });

    expect({ state: store.getJob(id)?.state, next: claimOutcome() }).toStrictEqual({
      state: 'failed',
      next: { threw: false, job: undefined },
    });
  });

  it('keeps a parked job readable, since a failure nobody can read is a failure nobody fixes', () => {
    const id = enqueue();
    claim();

    store.failJob({ id, error: FIRST_FAILURE });

    expect(store.getJob(id)).toMatchObject({
      kind: EXTRACT,
      payload: EXTRACT_PAYLOAD,
      attempts: 1,
      lastError: FIRST_FAILURE,
    });
  });

  it('refuses to fail a job nothing enqueued, for the reason completing one is refused', () => {
    const refusal = refusalFrom(() => {
      store.failJob({ id: UNMINTED_JOB_ID, error: FIRST_FAILURE });
    });

    expect({ refused: refusal !== undefined, job: store.getJob(UNMINTED_JOB_ID) }).toStrictEqual({
      refused: true,
      job: undefined,
    });
  });

  it('names the job that did not resolve', () => {
    const refusal = refusalFrom(() => {
      store.failJob({ id: UNMINTED_JOB_ID, error: FIRST_FAILURE });
    });

    expect(refusal).toBeInstanceOf(UnknownJobError);
    expect((refusal as UnknownJobError).jobId).toBe(UNMINTED_JOB_ID);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The way back off `failed`.
 * ---------------------------------------------------------------------------
 *
 * Everything above makes `failed` terminal. `failJob` with no `retryAt` parks a
 * job there and `claimJob` selects `state = 'pending'` and nothing else, so a
 * parked job is readable, countable, and permanently unworkable. That was
 * survivable while the only thing parking jobs was an unretryable *fact* — a
 * document that does not exist, a materialized one §5.10 forbids mining, a
 * payload no drain can read — because retrying none of those could change the
 * answer.
 *
 * It stops being survivable the moment a caller caps its retries. A cap turns a
 * five-minute outage at somebody else's API into permanent work loss, and the
 * extraction drain's own `handBack` docblock says so in as many words: a cap
 * *"needs a public requeue beside it"*. This is that requeue, and it is the half
 * that makes the other half affordable.
 *
 * ── Four rulings, and what each is weighed against ──────────────────────────
 *
 * **`attempts` is preserved, never reset.** The counter is the diagnosis. An
 * operator requeueing a job wants to keep seeing that it died twenty times, and
 * a requeue that zeroed it would hand the caller a fresh budget every time —
 * which is a cap that cannot be reached by anything an operator is willing to
 * retry, i.e. no cap at all.
 *
 * **`scheduled_at` is cleared to NULL.** `failJob`'s parking arm *"leaves
 * `scheduled_at` alone"* on purpose, so a job parked at a cap still carries the
 * not-before its last backoff wrote — an instant in the future. A requeue that
 * moved `state` alone would answer the operator with a job that is `pending`,
 * satisfies every assertion about state, and is still not claimable. NULL rather
 * than a `now()` stamp because NULL is what the column already means by "no
 * not-before": `claimJob` reads `scheduled_at IS NULL OR scheduled_at <= ?`, so
 * NULL is due under any clock, and stamping an instant would invent a schedule
 * nobody set.
 *
 * **`done` and `running` are refused, by type.** Not silence, for the reason
 * {@link UnknownJobError} is not silence: `deleteDocument` is quiet because the
 * caller asked for a row to be absent and it is absent, so the request is
 * satisfied — where a requeue that quietly did nothing leaves the operator
 * believing work resumed when it did not. And not a requeue either. A `done`
 * job's output is already in the ledger and §9 *"does not deduplicate: a second
 * identical submission is a second job"*, so redoing finished work already has a
 * supported spelling — `enqueueJob` — that costs no `finished_at` record. A
 * `running` job is worse: there is no lease, no heartbeat and no reaper here
 * (this file's own note 3), so the store cannot tell a wedged drain from a live
 * one, and flipping a live drain's row back to `pending` hands one unit of work
 * to two drains — the single property §5.7 and `job-claim-race.test.ts` exist to
 * defend. A reaper reading `started_at` against a lease is the right tool for an
 * orphan, and requeue must not be a backdoor one.
 *
 * **An id nothing minted is refused with {@link UnknownJobError}**, exactly as
 * `completeJob` and `failJob` refuse one. An operator typing a job id at a
 * recovery tool and getting silence has been told the queue is working.
 *
 * Nothing here asserts where a requeued job lands *among other due jobs*: that
 * is the NULL-versus-instant race note 1 below leaves open, and pinning it here
 * would settle it sideways.
 */

describe('requeueing a job that was parked', () => {
  /**
   * A job parked behind a not-before that has not arrived yet.
   *
   * The sequence a capped drain actually produces — back off, back off, give up
   * — and the only arrangement that can tell a requeue which moves `state` from
   * one which also makes the job *due*. `failJob`'s parking arm leaves
   * `scheduled_at` exactly as the last backoff wrote it.
   *
   * @spec §9
   */
  const parkBehindAStaleInstant = (): number => {
    const id = enqueue();
    claim();
    store.failJob({ id, error: FIRST_FAILURE, retryAt: NOT_YET_DUE });
    store.failJob({ id, error: SECOND_FAILURE });
    return id;
  };

  /** A job parked the ordinary way: claimed, failed with no retry instant. @spec §9 */
  const park = (): number => {
    const id = enqueue();
    claim();
    store.failJob({ id, error: FIRST_FAILURE });
    return id;
  };

  it('returns a parked job to pending', () => {
    const id = park();

    store.requeueJob(id);

    expect(store.getJob(id)?.state).toBe('pending');
  });

  it('lets a drain take it again, which is the whole point of the call', () => {
    const id = park();
    const before = claimOutcome();

    store.requeueJob(id);

    expect({ before, after: claim()?.id }).toStrictEqual({
      before: { threw: false, job: undefined },
      after: id,
    });
  });

  it('keeps the attempts behind it, because the count is the diagnosis', () => {
    const id = enqueue();
    claim();
    store.failJob({ id, error: FIRST_FAILURE, retryAt: DUE_LONG_AGO });
    claim();
    store.failJob({ id, error: SECOND_FAILURE });

    store.requeueJob(id);

    expect(store.getJob(id)?.attempts).toBe(2);
  });

  it('keeps the kind, the payload and the reason the last attempt died', () => {
    const id = park();

    store.requeueJob(id);

    expect(store.getJob(id)).toMatchObject({
      kind: EXTRACT,
      payload: EXTRACT_PAYLOAD,
      lastError: FIRST_FAILURE,
    });
  });

  it('hands the requeued job back to the drain with its history intact', () => {
    const id = enqueue();
    claim();
    store.failJob({ id, error: FIRST_FAILURE, retryAt: DUE_LONG_AGO });
    claim();
    store.failJob({ id, error: SECOND_FAILURE });

    store.requeueJob(id);

    expect(claim()).toMatchObject({ id, attempts: 2, lastError: SECOND_FAILURE });
  });

  it('clears the not-before, rather than leaving one for a drain to wait on', () => {
    const id = parkBehindAStaleInstant();

    store.requeueJob(id);

    expect(store.getJob(id)?.scheduledAt).toBeNull();
  });

  it('makes it claimable at once, past the stale instant the parking failure left behind', () => {
    const id = parkBehindAStaleInstant();
    const before = claimOutcome();

    store.requeueJob(id);

    expect({ before, after: claim()?.id }).toStrictEqual({
      before: { threw: false, job: undefined },
      after: id,
    });
  });

  /**
   * Clearing the not-before is only "due at once" if the claim agrees.
   *
   * The two assertions above read the requeued job's own row and then take it off
   * an otherwise empty queue, which a requeue that merely made the job *eventually*
   * claimable would satisfy just as well. What `scheduled_at = NULL` actually buys
   * is a position: SQL NULL sorts below every instant, so a requeued job is due
   * before work that carries a concrete due instant, rather than queueing behind
   * it. That is the difference between a recovery call and a call that puts the
   * job back at the end of the line.
   *
   * The parked job is enqueued *second* on purpose, so it holds the higher id. A
   * claim that named no order at all would hand back the lower id first and fail
   * here, which is what stops this passing on rowid order by coincidence — and
   * nothing is claimed before the assertion, so the fixture does not lean on the
   * ordering it is testing.
   *
   * @spec §9, §12
   */
  it('brings it back ahead of work that is merely due, since a cleared not-before outranks an instant', () => {
    const merelyDue = enqueue({ scheduledAt: DUE_LONG_AGO });
    const parked = enqueue({ scheduledAt: NOT_YET_DUE });
    store.failJob({ id: parked, error: FIRST_FAILURE });

    store.requeueJob(parked);

    expect([claim()?.id, claim()?.id]).toStrictEqual([parked, merelyDue]);
  });

  it('returns the job to the ordinary lifecycle, all the way to done', () => {
    const id = park();

    store.requeueJob(id);
    const retaken = claim();
    store.completeJob(id);

    const job = store.getJob(id);
    expect({
      retaken: retaken?.id,
      state: job?.state,
      finished: isInstant(job?.finishedAt),
      attempts: job?.attempts,
    }).toStrictEqual({ retaken: id, state: 'done', finished: true, attempts: 1 });
  });

  it('makes a pending job that is not due yet due at once, which is an operator saying "now"', () => {
    const id = enqueue({ scheduledAt: NOT_YET_DUE });
    const before = claimOutcome();

    store.requeueJob(id);

    expect({ before, after: claim()?.id, attempts: store.getJob(id)?.attempts }).toStrictEqual({
      before: { threw: false, job: undefined },
      after: id,
      attempts: 0,
    });
  });

  it('leaves every other parked job exactly where it was', () => {
    const requeued = park();
    const untouched = park();

    store.requeueJob(requeued);

    expect({
      requeuedState: store.getJob(requeued)?.state,
      untouchedState: store.getJob(untouched)?.state,
      claimed: [claim()?.id, claim()?.id],
    }).toStrictEqual({
      requeuedState: 'pending',
      untouchedState: 'failed',
      claimed: [requeued, undefined],
    });
  });

  /*
   * The two states a requeue must not touch, and the refusal is by class in both
   * cases — a boolean or a silent no-op would be indistinguishable from success
   * at the recovery tool this call exists to be.
   */

  it('refuses a job the drain has finished, since redoing finished work is what a fresh job is for', () => {
    const id = enqueue();
    claim();
    store.completeJob(id);

    const refusal = refusalFrom(() => {
      store.requeueJob(id);
    });

    expect({
      refusal: refusal instanceof JobNotRequeueableError,
      state: store.getJob(id)?.state,
      claimable: claimOutcome(),
    }).toStrictEqual({
      refusal: true,
      state: 'done',
      claimable: { threw: false, job: undefined },
    });
  });

  it('names the finished job and the state it refused', () => {
    const id = enqueue();
    claim();
    store.completeJob(id);

    const refusal = refusalFrom(() => {
      store.requeueJob(id);
    });

    expect(refusal).toBeInstanceOf(JobNotRequeueableError);
    expect({
      jobId: (refusal as JobNotRequeueableError).jobId,
      state: (refusal as JobNotRequeueableError).state,
    }).toStrictEqual({ jobId: id, state: 'done' });
  });

  it('refuses a job a drain is still holding, rather than giving one unit of work to two drains', () => {
    const id = enqueue();
    claim();

    const refusal = refusalFrom(() => {
      store.requeueJob(id);
    });

    expect({
      refusal: refusal instanceof JobNotRequeueableError,
      state: store.getJob(id)?.state,
      claimable: claimOutcome(),
    }).toStrictEqual({
      refusal: true,
      state: 'running',
      claimable: { threw: false, job: undefined },
    });
  });

  it('names the running job and the state it refused', () => {
    const id = enqueue();
    claim();

    const refusal = refusalFrom(() => {
      store.requeueJob(id);
    });

    expect(refusal).toBeInstanceOf(JobNotRequeueableError);
    expect({
      jobId: (refusal as JobNotRequeueableError).jobId,
      state: (refusal as JobNotRequeueableError).state,
    }).toStrictEqual({ jobId: id, state: 'running' });
  });

  /*
   * The class is named inside the object rather than left to a bare "it
   * refused", because in a red run every call here raises a `TypeError` for a
   * missing method and `refusal !== undefined` is satisfied by that — a refusal
   * test that passes while nothing exists is a refusal test that has measured
   * nothing.
   */
  it('refuses an id nothing enqueued, for the reason completing one is refused', () => {
    const refusal = refusalFrom(() => {
      store.requeueJob(UNMINTED_JOB_ID);
    });

    expect({
      refused: refusal instanceof UnknownJobError,
      job: store.getJob(UNMINTED_JOB_ID),
    }).toStrictEqual({ refused: true, job: undefined });
  });

  it('names the job that did not resolve, and does not call it unrequeueable', () => {
    const refusal = refusalFrom(() => {
      store.requeueJob(UNMINTED_JOB_ID);
    });

    expect(refusal).toBeInstanceOf(UnknownJobError);
    expect((refusal as UnknownJobError).jobId).toBe(UNMINTED_JOB_ID);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The schedule order, on a file whose planner has changed its mind.
 * ---------------------------------------------------------------------------
 *
 * Every assertion above is satisfied by a claim that names no order at all, and
 * that was measured rather than assumed: with the `ORDER BY scheduled_at, id`
 * struck out of the claim, all of this cycle's assertions still pass, in this
 * file and in the three-process race fixture alike.
 *
 * They pass because migration 0 carries `idx_jobs_queue ON jobs (state,
 * scheduled_at)`, and while SQLite drives the claim's subquery through that
 * index the rows arrive in schedule order whether or not anything asked for it.
 * Which makes the schedule look like a property of the index — and an index is
 * an optimization, chosen per statement by a planner that is free to choose
 * differently.
 *
 * `ANALYZE` is what makes it choose differently, and it is ordinary maintenance
 * rather than an exotic event: SQLite's own guidance is to run `PRAGMA
 * optimize` before closing a long-lived connection, which runs `ANALYZE` for
 * you, and any operator with the file can run it directly. Once `sqlite_stat1`
 * exists, `state = 'pending'` over a table that is mostly pending stops looking
 * selective, and an *unordered* subquery switches to a full table scan — which
 * delivers rows in rowid order, so the claim hands out the job enqueued first
 * instead of the job scheduled first. Measured on this schema: the unordered
 * plan moves from `SEARCH jobs USING INDEX idx_jobs_queue` to `SCAN jobs`.
 *
 * The ordered subquery does not move, because the index is what satisfies its
 * `ORDER BY` and dropping to a scan would cost a sort. So the clause is not
 * decoration over an index that already sorts — it is the reason the index is
 * still chosen, and the only thing that makes the ordering a promise rather
 * than a coincidence.
 *
 * §9's nightly consolidation is what breaks otherwise. A schedule that holds
 * only while the planner cooperates is advisory, and the section above says it
 * is not.
 *
 * A file rather than `:memory:`: `ANALYZE` has to be run by something other
 * than the store, which offers no way to execute one, and a second connection
 * to `:memory:` is a second empty database.
 */

describe('the schedule order on a file the planner has collected statistics for', () => {
  let directory: string;
  let dbPath: string;

  /** Two jobs, enqueued latest-schedule first, so enqueue order and schedule order disagree. @spec §9 */
  const seedOutOfOrder = (): { readonly enqueuedFirst: number; readonly scheduledFirst: number } => {
    const seeding = openGraphStore({ path: dbPath });
    try {
      return {
        enqueuedFirst: seeding.enqueueJob({
          kind: EXTRACT,
          payload: EXTRACT_PAYLOAD,
          scheduledAt: DUE_LATEST,
        }),
        scheduledFirst: seeding.enqueueJob({
          kind: EXTRACT,
          payload: EXTRACT_PAYLOAD,
          scheduledAt: DUE_LONG_AGO,
        }),
      };
    } finally {
      seeding.close();
    }
  };

  /** Collects the statistics, exactly as `PRAGMA optimize` or an operator would. @spec §9, §11 */
  const analyze = (): void => {
    const db = new Database(dbPath);
    try {
      db.exec('ANALYZE');
    } finally {
      db.close();
    }
  };

  /**
   * Whether the claim's subquery is still reaching the queue through the index.
   *
   * Fixture insurance, and asserted beside the claim rather than on its own: a
   * planner that never moved would make the assertion below pass for a reason
   * that has nothing to do with the `ORDER BY`, which is the same failure the
   * race fixture's share assertion exists to catch. Only the subquery's step is
   * read, since the outer UPDATE always seeks the row by primary key.
   *
   * @spec §9, §11
   */
  const subqueryLeansOnQueueIndex = (): boolean => {
    const db = new Database(dbPath);
    try {
      const steps = db
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT id
               FROM jobs
              WHERE kind = ?
                AND state = 'pending'
                AND (scheduled_at IS NULL OR scheduled_at <= ?)
              ORDER BY scheduled_at, id
              LIMIT 1`,
        )
        .all(EXTRACT, NOT_YET_DUE) as readonly { readonly detail: string }[];
      return steps.some((step) => step.detail.includes('idx_jobs_queue'));
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kg-jobs-analyzed-'));
    dbPath = join(directory, 'graph.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('still claims the job scheduled first, not the one enqueued first', () => {
    const { scheduledFirst } = seedOutOfOrder();

    analyze();

    const drain = openGraphStore({ path: dbPath });
    try {
      expect({
        claimed: drain.claimJob(EXTRACT)?.id,
        stillIndexed: subqueryLeansOnQueueIndex(),
      }).toStrictEqual({ claimed: scheduledFirst, stillIndexed: true });
    } finally {
      drain.close();
    }
  });

  it('drains the rest in schedule order too, so the first claim is not a coincidence', () => {
    const { enqueuedFirst, scheduledFirst } = seedOutOfOrder();

    analyze();

    const drain = openGraphStore({ path: dbPath });
    try {
      expect([drain.claimJob(EXTRACT)?.id, drain.claimJob(EXTRACT)?.id]).toStrictEqual([
        scheduledFirst,
        enqueuedFirst,
      ]);
    } finally {
      drain.close();
    }
  });

  /**
   * Due work first, then the parked job that outranks it once requeued.
   *
   * `requeueJob` writes NULL into the very column the claim sorts on, so the
   * ruling that a cleared not-before means *at once* is a claim about this
   * `ORDER BY` and not only about the row. It therefore has to hold on the file
   * the planner has statistics for, not just on the empty one the fixtures above
   * build: an implied ordering that survives a fresh database and collapses into
   * rowid order after `ANALYZE` is the failure this whole describe exists for.
   *
   * The parked job holds the higher id, so rowid order and schedule order
   * disagree and only the intended one passes.
   *
   * @spec §9, §11, §12
   */
  const seedRequeueBesideDueWork = (): { readonly parked: number; readonly merelyDue: number } => {
    const seeding = openGraphStore({ path: dbPath });
    try {
      const merelyDue = seeding.enqueueJob({
        kind: EXTRACT,
        payload: EXTRACT_PAYLOAD,
        scheduledAt: DUE_LONG_AGO,
      });
      const parked = seeding.enqueueJob({
        kind: EXTRACT,
        payload: EXTRACT_PAYLOAD,
        scheduledAt: NOT_YET_DUE,
      });
      seeding.failJob({ id: parked, error: FIRST_FAILURE });
      return { parked, merelyDue };
    } finally {
      seeding.close();
    }
  };

  it('still brings a requeued job back ahead of work that is merely due', () => {
    const { parked, merelyDue } = seedRequeueBesideDueWork();

    analyze();

    const drain = openGraphStore({ path: dbPath });
    try {
      drain.requeueJob(parked);

      expect([drain.claimJob(EXTRACT)?.id, drain.claimJob(EXTRACT)?.id]).toStrictEqual([
        parked,
        merelyDue,
      ]);
    } finally {
      drain.close();
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Left underdetermined, deliberately unasserted.
 * ---------------------------------------------------------------------------
 *
 * 1. **What an omitted `scheduledAt` becomes in the column.** Two readings both
 *    satisfy every assertion above: SQL NULL, which sorts before every instant
 *    in SQLite and so means "at once"; or a `now()` stamped at enqueue, which
 *    makes the column total and the ordering purely chronological. The two
 *    differ only in one case — an unscheduled job racing a job scheduled in the
 *    *past* — and nothing in §9 says which should win. Nothing here asserts that
 *    case.
 * 2. **Transitions from the wrong state, for the three calls a drain makes.**
 *    Completing a job that was never claimed, failing one already done, claiming
 *    a job twice through a restart that lost its `running` row: each is a caller
 *    mistake with no reading in §9, and a store that refused them would be
 *    running a state machine nobody has specified. Only the transitions a drain
 *    actually makes are pinned. `requeueJob` is the exception and is not a
 *    counter-example: it is not a report about work a drain did, it is a *named
 *    transition* — the inverse of parking — so which states it applies from is
 *    the whole of its contract rather than a state machine smuggled in beside
 *    one, and the section above pins all four answers.
 * 3. **How a `running` job is ever recovered.** A drain that dies holding a
 *    claim leaves the job `running` for good — there is no lease, no visibility
 *    timeout and no `started_at` sweep here. §6.4 gives *verification tasks* a
 *    TTL for exactly this shape of problem and §9 says nothing about jobs, so the
 *    reaper is a later cycle's ruling rather than a guess made in this one.
 *    `requeueJob` refusing `running` is what keeps that ruling open: a requeue
 *    that took the state would be a reaper with no lease to read, which is the
 *    one version of it that cannot be written safely.
 * 5. **Where a requeued job lands among other due jobs.** It is cleared to a
 *    NULL not-before, so the answer is note 1's unsettled race — a job with no
 *    schedule against one scheduled in the past — and pinning it here would
 *    settle that sideways. Nothing above claims from a queue holding more than
 *    one claimable row, which is also why this section needs no `ANALYZE`
 *    fixture: no assertion in it depends on the order rows come back in.
 * 6. **What `requeueJob` does to `started_at` and `finished_at`.** A parked job
 *    carries the `started_at` of the attempt that died and no `finished_at` at
 *    all (`failJob`'s parking arm stamps neither), and `claimJob` overwrites
 *    `started_at` on the next claim — so both readings are invisible to every
 *    caller. Unasserted rather than guessed.
 * 4. **Whether a payload the store could not have written should refuse or
 *    degrade on read.** `entities.locator` degrades by dropping the key;
 *    `stage_log` refuses by class. A job payload has an argument for refusing —
 *    `{}` is a legitimate payload for a sweep that takes no arguments, so
 *    degrading unreadable bytes onto it would silently turn "extract this chunk"
 *    into "extract nothing" — but that is a read-path ruling, and this cycle
 *    only pins the write boundary that stops the row existing
 *    (`jobs-table-guards.test.ts`).
 */
