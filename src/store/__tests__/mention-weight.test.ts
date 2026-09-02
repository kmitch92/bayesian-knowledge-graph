/**
 * `mentions.weight`: the mention index as a cache of naming-claim support.
 *
 * §3.1 already calls the mention index *"the many-to-one mention index (surface
 * form → referent) materializing identity claims over names"*. F2 takes that
 * literally — a naming is a claim, its corroboration is ordinary evidence, and
 * the column beside the pair is a cache of that claim's support rather than a
 * tally of uses. So the integer `n` becomes `weight REAL`: §15's tier weights
 * and §4.2's episode caps are fractional, and a column that could only hold
 * whole numbers would round two-and-a-bit observations to two or to three and
 * change which surface form a referent answers to.
 *
 * The `typeof` guard carries over unchanged in spirit and only widened in
 * letter — `IN ('real','integer')` rather than `= 'integer'`. It is not
 * decoration. `REAL` declares affinity, and affinity is not a type constraint:
 * SQLite converts what it can read as a number and stores everything else
 * exactly as it arrived. The tally is read `ORDER BY weight DESC`, and in
 * SQLite's storage-class ordering every TEXT sorts above every number — so one
 * row written by hand with `weight = 'zzz'` reaches the head of the list, and
 * §3.1's derived name is the head of that list and nothing more. A referent
 * would be renamed to garbage by a single foreign write. This repo has been
 * bitten by exactly that affinity gap before, on this exact column.
 *
 * Reached from outside the store on purpose, exactly as `regime-table-check.ts`
 * reaches the other six columns whose CHECKs make the same argument: the claim
 * being tested is about the file on disk and the promise it makes to *"any
 * future writer that is not this store"*, so a prepared statement of ours
 * anywhere in the path would be the store keeping its own promise instead.
 *
 * A temp file, not `:memory:`, because `:memory:` opens a private database and
 * a second connection to one is a second empty database.
 *
 * @spec §3.1, §3.5, §4.2, §5.2, §11, §15
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraphStore, type GraphStore } from '../index';

import { CREATED_AT, ENTITY_ID, makeEntity } from './fixtures';

/** The extended result code SQLite reports when a table CHECK refuses a write. */
const CHECK_VIOLATION = 'SQLITE_CONSTRAINT_CHECK';

/** The referent's own name, and the form an honest tally puts first. @spec §3.1 */
const CANONICAL_FORM = 'AuthService';

/**
 * The support behind {@link CANONICAL_FORM}: four independent namings at §15's
 * observed-tier weight of 1.0, so it leads the tally on merit.
 *
 * @spec §4.2, §4.4, §15
 */
const CANONICAL_WEIGHT = 4;

/**
 * The support behind {@link ALIAS_FORM}: one full naming plus one capped repeat
 * from the same episode. Fractional by construction — §4.2's cap series is
 * 1, ½, ¼, … and no column that stored counts could hold this number.
 *
 * @spec §4.2, §15
 */
const ALIAS_WEIGHT = 1.5;

/** A second real surface form, corroborated less than the first. @spec §3.1 */
const ALIAS_FORM = 'auth-service';

/** The form a writer that is not this store tries to add. @spec §3.1 */
const CAPTURING_FORM = 'the form a foreign writer added';

/** One column of one row, exactly as it sits in the file. */
interface StoredColumn {
  readonly type: string;
  readonly value: number | string | Buffer | null;
}

/** What a statement did: which constraint refused it, or how many rows moved. */
interface RawOutcome {
  readonly code: string | undefined;
  readonly changes: number;
}

/** A value offered to the column, written as the SQL literal it arrives as. */
interface RefusedLiteral {
  readonly description: string;
  readonly literal: string;
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

/** Opens a store on the same file, to read back what the raw writer left behind. @spec §11 */
const withStore = <T>(run: (store: GraphStore) => T): T => {
  const store: GraphStore = openGraphStore({ path: dbPath });
  try {
    return run(store);
  } finally {
    store.close();
  }
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

/** Offers a mention row for `form` with the given weight literal. @spec §3.1 */
const mentionInsert = (form: string, weight: string): string => `
  INSERT INTO mentions (surface_form, referent_id, at, weight)
  VALUES ('${form}', '${ENTITY_ID}', '${CREATED_AT}', ${weight})
`;

/** Rewrites the weight on the form that legitimately leads the tally. @spec §3.1 */
const mentionUpdate = (weight: string): string => `
  UPDATE mentions SET weight = ${weight}
  WHERE surface_form = '${CANONICAL_FORM}' AND referent_id = '${ENTITY_ID}'
`;

/** The weight column of one mention row, its storage class and its contents. @spec §3.1 */
const mentionWeight = (form: string): StoredColumn | undefined =>
  withRawConnection(
    (db) =>
      db
        .prepare(
          `SELECT typeof(weight) AS type, weight AS value FROM mentions
            WHERE surface_form = '${form}' AND referent_id = '${ENTITY_ID}'`,
        )
        .get() as StoredColumn | undefined,
  );

/**
 * The referent's surface forms in the order the store ranks them.
 *
 * Forms rather than weights: §3.1's derived name is the head of this list, and
 * a test that read the number would be pinning the tally's shape rather than
 * the ranking the name is a function of.
 *
 * @spec §3.1
 */
const rankedForms = (): string[] =>
  withStore((store) => store.getMentionTally(ENTITY_ID).map((tally) => tally.surfaceForm));

/**
 * Weights the column must refuse, every one of which outranks a real weight
 * under SQLite's storage-class ordering — which is what makes them dangerous
 * rather than merely wrong.
 *
 * @spec §3.1, §3.5
 */
const REFUSED_WEIGHTS: readonly RefusedLiteral[] = [
  { description: 'text, which no affinity can read as a number', literal: "'zzz'" },
  { description: 'a hex literal, which REAL affinity leaves as text', literal: "'0x10'" },
  { description: 'the empty string, which is text and not zero', literal: "''" },
  { description: 'a blob, which REAL affinity does not convert either', literal: "x'010203'" },
];

/**
 * Weights the storage-class arm reads perfectly well and the floor still
 * refuses.
 *
 * Support is a sum of non-negative observation weights (§4.2), so a negative
 * one is not a number the tally can be read down to — and the `>= 0` floor is
 * the only clause that can say so.
 *
 * @spec §4.2
 */
const REFUSED_MAGNITUDES: readonly RefusedLiteral[] = [
  { description: 'negative, which no sum of observation weights reaches', literal: '-1' },
  { description: 'negative written as text, converted before the CHECK ran', literal: "'-1'" },
];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-mention-weight-'));
  dbPath = join(directory, 'graph.db');
  withStore((store) => {
    store.putEntity(makeEntity());
  });
  rawStatement(mentionInsert(CANONICAL_FORM, String(CANONICAL_WEIGHT)));
  rawStatement(mentionInsert(ALIAS_FORM, String(ALIAS_WEIGHT)));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the weight a mention row carries', () => {
  it('takes a real weight, so the harness can write one at all', () => {
    expect(mentionWeight(CANONICAL_FORM)).toStrictEqual({
      type: 'real',
      value: CANONICAL_WEIGHT,
    });
  });

  it('keeps a fraction a fraction rather than narrowing it to a count', () => {
    expect(mentionWeight(ALIAS_FORM)).toStrictEqual({ type: 'real', value: ALIAS_WEIGHT });
  });

  it('holds a capped repeat at its exact §4.2 value rather than rounding it away', () => {
    expect(rawStatement(mentionInsert(CAPTURING_FORM, '0.125'))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(mentionWeight(CAPTURING_FORM)).toStrictEqual({ type: 'real', value: 0.125 });
  });

  it('stores a whole weight as a real, because the column carries evidence and not a count', () => {
    expect(rawStatement(mentionInsert(CAPTURING_FORM, '7'))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(mentionWeight(CAPTURING_FORM)).toStrictEqual({ type: 'real', value: 7 });
  });

  it('accepts a weight of zero, which is what a tainted episode contributes', () => {
    expect(rawStatement(mentionInsert(CAPTURING_FORM, '0'))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(mentionWeight(CAPTURING_FORM)).toStrictEqual({ type: 'real', value: 0 });
  });

  it('ranks the forms by weight, best corroborated first', () => {
    expect(rankedForms()).toStrictEqual([CANONICAL_FORM, ALIAS_FORM]);
  });

  it('lets a heavier form take the head of the ranking, fraction and all', () => {
    rawStatement(mentionInsert(CAPTURING_FORM, '4.5'));

    expect(rankedForms()).toStrictEqual([CAPTURING_FORM, CANONICAL_FORM, ALIAS_FORM]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The storage-class guard, from outside the store.
 * ---------------------------------------------------------------------------
 */

describe('the typeof guard on the mention weight', () => {
  it.each(REFUSED_WEIGHTS)('refuses an inserted weight that is $description', ({ literal }) => {
    expect(rawStatement(mentionInsert(CAPTURING_FORM, literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_WEIGHTS)('refuses an updated weight that is $description', ({ literal }) => {
    expect(rawStatement(mentionUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves no row behind when it refuses an insert', () => {
    rawStatement(mentionInsert(CAPTURING_FORM, "'zzz'"));

    expect(mentionWeight(CAPTURING_FORM)).toBeUndefined();
  });

  it('leaves the seeded weight exactly as it was when it refuses an update', () => {
    rawStatement(mentionUpdate("'zzz'"));

    expect(mentionWeight(CANONICAL_FORM)).toStrictEqual({
      type: 'real',
      value: CANONICAL_WEIGHT,
    });
  });

  it('does not let a text weight capture the name §3.1 derives from the head of the tally', () => {
    rawStatement(mentionInsert(CAPTURING_FORM, "'zzz'"));

    expect(rankedForms()).toStrictEqual([CANONICAL_FORM, ALIAS_FORM]);
  });

  it('hands every weight back through the store as a number', () => {
    rawStatement(mentionInsert(CAPTURING_FORM, "'zzz'"));

    // The one place this file names the member F2 adds to `MentionTally`, and
    // the one type error it is expected to raise until F2 lands. Left as an
    // error rather than cast away: the count the column used to hold is gone,
    // and a cast here would hide from the read path that it has to stop
    // reporting one. There is no parse between the column and the caller, so a
    // weight that arrived as text would arrive here type-checked and wrong.
    expect(
      withStore((store) => store.getMentionTally(ENTITY_ID).map((tally) => typeof tally.weight)),
    ).toStrictEqual(['number', 'number']);
  });

  it('accepts a numeric string, because affinity converted it before any CHECK ran', () => {
    expect(rawStatement(mentionInsert(CAPTURING_FORM, "'1.5'"))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(mentionWeight(CAPTURING_FORM)).toStrictEqual({ type: 'real', value: 1.5 });
  });

  it('accepts a whole number written as a string for the same reason', () => {
    expect(rawStatement(mentionInsert(CAPTURING_FORM, "'5'"))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(mentionWeight(CAPTURING_FORM)).toStrictEqual({ type: 'real', value: 5 });
  });

  it('ranks a converted string by the number it became, not by the text it arrived as', () => {
    rawStatement(mentionInsert(CAPTURING_FORM, "'2'"));

    expect(rankedForms()).toStrictEqual([CANONICAL_FORM, CAPTURING_FORM, ALIAS_FORM]);
  });
});

describe('the floor under the mention weight', () => {
  it.each(REFUSED_MAGNITUDES)('refuses an inserted weight that is $description', ({ literal }) => {
    expect(rawStatement(mentionInsert(CAPTURING_FORM, literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_MAGNITUDES)('refuses an updated weight that is $description', ({ literal }) => {
    expect(rawStatement(mentionUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves the ranking as it was when it refuses a negative weight', () => {
    rawStatement(mentionInsert(CAPTURING_FORM, '-1'));

    expect(rankedForms()).toStrictEqual([CANONICAL_FORM, ALIAS_FORM]);
  });
});
