/**
 * The regime rule as a *database* constraint, reached without going through the
 * store.
 *
 * `regime.test.ts` pins what {@link GraphStore.putClaim} refuses. That is the
 * store keeping its own promise, and it would keep it just as well if migration
 * 0's table CHECK were deleted tomorrow — which is the gap this file closes.
 * Migration 0 states the rule in SQL and justifies it as "the cheapest place to
 * make the rule unfalsifiable — it also holds on the UPDATE paths and for a
 * future writer that is not this store". That is a claim about the file on disk,
 * so it is asserted against the file on disk: a plain `better-sqlite3`
 * connection, opened on a database this store created, with no prepared
 * statement of the store's anywhere in the path.
 *
 * Diagram §6: *"Nothing is ever both. Nothing is ever neither."* A view claim
 * with a posterior is a parser vote counted as corroboration; an evidence claim
 * without one is a belief with no belief in it. Both arms are checked from the
 * outside here, on INSERT and on UPDATE, because a schema that only guards
 * insertion guards nothing — every §4.2 increment and every §4.5 decay is an
 * UPDATE.
 *
 * The last section is the hole the CHECK genuinely cannot cover, and it is the
 * reason two statements in this store carry a regime predicate of their own.
 * `alpha = alpha + 1` over a NULL yields NULL, which satisfies the view arm, so
 * a raw increment against a view claim is *accepted* and changes nothing. The
 * CHECK cannot see that as a violation; only `WHERE ... AND regime = 'evidence'`
 * can. Pinned so nobody simplifies that predicate away.
 *
 * The next four sections carry the same argument onto six sibling columns that
 * declare an affinity and check nothing. `mentions.n`, `pathway_counters.n` and
 * `provenance.ordinal` are INTEGER, which converts numeric text and leaves
 * everything else exactly as it arrived; `claims.embedding`,
 * `entities.gloss_embedding` and `entities.facets` are BLOB, which converts
 * nothing at all. Same threat model, same writer that is not this store, and in
 * one case — the mention count — a live capture rather than a read that fails.
 *
 * The last two sections are the same threat model reaching three TEXT columns
 * that hold JSON, where the failure is neither a silent capture nor a wrong
 * number but an exception thrown at a caller who has no way to see it coming.
 *
 * A temp file rather than `:memory:` throughout, because `:memory:` opens a
 * private, unshared database and a second connection to one is a second empty
 * database.
 *
 * @spec §3.1, §3.2, §3.5, §4.1, §4.2, §4.5, §11
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Entity, Evidence } from '../../schema/index';
import {
  RegimeViolationError,
  openGraphStore,
  type GraphStore,
  type StageLogEntry,
} from '../index';

import {
  CHANNEL,
  CHURN_GAMMA,
  CLAIM_ID,
  CREATED_AT,
  ENTITY_ID,
  EPISODE_ID,
  LOCATOR,
  PRIOR_ALPHA,
  PRIOR_BETA,
  STORE_RERANK_WIDTH,
  THIRD_CLAIM_ID,
  makeClaim,
  makeEntity,
  makeViewClaim,
  testUlid,
} from './fixtures';

/** The extended result code SQLite reports when a table CHECK refuses a row. */
const CHECK_VIOLATION = 'SQLITE_CONSTRAINT_CHECK';

/** An id no seeded row holds, for rows a raw writer tries to add. @spec §3.2 */
const RAW_CLAIM_ID = testUlid('CLAIM-RAWWRITER');

/**
 * Bytes migration 0's vector columns expect: four per f32 component.
 *
 * Computed here from the fixture width rather than imported from the store, so
 * that a substitution which quietly stopped tracking its source constant would
 * show up as a refusal of the store's own vectors rather than as agreement
 * between two copies of the same mistake.
 *
 * @spec §11
 */
const RERANK_BYTES = STORE_RERANK_WIDTH * Float32Array.BYTES_PER_ELEMENT;

/**
 * An INSERT with every column but the three under test pinned to a legal value.
 *
 * Written out here rather than driven through the store precisely because the
 * store is what these assertions must not depend on.
 *
 * @spec §3.2
 */
const RAW_INSERT = `
  INSERT INTO claims
    (id, text, embedding, kind, tier, status, regime, alpha, beta, scope, created_at, canonical)
  VALUES
    (@id, 'written by a hand that is not this store', zeroblob(${String(RERANK_BYTES)}),
     'fact', 'observed', 'active', @regime, @alpha, @beta, @scope, @createdAt, 0)
`;

/**
 * What a raw writer can actually put in the posterior columns.
 *
 * `alpha REAL` is a storage class *affinity* rather than a constraint: SQLite
 * converts a value it can read as a number and stores whatever is left as it
 * arrived. So the set of things a column of that declared type can end up
 * holding is the driver's set of storable values, not the number line.
 *
 * @spec §3.2
 */
type StoredPosterior = number | string | Buffer | null;

/** The regime, α and β a raw writer offers, with everything else already legal. @spec §3.2 */
interface RawClaimBindings {
  readonly id: string;
  readonly regime: string;
  readonly alpha: StoredPosterior;
  readonly beta: StoredPosterior;
  readonly scope: string;
  readonly createdAt: string;
}

/** What a statement did: the constraint that refused it, or how many rows it moved. */
interface RawOutcome {
  readonly code: string | undefined;
  readonly changes: number;
}

/** One INSERT the CHECK is expected to refuse. @spec §3.2 */
interface RefusedInsert {
  readonly description: string;
  readonly regime: string;
  readonly alpha: StoredPosterior;
  readonly beta: StoredPosterior;
}

/** The storage classes the posterior columns ended up holding. @spec §3.2 */
interface PosteriorTypes {
  readonly alpha: string;
  readonly beta: string;
}

/** One UPDATE the CHECK is expected to refuse, and the seeded row it targets. @spec §3.2 */
interface RefusedUpdate {
  readonly description: string;
  readonly assignments: string;
  readonly claimId: string;
}

let directory: string;
let dbPath: string;

/** Runs a body against a plain driver connection — no store, no sqlite-vec, no prepared statement of ours. @spec §11 */
const withRawConnection = <T>(run: (db: Database.Database) => T): T => {
  const db = new Database(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
};

/** Opens the store on the same file, for the reads that say what the raw writer actually left behind. @spec §11 */
const withStore = <T>(run: (store: GraphStore) => T): T => {
  const store: GraphStore = openGraphStore({ path: dbPath });
  try {
    return run(store);
  } finally {
    store.close();
  }
};

/** Offers a claim row straight to the table, and reports what the table said. @spec §3.2 */
const rawInsert = (claim: Omit<RefusedInsert, 'description'>): RawOutcome =>
  withRawConnection((db) => {
    const bindings: RawClaimBindings = {
      id: RAW_CLAIM_ID,
      regime: claim.regime,
      alpha: claim.alpha,
      beta: claim.beta,
      scope: ENTITY_ID,
      createdAt: CREATED_AT,
    };
    try {
      return { code: undefined, changes: db.prepare<RawClaimBindings>(RAW_INSERT).run(bindings).changes };
    } catch (error) {
      return { code: (error as { readonly code?: string }).code, changes: 0 };
    }
  });

/** Mutates a seeded claim straight through the table, and reports what the table said. @spec §3.2 */
const rawUpdate = (assignments: string, claimId: string): RawOutcome =>
  withRawConnection((db) => {
    const sql = `UPDATE claims SET ${assignments} WHERE id = @claimId`;
    try {
      return {
        code: undefined,
        changes: db.prepare<{ claimId: string }>(sql).run({ claimId }).changes,
      };
    } catch (error) {
      return { code: (error as { readonly code?: string }).code, changes: 0 };
    }
  });

/** The posterior columns as they actually sit in the file, read by nothing that could normalize them. @spec §3.2 */
const rawPosterior = (claimId: string): unknown =>
  withRawConnection((db) =>
    db
      .prepare<{ claimId: string }>('SELECT regime, alpha, beta FROM claims WHERE id = @claimId')
      .get({ claimId }),
  );

/**
 * The storage class SQLite actually settled on, which is the thing REAL affinity
 * decides and the declared column type only suggests.
 *
 * @spec §3.2
 */
const rawPosteriorTypes = (claimId: string): PosteriorTypes | undefined =>
  withRawConnection((db) =>
    db
      .prepare<{ claimId: string }, PosteriorTypes>(
        'SELECT typeof(alpha) AS alpha, typeof(beta) AS beta FROM claims WHERE id = @claimId',
      )
      .get({ claimId }),
  );

/** The refusal a store call produced, or `undefined` if it did not refuse. @spec §3.2 */
const refusalFrom = (write: (store: GraphStore) => void): unknown =>
  withStore((store) => {
    try {
      write(store);
      return undefined;
    } catch (error) {
      return error;
    }
  });

const REFUSED_INSERTS: readonly RefusedInsert[] = [
  { description: 'a view claim carrying a posterior', regime: 'view', alpha: 3, beta: 1 },
  { description: 'a view claim carrying only an α', regime: 'view', alpha: 3, beta: null },
  { description: 'a view claim carrying only a β', regime: 'view', alpha: null, beta: 1 },
  {
    description: 'an evidence claim with no posterior at all',
    regime: 'evidence',
    alpha: null,
    beta: null,
  },
  { description: 'an evidence claim missing its β', regime: 'evidence', alpha: 4, beta: null },
  { description: 'an evidence claim missing its α', regime: 'evidence', alpha: null, beta: 2 },
  { description: 'an evidence claim whose α is zero', regime: 'evidence', alpha: 0, beta: 1 },
  { description: 'an evidence claim whose β is zero', regime: 'evidence', alpha: 1, beta: 0 },
  { description: 'an evidence claim whose α is negative', regime: 'evidence', alpha: -1, beta: 1 },
  { description: 'an evidence claim whose β is negative', regime: 'evidence', alpha: 1, beta: -2 },
];

const REFUSED_UPDATES: readonly RefusedUpdate[] = [
  {
    description: 'grafting a posterior onto a view claim',
    assignments: 'alpha = 3, beta = 1',
    claimId: THIRD_CLAIM_ID,
  },
  {
    description: 'grafting half a posterior onto a view claim',
    assignments: 'alpha = 3',
    claimId: THIRD_CLAIM_ID,
  },
  {
    description: 'stripping the posterior off an evidence claim',
    assignments: 'alpha = NULL, beta = NULL',
    claimId: CLAIM_ID,
  },
  {
    description: 'stripping just the β off an evidence claim',
    assignments: 'beta = NULL',
    claimId: CLAIM_ID,
  },
  {
    description: 'flipping an evidence claim to view with its posterior still on it',
    assignments: "regime = 'view'",
    claimId: CLAIM_ID,
  },
  {
    description: 'flipping a view claim to evidence with no posterior to carry',
    assignments: "regime = 'evidence'",
    claimId: THIRD_CLAIM_ID,
  },
  {
    description: "driving an evidence claim's α down to zero",
    assignments: 'alpha = 0',
    claimId: CLAIM_ID,
  },
  {
    description: "driving an evidence claim's β below zero",
    assignments: 'beta = -1',
    claimId: CLAIM_ID,
  },
];

/** A blob no numeric reading of any kind could be got out of. @spec §3.2 */
const NON_NUMERIC_BLOB = Buffer.from([0x01, 0x02, 0x03]);

/**
 * Posteriors that are present, and positive by SQLite's ordering, and still not
 * numbers.
 *
 * Every one of these satisfies `alpha > 0` today, because the comparison is over
 * SQLite's storage-class order rather than over numbers: TEXT sorts above every
 * number and BLOB above every TEXT, so `'abc' > 0` and `x'010203' > 0` are both
 * true. The presence-and-sign arms cannot see any of it.
 *
 * @spec §3.2, §4.1
 */
const REFUSED_TYPES: readonly RefusedInsert[] = [
  { description: 'an evidence claim whose α is text', regime: 'evidence', alpha: 'abc', beta: 1 },
  { description: 'an evidence claim whose β is text', regime: 'evidence', alpha: 1, beta: 'abc' },
  {
    description: 'an evidence claim whose α is a hex literal no affinity converts',
    regime: 'evidence',
    alpha: '0x10',
    beta: 1,
  },
  {
    description: 'an evidence claim whose α is a blob',
    regime: 'evidence',
    alpha: NON_NUMERIC_BLOB,
    beta: 1,
  },
  {
    description: 'an evidence claim whose β is a blob',
    regime: 'evidence',
    alpha: 1,
    beta: NON_NUMERIC_BLOB,
  },
  {
    description: 'an evidence claim with neither parameter numeric',
    regime: 'evidence',
    alpha: 'abc',
    beta: NON_NUMERIC_BLOB,
  },
];

/** The same substitutions arriving on the §4 write paths instead. @spec §3.2, §4.2 */
const REFUSED_TYPE_UPDATES: readonly RefusedUpdate[] = [
  {
    description: "turning an evidence claim's α into text",
    assignments: "alpha = 'abc'",
    claimId: CLAIM_ID,
  },
  {
    description: "turning an evidence claim's β into text",
    assignments: "beta = 'abc'",
    claimId: CLAIM_ID,
  },
  {
    description: "turning an evidence claim's α into a blob",
    assignments: "alpha = x'010203'",
    claimId: CLAIM_ID,
  },
  {
    description: "turning an evidence claim's β into a blob",
    assignments: "beta = x'010203'",
    claimId: CLAIM_ID,
  },
];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-mcp-regime-check-'));
  dbPath = join(directory, 'graph.db');
  withStore((store) => {
    store.putEntity(makeEntity());
    store.putClaim(makeClaim());
    store.putClaim(makeViewClaim());
  });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the table CHECK, met by a writer that never touches this store', () => {
  it('lets a well-formed evidence claim through, so the harness can write at all', () => {
    expect(rawInsert({ regime: 'evidence', alpha: 2, beta: 5 })).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it('lets a well-formed view claim through, posterior columns empty', () => {
    expect(rawInsert({ regime: 'view', alpha: null, beta: null })).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it('hands the row a raw writer left behind straight back through the store', () => {
    rawInsert({ regime: 'evidence', alpha: 2, beta: 5 });

    expect(withStore((store) => store.getEvidence(RAW_CLAIM_ID))).toStrictEqual({
      alpha: 2,
      beta: 5,
    });
  });

  it.each(REFUSED_INSERTS)('refuses $description', ({ regime, alpha, beta }) => {
    expect(rawInsert({ regime, alpha, beta }).code).toBe(CHECK_VIOLATION);
  });

  it('refuses a regime that is neither, so the two arms are the only two there are', () => {
    expect(rawInsert({ regime: 'hybrid', alpha: null, beta: null }).code).toBe(CHECK_VIOLATION);
  });

  it('leaves no row behind when it refuses', () => {
    rawInsert({ regime: 'evidence', alpha: null, beta: null });

    expect(withStore((store) => store.getClaim(RAW_CLAIM_ID))).toBeUndefined();
  });
});

describe('the table CHECK on the UPDATE paths, which is where §4 actually writes', () => {
  it.each(REFUSED_UPDATES)('refuses $description', ({ assignments, claimId }) => {
    expect(rawUpdate(assignments, claimId).code).toBe(CHECK_VIOLATION);
  });

  it('leaves the evidence claim exactly as it was when it refuses', () => {
    rawUpdate('alpha = NULL, beta = NULL', CLAIM_ID);

    expect(withStore((store) => store.getEvidence(CLAIM_ID))).toStrictEqual(makeClaim().evidence);
  });

  it('leaves the view claim without a posterior when it refuses to graft one on', () => {
    rawUpdate('alpha = 3, beta = 1', THIRD_CLAIM_ID);

    expect(withStore((store) => store.getEvidence(THIRD_CLAIM_ID))).toBeNull();
  });

  it('allows the flip that moves the regime and the posterior in one statement', () => {
    expect(rawUpdate("regime = 'view', alpha = NULL, beta = NULL", CLAIM_ID)).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it('allows an ordinary corroboration of an evidence claim', () => {
    expect(rawUpdate('alpha = alpha + 1', CLAIM_ID)).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });
});

describe('the one regime violation the CHECK cannot see', () => {
  it('accepts alpha = alpha + 1 against a view claim, because NULL + 1 is NULL', () => {
    expect(rawUpdate('alpha = alpha + 1', THIRD_CLAIM_ID)).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it('accepts beta = beta + 1 against a view claim for the same reason', () => {
    expect(rawUpdate('beta = beta + 1', THIRD_CLAIM_ID)).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it('leaves the view claim with no posterior all the same, having reported a row changed', () => {
    rawUpdate('alpha = alpha + 1, beta = beta + 1', THIRD_CLAIM_ID);

    expect(rawPosterior(THIRD_CLAIM_ID)).toStrictEqual({
      regime: 'view',
      alpha: null,
      beta: null,
    });
  });

  it('is why incrementEvidence carries its own regime predicate rather than trusting the CHECK', () => {
    expect(
      refusalFrom((store) => {
        store.incrementEvidence({ claimId: THIRD_CLAIM_ID, alpha: 1 });
      }),
    ).toBeInstanceOf(RegimeViolationError);
  });

  it('is why decayEvidence carries the same predicate', () => {
    const prior: Evidence = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA };

    expect(
      refusalFrom((store) => {
        store.decayEvidence({
          claimId: THIRD_CLAIM_ID,
          gamma: CHURN_GAMMA,
          prior,
          at: CREATED_AT,
        });
      }),
    ).toBeInstanceOf(RegimeViolationError);
  });

  it('still lets the same increment through against an evidence claim', () => {
    withStore((store) => {
      store.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });
    });

    expect(withStore((store) => store.getEvidence(CLAIM_ID))).toStrictEqual({
      alpha: PRIOR_ALPHA + 1,
      beta: PRIOR_BETA,
    });
  });
});

/**
 * The other half of the same promise: a posterior has to be a *number*.
 *
 * `alpha REAL` declares an affinity, not a type. A value SQLite can read as a
 * number is converted on the way in and a value it cannot is stored as it
 * arrived, so the column keeps text and blobs quite happily — and the arms above
 * do not notice, because `alpha > 0` is decided by storage-class order, in which
 * every TEXT outranks every number and every BLOB outranks every TEXT. `'abc' >
 * 0` is true. A claim whose α is `'abc'` is therefore a well-formed row by the
 * presence-and-sign rule and a garbage posterior by every reading of §4.1.
 *
 * Checked in the table rather than on the way out for the reason migration 0
 * already gives: the guarantee is claimed against "any future writer that is not
 * this store", and a read-path guard is a guarantee only the reads that
 * remembered to ask for it get. Refusing the write is also the only version that
 * keeps §4.2's `alpha = alpha + ?` meaningful, since text plus one is NULL and
 * the posterior would be gone rather than wrong.
 *
 * @spec §3.2, §4.1, §4.2
 */
describe('the table CHECK on what a posterior is, not merely whether one is there', () => {
  it.each(REFUSED_TYPES)('refuses $description', ({ regime, alpha, beta }) => {
    expect(rawInsert({ regime, alpha, beta })).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_TYPE_UPDATES)('refuses $description', ({ assignments, claimId }) => {
    expect(rawUpdate(assignments, claimId)).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves no row behind, so no reader is handed an α that is not a number', () => {
    rawInsert({ regime: 'evidence', alpha: 'abc', beta: 1 });

    expect(withStore((store) => store.getEvidence(RAW_CLAIM_ID))).toBeUndefined();
  });

  it('leaves a seeded posterior numeric when it refuses to overwrite it with text', () => {
    rawUpdate("alpha = 'abc'", CLAIM_ID);

    expect(withStore((store) => store.getEvidence(CLAIM_ID))).toStrictEqual(makeClaim().evidence);
  });

  it('accepts an integer α, which the column has already stored as a real', () => {
    expect(rawInsert({ regime: 'evidence', alpha: 2, beta: 5 })).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(rawPosteriorTypes(RAW_CLAIM_ID)).toStrictEqual({ alpha: 'real', beta: 'real' });
  });

  it('accepts a numeric string, which affinity converted before any CHECK ran', () => {
    expect(rawInsert({ regime: 'evidence', alpha: '1.5', beta: '2' })).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(rawPosteriorTypes(RAW_CLAIM_ID)).toStrictEqual({ alpha: 'real', beta: 'real' });
  });

  it('hands that converted string back through the store as the number it became', () => {
    rawInsert({ regime: 'evidence', alpha: '1.5', beta: '2' });

    expect(withStore((store) => store.getEvidence(RAW_CLAIM_ID))).toStrictEqual({
      alpha: 1.5,
      beta: 2,
    });
  });

  it('converts on the UPDATE path too, so a §4 write of a numeric string is a real', () => {
    expect(rawUpdate("alpha = '1.5'", CLAIM_ID)).toStrictEqual({ code: undefined, changes: 1 });

    expect(rawPosteriorTypes(CLAIM_ID)).toStrictEqual({ alpha: 'real', beta: 'real' });
  });

  it('still refuses a negative numeric string, which the sign arm sees after conversion', () => {
    expect(rawInsert({ regime: 'evidence', alpha: '-1', beta: 1 }).code).toBe(CHECK_VIOLATION);
  });
});

/* -------------------------------------------------------------------------- *
 * The same hole on six columns that carry no CHECK at all.
 * -------------------------------------------------------------------------- */

/** A raw writer's referent, for the entity rows the harness adds from outside. @spec §3.1 */
const RAW_ENTITY_ID = testUlid('ENTITY-RAWWRITER');

/** The referent's own name, and the form the honest tally puts first. @spec §3.1 */
const CANONICAL_FORM = 'AuthService';

/** How many times {@link CANONICAL_FORM} is seeded, so it leads on merit. @spec §3.1 */
const CANONICAL_NAMINGS = 3;

/** A second real surface form, named once. @spec §3.1 */
const ALIAS_FORM = 'auth-service';

/** The form a corrupt count would hand the referent's name to. @spec §3.1 */
const CAPTURING_FORM = 'the auth thing';

/** The A15 cluster the seeded pathway counter is keyed by. @spec §3.5 */
const CLUSTER_LEVEL = 'channel';

/** A second cluster, so an INSERT test never collides with the seeded row. @spec §3.5 */
const OTHER_CLUSTER_KEY = 'stdio';

/** What the seeded pathway counter starts at. @spec §3.5 */
const SEEDED_PATHWAY_COUNT = 2;

/** The two artifacts {@link makeClaim} records, at ordinals 0 and 1. @spec §3.5 */
const [FIRST_ARTIFACT, SECOND_ARTIFACT] = makeClaim().provenance.artifacts as [string, string];

/** A third artifact a raw writer tries to graft onto the axis. @spec §3.5 */
const INJECTED_ARTIFACT = 'src/auth/injected.ts';

/** The ordinal a legitimate third artifact would take. @spec §3.5 */
const THIRD_ORDINAL = 2;

/** A value offered to a column, written as the SQL literal it arrives as. */
interface RefusedLiteral {
  readonly description: string;
  readonly literal: string;
}

/** One column of one row, as it actually sits in the file. */
interface StoredColumn {
  readonly type: string;
  readonly value: StoredPosterior;
}

/** Runs one statement of the harness's own writing, and reports what the table said. @spec §3.2 */
const rawStatement = (sql: string): RawOutcome =>
  withRawConnection((db) => {
    try {
      return { code: undefined, changes: db.prepare(sql).run().changes };
    } catch (error) {
      return { code: (error as { readonly code?: string }).code, changes: 0 };
    }
  });

/**
 * A column's storage class and its contents, read by nothing that could
 * normalize either. The statement selects `typeof(x) AS type, x AS value`.
 */
const rawColumn = (sql: string): StoredColumn | undefined =>
  withRawConnection((db) => db.prepare(sql).get() as StoredColumn | undefined);

/**
 * What a store read handed back — or the error it raised instead of handing
 * anything back, which on the vector columns is the whole point.
 */
const readOrError = <T>(read: (store: GraphStore) => T): T | Error =>
  withStore((store) => {
    try {
      return read(store);
    } catch (error) {
      return error as Error;
    }
  });

/**
 * Counts an INTEGER column cannot read as a number, and so keeps verbatim.
 *
 * Every one of these outranks every real count under SQLite's storage-class
 * ordering, which is what makes them dangerous rather than merely wrong.
 *
 * @spec §3.1, §3.5
 */
const REFUSED_COUNTS: readonly RefusedLiteral[] = [
  { description: 'text no affinity can read as a number', literal: "'abc'" },
  { description: 'a hex literal INTEGER affinity leaves as text', literal: "'0x10'" },
  { description: 'the empty string, which is text and not zero', literal: "''" },
  { description: 'a blob, which INTEGER affinity does not convert either', literal: "x'010203'" },
];

/**
 * Counts the column reads as numbers perfectly well, and still must not hold.
 *
 * The other half of the guarantee, and the half the storage-class arm cannot
 * make. INTEGER affinity converts a real to an integer only when the conversion
 * is lossless, so `1.5` reaches the column as a REAL and a tally acquires a
 * fraction; `-1` arrives as an honest integer and a tally goes below the floor
 * §3.1 counts from. Neither is text, so neither is refused by `typeof` alone —
 * the `= 'integer'` narrowing and the `>= 0` floor each catch exactly one.
 *
 * @spec §3.1, §3.5
 */
const REFUSED_MAGNITUDES: readonly RefusedLiteral[] = [
  { description: 'a fraction, which INTEGER affinity has to keep as a real', literal: '1.5' },
  { description: 'a fraction written as text, converted before the CHECK ran', literal: "'1.5'" },
  { description: 'a negative count, which no tally can be read down to', literal: '-1' },
];

/**
 * Vectors a BLOB column keeps exactly as they arrived, because BLOB affinity
 * performs no conversion of any kind.
 *
 * The two numeric entries are the quiet half: `bytes.set(blob)` over a number
 * reads no `byteLength`, so the column decodes to an empty vector and no reader
 * is told anything went wrong.
 *
 * The last entry is the one only the storage-class arm can refuse. `length()`
 * over text counts characters, so a string of exactly {@link RERANK_BYTES} of
 * them satisfies every width clause on all three columns — the equality on the
 * single-vector pair, and both the modulo and the cap on `facets` — and is
 * still not a vector. Without it the width clauses would answer for the whole
 * CHECK and `typeof` could be deleted unnoticed.
 *
 * @spec §3.1, §3.2, §11
 */
const REFUSED_VECTORS: readonly RefusedLiteral[] = [
  { description: 'text, of which a blob column converts no part', literal: "'abc'" },
  { description: 'a numeric string, which is still text in a blob column', literal: "'768'" },
  { description: 'an integer, which decodes to an empty vector rather than failing', literal: '5' },
  { description: 'a real, for the same reason', literal: '1.5' },
  {
    description: 'text as long as the blob, which every width clause admits',
    literal: `'${'x'.repeat(RERANK_BYTES)}'`,
  },
];

/**
 * Blobs of the wrong width, which the storage-class arm has no opinion about.
 *
 * `typeof = 'blob'` alone admits every one of these, and each decodes without
 * raising into a vector of the wrong component count — scored, from then on,
 * against 768-component vectors it has no geometric relationship with. That is
 * the failure the width clause exists for, and the one the storage-class tests
 * above cannot reach.
 *
 * `zeroblob(7)` is not even a whole number of f32 components; the doubled width
 * is a perfectly legal f32 blob and wrong only in its count, which is the case
 * a length check that had drifted from its source constant would let through.
 *
 * @spec §3.1, §3.2, §11
 */
const REFUSED_WIDTHS: readonly RefusedLiteral[] = [
  { description: 'seven bytes, not even a whole f32 component', literal: 'zeroblob(7)' },
  {
    description: 'twice the rerank width, a legal f32 blob at the wrong count',
    literal: `zeroblob(${String(RERANK_BYTES * 2)})`,
  },
  {
    description: 'one byte short of the rerank width',
    literal: `zeroblob(${String(RERANK_BYTES - 1)})`,
  },
];

/**
 * Centroid blobs the packed `facets` column must not hold.
 *
 * Two separate clauses answer for these and neither subsumes the other. The
 * modulo is what makes the column a whole number of centroids, so that
 * `decodeFloatVectors` splitting it every {@link RERANK_BYTES} bytes cannot
 * hand back a final short vector nothing trimmed. The cap is §3.1's four,
 * restated in SQL because the schema's `.max(4)` binds only writers that go
 * through the schema.
 *
 * @spec §3.1, §9, §11
 */
const REFUSED_FACET_WIDTHS: readonly RefusedLiteral[] = [
  {
    description: 'five centroids, one past the four §3.1 caps a referent at',
    literal: `zeroblob(${String(RERANK_BYTES * 5)})`,
  },
  {
    description: 'a centroid and a half, which no split divides evenly',
    literal: `zeroblob(${String(RERANK_BYTES + RERANK_BYTES / 2)})`,
  },
  {
    description: 'seven bytes, less than a single centroid',
    literal: 'zeroblob(7)',
  },
];

/** Offers the mention index a row for {@link CAPTURING_FORM} with the given count. @spec §3.1 */
const mentionInsert = (count: string): string => `
  INSERT INTO mentions (surface_form, referent_id, at, n)
  VALUES ('${CAPTURING_FORM}', '${ENTITY_ID}', '${CREATED_AT}', ${count})
`;

/** Rewrites the count on the form that legitimately leads the tally. @spec §3.1 */
const mentionUpdate = (count: string): string => `
  UPDATE mentions SET n = ${count}
  WHERE surface_form = '${CANONICAL_FORM}' AND referent_id = '${ENTITY_ID}'
`;

/** The count column of one mention row, as stored. @spec §3.1 */
const mentionCount = (surfaceForm: string): StoredColumn | undefined =>
  rawColumn(`
    SELECT typeof(n) AS type, n AS value FROM mentions
    WHERE surface_form = '${surfaceForm}' AND referent_id = '${ENTITY_ID}'
  `);

/** Offers the A15 counter table a row in {@link OTHER_CLUSTER_KEY} with the given count. @spec §3.5 */
const counterInsert = (count: string): string => `
  INSERT INTO pathway_counters (claim_id, cluster_level, cluster_key, n)
  VALUES ('${CLAIM_ID}', '${CLUSTER_LEVEL}', '${OTHER_CLUSTER_KEY}', ${count})
`;

/** Rewrites the seeded counter's count. @spec §3.5 */
const counterUpdate = (count: string): string => `
  UPDATE pathway_counters SET n = ${count}
  WHERE claim_id = '${CLAIM_ID}' AND cluster_level = '${CLUSTER_LEVEL}'
    AND cluster_key = '${CHANNEL}'
`;

/** The count column of one pathway counter, as stored. @spec §3.5 */
const counterCount = (clusterKey: string): StoredColumn | undefined =>
  rawColumn(`
    SELECT typeof(n) AS type, n AS value FROM pathway_counters
    WHERE claim_id = '${CLAIM_ID}' AND cluster_level = '${CLUSTER_LEVEL}'
      AND cluster_key = '${clusterKey}'
  `);

/** Grafts a third artifact onto the claim's provenance at the given ordinal. @spec §3.5 */
const provenanceInsert = (ordinal: string): string => `
  INSERT INTO provenance (claim_id, axis, value, ordinal)
  VALUES ('${CLAIM_ID}', 'artifact', '${INJECTED_ARTIFACT}', ${ordinal})
`;

/** Moves one artifact's position within its axis. @spec §3.5 */
const provenanceUpdate = (ordinal: string, value: string): string => `
  UPDATE provenance SET ordinal = ${ordinal}
  WHERE claim_id = '${CLAIM_ID}' AND axis = 'artifact' AND value = '${value}'
`;

/** The artifact axis as the store reconstructs it, ordered by `ordinal`. @spec §3.5 */
const artifacts = (): string[] | Error | undefined =>
  readOrError((store) => store.getClaim(CLAIM_ID)?.provenance.artifacts);

/** Replaces the rerank vector on the seeded claim. @spec §3.2, §11 */
const embeddingUpdate = (embedding: string): string =>
  `UPDATE claims SET embedding = ${embedding} WHERE id = '${CLAIM_ID}'`;

/** Offers a whole claim row whose only unusual column is the rerank vector. @spec §3.2, §11 */
const embeddingInsert = (embedding: string): string => `
  INSERT INTO claims
    (id, text, embedding, kind, tier, status, regime, alpha, beta, scope, created_at, canonical)
  VALUES
    ('${RAW_CLAIM_ID}', 'written by a hand that is not this store', ${embedding},
     'fact', 'observed', 'active', 'evidence', 2, 5, '${ENTITY_ID}', '${CREATED_AT}', 0)
`;

/** Offers a whole referent row whose only unusual columns are its two vectors. @spec §3.1, §11 */
const entityInsert = (gloss: string, facets: string): string => `
  INSERT INTO entities (id, name, regime, gloss_embedding, facets)
  VALUES ('${RAW_ENTITY_ID}', 'RawWriter', 'view', ${gloss}, ${facets})
`;

/** Replaces the anchor-resolution vector on the seeded referent. @spec §3.1, §11 */
const glossUpdate = (gloss: string): string =>
  `UPDATE entities SET gloss_embedding = ${gloss} WHERE id = '${ENTITY_ID}'`;

/** Replaces the packed centroids on the seeded referent. @spec §3.1, §9 */
const facetsUpdate = (facets: string): string =>
  `UPDATE entities SET facets = ${facets} WHERE id = '${ENTITY_ID}'`;

/**
 * §3.1's mention count as a count, rather than as a column with INTEGER written
 * beside it.
 *
 * This is the live one. `mentions.n` carries no CHECK at all, INTEGER affinity
 * stores anything it cannot read as a number verbatim, and the tally is read
 * `ORDER BY n DESC` — in which every TEXT outranks every integer. So one row
 * written by a hand that is not this store leads the tally, and §3.1 derives
 * `entities.name` as the head of exactly that list. The count is also handed
 * back through {@link GraphStore.getMentionTally} as `n: number`, with no parse
 * between the column and the caller, so the capture arrives type-checked.
 *
 * Numeric text is untouched by any of this: INTEGER affinity converts `'5'` to
 * the integer 5 before a CHECK could run, exactly as REAL affinity converts
 * `'1.5'` on the posterior columns.
 *
 * @spec §3.1, §5.2
 */
describe('the mention count as a count, on a column that checks nothing', () => {
  beforeEach(() => {
    withStore((store) => {
      for (let naming = 0; naming < CANONICAL_NAMINGS; naming += 1)
        store.putMention({ surfaceForm: CANONICAL_FORM, referentId: ENTITY_ID });
      store.putMention({ surfaceForm: ALIAS_FORM, referentId: ENTITY_ID });
    });
  });

  it.each(REFUSED_COUNTS)('refuses an inserted count that is $description', ({ literal }) => {
    expect(rawStatement(mentionInsert(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_COUNTS)('refuses an updated count that is $description', ({ literal }) => {
    expect(rawStatement(mentionUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves no row behind when it refuses an insert', () => {
    rawStatement(mentionInsert("'abc'"));

    expect(mentionCount(CAPTURING_FORM)).toBeUndefined();
  });

  it('leaves the seeded count exactly as it was when it refuses an update', () => {
    rawStatement(mentionUpdate("'abc'"));

    expect(mentionCount(CANONICAL_FORM)).toStrictEqual({
      type: 'integer',
      value: CANONICAL_NAMINGS,
    });
  });

  it('hands every count back through the store as a number', () => {
    rawStatement(mentionInsert("'abc'"));

    expect(withStore((store) => store.getMentionTally(ENTITY_ID).map((tally) => typeof tally.n)))
      .toStrictEqual(['number', 'number']);
  });

  it('does not let a corrupt count capture the name §3.1 derives from this tally', () => {
    rawStatement(mentionInsert("'zzz'"));

    // §3.1's derived name is the head of this list and nothing more, so the head
    // is where the capture would land.
    expect(withStore((store) => store.getMentionTally(ENTITY_ID))[0]?.surfaceForm).toBe(
      CANONICAL_FORM,
    );
  });

  it('keeps the whole tally the honest one after a refused write', () => {
    rawStatement(mentionInsert("'zzz'"));

    expect(withStore((store) => store.getMentionTally(ENTITY_ID))).toStrictEqual([
      { surfaceForm: CANONICAL_FORM, n: CANONICAL_NAMINGS },
      { surfaceForm: ALIAS_FORM, n: 1 },
    ]);
  });

  it.each(REFUSED_MAGNITUDES)('refuses an inserted count that is $description', ({ literal }) => {
    expect(rawStatement(mentionInsert(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_MAGNITUDES)('refuses an updated count that is $description', ({ literal }) => {
    expect(rawStatement(mentionUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('accepts an ordinary integer count from a raw writer', () => {
    expect(rawStatement(mentionInsert('4'))).toStrictEqual({ code: undefined, changes: 1 });

    expect(mentionCount(CAPTURING_FORM)).toStrictEqual({ type: 'integer', value: 4 });
  });

  it('accepts a whole number written as a real, which affinity narrows losslessly', () => {
    expect(rawStatement(mentionInsert('4.0'))).toStrictEqual({ code: undefined, changes: 1 });

    expect(mentionCount(CAPTURING_FORM)).toStrictEqual({ type: 'integer', value: 4 });
  });

  it('accepts a count of zero, because the floor is nought and not one', () => {
    expect(rawStatement(mentionInsert('0'))).toStrictEqual({ code: undefined, changes: 1 });

    expect(mentionCount(CAPTURING_FORM)).toStrictEqual({ type: 'integer', value: 0 });
  });

  it('leaves a zero-count form behind the honest ones rather than refusing it', () => {
    rawStatement(mentionInsert('0'));

    expect(withStore((store) => store.getMentionTally(ENTITY_ID))).toStrictEqual([
      { surfaceForm: CANONICAL_FORM, n: CANONICAL_NAMINGS },
      { surfaceForm: ALIAS_FORM, n: 1 },
      { surfaceForm: CAPTURING_FORM, n: 0 },
    ]);
  });

  it('accepts a numeric string, which affinity converted before any CHECK ran', () => {
    expect(rawStatement(mentionInsert("'5'"))).toStrictEqual({ code: undefined, changes: 1 });

    expect(mentionCount(CAPTURING_FORM)).toStrictEqual({ type: 'integer', value: 5 });
  });

  it('hands that converted string back through the store as the number it became', () => {
    rawStatement(mentionInsert("'5'"));

    expect(withStore((store) => store.getMentionTally(ENTITY_ID))[0]).toStrictEqual({
      surfaceForm: CAPTURING_FORM,
      n: 5,
    });
  });

  it("still lets the store's own UPSERT increment a count", () => {
    withStore((store) => {
      store.putMention({ surfaceForm: CANONICAL_FORM, referentId: ENTITY_ID });
    });

    expect(withStore((store) => store.getMentionTally(ENTITY_ID))[0]).toStrictEqual({
      surfaceForm: CANONICAL_FORM,
      n: CANONICAL_NAMINGS + 1,
    });
  });

  it('still lets a raw writer increment one the same way', () => {
    expect(rawStatement(mentionUpdate('n + 1'))).toStrictEqual({ code: undefined, changes: 1 });

    expect(mentionCount(CANONICAL_FORM)).toStrictEqual({
      type: 'integer',
      value: CANONICAL_NAMINGS + 1,
    });
  });
});

/**
 * The A15 saturation counter, which v1 writes nothing to and a later feature
 * reads as a number.
 *
 * Same column shape and same silence as the mention count. Nothing derives a
 * name from it, so there is no capture to demonstrate — the point is that a
 * table created empty at migration 0 is a seam a future writer arrives at, and
 * the moment to state what `n` is is before that writer exists rather than
 * after.
 *
 * @spec §3.5, §4.2
 */
describe('the pathway counter as a count, on a column that checks nothing', () => {
  beforeEach(() => {
    rawStatement(`
      INSERT INTO pathway_counters (claim_id, cluster_level, cluster_key, n)
      VALUES ('${CLAIM_ID}', '${CLUSTER_LEVEL}', '${CHANNEL}', ${String(SEEDED_PATHWAY_COUNT)})
    `);
  });

  it.each(REFUSED_COUNTS)('refuses an inserted count that is $description', ({ literal }) => {
    expect(rawStatement(counterInsert(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_COUNTS)('refuses an updated count that is $description', ({ literal }) => {
    expect(rawStatement(counterUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves the seeded counter exactly as it was when it refuses', () => {
    rawStatement(counterUpdate("'abc'"));

    expect(counterCount(CHANNEL)).toStrictEqual({
      type: 'integer',
      value: SEEDED_PATHWAY_COUNT,
    });
  });

  it.each(REFUSED_MAGNITUDES)('refuses an inserted count that is $description', ({ literal }) => {
    expect(rawStatement(counterInsert(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_MAGNITUDES)('refuses an updated count that is $description', ({ literal }) => {
    expect(rawStatement(counterUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('accepts an ordinary integer count', () => {
    expect(rawStatement(counterInsert('7'))).toStrictEqual({ code: undefined, changes: 1 });

    expect(counterCount(OTHER_CLUSTER_KEY)).toStrictEqual({ type: 'integer', value: 7 });
  });

  it('accepts a whole number written as a real, which affinity narrows losslessly', () => {
    expect(rawStatement(counterInsert('7.0'))).toStrictEqual({ code: undefined, changes: 1 });

    expect(counterCount(OTHER_CLUSTER_KEY)).toStrictEqual({ type: 'integer', value: 7 });
  });

  it('accepts a numeric string, converted before any CHECK ran', () => {
    expect(rawStatement(counterInsert("'5'"))).toStrictEqual({ code: undefined, changes: 1 });

    expect(counterCount(OTHER_CLUSTER_KEY)).toStrictEqual({ type: 'integer', value: 5 });
  });

  it("accepts the column's own default, which is the row a first corroboration mints", () => {
    expect(
      rawStatement(`
        INSERT INTO pathway_counters (claim_id, cluster_level, cluster_key)
        VALUES ('${CLAIM_ID}', '${CLUSTER_LEVEL}', '${OTHER_CLUSTER_KEY}')
      `),
    ).toStrictEqual({ code: undefined, changes: 1 });

    expect(counterCount(OTHER_CLUSTER_KEY)).toStrictEqual({ type: 'integer', value: 0 });
  });

  it('still lets the saturation increment through', () => {
    expect(rawStatement(counterUpdate('n + 1'))).toStrictEqual({ code: undefined, changes: 1 });

    expect(counterCount(CHANNEL)).toStrictEqual({
      type: 'integer',
      value: SEEDED_PATHWAY_COUNT + 1,
    });
  });
});

/**
 * `provenance.ordinal`, which is the only thing keeping each axis an ordered
 * list rather than a set.
 *
 * The axis is read back `ORDER BY axis, ordinal`, so a TEXT ordinal does not
 * merely sit in the wrong place — it sorts after every integer ordinal on the
 * axis, which silently rewrites the order of the artifacts, change events and
 * episodes that §4.4 independence discounting and §4.5 churn decay read. The
 * UNIQUE `(claim_id, axis, ordinal)` does not help: SQLite compares storage
 * classes there too, so `'0'` written as text is a different key from `0`.
 *
 * @spec §3.5, §4.4, §4.5
 */
describe('the provenance ordinal as a position, on a column that checks nothing', () => {
  it.each(REFUSED_COUNTS)('refuses an inserted ordinal that is $description', ({ literal }) => {
    expect(rawStatement(provenanceInsert(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_COUNTS)('refuses an updated ordinal that is $description', ({ literal }) => {
    expect(rawStatement(provenanceUpdate(literal, FIRST_ARTIFACT))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('does not let a text ordinal reorder an axis §3.5 promises is a list', () => {
    rawStatement(provenanceUpdate("'first'", FIRST_ARTIFACT));

    expect(artifacts()).toStrictEqual([FIRST_ARTIFACT, SECOND_ARTIFACT]);
  });

  it('adds nothing to the axis when it refuses an insert', () => {
    rawStatement(provenanceInsert("'abc'"));

    expect(artifacts()).toStrictEqual([FIRST_ARTIFACT, SECOND_ARTIFACT]);
  });

  it.each(REFUSED_MAGNITUDES)('refuses an inserted ordinal that is $description', ({ literal }) => {
    expect(rawStatement(provenanceInsert(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_MAGNITUDES)('refuses an updated ordinal that is $description', ({ literal }) => {
    expect(rawStatement(provenanceUpdate(literal, FIRST_ARTIFACT))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('keeps the axis in its own order when it refuses an ordinal below the floor', () => {
    rawStatement(provenanceUpdate('-1', SECOND_ARTIFACT));

    expect(artifacts()).toStrictEqual([FIRST_ARTIFACT, SECOND_ARTIFACT]);
  });

  it('accepts a third artifact at the ordinal that follows, and orders it last', () => {
    expect(rawStatement(provenanceInsert(String(THIRD_ORDINAL)))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(artifacts()).toStrictEqual([FIRST_ARTIFACT, SECOND_ARTIFACT, INJECTED_ARTIFACT]);
  });

  it('accepts that ordinal as a numeric string, converted before any CHECK ran', () => {
    expect(rawStatement(provenanceInsert(`'${String(THIRD_ORDINAL)}'`))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(artifacts()).toStrictEqual([FIRST_ARTIFACT, SECOND_ARTIFACT, INJECTED_ARTIFACT]);
  });

  it('still orders an axis by its ordinals rather than by insertion', () => {
    rawStatement(provenanceUpdate('9', FIRST_ARTIFACT));

    expect(artifacts()).toStrictEqual([SECOND_ARTIFACT, FIRST_ARTIFACT]);
  });
});

/**
 * The three vector columns, where BLOB affinity converts nothing at all.
 *
 * A blob column takes text as text, an integer as an integer and a real as a
 * real, so every one of these reaches {@link decodeFloatVector} — which copies
 * through `bytes.set(blob)`. Over a string that raises a `RangeError` at read
 * time; over a number it reads no `byteLength` at all and yields an *empty*
 * vector, so the referent quietly loses its anchor-resolution geometry and
 * nothing anywhere reports it.
 *
 * Refused in the table for the reason migration 0 already gives about the
 * posterior: a read-path guard is a guarantee only the reads that remembered to
 * ask for it get, and a write that is refused cannot be read at all.
 *
 * `typeof(x'')` is `'blob'`, so the empty blob `entities.facets` defaults to —
 * a referent with no centroids — is admitted by a `typeof` clause without any
 * exception carved for it.
 *
 * @spec §3.1, §3.2, §9, §11
 */
describe('the vector columns as vectors, where affinity converts nothing', () => {
  it.each(REFUSED_VECTORS)('refuses a claim embedding inserted as $description', ({ literal }) => {
    expect(rawStatement(embeddingInsert(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_VECTORS)('refuses a claim embedding updated to $description', ({ literal }) => {
    expect(rawStatement(embeddingUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_VECTORS)('refuses a gloss embedding inserted as $description', ({ literal }) => {
    expect(rawStatement(entityInsert(literal, "x''"))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_VECTORS)('refuses a gloss embedding updated to $description', ({ literal }) => {
    expect(rawStatement(glossUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_VECTORS)('refuses facets inserted as $description', ({ literal }) => {
    expect(rawStatement(entityInsert(`zeroblob(${String(RERANK_BYTES)})`, literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_VECTORS)('refuses facets updated to $description', ({ literal }) => {
    expect(rawStatement(facetsUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_WIDTHS)('refuses a claim embedding inserted as $description', ({ literal }) => {
    expect(rawStatement(embeddingInsert(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_WIDTHS)('refuses a claim embedding updated to $description', ({ literal }) => {
    expect(rawStatement(embeddingUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_WIDTHS)('refuses a gloss embedding inserted as $description', ({ literal }) => {
    expect(rawStatement(entityInsert(literal, "x''"))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_WIDTHS)('refuses a gloss embedding updated to $description', ({ literal }) => {
    expect(rawStatement(glossUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_FACET_WIDTHS)('refuses facets inserted as $description', ({ literal }) => {
    expect(rawStatement(entityInsert(`zeroblob(${String(RERANK_BYTES)})`, literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_FACET_WIDTHS)('refuses facets updated to $description', ({ literal }) => {
    expect(rawStatement(facetsUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves the referent gloss at its own width when it refuses a narrower one', () => {
    rawStatement(glossUpdate('zeroblob(7)'));

    expect(readOrError((store) => store.getEntity(ENTITY_ID)?.glossEmbedding)).toStrictEqual(
      makeEntity().glossEmbedding,
    );
  });

  it('never hands a referent read a gloss of a width nothing can score', () => {
    rawStatement(glossUpdate(`zeroblob(${String(RERANK_BYTES * 2)})`));

    expect(
      readOrError((store) => store.getEntity(ENTITY_ID)?.glossEmbedding?.length),
    ).toBe(STORE_RERANK_WIDTH);
  });

  it('leaves the seeded facet set alone when it refuses a fifth centroid', () => {
    rawStatement(facetsUpdate(`zeroblob(${String(RERANK_BYTES * 5)})`));

    expect(readOrError((store) => store.getEntity(ENTITY_ID)?.facets)).toStrictEqual(
      makeEntity().facets,
    );
  });

  it('accepts the fourth centroid, so the cap is four and not three', () => {
    expect(
      rawStatement(
        entityInsert(`zeroblob(${String(RERANK_BYTES)})`, `zeroblob(${String(RERANK_BYTES * 4)})`),
      ),
    ).toStrictEqual({ code: undefined, changes: 1 });

    expect(
      withStore((store) => store.getEntity(RAW_ENTITY_ID)?.facets?.map((facet) => facet.length)),
    ).toStrictEqual([
      STORE_RERANK_WIDTH,
      STORE_RERANK_WIDTH,
      STORE_RERANK_WIDTH,
      STORE_RERANK_WIDTH,
    ]);
  });

  it('never hands a claim read an embedding decodeFloatVector cannot unpack', () => {
    rawStatement(embeddingUpdate("'abc'"));

    expect(readOrError((store) => store.getClaim(CLAIM_ID)?.embedding)).toStrictEqual(
      makeClaim().embedding,
    );
  });

  it('never hands a referent read a gloss embedding it cannot unpack', () => {
    rawStatement(glossUpdate("'abc'"));

    expect(readOrError((store) => store.getEntity(ENTITY_ID)?.glossEmbedding)).toStrictEqual(
      makeEntity().glossEmbedding,
    );
  });

  it('never silently empties a referent gloss, which an integer does without raising', () => {
    rawStatement(glossUpdate('5'));

    expect(readOrError((store) => store.getEntity(ENTITY_ID)?.glossEmbedding)).toStrictEqual(
      makeEntity().glossEmbedding,
    );
  });

  it('never silently empties a referent facet set the same way', () => {
    rawStatement(facetsUpdate('5'));

    expect(readOrError((store) => store.getEntity(ENTITY_ID)?.facets)).toStrictEqual(
      makeEntity().facets,
    );
  });

  it('leaves no referent behind when it refuses an insert', () => {
    rawStatement(entityInsert("'abc'", "x''"));

    // Read through the same catch the vector assertions use: a referent this
    // insert did leave behind does not come back wrong, it comes back as a
    // `RangeError`, and an uncaught one says less than a diff does.
    expect(readOrError((store) => store.getEntity(RAW_ENTITY_ID))).toBeUndefined();
  });

  it('accepts a referent whose facets are the empty blob a centroid-less one carries', () => {
    expect(
      rawStatement(entityInsert(`zeroblob(${String(RERANK_BYTES)})`, "x''")),
    ).toStrictEqual({ code: undefined, changes: 1 });

    expect(withStore((store) => store.getEntity(RAW_ENTITY_ID)?.facets)).toStrictEqual([]);
  });

  it('accepts emptying a referent facet set on the update path too', () => {
    expect(rawStatement(facetsUpdate("x''"))).toStrictEqual({ code: undefined, changes: 1 });

    expect(withStore((store) => store.getEntity(ENTITY_ID)?.facets)).toStrictEqual([]);
  });

  it("reports typeof(x'') as blob, so no exception has to be carved for it", () => {
    expect(rawColumn("SELECT typeof(x'') AS type, x'' AS value")).toStrictEqual({
      type: 'blob',
      value: Buffer.alloc(0),
    });
  });

  it('accepts a raw claim whose embedding is a blob of the right width', () => {
    expect(rawStatement(embeddingInsert(`zeroblob(${String(RERANK_BYTES)})`))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(withStore((store) => store.getClaim(RAW_CLAIM_ID)?.embedding)).toStrictEqual(
      Array.from({ length: STORE_RERANK_WIDTH }, () => 0),
    );
  });

  it('round-trips the vectors the store itself wrote, untouched by any of this', () => {
    expect(withStore((store) => store.getEntity(ENTITY_ID))).toStrictEqual(makeEntity());
  });

  it('round-trips a claim embedding the store itself wrote', () => {
    expect(withStore((store) => store.getClaim(CLAIM_ID)?.embedding)).toStrictEqual(
      makeClaim().embedding,
    );
  });
});

/* -------------------------------------------------------------------------- *
 * The three TEXT columns the read path parses, on a schema that promised not to.
 * -------------------------------------------------------------------------- */

/**
 * Error names JavaScript mints for itself, which say nothing a caller can act
 * on.
 *
 * `errors.ts` already argues this for the open path: telling a refusal apart
 * from an ordinary failure means telling it apart *by type*, which is why
 * `StoreBusyError` exists rather than a driver `SqliteError` a dependency is
 * free to reword. A bare `SyntaxError` from `JSON.parse` is the same problem one
 * layer in — nothing about it names the store, the column or the row, and no
 * caller can branch on it.
 *
 * `Error` itself is on the list for the same reason: a refusal nobody named is a
 * refusal nobody can catch selectively.
 *
 * @spec §11, §12
 */
const STOCK_ERROR_NAMES: readonly string[] = [
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
];

/** How a refusal this store declared, named and exported appears in a reading. @spec §11 */
const MINTED_REFUSAL = 'a refusal this store minted';

/** The refusal a caller actually received, named rather than merely typed. @spec §11 */
const describeRefusal = (error: Error): string =>
  STOCK_ERROR_NAMES.includes(error.name) ? error.name : MINTED_REFUSAL;

/**
 * What the raw writer's statement did, including the case the harness itself
 * could get wrong.
 *
 * `changed nothing` is in the vocabulary precisely so a corruption test cannot
 * pass by not corrupting anything: a WHERE clause that matched no row leaves the
 * column pristine, the read then succeeds, and an assertion that only looked at
 * the read would report agreement with nothing under it.
 *
 * @spec §3.2
 */
const describeWrite = ({ code, changes }: RawOutcome): string => {
  if (code === CHECK_VIOLATION) return 'refused by the table';
  if (code !== undefined) return `refused with ${code}`;
  return changes === 1 ? 'landed in the column' : 'changed nothing';
};

/**
 * JSON columns as a writer that is not this store can leave them.
 *
 * The first two are what a half-written or hand-edited value looks like. The
 * empty string is the one a presence check misses — it is not SQL NULL, so every
 * `IS NOT NULL` guard admits it, and `JSON.parse('')` raises all the same. The
 * blob is the one affinity does not save anyone from: TEXT affinity converts
 * numbers to text and leaves a blob exactly as it arrived, so the column hands
 * back a `Buffer` where the row type says `string`, and `JSON.parse` stringifies
 * it into three control characters before failing on them.
 *
 * @spec §3.1, §3.5, §5.8
 */
const CORRUPT_JSON: readonly RefusedLiteral[] = [
  { description: 'text that was never JSON', literal: "'not json'" },
  { description: 'a half-written object, as a truncated write leaves one', literal: `'{"path":'` },
  { description: 'the empty string, which is present and still parses to nothing', literal: "''" },
  { description: 'a blob, which TEXT affinity does not convert', literal: "x'010203'" },
];

/**
 * The columns of a referent other than the one under test, as one comparable
 * string.
 *
 * Compared whole rather than sampled: a degrade that dropped the locator and the
 * gloss vector with it is a different outcome from one that dropped the locator,
 * and only a comparison that reads every remaining column can tell them apart.
 * JSON is a faithful medium for this row — every field is a string, a null or an
 * array of doubles, and `JSON.stringify` round-trips a double exactly.
 *
 * @spec §3.1
 */
interface ReferentColumns {
  readonly id: string;
  readonly name: string;
  readonly level: string | null;
  readonly regime: string;
  readonly glossEmbedding: readonly number[];
  readonly facets?: readonly (readonly number[])[] | undefined;
}

/** Everything about a referent except its locator. @spec §3.1 */
const referentBesidesLocator = (referent: ReferentColumns): string =>
  JSON.stringify([
    referent.id,
    referent.name,
    referent.level,
    referent.regime,
    referent.glossEmbedding,
    referent.facets,
  ]);

/** What a raw writer's locator did to a store read, said in full. @spec §3.1, §7.6 */
interface LocatorReading {
  /** What the statement that corrupted the column actually did. */
  readonly write: string;
  /** The error the read raised, or `null` if it handed something back. */
  readonly refusal: string | null;
  /** What arrived where the locator belongs. */
  readonly locator: string;
  /** Whether every other column of the referent came back as the store wrote it. */
  readonly referent: string;
}

/**
 * The readings a fix could produce, and the only ones this section admits.
 *
 * Three shapes, because three fixes are open and the choice between them is not
 * this cycle's to make. A `json_valid()` CHECK stops the bytes reaching the
 * column, so the referent still reads back whole. A guarded decode lets them
 * land and hands the caller a referent with no locator on it. A refusal this
 * store minted lets them land and says so by type. Which of `undefined`, an
 * absent key or `null` a guarded decode hands back is left open here — all three
 * mean the caller was not given corrupt bytes dressed as a locator — though
 * `null` is the one that makes a corrupt locator indistinguishable from a
 * referent that honestly carries none, a distinction the store's own encode path
 * takes trouble to preserve.
 *
 * What no entry admits is a `SyntaxError` reaching the caller, which is what
 * happens today, and what §7.6 cannot afford: that read serves an ambient hook
 * required to fail open, so an uncaught parse error there does not degrade a
 * session's answer, it ends the session.
 *
 * @spec §3.1, §7.6, §11
 */
const ACCEPTABLE_LOCATOR_READINGS: readonly LocatorReading[] = [
  {
    write: 'refused by the table',
    refusal: null,
    locator: 'as the store wrote it',
    referent: 'as the store wrote it',
  },
  {
    write: 'landed in the column',
    refusal: null,
    locator: 'not handed back',
    referent: 'as the store wrote it',
  },
  {
    write: 'landed in the column',
    refusal: MINTED_REFUSAL,
    locator: 'nothing came back',
    referent: 'nothing came back',
  },
];

/** Replaces the opaque locator on the seeded referent. @spec §3.1, §3.5 */
const locatorUpdate = (literal: string): string =>
  `UPDATE entities SET locator = ${literal} WHERE id = '${ENTITY_ID}'`;

/**
 * What came back where the locator belongs.
 *
 * The seeded locator is an object, so a string or a `Buffer` arriving here is the
 * column's own bytes handed through unread — which is not a degrade but a
 * substitution: nothing downstream could tell it from a referent whose locator
 * genuinely is that text.
 *
 * @spec §3.1, §3.5
 */
const describeLocator = (referent: Entity): string => {
  if (!('locator' in referent)) return 'not handed back';
  const { locator } = referent;
  if (locator === undefined || locator === null) return 'not handed back';
  if (typeof locator === 'string' || Buffer.isBuffer(locator)) return 'the unparsed column contents';
  return JSON.stringify(locator) === JSON.stringify(LOCATOR)
    ? 'as the store wrote it'
    : 'something else again';
};

/** Corrupts the locator column from outside, then reads the referent back through the store. @spec §3.1 */
const readCorruptLocator = (literal: string): LocatorReading => {
  const write = describeWrite(rawStatement(locatorUpdate(literal)));
  const outcome = readOrError((store) => store.getEntity(ENTITY_ID));

  if (outcome instanceof Error)
    return {
      write,
      refusal: describeRefusal(outcome),
      locator: 'nothing came back',
      referent: 'nothing came back',
    };

  if (outcome === undefined)
    return {
      write,
      refusal: null,
      locator: 'nothing came back',
      referent: 'no referent at all',
    };

  return {
    write,
    refusal: null,
    locator: describeLocator(outcome),
    referent:
      referentBesidesLocator(outcome) === referentBesidesLocator(makeEntity())
        ? 'as the store wrote it'
        : 'some other column moved with it',
  };
};

/** The locator column of the seeded referent, and whether SQLite reads it as JSON. @spec §3.5 */
const locatorValidity = (): StoredColumn | undefined =>
  rawColumn(`
    SELECT typeof(locator) AS type, json_valid(locator) AS value
      FROM entities WHERE id = '${ENTITY_ID}'
  `);

/**
 * Locators the store writes today, which any fix has to keep writing and reading.
 *
 * A locator is opaque by declaration — `z.unknown().nullable()`, and migration 0
 * calls the column "another pack's locator is another shape entirely" — so the
 * legitimate set is every JSON value, not every object. The bare string is the
 * pointed one: `'not json'` is a perfectly good locator, and the column holds it
 * as `"not json"` with the quotes JSON gives it, so a write-boundary CHECK that
 * refused it would be refusing the encoded form rather than the corrupt one.
 *
 * @spec §3.1, §3.5
 */
const LEGITIMATE_LOCATORS: readonly { readonly description: string; readonly locator: unknown }[] = [
  { description: 'the nested code recipe the store already writes', locator: LOCATOR },
  {
    description: 'an array, which is JSON without being an object',
    locator: ['src/auth/index.ts', [1, 412], null],
  },
  { description: 'JSON null, which is a locator and not the absence of one', locator: null },
  {
    description: 'unicode a byte-oriented reader would mangle',
    locator: { path: 'src/auth/подпись.ts', note: '“smart quotes” — ünïcödé 🔐' },
  },
  { description: 'the empty object, which points nowhere in particular', locator: {} },
  {
    description: 'text that is not itself JSON, which the encode path quotes on the way in',
    locator: 'not json',
  },
];

/**
 * `entities.locator`, which migration 0 says is never parsed and the read path
 * parses.
 *
 * The column comment is unambiguous — "Opaque JSON. Never parsed, never queried,
 * never indexed" — and `getEntity` hands `row.locator` to `JSON.parse` with
 * nothing between them. Every other guard in this file exists because a column
 * with an affinity written beside it makes no promise; this one exists because a
 * column with a promise written beside it is not kept.
 *
 * It matters more here than on the columns above for two reasons. The failure is
 * an exception rather than a wrong value, so it is not the read that degrades but
 * the caller that stops; and the caller is §7.6's ambient hook, which the spec
 * requires to fail open. A hook that returns a thinner answer has done its job
 * badly. A hook that throws has ended a session.
 *
 * A view on which way this one should be fixed, since the two sites in these
 * last sections differ in kind: this one wants to degrade. A referent's locator
 * is a pointer into a pack's own world, read by nothing in §4 and scored by
 * nothing in §11 — the name, the gloss vector and the facets are what the hook
 * came for, and handing those back without a locator is exactly the "worse
 * answer" §7.6 asks for in place of a failure. A CHECK at the write boundary is
 * the better long-term shape and is what the rest of this file argues for, but it
 * cannot help a database that already holds a bad row, and this read path is the
 * one where that difference is a broken session.
 *
 * @spec §3.1, §3.5, §7.6, §11
 */
describe('the locator column, which is documented as never parsed and is parsed', () => {
  it.each(CORRUPT_JSON)('survives a locator that is $description', ({ literal }) => {
    expect(ACCEPTABLE_LOCATOR_READINGS).toContainEqual(readCorruptLocator(literal));
  });

  it.each(LEGITIMATE_LOCATORS)('round-trips a locator that is $description', ({ locator }) => {
    const referent = makeEntity({ locator });

    withStore((store) => {
      store.putEntity(referent);
    });

    expect(withStore((store) => store.getEntity(ENTITY_ID))).toStrictEqual(referent);
  });

  it.each(LEGITIMATE_LOCATORS)(
    'leaves JSON in the column for a locator that is $description',
    ({ locator }) => {
      withStore((store) => {
        store.putEntity(makeEntity({ locator }));
      });

      expect(locatorValidity()).toStrictEqual({ type: 'text', value: 1 });
    },
  );

  it('leaves the column SQL NULL for a referent that carries no locator at all', () => {
    withStore((store) => {
      store.putEntity(makeEntity({ locator: undefined }));
    });

    expect(locatorValidity()).toStrictEqual({ type: 'null', value: null });
  });

  it('keeps a JSON null locator apart from the absence of one, which is the whole reason to store text', () => {
    withStore((store) => {
      store.putEntity(makeEntity({ locator: null }));
    });

    expect(
      rawColumn(`
        SELECT typeof(locator) AS type, locator AS value
          FROM entities WHERE id = '${ENTITY_ID}'
      `),
    ).toStrictEqual({ type: 'text', value: 'null' });
  });
});

/**
 * The stage log's two payload columns, read the same unguarded way.
 *
 * `readStageLog` parses `inputs` on every row and `decision` on every row that
 * has one, with the same absence of a guard and the same threat model. The table
 * is append-only by discipline rather than by trigger, so a raw `UPDATE` reaches
 * it exactly as a raw `INSERT` would.
 *
 * The other half of the view. This site does *not* want to degrade. §5.8 exists
 * so §13 can replay a corpus and tune every ⚙ constant in §15 against it, and
 * §12 names threshold brittleness as the risk that logging mitigates. A tuning
 * run reads this table as evidence of what the pipeline did; an entry whose
 * `inputs` quietly came back as `undefined`, or whose `decision` came back as
 * `null`, is indistinguishable from a stage that honestly recorded nothing and
 * from a dedupe rejection with nothing downstream — so the corruption is not
 * merely tolerated, it is laundered into a data point. Constants get tuned
 * against it. Silence is worse than a throw here, because the caller is an
 * offline audit that can be re-run, not a hook that has to answer now.
 *
 * The assertions below still admit either choice, because that decision belongs
 * to the cycle that fixes this. What they do not admit is a corrupt row taking
 * the whole read down with a `SyntaxError`, and they do not admit the corrupt
 * entry silently vanishing from the returned list either: §5.8 promises order and
 * §13 replays it, and a log with a hole in it reorders nothing while
 * misrepresenting everything after the hole.
 *
 * @spec §5.8, §12, §13, §15
 */
const APPENDED_STAGES = ['dedupe', 'resolve', 'adjudicate'] as const;

/** The order those stages were appended in, which is the order §13 replays them in. @spec §5.8, §13 */
const APPEND_ORDER = APPENDED_STAGES.join(', ');

/** The entry in the middle, so a corrupt row always has an honest neighbour on each side. @spec §5.8 */
const CORRUPTED_STAGE = 'resolve';

/** The two payload columns `readStageLog` parses. @spec §5.8 */
type PayloadColumn = 'inputs' | 'decision';

/** One log entry, nested on both payload columns so a flattening read would show. @spec §5.8 */
const stageEntry = (stage: string): StageLogEntry => ({
  episodeId: EPISODE_ID,
  stage,
  inputs: { normalizedTextHash: 'sha256:1f0a9c4d', candidates: [CLAIM_ID, THIRD_CLAIM_ID] },
  decision: { verdict: 'SUPPORTS', weight: { tier: 1, episodeCap: 0.5, taint: 1 } },
  at: CREATED_AT,
});

/** The log as the store appended it. @spec §5.8, §13 */
const appendedLog = (): StageLogEntry[] => APPENDED_STAGES.map(stageEntry);

/** What a raw writer's payload did to a stage-log read, said in full. @spec §5.8, §13 */
interface StageLogReading {
  /** What the statement that corrupted the column actually did. */
  readonly write: string;
  /** The error the read raised, or `null` if it handed something back. */
  readonly refusal: string | null;
  /** The stages that came back, in the order they came back in. */
  readonly order: string;
  /** What arrived in the corrupted column of the corrupted entry. */
  readonly corrupted: string;
  /** Whether the two honest entries came back as they were appended. */
  readonly neighbours: string;
}

/** The readings a fix could produce here, on the same three-way choice. @spec §5.8, §13 */
const ACCEPTABLE_STAGE_LOG_READINGS: readonly StageLogReading[] = [
  {
    write: 'refused by the table',
    refusal: null,
    order: APPEND_ORDER,
    corrupted: 'as it was appended',
    neighbours: 'as they were appended',
  },
  {
    write: 'landed in the column',
    refusal: null,
    order: APPEND_ORDER,
    corrupted: 'not handed back',
    neighbours: 'as they were appended',
  },
  {
    write: 'landed in the column',
    refusal: MINTED_REFUSAL,
    order: 'nothing came back',
    corrupted: 'nothing came back',
    neighbours: 'nothing came back',
  },
];

/** Rewrites one payload column of the middle entry, from outside the store. @spec §5.8 */
const stageLogUpdate = (column: PayloadColumn, literal: string): string => `
  UPDATE stage_log SET ${column} = ${literal}
  WHERE episode_id = '${EPISODE_ID}' AND stage = '${CORRUPTED_STAGE}'
`;

/** What came back in the column a raw writer corrupted. @spec §5.8 */
const describePayload = (entry: StageLogEntry | undefined, column: PayloadColumn): string => {
  if (entry === undefined) return 'the entry itself did not come back';
  const value = entry[column];
  if (value === undefined || value === null) return 'not handed back';
  if (typeof value === 'string' || Buffer.isBuffer(value)) return 'the unparsed column contents';
  return JSON.stringify(value) === JSON.stringify(stageEntry(CORRUPTED_STAGE)[column])
    ? 'as it was appended'
    : 'something else again';
};

/** Whether the entries on either side of the corrupt one survived it whole. @spec §5.8, §13 */
const describeNeighbours = (entries: readonly StageLogEntry[]): string =>
  JSON.stringify(entries.filter((entry) => entry.stage !== CORRUPTED_STAGE)) ===
  JSON.stringify(appendedLog().filter((entry) => entry.stage !== CORRUPTED_STAGE))
    ? 'as they were appended'
    : 'not as they were appended';

/** Corrupts one payload column from outside, then reads the episode's log back. @spec §5.8, §13 */
const readCorruptStageLog = (column: PayloadColumn, literal: string): StageLogReading => {
  const write = describeWrite(rawStatement(stageLogUpdate(column, literal)));
  const outcome = readOrError((store) => store.readStageLog(EPISODE_ID));

  if (outcome instanceof Error)
    return {
      write,
      refusal: describeRefusal(outcome),
      order: 'nothing came back',
      corrupted: 'nothing came back',
      neighbours: 'nothing came back',
    };

  return {
    write,
    refusal: null,
    order: outcome.map((entry) => entry.stage).join(', '),
    corrupted: describePayload(
      outcome.find((entry) => entry.stage === CORRUPTED_STAGE),
      column,
    ),
    neighbours: describeNeighbours(outcome),
  };
};

/** How many appended rows hold something SQLite cannot read as JSON. @spec §5.8 */
const unreadableStageLogRows = (): StoredColumn | undefined =>
  rawColumn(`
    SELECT typeof(count(*)) AS type, count(*) AS value FROM stage_log
     WHERE json_valid(inputs) = 0
        OR (decision IS NOT NULL AND json_valid(decision) = 0)
  `);

describe('the stage-log payloads, parsed on the audit path §13 tunes constants against', () => {
  beforeEach(() => {
    withStore((store) => {
      for (const entry of appendedLog()) store.appendStageLog(entry);
    });
  });

  it.each(CORRUPT_JSON)('survives inputs that are $description', ({ literal }) => {
    expect(ACCEPTABLE_STAGE_LOG_READINGS).toContainEqual(readCorruptStageLog('inputs', literal));
  });

  it.each(CORRUPT_JSON)('survives a decision that is $description', ({ literal }) => {
    expect(ACCEPTABLE_STAGE_LOG_READINGS).toContainEqual(readCorruptStageLog('decision', literal));
  });

  it('returns every appended entry whole, in the order it was appended', () => {
    expect(withStore((store) => store.readStageLog(EPISODE_ID))).toStrictEqual(appendedLog());
  });

  it('keeps a stage that made no decision apart from one whose decision is a payload', () => {
    const undecided: StageLogEntry = { ...stageEntry('apply'), decision: null };

    withStore((store) => {
      store.appendStageLog(undecided);
    });

    expect(withStore((store) => store.readStageLog(EPISODE_ID))).toStrictEqual([
      ...appendedLog(),
      undecided,
    ]);
  });

  it('round-trips a payload of every JSON shape a stage might log', () => {
    const awkward: StageLogEntry = {
      ...stageEntry('retrieve'),
      inputs: { query: '“ünïcödé” 🔐', floors: [0.62, null, -1.5], nested: { deep: { deeper: [] } } },
      decision: null,
    };

    withStore((store) => {
      store.appendStageLog(awkward);
    });

    expect(withStore((store) => store.readStageLog(EPISODE_ID)).at(-1)).toStrictEqual(awkward);
  });

  it('leaves nothing in either payload column that SQLite cannot read as JSON', () => {
    expect(unreadableStageLogRows()).toStrictEqual({ type: 'integer', value: 0 });
  });
});
