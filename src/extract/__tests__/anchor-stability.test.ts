/**
 * The property E2 exists to hold: **editing one region of a document must not
 * change the hashes of the regions that did not change.**
 *
 * §3.6 anchors a chunk by *"hash + fuzzy-quote anchoring, never raw offsets"*,
 * and §12 files span rot as the named failure a byte offset causes: *"document
 * edits break anchors; retracted assertions keep contributing"*. §5.10 says what
 * the anchors are *for*:
 *
 *   *"Testimony decay. Document edits fire the doc-side sibling of churn decay:
 *   members whose spans changed decay their doc-sourced contribution toward the
 *   prior; members whose quotes vanish flag `retracted_in_source` — the author
 *   withdrew the testimony."*
 *
 * That mechanism is only worth having if it is **selective**. A chunker that
 * shifts every downstream boundary when a word is inserted at the top reports
 * that every member of the document changed, every time anybody edits it — so
 * every member decays toward the prior on every commit, the document's derived
 * health (§7.7) collapses to noise, and the machinery *looks* like it is
 * working the whole time. That is worse than not having it: a broken anchor is
 * indistinguishable from an honest retraction.
 *
 * ── What is pinned, and what is deliberately not ────────────────────────────
 *
 * Several chunking algorithms satisfy this — chunk per paragraph, content-defined
 * chunking over a rolling hash, paragraph groups whose boundaries are decided by
 * content — and the choice between them is GREEN's. §5.10 never specifies a
 * chunk size and **nothing here asserts one**. Not a count, not a minimum, not a
 * maximum. What is asserted is locality, and it is asserted twice:
 *
 * 1. **It does not scale with the document.** The same edit, applied to the same
 *    leading text under two different amounts of trailing text, must not cost
 *    more anchors in the long document than in the short one. This is decisive
 *    at any chunk size — a chunker that emits two chunks for the short document
 *    and three for the long one still fails it if it reflows — which is why it
 *    is the primary assertion here.
 * 2. **It is bounded absolutely.** Of the chunks lying wholly outside the edited
 *    paragraph, at most {@link BOUNDARY_ALLOWANCE} may lose their hashes: one
 *    boundary on either side of the change.
 *
 * The weaker property the plan names is pinned beside them: re-ingesting an
 * unchanged document is a no-op, and — the half with teeth — enqueues nothing,
 * since the store deliberately does not deduplicate jobs (*"a second identical
 * submission is a second job"*), so the policy has to live here or every
 * re-ingest re-extracts the whole document.
 *
 * ── Reading a chunking without offsets ──────────────────────────────────────
 *
 * §3.6 forbids the chunk surface from carrying a byte offset, so this file
 * cannot ask a chunk where it is. It locates each chunk's *verbatim text* in the
 * document itself with `indexOf`, which the corpus makes exact by giving every
 * paragraph a unique opening. That is also why {@link ChunkView} must hand back
 * verbatim text at all: §5.10's claim-with-quote gate — *"every member carries
 * its verbatim source span"* — cannot be run by E3 against text this module
 * normalized.
 *
 * `getChunks`'s ordinal ordering is E1a's promise and is not re-litigated here;
 * every read below is keyed by ordinal rather than taken from row order, so the
 * `ANALYZE` trap that suite pins belongs to that suite.
 *
 * Real SQLite, `:memory:` and one temp file, no mocks of the store.
 *
 * @spec §3.6, §5.10, §7.7, §9, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXTRACT_JOB_KIND, openTextIngest } from '../index';

import {
  BOUNDARY_ALLOWANCE,
  DOCUMENT_ID,
  EDITS,
  LONG_PARAGRAPHS,
  MIDDLE_EDIT_AT,
  OTHER_DOCUMENT_ID,
  PARAGRAPH_BREAK,
  SHARED_EDIT_AT,
  SHORT_PARAGRAPHS,
  drainJobs,
  editParagraph,
  harnessFor,
  notebook,
  notebookParagraph,
  paragraphRegion,
  positionOf,
  squash,
  textSource,
  whollyAfter,
  whollyBefore,
  disturbedCount,
  type Edit,
  type Harness,
} from './fixtures';

let harness: Harness;

beforeEach(() => {
  harness = harnessFor(openTextIngest);
});

afterEach(() => {
  harness.close();
});

/** The hashes of a document's chunks, in ordinal order. @spec §3.6 */
const hashesOf = (documentId: string): string[] =>
  harness.text.chunksOf(documentId).map((view) => view.hash);

/** Ingests a text under one id and hands back the chunking it produced. @spec §5.10 */
const submit = async (text: string, id = DOCUMENT_ID): Promise<void> => {
  await harness.text.submitText(textSource({ id, text }));
};

describe('a chunk is anchored by content, so an edit costs only the region it lands in', () => {
  describe.each(EDITS.map((edit) => [edit.name, edit] as const))(
    'under %s in the middle of the document',
    (_name: string, edit: Edit) => {
      it('leaves every chunk wholly before and wholly after the edited paragraph anchored where it was', async () => {
        const before = notebook(LONG_PARAGRAPHS);
        const region = paragraphRegion(before, MIDDLE_EDIT_AT);
        await submit(before);
        const original = harness.text.chunksOf(DOCUMENT_ID);

        await submit(editParagraph(before, MIDDLE_EDIT_AT, edit));
        const survivors = hashesOf(DOCUMENT_ID);

        const untouched = [
          ...whollyBefore(original, before, region),
          ...whollyAfter(original, before, region),
        ];
        const lost = untouched.filter((view) => !survivors.includes(view.hash));

        expect({
          chunksBefore: whollyBefore(original, before, region).length > 0,
          chunksAfter: whollyAfter(original, before, region).length > 0,
        }).toStrictEqual({ chunksBefore: true, chunksAfter: true });
        expect(lost.length).toBeLessThanOrEqual(BOUNDARY_ALLOWANCE);
      });

      it('costs no more anchors in a long document than the same edit costs in a short one', async () => {
        const short = notebook(SHORT_PARAGRAPHS);
        const long = notebook(LONG_PARAGRAPHS);
        const editedShort = editParagraph(short, SHARED_EDIT_AT, edit);
        const editedLong = editParagraph(long, SHARED_EDIT_AT, edit);

        await submit(short, DOCUMENT_ID);
        const shortOriginal = harness.text.chunksOf(DOCUMENT_ID);
        await submit(editedShort, DOCUMENT_ID);
        const shortDisturbed = disturbedCount(shortOriginal, editedShort, hashesOf(DOCUMENT_ID));

        const other = harnessFor(openTextIngest);
        try {
          await other.text.submitText(textSource({ id: DOCUMENT_ID, text: long }));
          const longOriginal = other.text.chunksOf(DOCUMENT_ID);
          await other.text.submitText(textSource({ id: DOCUMENT_ID, text: editedLong }));
          const longHashes = other.text.chunksOf(DOCUMENT_ID).map((view) => view.hash);

          expect(longOriginal.length).toBeGreaterThan(shortOriginal.length);
          expect(disturbedCount(longOriginal, editedLong, longHashes)).toBeLessThanOrEqual(
            shortDisturbed,
          );
        } finally {
          other.close();
        }
      });
    },
  );

  it('appends without renumbering or re-anchoring a single existing chunk', async () => {
    const before = notebook(LONG_PARAGRAPHS);
    await submit(before);
    const original = harness.text.chunksOf(DOCUMENT_ID);

    await submit(`${before}${PARAGRAPH_BREAK}${notebookParagraph(LONG_PARAGRAPHS)}`);
    const after = harness.text.chunksOf(DOCUMENT_ID);

    const kept = after.slice(0, original.length - BOUNDARY_ALLOWANCE);
    expect(kept).toStrictEqual(original.slice(0, original.length - BOUNDARY_ALLOWANCE));
    expect(after.length).toBeGreaterThanOrEqual(original.length);
  });
});

describe('re-ingesting an unchanged document', () => {
  it('produces the same chunks at the same ordinals under the same hashes', async () => {
    await submit(notebook(LONG_PARAGRAPHS));
    const first = harness.text.chunksOf(DOCUMENT_ID);

    await submit(notebook(LONG_PARAGRAPHS));

    expect(harness.text.chunksOf(DOCUMENT_ID)).toStrictEqual(first);
  });

  it('enqueues nothing, so the extractor is not asked to re-mine what it already mined', async () => {
    await submit(notebook(LONG_PARAGRAPHS));
    const enqueuedByIngest = drainJobs(harness.store, EXTRACT_JOB_KIND).length;

    const receipt = await harness.text.submitText(
      textSource({ text: notebook(LONG_PARAGRAPHS) }),
    );

    expect(enqueuedByIngest).toBeGreaterThan(0);
    expect(receipt.enqueued).toStrictEqual([]);
    expect(drainJobs(harness.store, EXTRACT_JOB_KIND)).toStrictEqual([]);
  });
});

describe('an edited document enqueues only what changed', () => {
  it('parks a job for every new anchor and for no anchor that survived the edit', async () => {
    const before = notebook(LONG_PARAGRAPHS);
    await submit(before);
    const original = hashesOf(DOCUMENT_ID);
    drainJobs(harness.store, EXTRACT_JOB_KIND);

    const receipt = await harness.text.submitText(
      textSource({ text: editParagraph(before, MIDDLE_EDIT_AT, EDITS[0]!) }),
    );
    const parked = receipt.enqueued.map((id) => harness.store.getJob(id));
    const parkedHashes = parked.map((job) => (job?.payload as { hash?: unknown } | undefined)?.hash);

    expect(receipt.enqueued.length).toBeGreaterThan(0);
    expect(parkedHashes.filter((hash) => original.includes(hash as string))).toStrictEqual([]);
    expect(new Set(parkedHashes)).toStrictEqual(
      new Set(hashesOf(DOCUMENT_ID).filter((hash) => !original.includes(hash))),
    );
  });
});

describe('the chunking is a function of the text alone', () => {
  it('answers identically in a store that has never seen the document before', async () => {
    await submit(notebook(LONG_PARAGRAPHS));
    const first = harness.text.chunksOf(DOCUMENT_ID);

    const elsewhere = harnessFor(openTextIngest);
    try {
      await elsewhere.text.submitText(textSource({ text: notebook(LONG_PARAGRAPHS) }));
      expect(elsewhere.text.chunksOf(DOCUMENT_ID)).toStrictEqual(first);
    } finally {
      elsewhere.close();
    }
  });

  it('answers identically for the same text carried under a different document id', async () => {
    await submit(notebook(LONG_PARAGRAPHS), DOCUMENT_ID);
    await submit(notebook(LONG_PARAGRAPHS), OTHER_DOCUMENT_ID);

    expect(hashesOf(OTHER_DOCUMENT_ID)).toStrictEqual(hashesOf(DOCUMENT_ID));
  });
});

describe("a chunk's text is a verbatim span of the document", () => {
  it('quotes the document exactly, so E3 has something the verbatim gate can be run against', async () => {
    const text = notebook(LONG_PARAGRAPHS);
    await submit(text);

    const views = harness.text.chunksOf(DOCUMENT_ID);
    expect(views.filter((view) => !text.includes(view.text))).toStrictEqual([]);
    expect(views.filter((view) => view.text.length === 0)).toStrictEqual([]);
  });

  it('partitions the document: nothing dropped, nothing invented, nothing overlapped', async () => {
    const text = notebook(LONG_PARAGRAPHS);
    await submit(text);

    const views = harness.text.chunksOf(DOCUMENT_ID);
    expect(squash(views.map((view) => view.text).join(''))).toStrictEqual(squash(text));
  });

  it('numbers the chunks contiguously from zero, in the order the document reads', async () => {
    const text = notebook(LONG_PARAGRAPHS);
    await submit(text);

    const views = harness.text.chunksOf(DOCUMENT_ID);
    const positions = views.map((view) => positionOf(view, text));

    expect(views.map((view) => view.ordinal)).toStrictEqual(
      Array.from({ length: views.length }, (_, at) => at),
    );
    expect([...positions].sort((left, right) => left - right)).toStrictEqual(positions);
  });
});

describe('the chunk text survives the process that produced it', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kg-extract-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('is served by a port opened over the database afterwards, not from the writer that made it', async () => {
    const path = join(directory, 'graph.db');
    const writer = harnessFor(openTextIngest, path);
    let written: unknown;
    try {
      await writer.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));
      written = writer.text.chunksOf(DOCUMENT_ID);
    } finally {
      writer.close();
    }

    const reader = harnessFor(openTextIngest, path);
    try {
      expect(reader.text.chunksOf(DOCUMENT_ID)).toStrictEqual(written);
    } finally {
      reader.close();
    }
  });
});
