/**
 * What a revision *costs*, and what a shrinking one destroys.
 *
 * `anchor-stability.test.ts` pins the property in the currency of anchors: an
 * edit must not move the hashes of the regions it did not touch. This file pins
 * the same property in the two currencies that suite never spends —
 * **embeddings** and **rows** — because the anchor assertions are satisfied by
 * an implementation that gets both of those catastrophically wrong.
 *
 * ── Why the embedding count is an assertion and not a detail ────────────────
 *
 * §5.10 makes ingest *"cheap: chunk, embed, anchor"*, and of those three the
 * embedding is the only one that is a model call. §5.3's budget is spent per
 * paragraph, so "how many paragraphs did this revision re-embed" is the whole
 * cost of a re-ingest — and it is invisible to every assertion about hashes,
 * because re-embedding a paragraph produces the identical vector for the
 * identical text. A revision that silently re-embedded the entire document on
 * every commit would satisfy `anchor-stability.test.ts` completely while
 * spending the document's whole embedding budget on every save.
 *
 * So the geometry a document already holds is read here as a number: the fake
 * provider records its calls, and what is asserted is *which paragraphs* were
 * embedded, not merely how many. A count alone would pass for an implementation
 * that embedded the right number of the wrong paragraphs.
 *
 * ── Why the shrinking revision has a file to itself ─────────────────────────
 *
 * `putChunk` *"replaces whatever chunk that document already had at that
 * ordinal"* and the store has no `deleteChunk`. So a document revised from
 * twelve paragraphs to four writes ordinals 0–3 and leaves 4–11 exactly where
 * they were: eight chunk rows anchoring eight paragraphs the author has
 * deleted. §7.7 reads a document's health from *"member states plus extraction
 * coverage"* and would count all twelve; §5.10's `retracted_in_source` — *"the
 * author withdrew the testimony"* — is precisely the signal those eight rows
 * would suppress, because a row that still exists is a span that never
 * vanished.
 *
 * Every other test in this suite grows or rewrites a document. None shrinks
 * one, so none can see that tail. The two tests below shrink, and they assert
 * both halves at once: the deleted paragraphs are gone, *and* the survivors did
 * not pay to be re-embedded on the way. Those two are in tension — the only way
 * to drop the tail through this store is to delete the document and let the
 * cascade take its chunks, and a delete taken before the surviving geometry is
 * read would re-embed every paragraph in the document while looking correct.
 *
 * Real SQLite, `:memory:`. Only the embedding provider and the adjudicator are
 * faked, and no document here names an anchor, so every call the provider
 * records is a chunk being embedded.
 *
 * @spec §3.6, §5.3, §5.10, §7.7, §12
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXTRACT_JOB_KIND, chunkText, openTextIngest } from '../index';

import {
  DOCUMENT_ID,
  EDITS,
  LONG_PARAGRAPHS,
  SHORT_PARAGRAPHS,
  drainJobs,
  editParagraph,
  harnessFor,
  notebook,
  notebookParagraph,
  textSource,
  type Harness,
} from './fixtures';

/** The document before a shrinking revision, in paragraphs. */
const BEFORE_SHRINK = 12;

/** The document after it. Fewer than a third of what it held. */
const AFTER_SHRINK = 4;

let harness: Harness;

beforeEach(() => {
  harness = harnessFor(openTextIngest);
});

afterEach(() => {
  harness.close();
});

/** Ingests a text under the document id. @spec §5.10 */
const submit = async (text: string): Promise<void> => {
  await harness.text.submitText(textSource({ text }));
};

/**
 * The paragraphs the provider was asked to embed since the log was last
 * dropped.
 *
 * The texts and not the count: an implementation that embedded the right number
 * of the wrong paragraphs would be spending the same budget to store the wrong
 * geometry, and a count cannot tell the two apart.
 *
 * @spec §5.3
 */
const embeddedSince = (): string[] => harness.embeddings.calls.map((call) => call.text);

/** Drops the provider's call log, so the next assertion is about one revision. */
const startCounting = (): void => {
  harness.embeddings.forget();
};

describe('a revision embeds the paragraphs that changed and no others', () => {
  it('re-ingesting an unchanged document spends nothing on the embedding provider', async () => {
    await submit(notebook(SHORT_PARAGRAPHS));
    startCounting();

    await submit(notebook(SHORT_PARAGRAPHS));

    expect(embeddedSince()).toStrictEqual([]);
  });

  it('rewriting one paragraph embeds that paragraph and leaves the rest of the document alone', async () => {
    const before = notebook(SHORT_PARAGRAPHS);
    const at = 3;
    await submit(before);
    startCounting();

    const after = editParagraph(before, at, EDITS[0]!);
    await submit(after);

    expect(embeddedSince()).toStrictEqual([chunkText(after)[at]!.text]);
  });

  it('appending a paragraph embeds the new paragraph only', async () => {
    const before = notebook(SHORT_PARAGRAPHS);
    const added = notebookParagraph(SHORT_PARAGRAPHS);
    await submit(before);
    startCounting();

    await submit(`${before}\n\n${added}`);

    expect(embeddedSince()).toStrictEqual([added]);
  });

  it('costs the same in a long document as in a short one, so the budget does not scale either', async () => {
    const at = 3;
    const short = notebook(SHORT_PARAGRAPHS);
    await submit(short);
    startCounting();
    await submit(editParagraph(short, at, EDITS[0]!));
    const shortCost = embeddedSince().length;

    const long = harnessFor(openTextIngest);
    try {
      const text = notebook(LONG_PARAGRAPHS);
      await long.text.submitText(textSource({ text }));
      long.embeddings.forget();
      await long.text.submitText(textSource({ text: editParagraph(text, at, EDITS[0]!) }));

      expect(shortCost).toBeGreaterThan(0);
      expect(long.embeddings.calls.length).toBe(shortCost);
    } finally {
      long.close();
    }
  });
});

describe('a revision that deletes paragraphs', () => {
  /** Shrinks the document from {@link BEFORE_SHRINK} paragraphs to {@link AFTER_SHRINK}. */
  const shrink = async (): Promise<void> => {
    await submit(notebook(BEFORE_SHRINK));
    startCounting();
    await submit(notebook(AFTER_SHRINK));
  };

  it('leaves no chunk anchoring a paragraph the author deleted', async () => {
    await shrink();

    const withdrawn = Array.from({ length: BEFORE_SHRINK - AFTER_SHRINK }, (_, n) =>
      notebookParagraph(AFTER_SHRINK + n),
    );
    const surviving = harness.store.getChunks(DOCUMENT_ID).map((chunk) => chunk.hash);
    const gone = chunkText(notebook(BEFORE_SHRINK))
      .filter((view) => withdrawn.includes(view.text))
      .map((view) => view.hash);

    expect(gone.length).toBe(BEFORE_SHRINK - AFTER_SHRINK);
    expect(surviving.filter((hash) => gone.includes(hash))).toStrictEqual([]);
    expect(surviving.length).toBe(AFTER_SHRINK);
  });

  it('serves the shortened document, at contiguous ordinals, with nothing trailing it', async () => {
    await shrink();

    expect(harness.text.chunksOf(DOCUMENT_ID)).toStrictEqual(chunkText(notebook(AFTER_SHRINK)));
    expect(harness.store.getChunks(DOCUMENT_ID).map((chunk) => chunk.ordinal)).toStrictEqual(
      Array.from({ length: AFTER_SHRINK }, (_, at) => at),
    );
  });

  it('does not make the surviving paragraphs pay to be embedded a second time', async () => {
    await shrink();

    expect(embeddedSince()).toStrictEqual([]);
  });

  it('leaves every surviving chunk with the vector it already had, not a null one', async () => {
    await submit(notebook(BEFORE_SHRINK));
    const before = new Map(
      harness.store.getChunks(DOCUMENT_ID).map((chunk) => [chunk.hash, chunk.embedding]),
    );

    await submit(notebook(AFTER_SHRINK));

    const after = harness.store.getChunks(DOCUMENT_ID);
    expect(after.filter((chunk) => chunk.embedding === null)).toStrictEqual([]);
    expect(after.map((chunk) => chunk.embedding)).toStrictEqual(
      after.map((chunk) => before.get(chunk.hash)),
    );
  });

  it('parks no extraction work, because deleting text proposes nothing new to mine', async () => {
    await submit(notebook(BEFORE_SHRINK));
    drainJobs(harness.store, EXTRACT_JOB_KIND);

    const receipt = await harness.text.submitText(textSource({ text: notebook(AFTER_SHRINK) }));

    expect(receipt.enqueued).toStrictEqual([]);
    expect(drainJobs(harness.store, EXTRACT_JOB_KIND)).toStrictEqual([]);
  });

  it('is still the same document afterwards, in the same episode and first seen when it was', async () => {
    const first = await harness.text.submitText(textSource({ text: notebook(BEFORE_SHRINK) }));
    const createdAt = harness.store.getDocument(DOCUMENT_ID)?.createdAt;

    const revised = await harness.text.submitText(textSource({ text: notebook(AFTER_SHRINK) }));

    expect(revised.episodeId).toStrictEqual(first.episodeId);
    expect(harness.store.getDocument(DOCUMENT_ID)?.createdAt).toStrictEqual(createdAt);
    expect(createdAt).toEqual(expect.any(String));
  });

  it('re-embeds a paragraph the author restores, and only that one', async () => {
    await submit(notebook(BEFORE_SHRINK));
    await submit(notebook(AFTER_SHRINK));
    startCounting();

    await submit(notebook(AFTER_SHRINK + 1));

    expect(embeddedSince()).toStrictEqual([notebookParagraph(AFTER_SHRINK)]);
  });
});
