/**
 * The two doors E2 must not leave open: a materialized document, and a document
 * with nothing in it.
 *
 * ── Materialized documents: the refusal happens here ────────────────────────
 *
 * §5.10 is unconditional — *"Authored documents only. Materialized documents
 * have members by construction; re-extracting would launder canonicals back in
 * as fresh testimony."* §12 files it as a named failure mode: *"Testimony
 * laundering — materialized docs re-extracted, looping canonicals back as fresh
 * testimony."* That is §4.4's independence failure with a document in the
 * middle: the graph's own conclusions coming back as corroboration of
 * themselves, arriving through a door built for external testimony.
 *
 * The rule has two possible homes and this suite rules on one. **E2 does not
 * enqueue.** Three reasons:
 *
 * 1. The gate is already in E2's hand. `origin` is a column on the row
 *    `submitText` has just written, so refusing costs a field read. E3 would
 *    have to re-read the document for every job it claims, re-deriving on every
 *    drain a decision that was decidable once at ingest.
 * 2. A queue whose rows must never run is a queue whose depth lies. §9 hangs
 *    *"extraction backlog"* off this table as a health signal, and a backlog
 *    padded with work nobody may do makes that number unreadable.
 * 3. §5.10 makes extraction lazy for a cost reason. A job that will be claimed,
 *    inspected and dropped is the cost without the extraction.
 *
 * What E2 must still do is everything else: a materialized document is §3.7's
 * compression target and §7.7 renders its health, so it is chunked, embedded and
 * anchored exactly like an authored one. It *serves whole immediately*; it is
 * only never mined.
 *
 * This is a ruling, not the whole defence. `enqueueJob` is public and E3 will be
 * able to claim an `extract` job somebody else parked, so E3 should refuse to
 * drain one whose document is materialized as well — a second lock on the same
 * door. That assertion belongs to E3's suite, where there is a drain to make it
 * against.
 *
 * ── Degenerate input: never a document that only looks ingested ─────────────
 *
 * The failure to avoid is narrow and specific. A document row with zero chunks
 * is *worse* than a refusal: §7.7 computes health from *"member states plus
 * extraction coverage"*, and a document with no chunks has no coverage to be
 * short of, so it reads as complete. It would sit in the graph indefinitely,
 * serving nothing, flagged as nothing.
 *
 * Which honest answer E2 gives is not pinned — a named refusal that leaves the
 * store untouched and an acceptance that produces at least one real chunk are
 * both defensible, and §5.10 says nothing about either. What is pinned is that
 * it gives one of them, and that a crash is not one: {@link isNamedRefusal}
 * exists because with the module absent a bare throw assertion is satisfied by
 * a `TypeError`.
 *
 * Real SQLite, `:memory:`, no mocks of the store.
 *
 * @spec §3.6, §3.7, §4.4, §5.10, §7.7, §9, §12
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXTRACT_JOB_KIND, openTextIngest } from '../index';

import {
  DOCUMENT_ID,
  MATERIALIZED_DOCUMENT_ID,
  SHORT_PARAGRAPHS,
  UNKNOWN_ANCHOR,
  drainJobs,
  harnessFor,
  isNamedRefusal,
  notebook,
  refusalFrom,
  textSource,
  type Harness,
} from './fixtures';

let harness: Harness;

beforeEach(() => {
  harness = harnessFor(openTextIngest);
});

afterEach(() => {
  harness.close();
});

describe('a materialized document is chunked, embedded and anchored — and never queued', () => {
  it('parks no extraction work for it, so no canonical can return as testimony', async () => {
    const receipt = await harness.text.submitText(
      textSource({
        id: MATERIALIZED_DOCUMENT_ID,
        origin: 'materialized',
        text: notebook(SHORT_PARAGRAPHS),
      }),
    );

    expect(receipt.enqueued).toStrictEqual([]);
    expect(drainJobs(harness.store, EXTRACT_JOB_KIND)).toStrictEqual([]);
  });

  it('still serves whole immediately: a row, chunks, and a vector on every one of them', async () => {
    const receipt = await harness.text.submitText(
      textSource({
        id: MATERIALIZED_DOCUMENT_ID,
        origin: 'materialized',
        anchor: UNKNOWN_ANCHOR,
        text: notebook(SHORT_PARAGRAPHS),
      }),
    );

    const chunks = harness.store.getChunks(MATERIALIZED_DOCUMENT_ID);
    expect(harness.store.getDocument(MATERIALIZED_DOCUMENT_ID)).toMatchObject({
      origin: 'materialized',
      scope: receipt.anchor?.referentId,
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.filter((chunk) => chunk.embedding === null)).toStrictEqual([]);
  });

  it('leaves an authored document beside it queued as normal', async () => {
    await harness.text.submitText(
      textSource({
        id: MATERIALIZED_DOCUMENT_ID,
        origin: 'materialized',
        text: notebook(SHORT_PARAGRAPHS),
      }),
    );
    const authored = await harness.text.submitText(
      textSource({ text: notebook(SHORT_PARAGRAPHS) }),
    );

    const parked = drainJobs(harness.store, EXTRACT_JOB_KIND);
    expect(authored.enqueued.length).toBeGreaterThan(0);
    expect(parked.map((job) => (job.payload as { documentId?: unknown }).documentId)).toStrictEqual(
      parked.map(() => DOCUMENT_ID),
    );
  });
});

/**
 * The inputs that have no paragraphs to chunk, and the two that have exactly
 * one thing to chunk and no boundary to find.
 *
 * The enormous unbroken paragraph is the case §5.10 leaves most open: there is
 * no blank line to split on and no specified size to split at, so whether it
 * becomes one chunk or many is GREEN's call. Only the invariant is asserted.
 */
const DEGENERATE = [
  ['nothing at all', ''],
  ['whitespace alone', '   \n\n\t  \n '],
  ['a single word', 'Yes.'],
  [
    'one enormous unbroken paragraph',
    Array.from(
      { length: 600 },
      (_, n) => `clause ${n} of a sentence that its author never ended`,
    ).join(', '),
  ],
] as const;

describe('degenerate input never produces a document that only looks ingested', () => {
  it.each(DEGENERATE)('given %s, either declines cleanly or chunks it for real', async (_name, text) => {
    const refusal = await refusalFrom(() => harness.text.submitText(textSource({ text })));

    const document = harness.store.getDocument(DOCUMENT_ID);
    const chunks = harness.store.getChunks(DOCUMENT_ID);
    const outcome =
      refusal !== undefined
        ? {
            declined: isNamedRefusal(refusal),
            leftNothingBehind: document === undefined && chunks.length === 0,
          }
        : { declined: false, leftNothingBehind: false };
    const accepted = {
      wroteTheDocument: document !== undefined,
      chunkedIt: chunks.length > 0,
      embeddedEveryChunk: chunks.length > 0 && chunks.every((chunk) => chunk.embedding !== null),
    };

    expect(
      (outcome.declined && outcome.leftNothingBehind) ||
        (accepted.wroteTheDocument && accepted.chunkedIt && accepted.embeddedEveryChunk),
    ).toBe(true);
  });

  it.each(DEGENERATE.slice(2))('given %s, which is real text, ingests it rather than declining', async (_name, text) => {
    const receipt = await harness.text.submitText(textSource({ text }));

    expect(receipt.chunks.length).toBeGreaterThan(0);
    expect(receipt.enqueued.length).toBe(receipt.chunks.length);
    expect(harness.text.chunksOf(DOCUMENT_ID).map((view) => view.text).join('')).toContain(
      text.slice(0, 4),
    );
  });

  it('given nothing at all, never leaves a chunkless row for §7.7 to read as complete', async () => {
    await refusalFrom(() => harness.text.submitText(textSource({ text: '' })));

    const document = harness.store.getDocument(DOCUMENT_ID);
    expect(document === undefined || harness.store.getChunks(DOCUMENT_ID).length > 0).toBe(true);
  });
});
