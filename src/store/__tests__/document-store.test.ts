/**
 * The document and chunk surface: §5.10's cheap half, and nothing of its
 * expensive one.
 *
 * *"Ingest is cheap: chunk, embed, anchor — the document serves whole
 * immediately. Extraction is lazy."* Everything pinned here belongs to the
 * first clause. There is no member claim in this file, no `STATED_IN` edge, no
 * entailment gate: those are the deferred half, and a store that could not hold
 * a document until they existed would make the synchronous path wait on the
 * asynchronous one.
 *
 * The tables have been in migration 0 since it was written (plan §7 seams,
 * *"a table that exists from migration 0 is a feature that slots in rather than
 * one that bolts on"*) and nothing in `src/` has ever written a row to either.
 * This file is what turns them from a seam into a surface.
 *
 * Four claims are pinned, and they are not all the same kind of claim.
 *
 * **A document holds no evidence.** §3.6 is explicit — *"documents hold no
 * evidence of their own ... a document is a bundle of propositions with
 * different truth values, and whole-document evidence recreates the
 * attractor/shielding failures"*. So the record that crosses this boundary has
 * no α, no β, no status and no tier, and the round-trip is asserted on its
 * whole key set rather than field by field: a store that grew an `evidence`
 * column would pass every per-field assertion in this file.
 *
 * **`origin` is load-bearing, not hygiene.** §5.10 forbids extraction from
 * materialized documents *"because re-extracting them would launder canonicals
 * back in as fresh testimony"* — the graph's own conclusions returning as
 * independent corroboration of themselves, which is the §4.4 independence
 * failure with a document in the middle. The store cannot enforce that rule; it
 * is a write-path rule, exactly like every other policy the port refuses to
 * decide. What the store must do is make the distinction *available* and
 * unfalsifiable, so a caller that has to ask "may I extract from this?" gets an
 * answer, and no caller can write a third thing that neither arm of the rule
 * matches.
 *
 * **A chunk is anchored by its hash.** §3.6 spends a table row on it —
 * *"hash + fuzzy-quote anchoring, never raw offsets (span rot, §5.10)"* — and
 * §12 files span rot as a named failure mode: *"document edits break anchors;
 * retracted assertions keep contributing"*. A byte offset survives no edit above
 * it in the file. So the surface has nowhere to put one, and that is asserted on
 * the returned key set for the same reason the document's is: a chunk that grew
 * a `start` would still round-trip its hash.
 *
 * **The ordinal is a position in a sequence, not an anchor.** It orders chunks
 * and it keys them within a document, and it is the one thing about a chunk that
 * an edit is expected to change. Hence {@link GraphStore.getChunks} ordering by
 * it, and hence the replace-on-conflict reading below.
 *
 * Real SQLite, `:memory:`, no mocks — as every store test here does.
 *
 * @spec §3.6, §5.10, §11, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DimensionMismatchError,
  openGraphStore,
  UnknownDocumentError,
  UnknownDocumentOriginError,
  type DocumentChunk,
  type DocumentOrigin,
  type DocumentRecord,
  type GraphStore,
} from '../index';

import { CREATED_AT, ENTITY_ID, OTHER_ENTITY_ID, STORE_RERANK_WIDTH, testUlid, unitVectorArray } from './fixtures';


/** The authored ADR under test. @spec §3.6 */
const DOCUMENT_ID = testUlid('DOC-ADR-0007');

/** A second document, so no assertion here can be satisfied by a one-row table. @spec §3.6 */
const OTHER_DOCUMENT_ID = testUlid('DOC-RUNBOOK-FAILOVER');

/** A document nothing ever writes. @spec §3.6 */
const UNWRITTEN_DOCUMENT_ID = testUlid('DOC-NEVER-INGESTED');

/** @spec §3.6 */
const TITLE = 'ADR 0007 — session refresh idempotency';

/** @spec §3.6 */
const OTHER_TITLE = 'Runbook — Cognito failover';

/** §3.6's pointer-or-text column, here a pointer. @spec §3.6 */
const CONTENT_REF = 'docs/adr/0007-session-refresh-idempotency.md';

/**
 * The chunk hashes, prefixed and mixed-case on purpose.
 *
 * The store neither computes nor parses these, so the prefix is a caller's
 * convention and the assertion is that it survives one — a store that stripped
 * or folded it would have started interpreting an opaque anchor.
 *
 * @spec §3.6
 */
const FIRST_HASH = 'sha256:1F0a9c4D2b6e8f3a';

/** @spec §3.6 */
const SECOND_HASH = 'sha256:7c3e5b81d0a24f96';

/** @spec §3.6 */
const THIRD_HASH = 'sha256:b904e7c15d38a2f6';

/**
 * The hash the same paragraph carries wherever it appears.
 *
 * A boilerplate stanza — a licence header, a repeated warning — is one text in
 * two places, so it is one hash at two ordinals. @spec §3.6, §5.10
 */
const REPEATED_HASH = 'sha256:0000deadbeef0000';

let store: GraphStore;

/** A complete document row, every column populated. @spec §3.6 */
const makeDocument = (overrides: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: DOCUMENT_ID,
  title: TITLE,
  origin: 'authored',
  contentRef: CONTENT_REF,
  scope: ENTITY_ID,
  createdAt: CREATED_AT,
  ...overrides,
});

/** A chunk of {@link makeDocument}'s document, embedded unless told otherwise. @spec §3.6 */
const makeChunk = (overrides: Partial<DocumentChunk> = {}): DocumentChunk => ({
  documentId: DOCUMENT_ID,
  ordinal: 0,
  hash: FIRST_HASH,
  embedding: unitVectorArray(41),
  ...overrides,
});

/** The hashes of a document's chunks, in the order the store served them. @spec §3.6 */
const chunkHashes = (documentId: string = DOCUMENT_ID): string[] =>
  store.getChunks(documentId).map((chunk) => chunk.hash);

/** The ordinals of a document's chunks, in the order the store served them. @spec §3.6 */
const chunkOrdinals = (documentId: string = DOCUMENT_ID): number[] =>
  store.getChunks(documentId).map((chunk) => chunk.ordinal);

/**
 * The refusal a write produced, or `undefined` if it did not refuse.
 *
 * Returned rather than matched with `toThrow`, for the reason the pathway and
 * regime suites give: *"a store that refuses for an unrelated reason satisfies
 * `toThrow` just as well and never shows which rule did the refusing"*. In a
 * red run that reason is not hypothetical — every method under test is missing,
 * so every call throws a `TypeError`, and a bare `toThrow` would report a
 * passing refusal test against a store with no refusal in it.
 *
 * Where an error class already names the rule, the refusal is asserted to be an
 * instance of it. Where none does — a document whose `origin` is a third thing,
 * a chunk with no document — the refusal is asserted *together with* the state
 * afterwards, which no `TypeError` can satisfy either: reading the state back
 * goes through a method that does not exist yet.
 */
const refusalFrom = (write: () => void): unknown => {
  try {
    write();
    return undefined;
  } catch (error) {
    return error;
  }
};

/** Seeds a three-chunk document, written deliberately out of order. @spec §3.6 */
const seedShuffledChunks = (): void => {
  store.putDocument(makeDocument());
  store.putChunk(makeChunk({ ordinal: 2, hash: THIRD_HASH }));
  store.putChunk(makeChunk({ ordinal: 0, hash: FIRST_HASH }));
  store.putChunk(makeChunk({ ordinal: 1, hash: SECOND_HASH }));
};

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('a document round-trips through the store', () => {
  it('returns an authored document exactly as it was written', () => {
    const document = makeDocument();

    store.putDocument(document);

    expect(store.getDocument(DOCUMENT_ID)).toStrictEqual(document);
  });

  it('returns a materialized document exactly as it was written', () => {
    const document = makeDocument({ origin: 'materialized' });

    store.putDocument(document);

    expect(store.getDocument(DOCUMENT_ID)).toStrictEqual(document);
  });

  it('keeps an unanchored document unanchored rather than inventing a scope', () => {
    store.putDocument(makeDocument({ scope: null }));

    expect(store.getDocument(DOCUMENT_ID)?.scope).toBeNull();
  });

  it('keeps an unstamped document unstamped rather than inventing an instant', () => {
    store.putDocument(makeDocument({ createdAt: null }));

    expect(store.getDocument(DOCUMENT_ID)?.createdAt).toBeNull();
  });

  it('round-trips a document that is both unanchored and unstamped', () => {
    const document = makeDocument({ scope: null, createdAt: null });

    store.putDocument(document);

    expect(store.getDocument(DOCUMENT_ID)).toStrictEqual(document);
  });

  it('holds a document anchored at a referent the index has never minted, since that index is a view', () => {
    const document = makeDocument({ scope: testUlid('ENTITY-NEVER-MINTED') });

    store.putDocument(document);

    expect(store.getDocument(DOCUMENT_ID)).toStrictEqual(document);
  });

  it('carries no evidence of its own, since §3.6 puts evidence on member claims', () => {
    store.putDocument(makeDocument());

    expect(Object.keys(store.getDocument(DOCUMENT_ID) ?? {}).sort()).toStrictEqual([
      'contentRef',
      'createdAt',
      'id',
      'origin',
      'scope',
      'title',
    ]);
  });

  it('answers undefined for a document nothing has written', () => {
    expect(store.getDocument(UNWRITTEN_DOCUMENT_ID)).toBeUndefined();
  });

  it('keeps two documents apart', () => {
    store.putDocument(makeDocument());
    store.putDocument(makeDocument({ id: OTHER_DOCUMENT_ID, title: OTHER_TITLE }));

    expect(store.getDocument(OTHER_DOCUMENT_ID)?.title).toBe(OTHER_TITLE);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The origin, which decides whether a document may ever be extracted from.
 * ---------------------------------------------------------------------------
 *
 * §5.10: *"Authored documents only. Materialized documents have members by
 * construction; re-extracting them would launder canonicals back in as fresh
 * testimony."* §12 files that as its own attack — testimony laundering — and the
 * countermeasure it names is extraction on authored documents only.
 *
 * The store does not enforce it. It cannot: whether to extract is a write-path
 * decision, and a store that refused to serve a materialized document's chunks
 * would be making it. What the store owes the caller is a distinction that is
 * always present, always exactly one of the two, and never quietly a third
 * thing — because every arm of the laundering rule is written as "authored" or
 * "not authored", and a document whose origin is `'parsed'` satisfies neither
 * arm's intent while satisfying one of them by accident.
 */

describe('the origin a document was written under', () => {
  it.each<DocumentOrigin>(['authored', 'materialized'])(
    'stores %s and reports it back unchanged',
    (origin) => {
      store.putDocument(makeDocument({ origin }));

      expect(store.getDocument(DOCUMENT_ID)?.origin).toBe(origin);
    },
  );

  it('tells an authored document from a materialized one written beside it', () => {
    store.putDocument(makeDocument({ origin: 'authored' }));
    store.putDocument(makeDocument({ id: OTHER_DOCUMENT_ID, origin: 'materialized' }));

    expect([
      store.getDocument(DOCUMENT_ID)?.origin,
      store.getDocument(OTHER_DOCUMENT_ID)?.origin,
    ]).toStrictEqual(['authored', 'materialized']);
  });

  it.each(['parsed', 'generated', 'AUTHORED', ''])(
    'refuses %s, which no arm of the extraction rule is written for',
    (origin) => {
      const refusal = refusalFrom(() => {
        store.putDocument(makeDocument({ origin: origin as unknown as DocumentOrigin }));
      });

      // Refusal and absence as one assertion, because either alone is
      // satisfiable by something that is not the rule: a store with no
      // `putDocument` at all throws, and a store that wrote the row and then
      // threw would leave behind exactly the document §5.10's two arms cannot
      // classify.
      expect({ refused: refusal !== undefined, stored: store.getDocument(DOCUMENT_ID) }).toStrictEqual(
        { refused: true, stored: undefined },
      );
    },
  );

  /*
   * The assertion above is satisfied by *a* refusal, and the table CHECK is one:
   * a store with no origin check at all still refuses every value here, as a
   * `SqliteError` carrying `SQLITE_CONSTRAINT_CHECK`, and still stores nothing.
   * So the block above cannot tell the port's rule from the file's, and the two
   * are not the same promise — the file's is a promise to whoever holds the
   * file, and the port's is a promise to whoever holds the port, in a vocabulary
   * a driver upgrade cannot reword.
   *
   * This is the assertion that separates them. It is about the refusal's *class*,
   * which is the whole reason {@link UnknownDocumentOriginError} was declared
   * rather than left as the driver's error and a message string.
   */
  it.each(['parsed', 'generated', 'AUTHORED', ''])(
    'names %s as the thing that was wrong, rather than passing the table a value to reject',
    (origin) => {
      const refusal = refusalFrom(() => {
        store.putDocument(makeDocument({ origin: origin as unknown as DocumentOrigin }));
      });

      expect(refusal).toBeInstanceOf(UnknownDocumentOriginError);
      expect((refusal as UnknownDocumentOriginError).origin).toBe(origin);
    },
  );

  it('leaves an already-stored origin alone when it refuses to overwrite it', () => {
    store.putDocument(makeDocument({ origin: 'materialized' }));

    const refusal = refusalFrom(() => {
      store.putDocument(makeDocument({ origin: 'parsed' as unknown as DocumentOrigin }));
    });

    expect({
      refused: refusal !== undefined,
      origin: store.getDocument(DOCUMENT_ID)?.origin,
    }).toStrictEqual({ refused: true, origin: 'materialized' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Re-ingesting a document that is already there.
 * ---------------------------------------------------------------------------
 */

describe('re-putting a document that already exists', () => {
  it('replaces the row rather than leaving the old title in place', () => {
    store.putDocument(makeDocument());

    store.putDocument(makeDocument({ title: OTHER_TITLE }));

    expect(store.getDocument(DOCUMENT_ID)?.title).toBe(OTHER_TITLE);
  });

  it('clears a scope the document has lost', () => {
    store.putDocument(makeDocument());

    store.putDocument(makeDocument({ scope: null }));

    expect(store.getDocument(DOCUMENT_ID)?.scope).toBeNull();
  });

  it('leaves the chunks where they are, since a retitle is not a delete', () => {
    seedShuffledChunks();

    store.putDocument(makeDocument({ title: OTHER_TITLE }));

    expect(chunkHashes()).toStrictEqual([FIRST_HASH, SECOND_HASH, THIRD_HASH]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The chunk sequence.
 * ---------------------------------------------------------------------------
 */

describe('the chunks of a document', () => {
  it('serves them in ordinal order rather than in the order they arrived', () => {
    seedShuffledChunks();

    expect(chunkOrdinals()).toStrictEqual([0, 1, 2]);
  });

  it('serves their hashes in that same order, so the document reads as it was written', () => {
    seedShuffledChunks();

    expect(chunkHashes()).toStrictEqual([FIRST_HASH, SECOND_HASH, THIRD_HASH]);
  });

  it('orders by the ordinal as a number, not as the text it would sort as', () => {
    store.putDocument(makeDocument());
    store.putChunk(makeChunk({ ordinal: 10, hash: THIRD_HASH }));
    store.putChunk(makeChunk({ ordinal: 9, hash: SECOND_HASH }));
    store.putChunk(makeChunk({ ordinal: 2, hash: FIRST_HASH }));

    expect(chunkOrdinals()).toStrictEqual([2, 9, 10]);
  });

  it('replaces the chunk already sitting at an ordinal, since a re-chunk is not a fault', () => {
    store.putDocument(makeDocument());
    store.putChunk(makeChunk({ ordinal: 1, hash: FIRST_HASH }));

    store.putChunk(makeChunk({ ordinal: 1, hash: SECOND_HASH }));

    expect(chunkHashes()).toStrictEqual([SECOND_HASH]);
  });

  it('replaces the embedding along with the hash', () => {
    store.putDocument(makeDocument());
    store.putChunk(makeChunk({ ordinal: 1, embedding: unitVectorArray(41) }));

    store.putChunk(makeChunk({ ordinal: 1, hash: SECOND_HASH, embedding: null }));

    expect(store.getChunks(DOCUMENT_ID)[0]?.embedding).toBeNull();
  });

  it('answers with no chunks for a document that has none', () => {
    store.putDocument(makeDocument());

    expect(store.getChunks(DOCUMENT_ID)).toStrictEqual([]);
  });

  it('answers with no chunks for a document nothing has written', () => {
    expect(store.getChunks(UNWRITTEN_DOCUMENT_ID)).toStrictEqual([]);
  });

  it('keeps one document ordinal 0 clear of another document ordinal 0', () => {
    store.putDocument(makeDocument());
    store.putDocument(makeDocument({ id: OTHER_DOCUMENT_ID }));
    store.putChunk(makeChunk({ ordinal: 0, hash: FIRST_HASH }));
    store.putChunk(makeChunk({ documentId: OTHER_DOCUMENT_ID, ordinal: 0, hash: SECOND_HASH }));

    expect([chunkHashes(), chunkHashes(OTHER_DOCUMENT_ID)]).toStrictEqual([
      [FIRST_HASH],
      [SECOND_HASH],
    ]);
  });

  it('refuses a chunk whose document was never written', () => {
    store.putDocument(makeDocument());

    const refusal = refusalFrom(() => {
      store.putChunk(makeChunk({ documentId: UNWRITTEN_DOCUMENT_ID }));
    });

    expect({
      refused: refusal !== undefined,
      orphans: store.getChunks(UNWRITTEN_DOCUMENT_ID),
    }).toStrictEqual({ refused: true, orphans: [] });
  });

  /*
   * The same separation the origin block draws, for the same reason. The table's
   * `REFERENCES documents (id)` refuses this write too, as a `SqliteError`
   * carrying `SQLITE_CONSTRAINT_FOREIGNKEY` — so the assertion above passes
   * against a store with no document check in it at all, and cannot say which of
   * the two refused.
   *
   * The class can. It also carries the id, which the extended result code does
   * not: "a foreign key failed" names the column, never the value.
   */
  it('names the document that did not resolve, rather than letting the key fail unexplained', () => {
    store.putDocument(makeDocument());

    const refusal = refusalFrom(() => {
      store.putChunk(makeChunk({ documentId: UNWRITTEN_DOCUMENT_ID }));
    });

    expect(refusal).toBeInstanceOf(UnknownDocumentError);
    expect((refusal as UnknownDocumentError).documentId).toBe(UNWRITTEN_DOCUMENT_ID);
  });
});

/*
 * ---------------------------------------------------------------------------
 * What anchors a chunk.
 * ---------------------------------------------------------------------------
 *
 * §3.6: chunk boundaries are *"{ hash, embedding } — hash + fuzzy-quote
 * anchoring, never raw offsets (span rot, §5.10)"*. §12 names the failure a byte
 * offset causes and the fix: *"document edits break anchors; retracted
 * assertions keep contributing"*, answered by *"hash + fuzzy-quote anchoring; a
 * re-anchor pass"*.
 *
 * The schema suite already refuses an offset-anchored `DocumentNode`. This is
 * the same rule one layer down, where it is harder to hold: a table can grow a
 * column without any schema noticing, and an offset is exactly the column a
 * chunk table invites.
 */

describe('the anchor a chunk carries', () => {
  it('is a hash and an ordinal, with nowhere to put a byte offset', () => {
    store.putDocument(makeDocument());
    store.putChunk(makeChunk());

    expect(Object.keys(store.getChunks(DOCUMENT_ID)[0] ?? {}).sort()).toStrictEqual([
      'documentId',
      'embedding',
      'hash',
      'ordinal',
    ]);
  });

  it('drops a span a caller hands it rather than storing one', () => {
    store.putDocument(makeDocument());

    store.putChunk({ ...makeChunk(), start: 0, end: 240 } as DocumentChunk);

    expect(Object.keys(store.getChunks(DOCUMENT_ID)[0] ?? {}).sort()).toStrictEqual([
      'documentId',
      'embedding',
      'hash',
      'ordinal',
    ]);
  });

  it('exposes no autoincrement id, which would be a second identity for the chunk', () => {
    store.putDocument(makeDocument());
    store.putChunk(makeChunk());

    expect(store.getChunks(DOCUMENT_ID)[0]).not.toHaveProperty('id');
  });

  it('returns the hash byte for byte, neither folded nor stripped of its prefix', () => {
    store.putDocument(makeDocument());
    store.putChunk(makeChunk({ hash: FIRST_HASH }));

    expect(store.getChunks(DOCUMENT_ID)[0]?.hash).toBe(FIRST_HASH);
  });

  it('keeps both occurrences of a repeated paragraph, which share one hash', () => {
    store.putDocument(makeDocument());
    store.putChunk(makeChunk({ ordinal: 0, hash: REPEATED_HASH }));
    store.putChunk(makeChunk({ ordinal: 3, hash: REPEATED_HASH }));

    expect(chunkOrdinals()).toStrictEqual([0, 3]);
  });

  it('anchors the same text in two documents independently', () => {
    store.putDocument(makeDocument());
    store.putDocument(makeDocument({ id: OTHER_DOCUMENT_ID }));
    store.putChunk(makeChunk({ hash: REPEATED_HASH }));
    store.putChunk(makeChunk({ documentId: OTHER_DOCUMENT_ID, hash: REPEATED_HASH }));

    expect([chunkHashes(), chunkHashes(OTHER_DOCUMENT_ID)]).toStrictEqual([
      [REPEATED_HASH],
      [REPEATED_HASH],
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The chunk embedding.
 * ---------------------------------------------------------------------------
 */

describe('the embedding a chunk may carry', () => {
  it('round-trips a full-width vector component for component', () => {
    const embedding = unitVectorArray(41);
    store.putDocument(makeDocument());

    store.putChunk(makeChunk({ embedding }));

    expect(store.getChunks(DOCUMENT_ID)[0]?.embedding).toStrictEqual(embedding);
  });

  it('keeps an unembedded chunk null rather than empty, since [] is a vector that scores', () => {
    store.putDocument(makeDocument());

    store.putChunk(makeChunk({ embedding: null }));

    expect(store.getChunks(DOCUMENT_ID)[0]?.embedding).toBeNull();
  });

  it('serves an embedded and an unembedded chunk from one document', () => {
    store.putDocument(makeDocument());
    store.putChunk(makeChunk({ ordinal: 0, embedding: unitVectorArray(41) }));
    store.putChunk(makeChunk({ ordinal: 1, hash: SECOND_HASH, embedding: null }));

    expect(store.getChunks(DOCUMENT_ID).map((chunk) => chunk.embedding === null)).toStrictEqual([
      false,
      true,
    ]);
  });

  it('refuses an embedding narrower than the width migration 0 pinned', () => {
    store.putDocument(makeDocument());

    const refusal = refusalFrom(() => {
      store.putChunk(makeChunk({ embedding: unitVectorArray(41, STORE_RERANK_WIDTH / 2) }));
    });

    expect(refusal).toBeInstanceOf(DimensionMismatchError);
  });

  it('refuses an embedding wider than that', () => {
    store.putDocument(makeDocument());

    const refusal = refusalFrom(() => {
      store.putChunk(makeChunk({ embedding: unitVectorArray(41, STORE_RERANK_WIDTH + 1) }));
    });

    expect(refusal).toBeInstanceOf(DimensionMismatchError);
  });

  it('refuses an empty embedding, which is the narrowest wrong width of all', () => {
    store.putDocument(makeDocument());

    const refusal = refusalFrom(() => {
      store.putChunk(makeChunk({ embedding: [] }));
    });

    expect(refusal).toBeInstanceOf(DimensionMismatchError);
  });

  it('leaves no chunk behind when it refuses a width', () => {
    store.putDocument(makeDocument());

    refusalFrom(() => {
      store.putChunk(makeChunk({ embedding: [] }));
    });

    expect(store.getChunks(DOCUMENT_ID)).toStrictEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Deleting a document.
 * ---------------------------------------------------------------------------
 *
 * `document_chunks.document_id` is declared `REFERENCES documents (id) ON DELETE
 * CASCADE`, and the connection opens with `PRAGMA foreign_keys = ON`.
 *
 * That pragma is belt and braces rather than the thing that turns the cascade
 * on: better-sqlite3 bundles SQLite built with `SQLITE_DEFAULT_FOREIGN_KEYS=1`,
 * so foreign keys are already enforced on every connection it opens. SQLite's
 * *own* default is off, which is what the pragma insures against — a driver
 * swap, or a rebuild without that define, either of which would otherwise turn a
 * cascade into a table quietly filling with rows nothing collects.
 *
 * Enforced either way, the cascade is still a property of the *store*: it is a
 * per-connection switch, and a caller holding the file can turn it off. Pinned
 * as such at the end of this file.
 */

describe('deleting a document', () => {
  it('removes the document', () => {
    store.putDocument(makeDocument());

    store.deleteDocument(DOCUMENT_ID);

    expect(store.getDocument(DOCUMENT_ID)).toBeUndefined();
  });

  it('takes the document chunks with it', () => {
    seedShuffledChunks();

    store.deleteDocument(DOCUMENT_ID);

    expect(store.getChunks(DOCUMENT_ID)).toStrictEqual([]);
  });

  it('leaves another document chunks exactly where they were', () => {
    seedShuffledChunks();
    store.putDocument(makeDocument({ id: OTHER_DOCUMENT_ID }));
    store.putChunk(makeChunk({ documentId: OTHER_DOCUMENT_ID, hash: SECOND_HASH }));

    store.deleteDocument(DOCUMENT_ID);

    expect(chunkHashes(OTHER_DOCUMENT_ID)).toStrictEqual([SECOND_HASH]);
  });

  it('is silent about a document nothing has written', () => {
    const refusal = refusalFrom(() => {
      store.deleteDocument(UNWRITTEN_DOCUMENT_ID);
    });

    expect(refusal).toBeUndefined();
  });

  it('lets the id be ingested again afterwards, with no chunk of the old document left', () => {
    seedShuffledChunks();
    store.deleteDocument(DOCUMENT_ID);

    store.putDocument(makeDocument({ scope: OTHER_ENTITY_ID }));

    expect([store.getDocument(DOCUMENT_ID)?.scope, store.getChunks(DOCUMENT_ID)]).toStrictEqual([
      OTHER_ENTITY_ID,
      [],
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * What the store promises that the file does not.
 * ---------------------------------------------------------------------------
 *
 * Two claims above hold, in a `:memory:` store, for reasons that are not the
 * store's — and a promise kept by something else is a promise that leaves when
 * that something else does.
 *
 * A real file and a second connection to it, because that is what makes the
 * difference visible: `:memory:` opens a private database, so a second
 * connection to one is a second empty database, and there is no way to reach the
 * same rows by any route but the store's.
 *
 * @spec §3.6, §5.10
 */

describe('the promises the store keeps rather than delegating to the file', () => {
  let directory: string;
  let dbPath: string;

  /** Opens a store on the shared file, runs a body, and always closes it. @spec §11 */
  const onFile = <T>(run: (fileStore: GraphStore) => T): T => {
    const fileStore = openGraphStore({ path: dbPath });
    try {
      return run(fileStore);
    } finally {
      fileStore.close();
    }
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kg-document-store-'));
    dbPath = join(directory, 'graph.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /*
   * `getChunks` orders by ordinal, and every ordering assertion in this file
   * also passes against a `getChunks` with no `ORDER BY` at all — because
   * `UNIQUE (document_id, ordinal)` builds an index whose leading column is the
   * one the `WHERE` matches, so an index search hands back ordinal order for
   * free, and the planner always prefers one to a scan on an empty database.
   *
   * It does not always prefer one. `ANALYZE` is ordinary SQLite maintenance —
   * `PRAGMA optimize` runs it on a schedule in many deployments — and once
   * `sqlite_stat1` records that the index is unselective, because a document's
   * chunks are most of the table, the planner switches to `SCAN` and the rows
   * arrive in rowid order, which is the order they were *written*. A document
   * re-chunked in the middle then serves its paragraphs shuffled: §5.10's
   * sequence, silently reordered by a maintenance command nobody associates with
   * reading.
   *
   * So the ordering is the store's promise and not the index's, and this is
   * where that is checkable. The statistics are gathered on a plain connection
   * and the read is taken from a store opened afterwards, since a statement is
   * planned when it is prepared.
   */
  it('serves chunks in ordinal order even where the statistics have talked the planner into a scan', () => {
    onFile((fileStore) => {
      fileStore.putDocument({
        id: DOCUMENT_ID,
        title: TITLE,
        origin: 'authored',
        contentRef: CONTENT_REF,
        scope: ENTITY_ID,
        createdAt: CREATED_AT,
      });
      for (const [ordinal, hash] of [
        [2, THIRD_HASH],
        [0, FIRST_HASH],
        [1, SECOND_HASH],
      ] as const)
        fileStore.putChunk({ documentId: DOCUMENT_ID, ordinal, hash, embedding: null });
    });

    const statistics = new Database(dbPath);
    statistics.exec('ANALYZE');
    statistics.close();

    expect(onFile((fileStore) => fileStore.getChunks(DOCUMENT_ID).map((chunk) => chunk.hash))).toStrictEqual([
      FIRST_HASH,
      SECOND_HASH,
      THIRD_HASH,
    ]);
  });

  /*
   * `putChunk` refuses a chunk whose document was never written, and the table
   * refuses one too — `REFERENCES documents (id)` is right there in migration 0.
   *
   * The table's refusal is *defeasible*, and this is the demonstration. Foreign
   * key enforcement is a per-connection switch, so a caller that opens the file
   * and turns it off writes the orphan the schema forbids, and no cascade will
   * ever collect the row because the parent it would have cascaded from does not
   * exist. The store's refusal is a plain lookup and has no switch: it holds at
   * whatever the pragma happens to say.
   *
   * The orphan is written first and deliberately left in the file, so the store's
   * refusal below is taken against a database that already contains exactly the
   * row the store is being asked not to add.
   */
  it('refuses an orphan chunk on terms a caller cannot switch off, as the file can be made to', () => {
    onFile(() => undefined);

    const permissive = new Database(dbPath);
    permissive.pragma('foreign_keys = OFF');
    const written = permissive
      .prepare(
        `INSERT INTO document_chunks (document_id, ordinal, hash, embedding)
         VALUES ('${UNWRITTEN_DOCUMENT_ID}', 0, '${FIRST_HASH}', NULL)`,
      )
      .run().changes;
    permissive.close();

    const refusal = onFile((fileStore) =>
      refusalFrom(() => {
        fileStore.putChunk({
          documentId: UNWRITTEN_DOCUMENT_ID,
          ordinal: 1,
          hash: SECOND_HASH,
          embedding: null,
        });
      }),
    );

    expect({ fileAccepted: written, storeRefusedWith: (refusal as Error).constructor }).toStrictEqual({
      fileAccepted: 1,
      storeRefusedWith: UnknownDocumentError,
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Left underdetermined, deliberately unasserted.
 * ---------------------------------------------------------------------------
 *
 * Three divergences between §3.6's `DocumentNode` and the table migration 0
 * declares. None is resolved here, because resolving one by assertion would pin
 * a guess:
 *
 * 1. **`docKind`.** §3.6 makes it a required closed set — `adr | runbook |
 *    overview | postmortem | other` — and `documents` has no column for it.
 *    Nothing in §5.10 branches on it, so the table is not obviously wrong; but a
 *    closed vocabulary declared in the schema and absent from storage is a field
 *    that cannot survive a round trip, and one of the two declarations is
 *    mistaken.
 * 2. **`title`.** The table requires it and `DocumentNode` has no such field.
 *    Pinned here as a stored column because the column is `NOT NULL` and a
 *    document has to be nameable in a served result, but which of the two
 *    declarations is authoritative is not this cycle's to decide.
 * 3. **`chunks`.** `DocumentNode` nests them in the document with a *required*
 *    embedding; the table hangs them off it in their own row with a nullable
 *    one. This file follows the table, and argues the nullability on
 *    {@link DocumentChunk.embedding} — but §5.10's *"chunk, embed, anchor"* can
 *    also be read as all three happening before the document is stored at all,
 *    under which reading a null embedding is a state ingest never produces and
 *    the column should be `NOT NULL`. The reading taken here is the weaker
 *    claim: the store permits an unembedded chunk, and whether ingest ever
 *    writes one is the write path's business.
 *
 * A fourth thing §5.10 leaves open and this file does not touch: a document is
 * one episode (*"forty assertions from one ADR are one source, not forty
 * observations"*), and nothing on this surface records which episode. That is
 * extraction-side — the episode is the member claims' — but if a document ever
 * needs to name its own ingest episode, this is the table it would live on.
 */
