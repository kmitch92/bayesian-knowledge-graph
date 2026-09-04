/**
 * §5.10's cheap half, as a surface: *"Ingest is cheap: chunk, embed, anchor —
 * the document serves whole immediately. Extraction is lazy."*
 *
 * E1a gave the store somewhere to put a document and its chunks; E1b gave it a
 * queue and an atomic claim. Neither has ever been written to by anything in
 * `src/`. This file is where `submitText` becomes the thing that writes to both,
 * and where the expensive half is *parked* rather than paid: no member claim, no
 * `STATED_IN` edge, no entailment gate anywhere below. Those are E3's.
 *
 * ── The five things a job needs to be honest ────────────────────────────────
 *
 * **One job per chunk.** §5.10's cost argument is the whole reason the queue
 * exists — *"a 3,000-word ADR never pays forty inline adjudications"*. A job per
 * document would park the same forty adjudications in one unit of work.
 *
 * **A payload that names the chunk.** E3 fetches the chunk it was pointed at, so
 * the payload carries the document, the ordinal and the hash. Both, not either:
 * §3.6 records both on an extraction rejection for exactly this reason — *"the
 * ordinal is where the paragraph sat at the time, and the hash is what ties the
 * rejection to the text after a re-chunk moves it"* — and a repeated paragraph
 * is one hash at two ordinals, so the hash alone does not address a chunk.
 *
 * **No offset, anywhere.** The payload is asserted whole, not field by field: a
 * payload that grew a `start` would satisfy every per-field assertion.
 *
 * **The `document` side of the embedding.** §5.2 makes the read asymmetric and
 * the port says which side is which: a stored chunk is a *document*, and the
 * only `query` in this pipeline is the anchor's surface form climbing §5.2's
 * ladder. Embedding a chunk as a query costs measurable top-1 accuracy and
 * nothing in the stored vector records that it happened.
 *
 * **One episode for the whole document.** §5.10: *"A document is one episode.
 * Member seeding applies episode caps (§4.2): forty assertions in one ADR are
 * one source, not forty observations."* E2 applies no evidence — that is E3 —
 * but E3 cannot apply a cap over an episode E2 never recorded, and it cannot
 * apply it correctly if two documents share one. So what is pinned is what E2
 * must *carry*: one episode across a document's jobs, a different one for a
 * different document, and the same one again when the document is revised —
 * because a revision that minted a fresh episode would let the document
 * corroborate itself, which is §4.4's independence failure with an editor in
 * the middle.
 *
 * Real SQLite, `:memory:`, no mocks of the store.
 *
 * @spec §3.1, §3.5, §3.6, §4.2, §4.4, §5.2, §5.3, §5.10, §9, §11
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXTRACT_JOB_KIND, openTextIngest } from '../index';

import { RERANK_WIDTH, claimMessage, queriedTexts } from '../../referents/__tests__/fixtures';

import {
  DOCUMENT_ID,
  KNOWN_ANCHOR,
  LONG_PARAGRAPHS,
  OTHER_DOCUMENT_ID,
  SHORT_PARAGRAPHS,
  TITLE,
  UNKNOWN_ANCHOR,
  drainJobs,
  harnessFor,
  notebook,
  textSource,
  type Harness,
} from './fixtures';

/**
 * Keys that would be a byte offset by another name.
 *
 * §3.6 leaves nowhere to put one — *"hash + fuzzy-quote anchoring, never raw
 * offsets"* — and §12 says why: *"document edits break anchors"*. An offset
 * survives no edit above it, so a surface that carried one would hand E3 an
 * anchor that rots and looks fine.
 *
 * @spec §3.6, §12
 */
const OFFSET_KEYS = [
  'start',
  'end',
  'offset',
  'startOffset',
  'endOffset',
  'byteStart',
  'byteEnd',
  'charStart',
  'charEnd',
  'span',
  'range',
  'line',
  'lineStart',
  'lineEnd',
  'position',
  'index',
] as const;

let harness: Harness;

beforeEach(() => {
  harness = harnessFor(openTextIngest);
});

afterEach(() => {
  harness.close();
});

/** The offset-shaped keys an object carries, which must always be none of them. @spec §3.6 */
const offsetKeysOn = (value: unknown): string[] =>
  value === null || typeof value !== 'object'
    ? []
    : Object.keys(value).filter((key) => (OFFSET_KEYS as readonly string[]).includes(key));

describe('the document row §3.6 holds', () => {
  it('records the title and the origin the caller gave it, and nothing evidential', async () => {
    await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));

    const document = harness.store.getDocument(DOCUMENT_ID);
    expect(document).toMatchObject({ id: DOCUMENT_ID, title: TITLE, origin: 'authored' });
    expect(Object.keys(document ?? {}).filter((key) => ['alpha', 'beta', 'evidence', 'status', 'tier'].includes(key))).toStrictEqual([]);
  });

  it('serves a document whose anchor nobody named, with no scope rather than a guessed one', async () => {
    await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));

    expect(harness.store.getDocument(DOCUMENT_ID)?.scope).toBeNull();
    expect(harness.text.chunksOf(DOCUMENT_ID).length).toBeGreaterThan(0);
  });
});

describe('every chunk is embedded, on the side §5.2 says it sits', () => {
  it('gives each chunk a full-width vector rather than leaving it geometry-less', async () => {
    await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));

    const chunks = harness.store.getChunks(DOCUMENT_ID);
    expect(chunks.length).toBe(harness.text.chunksOf(DOCUMENT_ID).length);
    expect(chunks.filter((chunk) => chunk.embedding === null)).toStrictEqual([]);
    expect([...new Set(chunks.map((chunk) => chunk.embedding?.length))]).toStrictEqual([
      RERANK_WIDTH,
    ]);
  });

  it('embeds the chunk text as a document, never as a query', async () => {
    await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));

    const views = harness.text.chunksOf(DOCUMENT_ID);
    const documentSide = new Set(
      harness.embeddings.calls.filter((call) => call.task === 'document').map((call) => call.text),
    );

    expect(views.filter((view) => !documentSide.has(view.text))).toStrictEqual([]);
    expect(queriedTexts(harness.embeddings).filter((text) => views.some((view) => view.text === text))).toStrictEqual([]);
  });
});

describe('the extraction queue §5.10 parks the expensive half in', () => {
  it('enqueues exactly one job per chunk', async () => {
    const receipt = await harness.text.submitText(textSource({ text: notebook(LONG_PARAGRAPHS) }));

    const ascending = (left: number, right: number): number => left - right;
    const parked = drainJobs(harness.store, EXTRACT_JOB_KIND);
    expect(receipt.enqueued.length).toBe(receipt.chunks.length);
    expect(parked.map((job) => job.id).sort(ascending)).toStrictEqual(
      [...receipt.enqueued].sort(ascending),
    );
  });

  it('names each chunk by document, ordinal and hash, and carries no offset', async () => {
    const receipt = await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));

    const payloads = receipt.enqueued.map((id) => harness.store.getJob(id)?.payload);
    const expected = harness.text
      .chunksOf(DOCUMENT_ID)
      .map((view) => ({
        documentId: DOCUMENT_ID,
        ordinal: view.ordinal,
        hash: view.hash,
        episodeId: receipt.episodeId,
      }));

    expect(payloads).toStrictEqual(expected);
    expect(payloads.flatMap(offsetKeysOn)).toStrictEqual([]);
  });

  it('parks the work rather than doing it — every job is still pending, and no claim was written', async () => {
    const ledgerBefore = harness.store.listClaimIds();
    const receipt = await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));

    expect(receipt.enqueued.map((id) => harness.store.getJob(id)?.state)).toStrictEqual(
      receipt.enqueued.map(() => 'pending'),
    );
    expect(harness.store.listClaimIds()).toStrictEqual(ledgerBefore);
  });

  it('exposes no offset on the receipt either', async () => {
    const receipt = await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));

    expect(receipt.chunks.flatMap(offsetKeysOn)).toStrictEqual([]);
    expect(harness.text.chunksOf(DOCUMENT_ID).flatMap(offsetKeysOn)).toStrictEqual([]);
  });
});

describe('a document is one episode', () => {
  it('attributes every one of a document’s chunks to the single episode the receipt names', async () => {
    const receipt = await harness.text.submitText(textSource({ text: notebook(LONG_PARAGRAPHS) }));

    const episodes = receipt.enqueued.map(
      (id) => (harness.store.getJob(id)?.payload as { episodeId?: unknown } | undefined)?.episodeId,
    );

    expect(receipt.chunks.length).toBeGreaterThan(1);
    expect([...new Set(episodes)]).toStrictEqual([receipt.episodeId]);
  });

  it('gives two documents two episodes, even when one caller submits both', async () => {
    const first = await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));
    const second = await harness.text.submitText(
      textSource({ id: OTHER_DOCUMENT_ID, text: notebook(LONG_PARAGRAPHS) }),
    );

    expect(second.episodeId).not.toStrictEqual(first.episodeId);
  });

  it('keeps a revised document in the episode it already had, so it cannot corroborate itself', async () => {
    const first = await harness.text.submitText(textSource({ text: notebook(SHORT_PARAGRAPHS) }));
    const revised = await harness.text.submitText(
      textSource({ text: `${notebook(SHORT_PARAGRAPHS)}\n\nA line added later.` }),
    );

    expect(revised.episodeId).toStrictEqual(first.episodeId);
  });
});

describe("the document's anchor climbs §5.2's ladder like any other noun", () => {
  it('mints a provisional referent for a noun the graph has never held, and anchors the document at it', async () => {
    const receipt = await harness.text.submitText(
      textSource({ text: notebook(SHORT_PARAGRAPHS), anchor: UNKNOWN_ANCHOR }),
    );

    const scope = harness.store.getDocument(DOCUMENT_ID)?.scope;
    expect(receipt.anchor).toMatchObject({ surfaceForm: UNKNOWN_ANCHOR, rung: 'minted' });
    expect(scope).toStrictEqual(receipt.anchor?.referentId);
    expect(harness.ingest.referents.byStatus('provisional').map((referent) => referent.id)).toContain(scope);
    expect(harness.ingest.referents.visible().map((referent) => referent.id)).not.toContain(scope);
  });

  it('resolves to the referent an ordinary claim already grew, rather than minting a second one', async () => {
    const seeded = await harness.ingest.submit(
      claimMessage('AuthService validates bearer tokens before dispatch.', [KNOWN_ANCHOR]),
    );
    const before = harness.ingest.referents.all().length;

    await harness.text.submitText(
      textSource({ text: notebook(SHORT_PARAGRAPHS), anchor: KNOWN_ANCHOR }),
    );

    expect(harness.store.getDocument(DOCUMENT_ID)?.scope).toStrictEqual(
      seeded.resolutions[0]?.referentId,
    );
    expect(harness.ingest.referents.all().length).toBe(before);
  });

  it('lets a second document about the same unheard-of noun join the first, not fork from it', async () => {
    const first = await harness.text.submitText(
      textSource({ text: notebook(SHORT_PARAGRAPHS), anchor: UNKNOWN_ANCHOR }),
    );
    const second = await harness.text.submitText(
      textSource({ id: OTHER_DOCUMENT_ID, text: notebook(LONG_PARAGRAPHS), anchor: UNKNOWN_ANCHOR }),
    );

    expect(second.anchor?.referentId).toStrictEqual(first.anchor?.referentId);
    expect(second.anchor?.rung).not.toStrictEqual('minted');
  });
});
