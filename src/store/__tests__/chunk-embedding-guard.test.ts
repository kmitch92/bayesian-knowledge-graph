/**
 * `document_chunks.embedding`: the one vector column in this schema with no
 * guard on it.
 *
 * Every other f32 column migration 0 declares carries the same two-clause CHECK
 * — `entities.gloss_embedding`, `entities.facets`, `claims.embedding` — and each
 * carries a comment explaining why. The argument is the same every time:
 *
 *   *"`BLOB` above declares an affinity, and BLOB affinity is the one that
 *   converts nothing — text stays text, an integer stays an integer. Both then
 *   reach `decodeFloatVector`, which copies through `bytes.set(blob)`: over text
 *   that raises at read time, and over a number it reads no `byteLength` at all
 *   and yields an empty vector, so the referent loses its anchor geometry with
 *   nothing raised anywhere."*
 *
 * and, on the width clause:
 *
 *   *"`typeof = 'blob'` alone still admits `zeroblob(7)`, which decodes to a
 *   one-component vector that scores against 768-component ones as though it
 *   belonged beside them."*
 *
 * Neither sentence is about referents. Both are about what a blob column does to
 * a vector, and a chunk embedding is a vector — §5.10 makes it one third of
 * ingest (*"chunk, embed, anchor"*) and the thing that lets a document serve
 * whole and immediately. A chunk whose embedding decoded to seven bytes of zeros
 * would be retrieved beside real ones, scored, and served; a chunk whose
 * embedding is the text `'pending'` would raise at read time, on the serving
 * path, for a document that ingested cleanly a week earlier.
 *
 * So the guard belongs, and this file is the assertion that it does. It is not
 * a copy of the entity guard, because the column is not the same column: this
 * one is **nullable**, and the null has to stay legal. A referent with no gloss
 * vector has lost the only thing §5.2's last rung can reach it by. A chunk with
 * no vector is still ordered, still anchored by its hash, still served with its
 * document and still extractable from — §3.6 anchors a chunk by content, not by
 * geometry. The guard therefore reads
 *
 *   `embedding IS NULL OR (typeof(embedding) = 'blob' AND length(...) = ...)`
 *
 * — absent, or a real one; never a short one, and never a string.
 *
 * Reached from outside the store, exactly as `mention-weight.test.ts` and
 * `regime-table-check.test.ts` reach the columns whose CHECKs make the same
 * argument: the claim under test is about the file on disk and the promise it
 * makes to any future writer that is not this store, so a prepared statement of
 * ours anywhere in the path would be the store keeping its own promise instead.
 *
 * A temp file rather than `:memory:`, because `:memory:` opens a private
 * database and a second connection to one is a second empty database.
 *
 * Foreign keys are deliberately *not* exercised here, and not because they are
 * off: this driver is built with `SQLITE_DEFAULT_FOREIGN_KEYS=1`, so every
 * connection below enforces them without being asked, `withStore` and
 * `withRawConnection` alike. That is a fact about better-sqlite3 rather than
 * about SQLite, whose own default is off — which is the whole reason the cascade
 * is worth pinning against the *store* rather than against this file. It is, in
 * `document-store.test.ts`, where the store is in the path.
 *
 * @spec §3.6, §5.10, §11, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraphStore, type GraphStore } from '../index';

import { CREATED_AT, ENTITY_ID, STORE_RERANK_WIDTH, testUlid } from './fixtures';

/** The extended result code SQLite reports when a table CHECK refuses a write. */
const CHECK_VIOLATION = 'SQLITE_CONSTRAINT_CHECK';

/** The extended result code SQLite reports when a UNIQUE index refuses a write. */
const UNIQUE_VIOLATION = 'SQLITE_CONSTRAINT_UNIQUE';

/** Bytes in one stored f32 vector — what `{{RERANK_BYTES}}` substitutes to. @spec §11 */
const RERANK_BYTES = STORE_RERANK_WIDTH * Float32Array.BYTES_PER_ELEMENT;

/** The document the chunks under test belong to. @spec §3.6 */
const DOCUMENT_ID = testUlid('DOC-ADR-0007');

/** A second document, for the ordinal that is unique per document and not globally. @spec §3.6 */
const OTHER_DOCUMENT_ID = testUlid('DOC-RUNBOOK-FAILOVER');

/** The ordinal seeded before each test, holding a legitimate embedding. @spec §3.6 */
const SEEDED_ORDINAL = 0;

/** The ordinal every offered chunk in this file is written at. @spec §3.6 */
const OFFERED_ORDINAL = 1;

/** @spec §3.6 */
const SEEDED_HASH = 'sha256:1f0a9c4d2b6e8f3a';

/** @spec §3.6 */
const OFFERED_HASH = 'sha256:7c3e5b81d0a24f96';

/** One column of one row, as its storage class and its size rather than its contents. */
interface StoredBlob {
  readonly type: string;
  /** `length()` over a blob counts bytes, over text characters, and over null is null. */
  readonly bytes: number | null;
}

/** What a statement did: which constraint refused it, or how many rows moved. */
interface RawOutcome {
  readonly code: string | undefined;
  readonly changes: number;
}

/** A value offered to a column, written as the SQL literal it arrives as. */
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

/** Opens a store on the same file, which is what puts migration 0 into it. @spec §11 */
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

/** Offers a document row with the given origin literal. @spec §3.6 */
const documentInsert = (id: string, origin: string): string => `
  INSERT INTO documents (id, title, origin, content_ref, scope, created_at)
  VALUES ('${id}', 'ADR 0007', ${origin}, 'docs/adr/0007.md', '${ENTITY_ID}', '${CREATED_AT}')
`;

/** Rewrites the origin of the seeded document. @spec §3.6 */
const originUpdate = (origin: string): string =>
  `UPDATE documents SET origin = ${origin} WHERE id = '${DOCUMENT_ID}'`;

/** Offers a chunk row with the given embedding literal. @spec §3.6 */
const chunkInsert = (
  documentId: string,
  ordinal: number,
  hash: string,
  embedding: string,
): string => `
  INSERT INTO document_chunks (document_id, ordinal, hash, embedding)
  VALUES ('${documentId}', ${String(ordinal)}, '${hash}', ${embedding})
`;

/** Offers a chunk row without naming the embedding column at all. @spec §3.6 */
const chunkInsertWithoutEmbedding = (ordinal: number): string => `
  INSERT INTO document_chunks (document_id, ordinal, hash)
  VALUES ('${DOCUMENT_ID}', ${String(ordinal)}, '${OFFERED_HASH}')
`;

/** Rewrites the embedding on the chunk that legitimately carries one. @spec §3.6 */
const embeddingUpdate = (embedding: string): string => `
  UPDATE document_chunks SET embedding = ${embedding}
  WHERE document_id = '${DOCUMENT_ID}' AND ordinal = ${String(SEEDED_ORDINAL)}
`;

/** The embedding column of one chunk, as its storage class and its size. @spec §3.6 */
const chunkEmbedding = (ordinal: number): StoredBlob | undefined =>
  withRawConnection(
    (db) =>
      db
        .prepare(
          `SELECT typeof(embedding) AS type, length(embedding) AS bytes FROM document_chunks
            WHERE document_id = '${DOCUMENT_ID}' AND ordinal = ?`,
        )
        .get(ordinal) as StoredBlob | undefined,
  );

/** The origin column of the seeded document, exactly as it sits in the file. @spec §3.6 */
const documentOrigin = (id: string = DOCUMENT_ID): string | undefined =>
  withRawConnection(
    (db) =>
      (
        db.prepare(`SELECT origin FROM documents WHERE id = ?`).get(id) as
          | { readonly origin: string }
          | undefined
      )?.origin,
  );

/**
 * Embeddings the column must refuse.
 *
 * Split into no two groups on purpose: a blob of the wrong width and a string of
 * the right one fail for different reasons and are the same kind of accident —
 * something that is not a vector arriving in the column a vector is read out of.
 *
 * @spec §11, §12
 */
const REFUSED_EMBEDDINGS: readonly RefusedLiteral[] = [
  {
    description: 'text, which BLOB affinity converts to nothing and leaves as text',
    literal: "'pending'",
  },
  {
    description: 'text of exactly the right length, which counts characters and not bytes',
    literal: `'${'x'.repeat(RERANK_BYTES)}'`,
  },
  { description: 'the empty string, which every IS NOT NULL guard admits', literal: "''" },
  {
    description: 'an integer, over which a decode reads no byteLength and yields nothing',
    literal: '1',
  },
  { description: 'a real, for the same reason', literal: '1.5' },
  { description: 'an empty blob, which decodes to a vector of no components', literal: "x''" },
  {
    description: 'a seven-byte blob, which scores beside full-width vectors as though it belonged',
    literal: 'zeroblob(7)',
  },
  {
    description: 'a blob one component short',
    literal: `zeroblob(${String(RERANK_BYTES - Float32Array.BYTES_PER_ELEMENT)})`,
  },
  {
    description: 'a blob one component long',
    literal: `zeroblob(${String(RERANK_BYTES + Float32Array.BYTES_PER_ELEMENT)})`,
  },
  {
    description: 'a blob one byte short, which is not a whole number of components at all',
    literal: `zeroblob(${String(RERANK_BYTES - 1)})`,
  },
];

/**
 * Origins the column must refuse.
 *
 * Each one satisfies neither arm of §5.10's *"authored documents only"* rule
 * while looking enough like one arm to be read as it: a document whose origin is
 * `'generated'` is not `'materialized'`, so an extractor filtering on
 * `origin != 'materialized'` extracts from it and launders whatever generated it
 * back in as testimony (§12).
 *
 * @spec §3.6, §5.10, §12
 */
const REFUSED_ORIGINS: readonly RefusedLiteral[] = [
  { description: 'parsed, which the v0.2 schema used and v0.6 removed', literal: "'parsed'" },
  { description: 'generated, which reads as materialized and is not it', literal: "'generated'" },
  { description: 'the same word in the wrong case', literal: "'AUTHORED'" },
  { description: 'the empty string', literal: "''" },
  { description: 'a number, which TEXT affinity converts and stores', literal: '1' },
];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-chunk-embedding-'));
  dbPath = join(directory, 'graph.db');
  withStore(() => undefined);
  rawStatement(documentInsert(DOCUMENT_ID, "'authored'"));
  rawStatement(documentInsert(OTHER_DOCUMENT_ID, "'materialized'"));
  rawStatement(
    chunkInsert(DOCUMENT_ID, SEEDED_ORDINAL, SEEDED_HASH, `zeroblob(${String(RERANK_BYTES)})`),
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the embedding a chunk row may carry', () => {
  it('takes a full-width blob, so the harness can write one at all', () => {
    expect(chunkEmbedding(SEEDED_ORDINAL)).toStrictEqual({ type: 'blob', bytes: RERANK_BYTES });
  });

  it('takes an explicit null, since a chunk that has not been embedded is still a chunk', () => {
    expect(
      rawStatement(chunkInsert(DOCUMENT_ID, OFFERED_ORDINAL, OFFERED_HASH, 'NULL')),
    ).toStrictEqual({ code: undefined, changes: 1 });

    expect(chunkEmbedding(OFFERED_ORDINAL)).toStrictEqual({ type: 'null', bytes: null });
  });

  it('takes a chunk that never names the column, for the same reason', () => {
    expect(rawStatement(chunkInsertWithoutEmbedding(OFFERED_ORDINAL))).toStrictEqual({
      code: undefined,
      changes: 1,
    });

    expect(chunkEmbedding(OFFERED_ORDINAL)).toStrictEqual({ type: 'null', bytes: null });
  });

  it('lets an embedded chunk be un-embedded again, as a re-chunk that has not run yet', () => {
    expect(rawStatement(embeddingUpdate('NULL'))).toStrictEqual({ code: undefined, changes: 1 });

    expect(chunkEmbedding(SEEDED_ORDINAL)).toStrictEqual({ type: 'null', bytes: null });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The guard this cycle adds.
 * ---------------------------------------------------------------------------
 */

describe('the typeof and width guard on a chunk embedding', () => {
  it.each(REFUSED_EMBEDDINGS)('refuses an inserted embedding that is $description', ({ literal }) => {
    expect(
      rawStatement(chunkInsert(DOCUMENT_ID, OFFERED_ORDINAL, OFFERED_HASH, literal)),
    ).toStrictEqual({ code: CHECK_VIOLATION, changes: 0 });
  });

  it.each(REFUSED_EMBEDDINGS)('refuses an updated embedding that is $description', ({ literal }) => {
    expect(rawStatement(embeddingUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves no chunk behind when it refuses an insert', () => {
    rawStatement(chunkInsert(DOCUMENT_ID, OFFERED_ORDINAL, OFFERED_HASH, "'pending'"));

    expect(chunkEmbedding(OFFERED_ORDINAL)).toBeUndefined();
  });

  it('leaves the seeded embedding exactly as it was when it refuses an update', () => {
    rawStatement(embeddingUpdate("'pending'"));

    expect(chunkEmbedding(SEEDED_ORDINAL)).toStrictEqual({ type: 'blob', bytes: RERANK_BYTES });
  });

  it('refuses a short blob even where the chunk carries a perfectly good hash', () => {
    expect(
      rawStatement(chunkInsert(DOCUMENT_ID, OFFERED_ORDINAL, OFFERED_HASH, 'zeroblob(7)')),
    ).toStrictEqual({ code: CHECK_VIOLATION, changes: 0 });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The origin CHECK, which migration 0 already carries.
 * ---------------------------------------------------------------------------
 *
 * Not RED — these pass against the file as it stands. They are here because the
 * clause is load-bearing for §5.10's laundering rule and nothing in this repo
 * has ever exercised it: a column whose CHECK no test reads is a column a later
 * migration can widen without anything noticing.
 */

describe('the origin CHECK on a document row', () => {
  it.each(['authored', 'materialized'])('stores %s, which is one of the two arms', (origin) => {
    expect(documentOrigin(origin === 'authored' ? DOCUMENT_ID : OTHER_DOCUMENT_ID)).toBe(origin);
  });

  it.each(REFUSED_ORIGINS)('refuses an inserted origin that is $description', ({ literal }) => {
    expect(rawStatement(documentInsert(testUlid('DOC-OFFERED'), literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it.each(REFUSED_ORIGINS)('refuses an updated origin that is $description', ({ literal }) => {
    expect(rawStatement(originUpdate(literal))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('leaves an authored document authored when it refuses to relabel it', () => {
    rawStatement(originUpdate("'generated'"));

    expect(documentOrigin()).toBe('authored');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The ordinal, unique per document and not globally.
 * ---------------------------------------------------------------------------
 *
 * Also not RED. `UNIQUE (document_id, ordinal)` is what makes the store's
 * replace-on-conflict reading expressible at all, and what stops two chunks
 * claiming one position in a document — which would make `getChunks` ordering
 * ambiguous exactly where §5.10 needs it to be a sequence.
 */

describe('the uniqueness of an ordinal within a document', () => {
  it('refuses a second chunk at an ordinal the document already holds', () => {
    expect(
      rawStatement(chunkInsert(DOCUMENT_ID, SEEDED_ORDINAL, OFFERED_HASH, 'NULL')),
    ).toStrictEqual({ code: UNIQUE_VIOLATION, changes: 0 });
  });

  it('refuses it even when the offered chunk carries the same hash', () => {
    expect(
      rawStatement(chunkInsert(DOCUMENT_ID, SEEDED_ORDINAL, SEEDED_HASH, 'NULL')),
    ).toStrictEqual({ code: UNIQUE_VIOLATION, changes: 0 });
  });

  it('accepts the same ordinal in another document, since the key is the pair', () => {
    expect(
      rawStatement(chunkInsert(OTHER_DOCUMENT_ID, SEEDED_ORDINAL, SEEDED_HASH, 'NULL')),
    ).toStrictEqual({ code: undefined, changes: 1 });
  });

  it('accepts a repeated hash at another ordinal, since a document may repeat a paragraph', () => {
    expect(
      rawStatement(chunkInsert(DOCUMENT_ID, OFFERED_ORDINAL, SEEDED_HASH, 'NULL')),
    ).toStrictEqual({ code: undefined, changes: 1 });
  });
});
