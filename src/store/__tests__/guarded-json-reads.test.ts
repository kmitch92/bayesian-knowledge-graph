/**
 * The two JSON read guards, exercised on a database that already holds a bad row.
 *
 * `regime-table-check.test.ts` pins the write boundary: a `json_valid()` CHECK on
 * `entities.locator` and on both `stage_log` payload columns, met by a writer
 * that never touches this store. Every corrupt literal offered there is now
 * refused by the table, which is the right outcome and also the reason this file
 * exists — a refused write never reaches a read, so those twelve assertions pass
 * without the read path being run at all.
 *
 * The guards are the primary fix. A CHECK added in migration 0 today cannot
 * repair a row an older build already wrote, and the row that matters is exactly
 * that one: the file on disk from before the constraint, or from a writer that
 * had constraints suppressed. `getEntity` degrades over such a row because §7.6's
 * ambient hook is required to fail open; `readStageLog` refuses over it because
 * §13 tunes every ⚙ constant in §15 against that log and a payload that came back
 * empty would be tuned against as though a stage had honestly logged nothing.
 * Neither behaviour is reachable from a caller who goes through the table.
 *
 * `PRAGMA ignore_check_constraints = ON` is how the bad row gets here, and it is
 * the honest instrument rather than a convenient one. It is a *connection*
 * setting, stored nowhere in the file, so the row it leaves behind is
 * byte-identical to the row a build without the CHECK would have written and the
 * store's own connection is in no way party to it. The threat model this suite
 * has stated throughout — "a writer that is not this store" — is precisely a
 * writer whose constraints are not this table's, and a migration that a store
 * only ever wrote through its own CHECK could not produce a corrupt row *by
 * construction*, which would make the guards dead code rather than a fix.
 *
 * A temp file rather than `:memory:`, for this suite's usual reason: `:memory:`
 * opens a private, unshared database, and a second connection to one is a second
 * empty database.
 *
 * @spec §3.1, §3.5, §5.8, §7.6, §11, §12, §13
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CorruptStageLogError,
  openGraphStore,
  type GraphStore,
  type StageLogEntry,
} from '../index';

import {
  CREATED_AT,
  ENTITY_ID,
  EPISODE_ID,
  LOCATOR,
  OTHER_ENTITY_ID,
  STORE_RERANK_WIDTH,
  makeEntity,
  type EntityRecord,
} from './fixtures';

/** Byte width of a full-precision stored vector, so a raw INSERT can satisfy the width CHECK. @spec §11 */
const RERANK_BYTES = STORE_RERANK_WIDTH * Float32Array.BYTES_PER_ELEMENT;

/** What a statement offered to the table did: which constraint refused it, and how many rows moved. */
interface RawOutcome {
  readonly code: string | undefined;
  readonly changes: number;
}

/** A value offered to a JSON column, written as the SQL literal it arrives as. */
interface CorruptLiteral {
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

/** Opens the store on the same file and reads back what another writer left behind. @spec §11 */
const withStore = <T>(run: (store: GraphStore) => T): T => {
  const store: GraphStore = openGraphStore({ path: dbPath });
  try {
    return run(store);
  } finally {
    store.close();
  }
};

/** What a store read handed back, or the error it raised instead of handing anything back. @spec §11 */
const readOrError = <T>(read: (store: GraphStore) => T): T | Error =>
  withStore((store) => {
    try {
      return read(store);
    } catch (error) {
      return error as Error;
    }
  });

/** One statement offered to the table with its constraints intact, and what the table said. @spec §11 */
const underEnforcedChecks = (sql: string): RawOutcome =>
  withRawConnection((db) => {
    try {
      return { code: undefined, changes: db.prepare(sql).run().changes };
    } catch (error) {
      return { code: (error as { readonly code?: string }).code, changes: 0 };
    }
  });

/**
 * One statement from a writer whose CHECK constraints are not this table's, and
 * how many rows it moved.
 *
 * The pragma is set and cleared inside the one connection that needs it, and the
 * connection is closed before any store opens the file: nothing about the
 * suppression outlives this call or is visible to the read under test. The row
 * count comes back so a caller can fold it into its assertion — a corruption
 * test whose `WHERE` matched nothing leaves the column pristine, and an
 * assertion that only inspected the read would then report agreement with
 * nothing underneath it.
 *
 * @spec §11, §12
 */
const withChecksSuppressed = (sql: string): number =>
  withRawConnection((db) => {
    db.pragma('ignore_check_constraints = ON');
    try {
      return db.prepare(sql).run().changes;
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }
  });

/**
 * JSON columns as a writer that is not this store leaves them.
 *
 * The same four the write boundary refuses, kept here in the reader's terms. The
 * first two are a half-written or hand-edited value. The empty string is the one
 * a presence check misses — it is not SQL NULL, so every `IS NOT NULL` guard
 * admits it, and `JSON.parse('')` raises all the same. The blob is the one
 * affinity does not save anyone from: TEXT affinity leaves a blob exactly as it
 * arrived, so the column hands back a `Buffer` where the row type says `string`,
 * and `JSON.parse` stringifies it into three control characters before failing
 * on them. All four reach the guard as the identical event — a `SyntaxError`
 * from a parse the caller never asked for.
 *
 * @spec §3.1, §5.8
 */
const CORRUPT_JSON: readonly CorruptLiteral[] = [
  { description: 'text that was never JSON', literal: "'not json'" },
  { description: 'a half-written object, as a truncated write leaves one', literal: `'{"path":'` },
  { description: 'the empty string, which is present and still parses to nothing', literal: "''" },
  { description: 'a blob, which TEXT affinity does not convert', literal: "x'010203'" },
];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-mcp-guarded-reads-'));
  dbPath = join(directory, 'graph.db');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- *
 * §3.1 The locator, which degrades.
 * -------------------------------------------------------------------------- */

/** The same referent minus the locator key, which is what a degrade hands back. @spec §3.1 */
const withoutLocator = ({ locator, ...rest }: EntityRecord): Omit<EntityRecord, 'locator'> => rest;

/** What a store read made of a referent whose locator column another writer rewrote. @spec §3.1, §7.6 */
interface LocatorReading {
  /** Rows the outside writer actually changed. One, or the test corrupted nothing. */
  readonly wrote: number;
  /** The error the read raised, named by class, or `null` if it handed something back. */
  readonly refusal: string | null;
  /** The referent that came back, whole, so a column that moved with the locator shows. */
  readonly referent: unknown;
}

/** Replaces the seeded referent's locator from outside, then reads the referent back. @spec §3.1 */
const readLocatorAfter = (literal: string): LocatorReading => {
  const wrote = withChecksSuppressed(
    `UPDATE entities SET locator = ${literal} WHERE id = '${ENTITY_ID}'`,
  );
  const outcome = readOrError((store) => store.getEntity(ENTITY_ID));

  return outcome instanceof Error
    ? { wrote, refusal: outcome.constructor.name, referent: 'nothing came back' }
    : { wrote, refusal: null, referent: outcome };
};

/**
 * `entities.locator`, read back over bytes the CHECK would have refused.
 *
 * The degrade is the whole guarantee here, and it is a guarantee about a key
 * rather than about a value: the referent comes back without a `locator`
 * property at all, not with one set to `null`. A referent can honestly carry a
 * JSON `null` locator — the encode path takes trouble to keep that apart from
 * carrying none — so a guard that collapsed unreadable bytes onto `null` would
 * be inventing a locator the pack never wrote, and no caller downstream could
 * tell the invention from the real thing.
 *
 * Every assertion compares the whole referent rather than the locator alone,
 * because "dropped the locator" and "dropped the locator and the gloss vector
 * with it" are different outcomes and only a whole-row comparison separates
 * them.
 *
 * @spec §3.1, §3.5, §7.6
 */
describe('a locator this store could not have written, on the read §7.6 must not lose', () => {
  beforeEach(() => {
    withStore((store) => {
      store.putEntity(makeEntity());
    });
  });

  it.each(CORRUPT_JSON)('hands back a referent with no locator when it holds $description', ({ literal }) => {
    expect(readLocatorAfter(literal)).toStrictEqual({
      wrote: 1,
      refusal: null,
      referent: withoutLocator(makeEntity()),
    });
  });

  it('keeps a JSON null locator apart from bytes it could not read, in both directions', () => {
    withStore((store) => {
      store.putEntity(makeEntity({ locator: null }));
    });

    const honest = readOrError((store) => store.getEntity(ENTITY_ID));
    const wrote = withChecksSuppressed(
      `UPDATE entities SET locator = 'not json' WHERE id = '${ENTITY_ID}'`,
    );
    const unreadable = readOrError((store) => store.getEntity(ENTITY_ID));

    expect({ honest, wrote, unreadable }).toStrictEqual({
      honest: makeEntity({ locator: null }),
      wrote: 1,
      unreadable: withoutLocator(makeEntity()),
    });
  });

  it('degrades to the referent a locator was never written for, rather than to a third thing', () => {
    withStore((store) => {
      store.putEntity(makeEntity({ locator: undefined }));
    });

    const absent = readOrError((store) => store.getEntity(ENTITY_ID));

    withStore((store) => {
      store.putEntity(makeEntity());
    });
    withChecksSuppressed(`UPDATE entities SET locator = '' WHERE id = '${ENTITY_ID}'`);

    expect(readOrError((store) => store.getEntity(ENTITY_ID))).toStrictEqual(absent);
  });

  it('still parses a locator it can read, so the guard is not a blanket refusal to look', () => {
    expect(readOrError((store) => store.getEntity(ENTITY_ID))).toStrictEqual(
      makeEntity({ locator: LOCATOR }),
    );
  });
});

/* -------------------------------------------------------------------------- *
 * §5.8 The stage-log payloads, which refuse.
 * -------------------------------------------------------------------------- */

/**
 * The stages the log is seeded with, `resolve` twice.
 *
 * The repeat is the point. `episode_id` and `stage` together do not identify a
 * row — a stage may run more than once in an episode — so a refusal that named
 * only those two would leave an operator holding two candidate rows and no way
 * to tell which of them holds the damage. Corrupting the second run and
 * demanding the refusal name *that* row is the only assertion that can tell a
 * primary key apart from a plausible-looking pair.
 *
 * @spec §5.8, §13
 */
const APPENDED_STAGES = ['dedupe', 'resolve', 'resolve', 'adjudicate'] as const;

/** The stage that ran twice, whose second run gets the corrupt payload. @spec §5.8 */
const REPEATED_STAGE = 'resolve';

/** The order the log was appended in, which is the order §13 replays it in. @spec §5.8, §13 */
const APPEND_ORDER = APPENDED_STAGES.join(', ');

/** One log entry, nested on both payload columns so a flattening read would show. @spec §5.8 */
const stageEntry = (stage: string): StageLogEntry => ({
  episodeId: EPISODE_ID,
  stage,
  inputs: { normalizedTextHash: 'sha256:1f0a9c4d', candidates: ['AuthService'] },
  decision: { verdict: 'SUPPORTS', weight: { tier: 1, episodeCap: 0.5, taint: 1 } },
  at: CREATED_AT,
});

/** The log as the store appended it. @spec §5.8 */
const appendedLog = (): StageLogEntry[] => APPENDED_STAGES.map(stageEntry);

/** The `stage_log` primary keys of the repeated stage's two runs, in append order. @spec §5.8 */
const repeatedStageRowIds = (): readonly number[] =>
  withRawConnection((db) =>
    db
      .prepare<[], { readonly id: number }>(
        `SELECT id FROM stage_log
          WHERE episode_id = '${EPISODE_ID}' AND stage = '${REPEATED_STAGE}'
          ORDER BY id`,
      )
      .all()
      .map((row) => row.id),
  );

/**
 * Which run of the repeated stage a refusal named, in terms only a primary key
 * can satisfy.
 *
 * @spec §5.8
 */
const nameRun = (rowId: number, ids: readonly number[]): string => {
  if (rowId === ids[0]) return 'the first run, which is not the corrupt one';
  if (rowId === ids[1]) return 'the corrupted second run';
  return 'a row that is neither run of the stage';
};

/** What a store read made of a log whose middle payload another writer rewrote. @spec §5.8, §13 */
interface StageLogReading {
  /** Rows the outside writer actually changed. */
  readonly wrote: number;
  /** How many times the repeated stage ran, so an unambiguous fixture cannot pass for an ambiguous one. */
  readonly runs: number;
  /** The error the read raised, named by class, or `null` if it handed something back. */
  readonly refusal: string | null;
  /** The episode the refusal named. */
  readonly episode: string | null;
  /** The stage the refusal named. */
  readonly stage: string | null;
  /** The row the refusal named, as a run of that stage. */
  readonly row: string | null;
  /** Which payload column the refusal named. */
  readonly column: string | null;
  /** The stages that came back, in the order they came back in. */
  readonly entries: string;
}

/** Rewrites one payload column of the repeated stage's second run, then reads the log back. @spec §5.8 */
const readStageLogAfter = (column: 'inputs' | 'decision', literal: string): StageLogReading => {
  const ids = repeatedStageRowIds();
  const wrote = withChecksSuppressed(`
    UPDATE stage_log SET ${column} = ${literal}
     WHERE id = (SELECT max(id) FROM stage_log
                  WHERE episode_id = '${EPISODE_ID}' AND stage = '${REPEATED_STAGE}')
  `);
  const outcome = readOrError((store) => store.readStageLog(EPISODE_ID));
  const nothing = { episode: null, stage: null, row: null, column: null };

  if (outcome instanceof CorruptStageLogError)
    return {
      wrote,
      runs: ids.length,
      refusal: 'CorruptStageLogError',
      episode: outcome.episodeId,
      stage: outcome.stage,
      row: nameRun(outcome.rowId, ids),
      column: outcome.column,
      entries: 'nothing came back',
    };

  if (outcome instanceof Error)
    return {
      wrote,
      runs: ids.length,
      refusal: outcome.constructor.name,
      ...nothing,
      entries: 'nothing came back',
    };

  return {
    wrote,
    runs: ids.length,
    refusal: null,
    ...nothing,
    entries: outcome.map((entry) => entry.stage).join(', '),
  };
};

/** The refusal a payload column produced, for the assertions that inspect one directly. @spec §5.8 */
const refusalFrom = (column: 'inputs' | 'decision', literal: string): unknown => {
  withChecksSuppressed(`
    UPDATE stage_log SET ${column} = ${literal}
     WHERE id = (SELECT max(id) FROM stage_log
                  WHERE episode_id = '${EPISODE_ID}' AND stage = '${REPEATED_STAGE}')
  `);
  return readOrError((store) => store.readStageLog(EPISODE_ID));
};

/**
 * `stage_log.inputs` and `stage_log.decision`, read back over bytes the CHECK
 * would have refused.
 *
 * The mirror image of the locator, one table over, and the asymmetry is the
 * argument. Degrading here does not tolerate the corruption, it launders it:
 * `appendStageLog` writes a JSON `null` decision for a stage that decided
 * nothing — a dedupe rejection every time — so an entry whose payload quietly
 * came back empty is indistinguishable from a stage that honestly recorded
 * nothing, and §13 then tunes §15's constants against it.
 *
 * Dropping the entry instead is refused for a second reason the assertions state
 * separately: §5.8 promises order and §13 replays it, so a log with a hole in it
 * reorders nothing while misrepresenting everything after the hole. A read that
 * returned the three honest entries would look perfectly ordered and be a lie,
 * which is why `entries` is compared rather than merely counted.
 *
 * @spec §5.8, §12, §13, §15
 */
describe('a stage-log payload this store could not have written, on §13’s audit path', () => {
  beforeEach(() => {
    withStore((store) => {
      for (const entry of appendedLog()) store.appendStageLog(entry);
    });
  });

  it.each(CORRUPT_JSON)('refuses the whole read when inputs hold $description', ({ literal }) => {
    expect(readStageLogAfter('inputs', literal)).toStrictEqual({
      wrote: 1,
      runs: 2,
      refusal: 'CorruptStageLogError',
      episode: EPISODE_ID,
      stage: REPEATED_STAGE,
      row: 'the corrupted second run',
      column: 'inputs',
      entries: 'nothing came back',
    });
  });

  it.each(CORRUPT_JSON)('refuses the whole read when a decision holds $description', ({ literal }) => {
    expect(readStageLogAfter('decision', literal)).toStrictEqual({
      wrote: 1,
      runs: 2,
      refusal: 'CorruptStageLogError',
      episode: EPISODE_ID,
      stage: REPEATED_STAGE,
      row: 'the corrupted second run',
      column: 'decision',
      entries: 'nothing came back',
    });
  });

  it('keeps the parse failure as the cause, which is the detail a bare refusal loses', () => {
    const refusal = refusalFrom('inputs', "'{\"stage\":'");

    expect({
      named: refusal instanceof CorruptStageLogError,
      cause: (refusal as Error | undefined)?.cause instanceof SyntaxError,
    }).toStrictEqual({ named: true, cause: true });
  });

  it('names a row an operator can go to, rather than a pair two rows answer to', () => {
    const ids = repeatedStageRowIds();
    const refusal = refusalFrom('inputs', "'not json'");

    expect({
      runs: ids.length,
      identifiesOneRow: refusal instanceof CorruptStageLogError && ids.includes(refusal.rowId),
      isTheCorruptRun:
        refusal instanceof CorruptStageLogError && nameRun(refusal.rowId, ids) === 'the corrupted second run',
    }).toStrictEqual({ runs: 2, identifiesOneRow: true, isTheCorruptRun: true });
  });

  it('returns every appended entry whole and in order while every payload is readable', () => {
    expect(readOrError((store) => store.readStageLog(EPISODE_ID))).toStrictEqual(appendedLog());
  });

  it('reads the honest entries back once the corrupt row is repaired, so the refusal is about the row', () => {
    refusalFrom('inputs', "'not json'");
    withChecksSuppressed(`
      UPDATE stage_log SET inputs = '{"normalizedTextHash":"sha256:1f0a9c4d","candidates":["AuthService"]}'
       WHERE id = (SELECT max(id) FROM stage_log
                    WHERE episode_id = '${EPISODE_ID}' AND stage = '${REPEATED_STAGE}')
    `);

    expect(readOrError((store) => store.readStageLog(EPISODE_ID))).toStrictEqual(appendedLog());
  });

  it('leaves the order of the log alone, which is the only reason a hole in it would be visible', () => {
    expect(readStageLogAfter('inputs', "'not json'").entries).not.toBe(
      APPENDED_STAGES.filter((_, index) => index !== 2).join(', '),
    );
    expect(APPEND_ORDER).toBe('dedupe, resolve, resolve, adjudicate');
  });
});

/* -------------------------------------------------------------------------- *
 * The write boundary the guards sit behind.
 * -------------------------------------------------------------------------- */

/** The three columns a `json_valid()` CHECK stands on, and how an outside writer reaches each. @spec §3.1, §5.8 */
const JSON_COLUMNS: readonly {
  readonly column: string;
  readonly update: (literal: string) => string;
}[] = [
  {
    column: 'a referent locator',
    update: (literal) => `UPDATE entities SET locator = ${literal} WHERE id = '${ENTITY_ID}'`,
  },
  {
    column: 'stage-log inputs',
    update: (literal) =>
      `UPDATE stage_log SET inputs = ${literal} WHERE episode_id = '${EPISODE_ID}'`,
  },
  {
    column: 'a stage-log decision',
    update: (literal) =>
      `UPDATE stage_log SET decision = ${literal} WHERE episode_id = '${EPISODE_ID}'`,
  },
];

/** Every corrupt literal against every guarded column. @spec §3.1, §5.8 */
const REFUSED_WRITES = JSON_COLUMNS.flatMap(({ column, update }) =>
  CORRUPT_JSON.map(({ description, literal }) => ({ column, description, sql: update(literal) })),
);

/**
 * The `json_valid()` CHECKs, asserted as the boundary this fix actually chose.
 *
 * `regime-table-check.test.ts` reaches the same three columns and deliberately
 * admits any of three outcomes on each, because it was written while the shape
 * of the fix was still open: a CHECK, a guarded read, or a refusal by type all
 * satisfy it. That permissiveness was right then and is a hole now — with the
 * fix chosen, every one of those twelve assertions passes just as happily with
 * the CHECKs deleted from migration 0, so nothing in the suite notices their
 * removal.
 *
 * These do. A refusal is asserted by extended result code, so a `WHERE` that
 * matched no row cannot pass for one: an unmatched statement reports no code at
 * all rather than this one.
 *
 * The other direction — that the CHECK is not *over*-tight, and still admits a
 * bare JSON string, an array, a `null` and the unicode a pack may put in a
 * locator — belongs to the round-trip assertions in the sibling file, which fail
 * loudly if the constraint ever grows past `json_valid`.
 *
 * @spec §3.1, §5.8, §11, §12
 */
describe('the json_valid boundary, which stops the next writer leaving a row like these', () => {
  beforeEach(() => {
    withStore((store) => {
      store.putEntity(makeEntity());
      store.appendStageLog(stageEntry('dedupe'));
    });
  });

  it.each(REFUSED_WRITES)('refuses $column holding $description', ({ sql }) => {
    expect(underEnforcedChecks(sql)).toStrictEqual({
      code: 'SQLITE_CONSTRAINT_CHECK',
      changes: 0,
    });
  });

  it.each(JSON_COLUMNS)('leaves $column as the store wrote it after a refusal', ({ update }) => {
    underEnforcedChecks(update("'not json'"));

    expect(readOrError((store) => store.readStageLog(EPISODE_ID))).toStrictEqual([
      stageEntry('dedupe'),
    ]);
    expect(readOrError((store) => store.getEntity(ENTITY_ID))).toStrictEqual(makeEntity());
  });
});

/* -------------------------------------------------------------------------- *
 * The absences both CHECKs have to admit.
 * -------------------------------------------------------------------------- */

/**
 * A referent with no locator at all, and a stage that logged no decision.
 *
 * Both columns are nullable and both nulls are ordinary: a referent minted from
 * a mention points at nothing, and a stage that decided nothing is the common
 * case. `json_valid(NULL)` is NULL rather than 0, and SQLite passes a CHECK whose
 * expression is NULL, so the admission asserted here is *not* proof that the
 * `IS NULL` arms are doing work — a CHECK written without them admits these rows
 * too. What the arms buy is that the intent is stated where the constraint is,
 * and what these tests buy is the other direction: an arm rewritten to
 * `locator IS NOT NULL AND json_valid(locator)`, or a guard that treated SQL NULL
 * as bytes to parse, fails here rather than in production.
 *
 * @spec §3.1, §5.8
 */
describe('the absent locator and the absent decision, which both CHECKs admit', () => {
  // Migration 0 has to have run before another writer can offer either table a
  // row: an outside connection to a path no store has opened is a connection to
  // an empty database, and every INSERT below would be refused for having no
  // table rather than for the constraint under test.
  beforeEach(() => {
    withStore(() => undefined);
  });

  it('admits a referent row whose locator column is SQL NULL', () => {
    expect(
      underEnforcedChecks(`
        INSERT INTO entities (id, name, level, regime, locator, gloss_embedding)
        VALUES ('${OTHER_ENTITY_ID}', 'CognitoClient', NULL, 'evidence', NULL,
                zeroblob(${String(RERANK_BYTES)}))
      `),
    ).toStrictEqual({ code: undefined, changes: 1 });
  });

  it('hands that referent back without a locator key rather than raising over its NULL', () => {
    underEnforcedChecks(`
      INSERT INTO entities (id, name, level, regime, locator, gloss_embedding)
      VALUES ('${OTHER_ENTITY_ID}', 'CognitoClient', NULL, 'evidence', NULL,
              zeroblob(${String(RERANK_BYTES)}))
    `);

    expect(readOrError((store) => store.getEntity(OTHER_ENTITY_ID))).toStrictEqual({
      id: OTHER_ENTITY_ID,
      name: 'CognitoClient',
      level: null,
      regime: 'evidence',
      glossEmbedding: Array.from<number>({ length: STORE_RERANK_WIDTH }).fill(0),
      facets: [],
    });
  });

  it('admits a stage-log row whose decision column is SQL NULL', () => {
    withStore((store) => {
      store.appendStageLog(stageEntry('dedupe'));
    });

    expect(
      underEnforcedChecks(`
        INSERT INTO stage_log (episode_id, stage, inputs, decision, at)
        VALUES ('${EPISODE_ID}', 'apply', '{"applied":false}', NULL, '${CREATED_AT}')
      `),
    ).toStrictEqual({ code: undefined, changes: 1 });
  });

  it('reads a SQL NULL decision as a stage that decided nothing, not as a payload to parse', () => {
    withStore((store) => {
      store.appendStageLog(stageEntry('dedupe'));
    });
    underEnforcedChecks(`
      INSERT INTO stage_log (episode_id, stage, inputs, decision, at)
      VALUES ('${EPISODE_ID}', 'apply', '{"applied":false}', NULL, '${CREATED_AT}')
    `);

    expect(readOrError((store) => store.readStageLog(EPISODE_ID))).toStrictEqual([
      stageEntry('dedupe'),
      {
        episodeId: EPISODE_ID,
        stage: 'apply',
        inputs: { applied: false },
        decision: null,
        at: CREATED_AT,
      },
    ]);
  });
});
