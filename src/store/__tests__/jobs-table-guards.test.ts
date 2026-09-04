/**
 * `jobs`: three columns migration 0 declared and never constrained.
 *
 * The table was written as a §7 seam and has had no writer since, so nothing has
 * ever had reason to ask what its columns admit. E1b gives it one, and the
 * answer today is: anything. `state` is `TEXT NOT NULL DEFAULT 'pending'` with no
 * CHECK, `attempts` is `INTEGER NOT NULL DEFAULT 0` with neither a `typeof` nor a
 * `>= 0` clause, and `payload` is `TEXT NOT NULL DEFAULT '{}'` with no
 * `json_valid`. Each is the same omission a sibling column in this schema already
 * carries a CHECK and a paragraph of argument for.
 *
 * ── `state`, a closed set the queue's whole mechanism runs on ────────────────
 *
 * Every state this queue can be in is enumerable: a job is waiting, running,
 * finished, or parked after a failure. `claims.status` is the precedent and the
 * argument is the same shape but sharper here, because of *how* the column is
 * read. A claim's status is read to decide how to *serve* a row that is
 * definitely there; a job's state is read to decide whether the row is there at
 * all — `claimJob` selects `WHERE state = 'pending'`, and a job whose state is
 * `'Pending'`, `'queued'` or `'pendign'` is not selected by that, ever.
 *
 * That failure has no symptom. A claim with a bad status shows up wrong; a job
 * with a bad state shows up as nothing — enqueued, never claimed, never failed,
 * never counted, with no error anywhere and no row to look at unless someone
 * already suspects. §5.10 parks a whole document's extraction behind this
 * column, and §5.9 parks every captured hook event behind it, so a value the
 * `WHERE` cannot match is silently dropped work on both of the write-side
 * transports.
 *
 * ── `attempts`, a counter that decides whether a job is ever retried ─────────
 *
 * `provenance.ordinal` and, since E1a, `document_chunks.ordinal` both carry
 * `typeof(x) = 'integer' AND x >= 0`, and both comments make the affinity
 * argument: INTEGER affinity converts numeric text and leaves everything else
 * exactly as it arrived, so `'many'` sits in the column as TEXT and a blob sits
 * in it as a blob.
 *
 * What that costs here is not ordering, it is arithmetic. SQLite compares TEXT
 * above every number, so a retry budget written as `attempts < 5` is false the
 * moment `attempts` is TEXT — the job is over budget forever, on its first
 * attempt. `attempts + 1` over `'many'` is `1`, so a counter that was corrupted
 * once silently restarts, and a poison job gets an unbounded budget. The `>= 0`
 * clause closes the other end of the same hole: a negative counter is a job that
 * can be retried more times than any budget allows.
 *
 * ── `payload`, opaque bytes a drain has to parse ─────────────────────────────
 *
 * `stage_log.inputs` and `stage_log.decision` are the precedent, and their
 * comment is directly transferable: *"TEXT affinity is no help here: it converts
 * a number to text but leaves a blob exactly as it arrived"*. A payload is what
 * tells the drain which chunk of which document to extract from, and `{}` is a
 * legitimate payload for a sweep that takes no arguments — so bytes that do not
 * parse cannot be repaired into anything, only refused at the boundary before
 * they land.
 *
 * ── Why from outside the store ───────────────────────────────────────────────
 *
 * Reached on a plain driver connection, exactly as `chunk-embedding-guard.test.ts`
 * and `mention-weight.test.ts` reach the columns whose CHECKs make the same
 * argument: the claim under test is about the file on disk and the promise it
 * makes to any future writer that is not this store. A prepared statement of ours
 * anywhere in the path would be the store keeping its own promise instead, and
 * the port's promises are pinned in `jobs-queue.test.ts` where they belong.
 *
 * A temp file rather than `:memory:`, because `:memory:` opens a private
 * database and a second connection to one is a second empty database.
 *
 * @spec §5.9, §5.10, §9, §11, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraphStore, type GraphStore, type JobState } from '../index';

/** The extended result code SQLite reports when a table CHECK refuses a write. */
const CHECK_VIOLATION = 'SQLITE_CONSTRAINT_CHECK';

/** The row every update in this file targets. Explicit, so no assertion depends on the autoincrement. @spec §9 */
const SEEDED_JOB_ID = 1;

/** The state the seeded row is written in. @spec §9 */
const SEEDED_STATE = 'pending';

/** The payload the seeded row carries. @spec §5.10 */
const SEEDED_PAYLOAD = '{"documentId":"DOC-ADR-0007","chunk":{"ordinal":3}}';

/** A value offered to a column, written as the SQL literal it arrives as. */
interface OfferedLiteral {
  readonly description: string;
  readonly literal: string;
}

/** What a statement did: which constraint refused it, or how many rows moved. */
interface RawOutcome {
  readonly code: string | undefined;
  readonly changes: number;
}

/** One column of one row, as its storage class and its contents. */
interface StoredValue {
  readonly type: string;
  readonly value: unknown;
}

let directory: string;
let dbPath: string;

/** Runs a body against a plain driver connection — no store, no prepared statement of ours. @spec §11 */
const withRawConnection = <T>(run: (db: Database.Database) => T): T => {
  const db = new Database(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
};

/** Opens a store on the same file, which is what puts migration 0 into it. @spec §11 */
const withStore = (): void => {
  const store: GraphStore = openGraphStore({ path: dbPath });
  store.close();
};

/** Runs one statement of the harness's own writing, and reports what the table said. */
const rawStatement = (sql: string): RawOutcome =>
  withRawConnection((db) => {
    try {
      return { code: undefined, changes: db.prepare(sql).run().changes };
    } catch (error) {
      return { code: (error as { readonly code?: string }).code, changes: 0 };
    }
  });

/** Offers a job row whose state is the given literal. @spec §9 */
const jobInsertWithState = (state: string): string => `
  INSERT INTO jobs (kind, payload, state, scheduled_at, attempts)
  VALUES ('extract', '${SEEDED_PAYLOAD}', ${state}, '2020-01-01T00:00:00.000Z', 0)
`;

/** Offers a job row whose attempts counter is the given literal. @spec §9 */
const jobInsertWithAttempts = (attempts: string): string => `
  INSERT INTO jobs (kind, payload, state, attempts)
  VALUES ('extract', '${SEEDED_PAYLOAD}', 'pending', ${attempts})
`;

/** Offers a job row whose payload is the given literal. @spec §5.10 */
const jobInsertWithPayload = (payload: string): string => `
  INSERT INTO jobs (kind, payload, state) VALUES ('extract', ${payload}, 'pending')
`;

/** Offers a job row that names no payload at all, so the column default answers. @spec §9 */
const JOB_INSERT_WITHOUT_PAYLOAD = `
  INSERT INTO jobs (kind, state) VALUES ('consolidate', 'pending')
`;

/** Offers a job row that names neither state nor attempts, so both defaults answer. @spec §9 */
const JOB_INSERT_ON_DEFAULTS = `
  INSERT INTO jobs (kind, payload) VALUES ('consolidate', '{}')
`;

/** Rewrites one column of the seeded row. @spec §9 */
const jobUpdate = (column: string, literal: string): string =>
  `UPDATE jobs SET ${column} = ${literal} WHERE id = ${String(SEEDED_JOB_ID)}`;

/** One column of one job row, as its storage class and its contents. @spec §9 */
const jobColumn = (column: string, id: number = SEEDED_JOB_ID): StoredValue | undefined =>
  withRawConnection(
    (db) =>
      db
        .prepare(`SELECT typeof(${column}) AS type, ${column} AS value FROM jobs WHERE id = ?`)
        .get(id) as StoredValue | undefined,
  );

/** How many rows the table holds, so a refusal that left one behind shows. @spec §9 */
const jobCount = (): number =>
  withRawConnection(
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { readonly n: number }).n,
  );

/**
 * The states this queue can be in, and nothing else.
 *
 * Four, because a job is waiting for a drain, held by one, finished, or parked
 * after a failure the caller gave no retry instant for. `pending` is the one the
 * column already defaults to, which is the constraint's tightest requirement: a
 * DEFAULT that fails its own CHECK makes every insert that omits the column an
 * error, so the set has to contain it.
 *
 * Pinned to {@link JobState} by the compiler rather than copied out of it. The
 * table CHECK and the port's union are two declarations of one vocabulary, and
 * nothing derives either from the other — a fifth state added to the union would
 * otherwise arrive here as a case nobody runs, and a job in it would be a job
 * `claimJob` never sees again. Naming the arms as keys means adding one to
 * {@link JobState} fails to compile until it is listed, and then fails as a
 * refused UPDATE until the CHECK admits it too.
 *
 * @spec §9
 */
const EVERY_DECLARED_STATE: Record<JobState, null> = {
  pending: null,
  running: null,
  done: null,
  failed: null,
};

/** Those states as a list, in declaration order. @spec §9 */
const PERMITTED_STATES = Object.keys(EVERY_DECLARED_STATE) as readonly JobState[];

/**
 * States the column must refuse.
 *
 * Each is a value a `WHERE state = 'pending'` cannot match while looking, to
 * anything reading the row, like a job that is waiting. That is the whole failure
 * mode: not a wrong answer, an absent one.
 *
 * @spec §9, §12
 */
const REFUSED_STATES: readonly OfferedLiteral[] = [
  { description: 'the same word in the wrong case', literal: "'Pending'" },
  { description: 'the same word shouted', literal: "'PENDING'" },
  { description: 'a synonym no query is written for', literal: "'queued'" },
  { description: 'a typo, which is what this actually looks like in the wild', literal: "'pendign'" },
  { description: 'a state from another queue, which verification tasks use', literal: "'open'" },
  { description: 'the empty string, which every IS NOT NULL guard admits', literal: "''" },
  { description: 'a number, which TEXT affinity converts and stores', literal: '1' },
];

/**
 * Attempt counts the column must admit.
 *
 * `'3'` is here deliberately. INTEGER affinity converts numeric text on the way
 * in, so it is stored as the integer 3 and the `typeof` clause is satisfied —
 * the same thing `provenance.ordinal`'s comment says about `'1.5'`, in the
 * direction where the conversion is harmless.
 *
 * @spec §9
 */
const PERMITTED_ATTEMPTS: readonly OfferedLiteral[] = [
  { description: 'zero, which is what a job starts with', literal: '0' },
  { description: 'a count of retries behind it', literal: '3' },
  { description: 'numeric text, which INTEGER affinity converts to a number', literal: "'3'" },
];

/**
 * Attempt counts the column must refuse.
 *
 * The text and blob cases are what a retry budget compares against and always
 * loses to; the real is a counter that no increment lands on cleanly; the
 * negatives are a budget that can never be exhausted.
 *
 * @spec §9, §12
 */
const REFUSED_ATTEMPTS: readonly OfferedLiteral[] = [
  { description: 'text, which sorts above every number in SQLite', literal: "'many'" },
  { description: 'the empty string, which is present and counts nothing', literal: "''" },
  { description: 'a blob, which INTEGER affinity does not convert', literal: "x'03'" },
  { description: 'a real, which no increment leaves as an integer', literal: '1.5' },
  { description: 'numeric text that converts to a real', literal: "'1.5'" },
  { description: 'a negative count, which is a retry budget that never runs out', literal: '-1' },
  { description: 'numeric text that converts to a negative count', literal: "'-1'" },
];

/**
 * Payloads the column must refuse.
 *
 * The same four `guarded-json-reads.test.ts` offers the stage log's two payload
 * columns, for its reasons: the first two are a half-written or hand-edited
 * value, the empty string is the one a presence check misses, and the blob is the
 * one TEXT affinity does not save anyone from.
 *
 * @spec §5.8, §9, §12
 */
const REFUSED_PAYLOADS: readonly OfferedLiteral[] = [
  { description: 'text that was never JSON', literal: "'not json'" },
  { description: 'a half-written object, as a truncated write leaves one', literal: `'{"chunk":'` },
  { description: 'the empty string, which is present and still parses to nothing', literal: "''" },
  { description: 'a blob, which TEXT affinity does not convert', literal: "x'010203'" },
];

/**
 * Payloads the column must admit.
 *
 * The guard is `json_valid` and not "is a JSON object": a job whose arguments are
 * a list, a bare string or an explicit `null` is offering valid JSON, and a
 * constraint tighter than the one the sibling columns carry would refuse rows the
 * store has every reason to write.
 *
 * @spec §5.8, §9
 */
const PERMITTED_PAYLOADS: readonly OfferedLiteral[] = [
  { description: 'an object, which is the ordinary case', literal: `'${SEEDED_PAYLOAD}'` },
  { description: 'the empty object the column already defaults to', literal: "'{}'" },
  { description: 'an array', literal: `'["DOC-ADR-0007",3]'` },
  { description: 'a JSON null, which is not the same as no payload', literal: "'null'" },
  { description: 'a bare JSON string', literal: `'"recluster everything"'` },
  { description: 'an object carrying unicode', literal: `'{"note":"réanchor — ✅"}'` },
];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-jobs-guard-'));
  dbPath = join(directory, 'graph.db');
  withStore();
  rawStatement(`
    INSERT INTO jobs (id, kind, payload, state, scheduled_at, attempts)
    VALUES (${String(SEEDED_JOB_ID)}, 'extract', '${SEEDED_PAYLOAD}', '${SEEDED_STATE}',
            '2020-01-01T00:00:00.000Z', 0)
  `);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the states a job row may hold', () => {
  it('holds the state the harness seeded, so the fixture writes a row at all', () => {
    expect(jobColumn('state')).toStrictEqual({ type: 'text', value: SEEDED_STATE });
  });

  it.each(PERMITTED_STATES)('takes %s, which the queue moves a job through', (state) => {
    expect(rawStatement(jobUpdate('state', `'${state}'`))).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it('leaves a row that named no state pending, since the default has to satisfy its own CHECK', () => {
    expect(rawStatement(JOB_INSERT_ON_DEFAULTS)).toStrictEqual({ code: undefined, changes: 1 });

    expect(jobColumn('state', SEEDED_JOB_ID + 1)).toStrictEqual({
      type: 'text',
      value: 'pending',
    });
  });

  it('leaves a row that named no attempts at zero, for the same reason', () => {
    rawStatement(JOB_INSERT_ON_DEFAULTS);

    expect(jobColumn('attempts', SEEDED_JOB_ID + 1)).toStrictEqual({ type: 'integer', value: 0 });
  });

  it('leaves a row that named no payload holding the empty object, for the same reason', () => {
    rawStatement(JOB_INSERT_WITHOUT_PAYLOAD);

    expect(jobColumn('payload', SEEDED_JOB_ID + 1)).toStrictEqual({ type: 'text', value: '{}' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The state CHECK this cycle adds.
 * ---------------------------------------------------------------------------
 */

describe('the closed set of states the queue can be in', () => {
  it.each(REFUSED_STATES)('refuses an inserted state that is $description', ({ literal }) => {
    expect(rawStatement(jobInsertWithState(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_STATES)('refuses an updated state that is $description', ({ literal }) => {
    expect(rawStatement(jobUpdate('state', literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves no job behind when it refuses an insert', () => {
    rawStatement(jobInsertWithState("'queued'"));

    expect(jobCount()).toBe(1);
  });

  it('leaves a pending job pending when it refuses to relabel it', () => {
    rawStatement(jobUpdate('state', "'queued'"));

    expect(jobColumn('state')).toStrictEqual({ type: 'text', value: SEEDED_STATE });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The attempts CHECK this cycle adds.
 * ---------------------------------------------------------------------------
 */

describe('the attempts counter on a job row', () => {
  it.each(PERMITTED_ATTEMPTS)('takes an attempts count that is $description', ({ literal }) => {
    expect(rawStatement(jobInsertWithAttempts(literal))).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it.each(REFUSED_ATTEMPTS)('refuses an inserted attempts count that is $description', ({ literal }) => {
    expect(rawStatement(jobInsertWithAttempts(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_ATTEMPTS)('refuses an updated attempts count that is $description', ({ literal }) => {
    expect(rawStatement(jobUpdate('attempts', literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves the counter where it was when it refuses to rewrite it', () => {
    rawStatement(jobUpdate('attempts', "'many'"));

    expect(jobColumn('attempts')).toStrictEqual({ type: 'integer', value: 0 });
  });

  it('stores numeric text as the integer INTEGER affinity converted it to', () => {
    rawStatement(jobUpdate('attempts', "'3'"));

    expect(jobColumn('attempts')).toStrictEqual({ type: 'integer', value: 3 });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The payload json_valid boundary this cycle adds.
 * ---------------------------------------------------------------------------
 */

describe('the json_valid boundary on a job payload', () => {
  it.each(PERMITTED_PAYLOADS)('takes a payload that is $description', ({ literal }) => {
    expect(rawStatement(jobInsertWithPayload(literal))).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it.each(REFUSED_PAYLOADS)('refuses an inserted payload that is $description', ({ literal }) => {
    expect(rawStatement(jobInsertWithPayload(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_PAYLOADS)('refuses an updated payload that is $description', ({ literal }) => {
    expect(rawStatement(jobUpdate('payload', literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves the payload exactly as it was when it refuses an update', () => {
    rawStatement(jobUpdate('payload', "'not json'"));

    expect(jobColumn('payload')).toStrictEqual({ type: 'text', value: SEEDED_PAYLOAD });
  });

  it('leaves no job behind when it refuses an insert', () => {
    rawStatement(jobInsertWithPayload("'not json'"));

    expect(jobCount()).toBe(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Left unconstrained on purpose.
 * ---------------------------------------------------------------------------
 *
 * **`kind`.** It stays open text. §9 already hangs four clocks off this table —
 * consolidation, re-clustering, re-verification sampling, churn decay — §5.10
 * adds extraction, and plan §7's deferred seams name several more that do not
 * exist yet. A CHECK on `kind` would make every one of those a migration, which
 * is the opposite of what a seam is for. The failure a closed `state` prevents
 * has no analogue here either: a job with a misspelled kind is invisible to the
 * drain that wanted it, but it is *visible* to a `SELECT kind, COUNT(*)`, which
 * is how anyone would ever notice.
 *
 * **`scheduled_at`, `started_at`, `finished_at`.** Left as bare TEXT, exactly as
 * `claims.created_at` and every other instant in this schema is. Constraining an
 * instant would be a new rule for this table rather than the enforcement of an
 * existing one, and the ordering these columns drive is pinned against the store
 * in `jobs-queue.test.ts`.
 */
