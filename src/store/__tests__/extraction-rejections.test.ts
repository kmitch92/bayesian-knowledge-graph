/**
 * The extraction-rejection log: where §5.10 sends what the extractor tried to
 * invent.
 *
 * *"Every member carries its verbatim source span; an entailment gate (span ⊨
 * claim, floor ⚙) guards insertion; failures go to the extraction-rejection log —
 * never the graph. Phantom members (assertions the document never made) corrupt
 * doc health in both directions: a refuted phantom marks a correct paragraph
 * stale, a supported phantom buys unearned health."*
 *
 * §12 files the same thing as an attack in its own right — *"hallucinated
 * extraction: the extractor writes assertions the document never made"* — and
 * names the countermeasure as *"claim-with-quote spans + entailment gate at
 * insert, failures to the rejection log"*.
 *
 * No table exists. This file designs one, and the design follows from what the
 * log is *for*.
 *
 * ── It is an instrument, not a bin ──────────────────────────────────────────
 *
 * The question the log has to answer is whether a given model is safe to extract
 * with. §13's drift audits are *"sampled entailment checks: extracted members
 * against their quoted spans"*, and §15's ⚙ list includes *"extraction verifier
 * tuning — the entailment gate's model and threshold: false rejects lose
 * knowledge, false accepts admit phantoms"*. Neither is answerable from a pile of
 * refused strings. Somebody reviewing a month of rejections needs, for each one:
 * what the model proposed, what it cited, where it claimed to have read it, why
 * it was refused, which model said it, and when. That is the row.
 *
 * ── This build's gate is the verbatim check ─────────────────────────────────
 *
 * The extractor must return a quote, and a claim is refused unless that quote
 * appears literally in the chunk. Semantic entailment is a later model and a
 * later ⚙ floor, so the reason vocabulary admits `entailmentBelowFloor` *now*,
 * before anything writes it — plan §7's rule for exactly this shape: *"a table
 * that exists from migration 0 is a feature that slots in rather than one that
 * bolts on"*, the same reason `RESERVED_EDGE_KINDS` names four edge kinds v1
 * refuses to write. The gate's own numbers — a score, the floor it fell under,
 * the model's parameters — go in the JSON `detail` column rather than in columns
 * of their own, so the second gate lands without a migration on either axis.
 *
 * ── A rejection is not a claim ──────────────────────────────────────────────
 *
 * There is no α, no β, no status, no tier and no id in the ledger's namespace.
 * §3.6 keeps evidence off documents because *"a document is a bundle of
 * propositions with different truth values"*; a rejection is one proposition that
 * was refused, which is further still from anything that carries a posterior.
 * The negative is asserted twice — on the record's own key set, and on the ledger
 * and referent index being untouched afterwards — because a store that wrote a
 * phantom claim *and* logged the rejection would satisfy either alone.
 *
 * Real SQLite, `:memory:`, no mocks. The last section reaches the file directly,
 * for the reason `chunk-embedding-guard.test.ts` does.
 *
 * @spec §3.6, §5.10, §12, §13, §15
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openGraphStore,
  UnknownDocumentError,
  UnknownRejectionReasonError,
  type ExtractionRejection,
  type ExtractionRejectionReason,
  type GraphStore,
} from '../index';

import { CREATED_AT, ENTITY_ID, testUlid } from './fixtures';

/** The authored ADR the extractor was run over. @spec §3.6, §5.10 */
const DOCUMENT_ID = testUlid('DOC-ADR-0007');

/** A second document, so no assertion here is satisfied by a one-document table. @spec §3.6 */
const OTHER_DOCUMENT_ID = testUlid('DOC-RUNBOOK-FAILOVER');

/** A document nothing ever ingested. @spec §3.6 */
const UNWRITTEN_DOCUMENT_ID = testUlid('DOC-NEVER-INGESTED');

/** The chunk most rejections in this file are attributed to. @spec §3.6 */
const CHUNK_ORDINAL = 1;

/** A second chunk of the same document. @spec §3.6 */
const OTHER_CHUNK_ORDINAL = 2;

/** The anchor of {@link CHUNK_ORDINAL}, which is what survives an edit that renumbers it. @spec §3.6 */
const CHUNK_HASH = 'sha256:1F0a9c4D2b6e8f3a';

/** The anchor of {@link OTHER_CHUNK_ORDINAL}. @spec §3.6 */
const OTHER_CHUNK_HASH = 'sha256:7c3e5b81d0a24f96';

/**
 * The assertion the extractor proposed and the document never made.
 *
 * A plausible one on purpose: §12's hallucinated-extraction row is not about
 * gibberish, it is about assertions that read like the document's own.
 *
 * @spec §5.10, §12
 */
const PHANTOM_CLAIM = 'Session refresh in AuthService retries three times before failing.';

/** A second phantom, so "kept the text" is distinguishable from "kept a text". @spec §5.10 */
const OTHER_PHANTOM_CLAIM = 'AuthService writes refresh failures to the audit log.';

/**
 * What the model cited, kept exactly as it offered it.
 *
 * Ragged on purpose — leading whitespace, a curly apostrophe, an ellipsis where
 * the model elided the middle of a sentence. A near-miss is the interesting case
 * for the audit: a quote that fails the verbatim check only on whitespace is a
 * different diagnosis from one the paragraph never contained, and normalizing on
 * the way in would erase the difference before anyone could read it.
 *
 * @spec §5.10, §13
 */
const OFFERED_QUOTE = '  the refresh handler retries … before it surfaces the error’s cause';

/** The model under audit — the grouping key the whole instrument exists for. @spec §13, §15 */
const MODEL_ID = 'haiku-4.5@2026-06';

/** When the extraction ran. @spec §5.10 */
const REJECTED_AT = '2026-09-01T10:15:00.000Z';

/** An earlier instant, so log order can be told apart from a sort on the clock. @spec §5.10 */
const EARLIER_THAN_REJECTED_AT = '2026-08-30T08:00:00.000Z';

/**
 * What the deferred entailment gate would record beside its verdict.
 *
 * Nested, and deliberately not flat: the store persists this blob without reading
 * a field of it, so a layer that quietly destructured `score` out of it would
 * still pass a flat fixture — the argument the `LOCATOR` fixture makes for
 * `entities.locator`.
 *
 * @spec §5.10, §15
 */
const GATE_DETAIL = {
  score: 0.41,
  floor: 0.7,
  gate: { name: 'entailment', revision: 3 },
} as const;

/**
 * Every arm of {@link ExtractionRejectionReason}, pinned to the union by the
 * compiler rather than copied out of it by hand.
 *
 * The vocabulary is declared in three places that have to agree: the union in
 * the port, the runtime list the port checks a caller's reason against, and the
 * table CHECK. `DOCUMENT_ORIGINS` collapses two of those into one — the Zod enum
 * in `src/schema/` is the single declaration, `DocumentOrigin` is
 * `DocumentNode['origin']` and the runtime list is
 * `DocumentNode.shape.origin.options` — so adding a third origin cannot leave
 * either derivation behind. This vocabulary has no such single declaration, and
 * a runtime list typed `readonly ExtractionRejectionReason[]` accepts a subset
 * silently: a fourth arm added to the union compiles perfectly well beside a
 * three-element list that no longer covers it.
 *
 * That is not hypothetical here. `entailmentBelowFloor` sits in the vocabulary
 * ahead of the gate that writes it, exactly as `RESERVED_EDGE_KINDS` does, so
 * the next person to touch this list is the one landing a second gate.
 *
 * A `Record` keyed by the union is what makes the copy checkable. Adding an arm
 * to {@link ExtractionRejectionReason} makes this object literal fail to compile
 * until the arm is named here, and every assertion below is driven off the keys —
 * so an arm the union declares but the port's list or the table CHECK has not
 * heard of fails as a refused write rather than as a case nobody ran.
 *
 * @spec §5.10, §13, §15
 */
const EVERY_DECLARED_REASON: Record<ExtractionRejectionReason, null> = {
  quoteAbsent: null,
  quoteNotVerbatim: null,
  mentionsAbsent: null,
  entailmentBelowFloor: null,
};

/** Those arms as a list, in declaration order. @spec §5.10 */
const DECLARED_REASONS = Object.keys(
  EVERY_DECLARED_REASON,
) as readonly ExtractionRejectionReason[];

let store: GraphStore;

/**
 * A complete rejection: every column populated, attributed to a chunk.
 *
 * @spec §5.10
 */
const makeRejection = (overrides: Partial<ExtractionRejection> = {}): ExtractionRejection => ({
  documentId: DOCUMENT_ID,
  chunkOrdinal: CHUNK_ORDINAL,
  chunkHash: CHUNK_HASH,
  claimText: PHANTOM_CLAIM,
  quote: OFFERED_QUOTE,
  reason: 'quoteNotVerbatim',
  modelId: MODEL_ID,
  detail: null,
  at: REJECTED_AT,
  ...overrides,
});

/**
 * A rejection that names no chunk, because nothing located one.
 *
 * The `quoteAbsent` case: the extractor returned a claim with no quote at all, so
 * there is no span to anchor and nothing to attribute a chunk by. The document is
 * still known — it is what the extractor was pointed at.
 *
 * @spec §5.10
 */
const makeUnanchoredRejection = (
  overrides: Partial<ExtractionRejection> = {},
): ExtractionRejection =>
  makeRejection({
    chunkOrdinal: null,
    chunkHash: null,
    quote: null,
    reason: 'quoteAbsent',
    ...overrides,
  });

/** The claim texts logged against a document, in the order the log holds them. @spec §5.10 */
const rejectedTexts = (documentId: string = DOCUMENT_ID, ordinal?: number): string[] =>
  store.readExtractionRejections(documentId, ordinal).map((rejection) => rejection.claimText);

/**
 * The refusal a write produced, or `undefined` if it did not refuse.
 *
 * Returned rather than matched with `toThrow`, for the reason the pathway, regime
 * and document suites give: a store that refuses for an unrelated reason
 * satisfies `toThrow` just as well and never shows which rule did the refusing.
 * In a red run that is not hypothetical — every method under test is missing, so
 * every call throws a `TypeError`.
 *
 * @spec §5.10
 */
const refusalFrom = (write: () => void): unknown => {
  try {
    write();
    return undefined;
  } catch (error) {
    return error;
  }
};

/** Seeds the document and the two chunks the rejections in this file are anchored to. @spec §3.6 */
const seedDocument = (id: string = DOCUMENT_ID): void => {
  store.putDocument({
    id,
    title: 'ADR 0007 — session refresh idempotency',
    origin: 'authored',
    contentRef: 'docs/adr/0007-session-refresh-idempotency.md',
    scope: ENTITY_ID,
    createdAt: CREATED_AT,
  });
  store.putChunk({ documentId: id, ordinal: CHUNK_ORDINAL, hash: CHUNK_HASH, embedding: null });
  store.putChunk({
    documentId: id,
    ordinal: OTHER_CHUNK_ORDINAL,
    hash: OTHER_CHUNK_HASH,
    embedding: null,
  });
};

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  seedDocument();
});

afterEach(() => {
  store.close();
});

describe('a rejection round-trips through the log', () => {
  it('returns the rejection exactly as it was written', () => {
    const rejection = makeRejection();

    store.recordExtractionRejection(rejection);

    expect(store.readExtractionRejections(DOCUMENT_ID)).toStrictEqual([rejection]);
  });

  it('keeps the claim the model proposed, which is the phantom under audit', () => {
    store.recordExtractionRejection(makeRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.claimText).toBe(PHANTOM_CLAIM);
  });

  it('keeps the quote byte for byte, neither trimmed nor folded, since a near miss is the diagnosis', () => {
    store.recordExtractionRejection(makeRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.quote).toBe(OFFERED_QUOTE);
  });

  it('keeps a rejection that cited nothing at all with no quote rather than an empty one', () => {
    store.recordExtractionRejection(makeUnanchoredRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.quote).toBeNull();
  });

  it('records which model proposed it, since that is what the audit groups by', () => {
    store.recordExtractionRejection(makeRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.modelId).toBe(MODEL_ID);
  });

  it('keeps a rejection whose model went unrecorded rather than inventing one', () => {
    store.recordExtractionRejection(makeRejection({ modelId: null }));

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.modelId).toBeNull();
  });

  it('round-trips a nested detail without flattening it', () => {
    store.recordExtractionRejection(makeRejection({ detail: GATE_DETAIL }));

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.detail).toStrictEqual(GATE_DETAIL);
  });

  it('keeps a rejection the gate had no numbers for with no detail', () => {
    store.recordExtractionRejection(makeRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.detail).toBeNull();
  });

  it('keeps the anchor of the chunk it was read from, which outlives the ordinal', () => {
    store.recordExtractionRejection(makeRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.chunkHash).toBe(CHUNK_HASH);
  });

  it('is a log and not a set, so a model that proposed one phantom twice is on record twice', () => {
    store.recordExtractionRejection(makeRejection());
    store.recordExtractionRejection(makeRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID)).toHaveLength(2);
  });

  it('returns rejections in the order they were recorded, not in the order of their instants', () => {
    store.recordExtractionRejection(makeRejection());
    store.recordExtractionRejection(
      makeRejection({ claimText: OTHER_PHANTOM_CLAIM, at: EARLIER_THAN_REJECTED_AT }),
    );

    expect(rejectedTexts()).toStrictEqual([PHANTOM_CLAIM, OTHER_PHANTOM_CLAIM]);
  });

  it('answers with nothing for a document whose extraction refused nothing', () => {
    expect(store.readExtractionRejections(DOCUMENT_ID)).toStrictEqual([]);
  });

  it('answers with nothing for a document nothing has written', () => {
    expect(store.readExtractionRejections(UNWRITTEN_DOCUMENT_ID)).toStrictEqual([]);
  });

  it('keeps two documents apart', () => {
    seedDocument(OTHER_DOCUMENT_ID);
    store.recordExtractionRejection(makeRejection());
    store.recordExtractionRejection(
      makeRejection({ documentId: OTHER_DOCUMENT_ID, claimText: OTHER_PHANTOM_CLAIM }),
    );

    expect(rejectedTexts(OTHER_DOCUMENT_ID)).toStrictEqual([OTHER_PHANTOM_CLAIM]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Reading a chunk's rejections.
 * ---------------------------------------------------------------------------
 *
 * The per-chunk read is what makes the log usable beside §8's document health: a
 * paragraph that the extractor keeps inventing assertions about is a different
 * signal from a document that produced one bad member, and only a read narrowed
 * to a chunk separates them.
 *
 * Narrowed by ordinal, because that is the handle a caller holds — `getChunks`
 * serves chunks by ordinal and E1a deliberately kept the autoincrement key off
 * `DocumentChunk`. The hash rides along in the row so that a rejection recorded
 * before an edit can still be matched to the text it was about after one.
 */

describe('the rejections logged against one chunk', () => {
  it('narrows to the chunk that was asked for', () => {
    store.recordExtractionRejection(makeRejection());
    store.recordExtractionRejection(
      makeRejection({
        chunkOrdinal: OTHER_CHUNK_ORDINAL,
        chunkHash: OTHER_CHUNK_HASH,
        claimText: OTHER_PHANTOM_CLAIM,
      }),
    );

    expect(rejectedTexts(DOCUMENT_ID, CHUNK_ORDINAL)).toStrictEqual([PHANTOM_CLAIM]);
  });

  it('keeps the other chunk of the same document separate', () => {
    store.recordExtractionRejection(makeRejection());
    store.recordExtractionRejection(
      makeRejection({
        chunkOrdinal: OTHER_CHUNK_ORDINAL,
        chunkHash: OTHER_CHUNK_HASH,
        claimText: OTHER_PHANTOM_CLAIM,
      }),
    );

    expect(rejectedTexts(DOCUMENT_ID, OTHER_CHUNK_ORDINAL)).toStrictEqual([OTHER_PHANTOM_CLAIM]);
  });

  it('answers with nothing for a chunk nothing was refused against', () => {
    store.recordExtractionRejection(makeRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID, OTHER_CHUNK_ORDINAL)).toStrictEqual([]);
  });

  it('leaves a rejection that named no chunk out of every chunk read', () => {
    store.recordExtractionRejection(makeUnanchoredRejection());

    expect(store.readExtractionRejections(DOCUMENT_ID, CHUNK_ORDINAL)).toStrictEqual([]);
  });

  it('still reports that rejection to the document read, which is where an unanchored one lives', () => {
    store.recordExtractionRejection(makeUnanchoredRejection());
    store.recordExtractionRejection(makeRejection({ claimText: OTHER_PHANTOM_CLAIM }));

    expect(rejectedTexts()).toStrictEqual([PHANTOM_CLAIM, OTHER_PHANTOM_CLAIM]);
  });

  it('reads a chunk of one document without reaching the same ordinal in another', () => {
    seedDocument(OTHER_DOCUMENT_ID);
    store.recordExtractionRejection(makeRejection());
    store.recordExtractionRejection(
      makeRejection({ documentId: OTHER_DOCUMENT_ID, claimText: OTHER_PHANTOM_CLAIM }),
    );

    expect(rejectedTexts(OTHER_DOCUMENT_ID, CHUNK_ORDINAL)).toStrictEqual([OTHER_PHANTOM_CLAIM]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The reason, which is a vocabulary and not a sentence.
 * ---------------------------------------------------------------------------
 *
 * Free text would make the log unreadable in the only way it is ever read. §13's
 * drift audit and §15's verifier tuning both ask a counting question — how often
 * did this model fail *this way* — and counting over prose written by whichever
 * caller happened to log the row is counting over nothing. The same argument
 * `claims.kind`, `claims.status` and `documents.origin` already make.
 *
 * Three arms. Two are this build's verbatim gate, split because they are
 * different diagnoses: a model that never quotes is broken in a way no threshold
 * fixes, while a model that quotes loosely is exactly what a floor is for. The
 * third is the deferred entailment gate, admitted before anything writes it so
 * that landing it is not a migration.
 */

describe('the reason a claim was refused', () => {
  it.each(DECLARED_REASONS)('stores %s and reports it back unchanged', (reason) => {
    store.recordExtractionRejection(makeRejection({ reason }));

    expect(store.readExtractionRejections(DOCUMENT_ID)[0]?.reason).toBe(reason);
  });

  it.each(['hallucinated', 'QUOTEABSENT', 'quote_absent', 'rejected', ''])(
    'refuses %s, which no audit could ever count',
    (reason) => {
      const refusal = refusalFrom(() => {
        store.recordExtractionRejection(
          makeRejection({ reason: reason as unknown as ExtractionRejectionReason }),
        );
      });

      // Refusal and absence as one assertion, because either alone is satisfiable
      // by something that is not the rule: a store with no
      // `recordExtractionRejection` at all throws, and a store that wrote the row
      // and then threw would leave behind exactly the uncountable row the
      // vocabulary exists to prevent.
      expect({
        refused: refusal !== undefined,
        logged: store.readExtractionRejections(DOCUMENT_ID),
      }).toStrictEqual({ refused: true, logged: [] });
    },
  );

  /*
   * The assertion above is satisfied by *a* refusal, and the table CHECK is one.
   * The two are not the same promise — the file's is to whoever holds the file,
   * the port's is to whoever holds the port, in a vocabulary a driver upgrade
   * cannot reword. This is the assertion that separates them, and it is why
   * `UnknownRejectionReasonError` is declared rather than left as the driver's
   * error and a message string.
   */
  it.each(['hallucinated', 'QUOTEABSENT', 'quote_absent', 'rejected', ''])(
    'names %s as the thing that was wrong, rather than passing the table a value to reject',
    (reason) => {
      const refusal = refusalFrom(() => {
        store.recordExtractionRejection(
          makeRejection({ reason: reason as unknown as ExtractionRejectionReason }),
        );
      });

      expect(refusal).toBeInstanceOf(UnknownRejectionReasonError);
      expect((refusal as UnknownRejectionReasonError).reason).toBe(reason);
    },
  );

  it('keeps two reasons apart on one chunk, so the audit can tell the diagnoses apart', () => {
    store.recordExtractionRejection(makeRejection({ reason: 'quoteNotVerbatim' }));
    store.recordExtractionRejection(
      makeUnanchoredRejection({ chunkOrdinal: CHUNK_ORDINAL, chunkHash: CHUNK_HASH }),
    );

    expect(
      store.readExtractionRejections(DOCUMENT_ID, CHUNK_ORDINAL).map((entry) => entry.reason),
    ).toStrictEqual(['quoteNotVerbatim', 'quoteAbsent']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * What a rejection is not.
 * ---------------------------------------------------------------------------
 *
 * §5.10: failures go to the rejection log *"never the graph"*. That is one
 * sentence carrying two claims — the row holds no evidence, and recording it
 * writes nothing anywhere else — and they fail independently.
 */

describe('a rejection holds no evidence and reaches no graph', () => {
  it('carries what an audit needs and nothing a posterior could live in', () => {
    store.recordExtractionRejection(makeRejection());

    expect(Object.keys(store.readExtractionRejections(DOCUMENT_ID)[0] ?? {}).sort()).toStrictEqual([
      'at',
      'chunkHash',
      'chunkOrdinal',
      'claimText',
      'detail',
      'documentId',
      'modelId',
      'quote',
      'reason',
    ]);
  });

  it('mints no claim and no referent, whatever the extractor proposed', () => {
    store.recordExtractionRejection(makeRejection());
    store.recordExtractionRejection(makeUnanchoredRejection());

    expect({ claims: store.listClaimIds(), referents: store.listEntityIds() }).toStrictEqual({
      claims: [],
      referents: [],
    });
  });

  it('leaves the document chunks exactly as ingest wrote them', () => {
    store.recordExtractionRejection(makeRejection());

    expect(store.getChunks(DOCUMENT_ID).map((chunk) => chunk.hash)).toStrictEqual([
      CHUNK_HASH,
      OTHER_CHUNK_HASH,
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The document a rejection is about.
 * ---------------------------------------------------------------------------
 *
 * Two rulings that look contradictory and are not.
 *
 * A rejection names a document that exists, because the extractor was pointed at
 * one: a rejection whose document was never ingested is a record of an extraction
 * that could not have happened, and it is unreadable besides — the only read this
 * port offers is keyed by document. That is `putChunk`'s refusal, for
 * `putChunk`'s reason.
 *
 * A rejection *survives* that document's deletion. It is an audit row, and the
 * sibling audit table in this schema already made this choice: `adjudication_log`
 * carries `episode_id TEXT` with no foreign key at all, where `stage_log` — the
 * replay log next to it — carries `REFERENCES episodes (id) ON DELETE CASCADE`.
 * The drift audit outlives what it is about on purpose. Deleting a document is a
 * lifecycle event; it is not a finding that the model behaved well, and a log
 * that a delete can rewrite is not evidence of anything.
 */

describe('the document a rejection names', () => {
  it('refuses a rejection whose document was never ingested', () => {
    const refusal = refusalFrom(() => {
      store.recordExtractionRejection(makeRejection({ documentId: UNWRITTEN_DOCUMENT_ID }));
    });

    expect({
      refused: refusal !== undefined,
      orphans: store.readExtractionRejections(UNWRITTEN_DOCUMENT_ID),
    }).toStrictEqual({ refused: true, orphans: [] });
  });

  it('names the document that did not resolve, which no foreign key failure would', () => {
    const refusal = refusalFrom(() => {
      store.recordExtractionRejection(makeRejection({ documentId: UNWRITTEN_DOCUMENT_ID }));
    });

    expect(refusal).toBeInstanceOf(UnknownDocumentError);
    expect((refusal as UnknownDocumentError).documentId).toBe(UNWRITTEN_DOCUMENT_ID);
  });

  it('survives the deletion of the document it is about, since a delete is not an acquittal', () => {
    store.recordExtractionRejection(makeRejection());

    store.deleteDocument(DOCUMENT_ID);

    expect(rejectedTexts()).toStrictEqual([PHANTOM_CLAIM]);
  });

  it('keeps the deleted document chunks gone all the same, so the cascade is unchanged', () => {
    store.recordExtractionRejection(makeRejection());

    store.deleteDocument(DOCUMENT_ID);

    expect(store.getChunks(DOCUMENT_ID)).toStrictEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The constraints the file carries, reached from outside the store.
 * ---------------------------------------------------------------------------
 *
 * The port's promises are above. These are the table's, and they are a different
 * promise to a different holder: whatever writes this database next — a repair
 * script, a later migration, a sibling tool — never goes through the port, and
 * the columns have to refuse on their own.
 *
 * A temp file rather than `:memory:`, because `:memory:` opens a private database
 * and a second connection to one is a second empty database.
 *
 * @spec §5.10, §11, §12
 */

describe('the constraints the rejection table carries', () => {
  const CHECK_VIOLATION = 'SQLITE_CONSTRAINT_CHECK';

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

  let directory: string;
  let dbPath: string;

  const withRawConnection = <T>(run: (db: Database.Database) => T): T => {
    const db = new Database(dbPath);
    try {
      return run(db);
    } finally {
      db.close();
    }
  };

  const rawStatement = (sql: string): RawOutcome =>
    withRawConnection((db) => {
      try {
        return { code: undefined, changes: db.prepare(sql).run().changes };
      } catch (error) {
        return { code: (error as { readonly code?: string }).code, changes: 0 };
      }
    });

  /** Offers a rejection row built from the given column literals. @spec §5.10 */
  const rejectionInsert = ({
    reason = "'quoteNotVerbatim'",
    detail = 'NULL',
    chunkOrdinal = String(CHUNK_ORDINAL),
  }: {
    readonly reason?: string;
    readonly detail?: string;
    readonly chunkOrdinal?: string;
  }): string => `
    INSERT INTO extraction_rejections
      (document_id, chunk_ordinal, chunk_hash, claim_text, quote, reason, model_id, detail, at)
    VALUES ('${DOCUMENT_ID}', ${chunkOrdinal}, '${CHUNK_HASH}', 'a phantom', 'a quote',
            ${reason}, '${MODEL_ID}', ${detail}, '${REJECTED_AT}')
  `;

  /** Reasons the column must refuse — every one of them uncountable in an audit. @spec §5.10, §13 */
  const REFUSED_REASONS: readonly OfferedLiteral[] = [
    { description: 'a word from no vocabulary at all', literal: "'hallucinated'" },
    { description: 'the right arm in the wrong case', literal: "'QuoteAbsent'" },
    { description: 'the right arm in the wrong convention', literal: "'quote_absent'" },
    { description: 'the empty string, which every IS NOT NULL guard admits', literal: "''" },
    { description: 'a number, which TEXT affinity converts and stores', literal: '1' },
  ];

  /** Details the column must refuse, the same four the stage log's payload columns refuse. @spec §5.8, §12 */
  const REFUSED_DETAILS: readonly OfferedLiteral[] = [
    { description: 'text that was never JSON', literal: "'not json'" },
    { description: 'a half-written object', literal: `'{"score":'` },
    { description: 'the empty string, which is present and parses to nothing', literal: "''" },
    { description: 'a blob, which TEXT affinity does not convert', literal: "x'010203'" },
  ];

  /**
   * Chunk ordinals the column must refuse.
   *
   * The same guard `document_chunks.ordinal` carries, and it buys something
   * specific here: the per-chunk read matches `chunk_ordinal = ?`, and SQLite
   * compares across storage classes, so a `'1'` written as TEXT is a different key
   * from the integer 1. The auditor asks what the model invented about this
   * paragraph and is told nothing — the worst answer an audit instrument can give,
   * because it is indistinguishable from a clean paragraph.
   *
   * @spec §3.6, §5.10
   */
  const REFUSED_ORDINALS: readonly OfferedLiteral[] = [
    { description: 'text, which no ordinal comparison matches', literal: "'first'" },
    { description: 'the empty string', literal: "''" },
    { description: 'a blob, which INTEGER affinity does not convert', literal: "x'01'" },
    { description: 'a fraction, which is not a position in a sequence', literal: '1.5' },
    { description: 'a negative position', literal: '-1' },
  ];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kg-rejection-guard-'));
    dbPath = join(directory, 'graph.db');

    const fileStore = openGraphStore({ path: dbPath });
    try {
      fileStore.putDocument({
        id: DOCUMENT_ID,
        title: 'ADR 0007',
        origin: 'authored',
        contentRef: 'docs/adr/0007.md',
        scope: ENTITY_ID,
        createdAt: CREATED_AT,
      });
    } finally {
      fileStore.close();
    }
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(DECLARED_REASONS)(
    'takes %s, which is one arm of the vocabulary',
    (reason) => {
      expect(rawStatement(rejectionInsert({ reason: `'${reason}'` }))).toStrictEqual({
        code: undefined,
        changes: 1,
      });
    },
  );

  it.each(REFUSED_REASONS)('refuses a reason that is $description', ({ literal }) => {
    expect(rawStatement(rejectionInsert({ reason: literal }))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('takes a rejection that names no chunk, since an absent quote anchors nothing', () => {
    expect(
      rawStatement(rejectionInsert({ reason: "'quoteAbsent'", chunkOrdinal: 'NULL' })),
    ).toStrictEqual({ code: undefined, changes: 1 });
  });

  /*
   * The document this fixture seeded has no chunks at all, so the row below names
   * an ordinal nothing holds — and the table takes it. That is the ruling, not an
   * oversight: a rejection is not a child of a chunk row. §5.10 edits documents
   * and re-chunks them between one extraction and the next, and a composite key
   * into `document_chunks` would make every re-chunk quietly delete the audit
   * history of the paragraphs that churn most, which are the paragraphs a model's
   * behaviour is most worth auditing over. The hash in the row is what ties the
   * rejection to the text; the ordinal is where it sat at the time.
   */
  it('takes a rejection naming a chunk the document does not hold, since a re-chunk must not erase an audit', () => {
    expect(rawStatement(rejectionInsert({ chunkOrdinal: '7' }))).toStrictEqual({
      code: undefined,
      changes: 1,
    });
  });

  it.each(REFUSED_ORDINALS)('refuses a chunk ordinal that is $description', ({ literal }) => {
    expect(rawStatement(rejectionInsert({ chunkOrdinal: literal }))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });

  it('takes a detail that is valid JSON', () => {
    expect(
      rawStatement(rejectionInsert({ detail: `'${JSON.stringify(GATE_DETAIL)}'` })),
    ).toStrictEqual({ code: undefined, changes: 1 });
  });

  it.each(REFUSED_DETAILS)('refuses a detail that is $description', ({ literal }) => {
    expect(rawStatement(rejectionInsert({ detail: literal }))).toStrictEqual({
      code: CHECK_VIOLATION,
      changes: 0,
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Left underdetermined, deliberately unasserted.
 * ---------------------------------------------------------------------------
 *
 * 1. **Reading the log across documents.** *"Is this model safe to extract
 *    with"* is a question about a month, not about an ADR, and the only reads
 *    here are keyed by document. `model_id` is a column precisely so that query
 *    is expressible, but a scan over the whole log needs the paging the ledger
 *    scan already had to design, and inventing a second paging convention here
 *    would pin one before anything reads it.
 * 2. **Whether the *port* should refuse a chunk the document no longer has.**
 *    The table's answer is settled above — no key into `document_chunks`, because
 *    a re-chunk must not collect the audit history of the paragraph it rewrote.
 *    Whether `recordExtractionRejection` should nonetheless look the chunk up and
 *    refuse is a separate question, and an open one: §5.10's re-anchor pass exists
 *    precisely because an ordinal recorded before an edit may point at other text
 *    or at nothing, so a check that is right at extraction time is wrong a commit
 *    later. Nothing here asserts either direction, and every rejection this file
 *    records through the port names a chunk that exists.
 * 3. **Whether the ordinal and the hash must arrive together.** A rejection that
 *    names an ordinal but no hash is a positional-only anchor, which §3.6 forbids
 *    for chunks — but that rule is written about chunks, and reading it onto this
 *    table would be an extension rather than an application. Left as two
 *    independently nullable columns.
 * 4. **JSON `null` in `detail` against SQL NULL.** `entities.locator` takes
 *    trouble to keep an honestly-null locator apart from an absent one; nothing
 *    here says which a `detail` of `null` came back from. The gate that fills
 *    that column does not exist yet, so the distinction has no reader.
 * 5. **Whether accepted members should be logged too.** §13's sampled entailment
 *    checks read *extracted members against their quoted spans*, which is a
 *    rate — and a rate needs a denominator this table does not hold. §5.10 sends
 *    only failures here, so only failures are here, and where the accepted half
 *    is counted is a §8 question about document health rather than a store one.
 */
