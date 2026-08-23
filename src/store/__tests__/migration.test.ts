/**
 * Migration 0, and the version stamp nothing currently reads back.
 *
 * `PRAGMA user_version` is the only record a SQLite file keeps of which schema
 * it is. The store writes it and then never asserts it, which leaves two
 * behaviours unpinned — one benign, one not.
 *
 * The benign one is re-entrancy: opening an already-migrated database must be a
 * no-op that finds the schema and the data exactly as they were left, and
 * several processes opening a *fresh* database at once must produce one migrated
 * schema rather than a race. §11 writes the guard for exactly that case, and in
 * v1 the case is ordinary — one MCP server per session plus git hooks shelling
 * out to the same binary, all starting against one file.
 *
 * The one that is not benign is the other direction. A `user_version` *above*
 * {@link SCHEMA_VERSION} means the file was written by a build that knows a
 * schema this one does not, and today the guard's `>=` lets that through
 * silently: the older binary skips migration, finds the tables it expects, and
 * starts writing. Every column the newer schema added is one this build never
 * populates, and every constraint it added is one this build never satisfies —
 * so the damage is not a crash the user can see, it is a ledger that quietly
 * stops meaning what the newer build thinks it means. A store that refuses to
 * open is recoverable; one that half-writes a future schema is not.
 *
 * `user_version` is read back through a plain better-sqlite3 connection, because
 * it is a property of the *file* rather than of the port — the point of these
 * assertions is what a different build would find on disk.
 *
 * @spec §5.7, §11
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  openGraphStore,
  type GraphStore,
} from '../index';

import { CLAIM_ID, ENTITY_ID, makeClaim, makeEntity, unitVector } from './fixtures';
import { releaseTogether, spawnWorker, type Worker } from './worker-harness';

/** How many processes race to migrate one fresh database. Three beats two: it also catches a guard that only serializes pairs. @spec §11 */
const RACING_OPENERS = 3;

/** The version a build one migration ahead of this one would leave behind. @spec §11 */
const FUTURE_VERSION = SCHEMA_VERSION + 1;

/**
 * How long the other process keeps the fresh database to itself.
 *
 * The deterministic sibling of the barrier race below. Two processes arriving
 * at `openGraphStore` in the same millisecond is a coin toss; one process
 * holding the write lock while the other opens is the same collision, forced.
 *
 * @spec §5.7, §11
 */
const BRIEF_HOLD_MS = 500;

const openerPath = fileURLToPath(new URL('./open-worker.ts', import.meta.url));
const holderPath = fileURLToPath(new URL('./lock-holder-worker.ts', import.meta.url));

let directory: string;
let dbPath: string;
let holder: Worker | undefined;

/** Reads the schema stamp a different build would find on this file. @spec §11 */
const readUserVersion = (path: string): number => {
  const db = new Database(path);
  try {
    return Number(db.pragma('user_version', { simple: true }));
  } finally {
    db.close();
  }
};

/** Stamps a schema version onto the file, standing in for a build that is not this one. @spec §11 */
const writeUserVersion = (path: string, version: number): void => {
  const db = new Database(path);
  try {
    db.pragma(`user_version = ${String(version)}`);
  } finally {
    db.close();
  }
};

/**
 * Opens a store that is expected to be refused, and hands back the refusal.
 *
 * `undefined` when the open succeeded, which is the shape of the gap this file
 * closes: opening a future schema returns a working store today.
 *
 * @spec §11
 */
const refusalFromOpening = (path: string): unknown => {
  try {
    openGraphStore({ path }).close();
  } catch (error) {
    return error;
  }
  return undefined;
};

/** Seeds one entity and one claim, so "the data survived" is something a read can answer. @spec §3.1, §3.2 */
const seed = (path: string): void => {
  const store = openGraphStore({ path });
  try {
    store.putEntity(makeEntity());
    store.putClaim(makeClaim());
  } finally {
    store.close();
  }
};

/** Spawns a second process that takes the write lock on the given path and keeps it. @spec §5.7 */
const holdWriteLock = async (path: string, holdMs: number): Promise<void> => {
  const worker = spawnWorker(holderPath, [path, String(holdMs)]);
  holder = worker;
  if (!(await worker.ready)) throw new Error(`the lock holder died: ${(await worker.done).stderr}`);
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-mcp-migration-'));
  dbPath = join(directory, 'graph.db');
  holder = undefined;
});

afterEach(async () => {
  if (holder !== undefined) {
    holder.kill();
    await holder.done;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('a database this build has just migrated', () => {
  it('carries the schema version this build supports', () => {
    openGraphStore({ path: dbPath }).close();

    expect(readUserVersion(dbPath)).toBe(SCHEMA_VERSION);
  });

  it('is usable the moment it is open', () => {
    const store = openGraphStore({ path: dbPath });
    try {
      store.putEntity(makeEntity());
      store.putClaim(makeClaim());

      expect(store.getClaim(CLAIM_ID)).toStrictEqual(makeClaim());
    } finally {
      store.close();
    }
  });
});

describe('reopening a database that has already been migrated', () => {
  beforeEach(() => {
    seed(dbPath);
  });

  it('opens cleanly, because migration 0 is not attempted a second time', () => {
    expect(() => openGraphStore({ path: dbPath }).close()).not.toThrow();
  });

  it('leaves the schema version exactly where the first open put it', () => {
    openGraphStore({ path: dbPath }).close();

    expect(readUserVersion(dbPath)).toBe(SCHEMA_VERSION);
  });

  it('finds everything that was written before it', () => {
    const store = openGraphStore({ path: dbPath });
    try {
      expect(store.getClaim(CLAIM_ID)).toStrictEqual(makeClaim());
    } finally {
      store.close();
    }
  });

  it('survives being opened repeatedly without accumulating anything', () => {
    for (let open = 0; open < 3; open += 1) openGraphStore({ path: dbPath }).close();

    const store = openGraphStore({ path: dbPath });
    try {
      expect([store.getEntity(ENTITY_ID), store.getClaim(CLAIM_ID)]).toStrictEqual([
        makeEntity(),
        makeClaim(),
      ]);
    } finally {
      store.close();
    }
  });
});

describe('opening a fresh database another process is already writing to', () => {
  it('waits for that writer rather than giving up on the spot, because §5.7 makes a collision a wait', async () => {
    await holdWriteLock(dbPath, BRIEF_HOLD_MS);

    expect(() => openGraphStore({ path: dbPath }).close()).not.toThrow();
  });

  it('comes back with a migrated schema once the writer lets go', async () => {
    await holdWriteLock(dbPath, BRIEF_HOLD_MS);

    const store = openGraphStore({ path: dbPath });
    try {
      store.putEntity(makeEntity());
      store.putClaim(makeClaim());

      expect(store.getClaim(CLAIM_ID)).toStrictEqual(makeClaim());
    } finally {
      store.close();
    }
  });

  it('still settles into WAL, which is the whole reason those two processes can share the file', async () => {
    await holdWriteLock(dbPath, BRIEF_HOLD_MS);

    const store = openGraphStore({ path: dbPath });
    try {
      expect(store.journalMode).toBe('wal');
    } finally {
      store.close();
    }
  });
});

describe('several processes opening one fresh database at the same instant', () => {
  it(
    'lets every one of them through, rather than failing the losers of the race',
    { timeout: 60_000 },
    async () => {
      const openers = Array.from({ length: RACING_OPENERS }, () =>
        spawnWorker(openerPath, [dbPath]),
      );

      const outcomes = await releaseTogether(openers);

      expect(outcomes.map((outcome) => outcome.stderr).join('')).toBe('');
      expect(outcomes.map((outcome) => outcome.code)).toStrictEqual(
        Array.from({ length: RACING_OPENERS }, () => 0),
      );
    },
  );

  it(
    'leaves exactly one migrated schema behind, at the supported version',
    { timeout: 60_000 },
    async () => {
      const openers = Array.from({ length: RACING_OPENERS }, () =>
        spawnWorker(openerPath, [dbPath]),
      );

      await releaseTogether(openers);

      expect(readUserVersion(dbPath)).toBe(SCHEMA_VERSION);
    },
  );

  it(
    'leaves a whole schema rather than a half-applied one',
    { timeout: 60_000 },
    async () => {
      const openers = Array.from({ length: RACING_OPENERS }, () =>
        spawnWorker(openerPath, [dbPath]),
      );
      await releaseTogether(openers);

      const store: GraphStore = openGraphStore({ path: dbPath });
      try {
        store.putEntity(makeEntity());
        store.putClaim(makeClaim());
        store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

        expect(
          store
            .searchClaims({ embedding: unitVector(10), limit: 5 })
            .map((hit) => hit.claimId),
        ).toStrictEqual([CLAIM_ID]);
      } finally {
        store.close();
      }
    },
  );
});

describe('a database written by a build one schema ahead of this one', () => {
  beforeEach(() => {
    seed(dbPath);
    writeUserVersion(dbPath, FUTURE_VERSION);
  });

  it('is refused under a name that says what went wrong', () => {
    const refusal = refusalFromOpening(dbPath);

    expect((refusal as Error | undefined)?.name).toBe('UnsupportedSchemaVersionError');
  });

  it('is refused rather than opened against a schema this build does not know', () => {
    const refusal = refusalFromOpening(dbPath);

    expect(refusal).toBeInstanceOf(UnsupportedSchemaVersionError);
  });

  it('reports the version it found and the version this build supports', () => {
    const refusal = refusalFromOpening(dbPath);

    expect({
      found: (refusal as UnsupportedSchemaVersionError | undefined)?.found,
      supported: (refusal as UnsupportedSchemaVersionError | undefined)?.supported,
    }).toStrictEqual({ found: FUTURE_VERSION, supported: SCHEMA_VERSION });
  });

  it('refuses without writing anything, so the newer build finds its store intact', () => {
    refusalFromOpening(dbPath);
    writeUserVersion(dbPath, SCHEMA_VERSION);

    const store = openGraphStore({ path: dbPath });
    try {
      expect(store.getClaim(CLAIM_ID)).toStrictEqual(makeClaim());
    } finally {
      store.close();
    }
  });

  it('leaves the future version stamp alone, rather than downgrading the file', () => {
    refusalFromOpening(dbPath);

    expect(readUserVersion(dbPath)).toBe(FUTURE_VERSION);
  });

  it('still opens a database stamped at exactly the supported version', () => {
    writeUserVersion(dbPath, SCHEMA_VERSION);

    const store = openGraphStore({ path: dbPath });
    try {
      expect(store.getClaim(CLAIM_ID)).toStrictEqual(makeClaim());
    } finally {
      store.close();
    }
  });
});
