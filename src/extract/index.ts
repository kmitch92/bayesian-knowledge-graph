/**
 * §5.10's cheap half: *"Ingest is cheap: chunk, embed, anchor — the document
 * serves whole immediately. Extraction is lazy."*
 *
 * This is the door text comes in through, and text is the *universal* ingress:
 * §5.10's document is an ADR, a philosophy notebook, a runbook, a transcript or
 * a repository, and nothing below knows which. A document arrives whole, is cut
 * at its own paragraph boundaries, embedded, anchored at a noun through §5.2's
 * ladder, and then **parked** — one job per chunk on §9's queue, so *"a
 * 3,000-word ADR never pays forty inline adjudications"*. The forty
 * adjudications are E3's, and nothing here claims a job, proposes a member,
 * writes a `STATED_IN` edge or moves a posterior on anything a document said.
 *
 * ── Where a chunk's text lives ──────────────────────────────────────────────
 *
 * In the document's `content_ref`, which §3.6 defines as *"full text or a
 * pointer to it"*, as the full text. `document_chunks` has no text column and is
 * not given one: a chunk row holds the ordinal, the anchor and the geometry, and
 * the span itself is recovered by re-running {@link chunkText} over the stored
 * text. That is sound because the chunker is a pure function of the text alone —
 * the same document cuts the same way in a store that has never seen it — so the
 * derivation and the rows cannot disagree while both are written from here.
 * `chunksOf` checks that anyway, against whatever wrote `content_ref` the one
 * time it was ever true: a pointer where full text belongs would derive chunks
 * matching no row, and {@link ContentRefDivergedError} says so instead of
 * serving the pointer as if it were prose.
 *
 * The alternative, a `text` column beside `hash`, stores the same bytes twice
 * and makes them able to drift: two copies of one span, one of which the
 * verbatim gate would be checked against. What the derivation buys instead is
 * that a chunk's text is *by construction* a verbatim span of the document it
 * came from, which is precisely the property §5.10's gate is going to test a
 * model's quote against.
 *
 * ── The two policies the store will not enforce ─────────────────────────────
 *
 * **Re-ingest enqueues only what changed.** §9's queue *"does not deduplicate: a
 * second identical submission is a second job"*, which is right for a queue and
 * wrong for a re-ingest — every commit would re-mine every paragraph it did not
 * touch. So a job is parked for a chunk whose anchor the previous chunking did
 * not hold, and for no other. An unchanged document therefore parks nothing at
 * all, and an edited one parks exactly the paragraphs the author moved.
 *
 * **A materialized document is never mined.** §5.10 is unconditional —
 * *"Authored documents only. Materialized documents have members by
 * construction; re-extracting would launder canonicals back in as fresh
 * testimony"* — which is §4.4's independence failure with a document in the
 * middle. The refusal lives here rather than in the drain because `origin` is a
 * field this path already holds, because §9 reads queue depth as a health signal
 * and a queue of work nobody may do makes that number unreadable, and because a
 * job claimed, inspected and dropped is the cost §5.10 deferred without the
 * extraction. It is still chunked, embedded and anchored: §3.7 compresses it and
 * §7.7 renders its health, so it serves whole like any other document.
 *
 * ── What a shrinking revision does not do atomically ────────────────────────
 *
 * `putChunk` replaces a chunk by ordinal, so a re-chunk with as many paragraphs
 * as before overwrites cleanly. One with fewer does not: the ordinals past the
 * end of the new chunking would survive as a tail anchoring paragraphs the
 * author deleted, so `submitText` deletes the document and lets §3.6's cascade
 * take its chunks with it before rewriting both. That delete and that rewrite
 * are two calls, not one transaction — `GraphStore` exposes none for a caller
 * to open — so a throw between them (a wrong-width vector from `embeddings` is
 * the plausible one, since `putChunk` is where that width is asserted) leaves
 * the document deleted and never rewritten. Total loss, not a partial one.
 *
 * Left this way for a cycle rather than fixed by exposing a transaction: that
 * would hand every future caller of this store a way to wrap arbitrary
 * multi-statement writes, undoing the "each write method is its own
 * transaction" invariant every other `GraphStore` writer relies on, to fix one
 * call site. The narrower fix — write the new chunks over ordinals `0..n-1`
 * first, then delete only the stale tail by ordinal, so nothing between those
 * two steps can destroy a document that already exists — needs a
 * `deleteChunk`-shaped addition to the port instead, which is next cycle's
 * work and not a refactor's to add unasked.
 *
 * ── Two consequences of a chunker with no cleverness in it ──────────────────
 *
 * A hard-wrapped CRLF document does not anchor identically to its LF twin: the
 * interior `\r\n` a hard wrap leaves mid-paragraph survives {@link chunkText}
 * untouched, because trimming and hashing a paragraph's bytes is exactly what
 * §3.6 and §5.10 mean by serving the span *verbatim* — reflowing it to match
 * the LF version would be the same normalization §5.10's quote-matching gate
 * cannot survive. The two documents are different bytes, so they are allowed
 * to be different chunks.
 *
 * A document using U+2029 (PARAGRAPH SEPARATOR — what PDF and rich-text
 * extractors emit in place of blank lines) has no blank line for {@link
 * chunkText} to split on, so it chunks as one paragraph regardless of length.
 * Every edit to it costs the whole document, exactly the failure mode
 * §5.10's cost argument exists to avoid. No ingress in this codebase produces
 * U+2029 today, and it is already covered by {@link chunkText}'s documented
 * behavior for "one enormous unbroken paragraph" — this is that case named,
 * not a new one.
 *
 * @spec §3.6, §3.7, §4.2, §4.4, §5.2, §5.3, §5.8, §5.10, §7.7, §9, §12
 */

import type { DocumentChunk, DocumentOrigin } from '../store/index.js';
import type { IngestOptions, Origin } from '../ingest/index.js';
import { createIdMinter } from '../referents/ids.js';
import {
  resolveSurfaceForm,
  type LadderContext,
  type Resolution,
} from '../referents/ladder.js';
import {
  mintReferent,
  recordMention,
  writeNamingClaim,
  type WriteContext,
} from '../ingest/spine-writer.js';

import { chunkText, type ChunkAnchor, type ChunkView } from './chunking.js';

export { chunkText, hashChunk } from './chunking.js';
export type { ChunkAnchor, ChunkView } from './chunking.js';

/**
 * The queue §5.10 parks the expensive half in.
 *
 * Open text on the store's side (§9 hangs five clocks off one table), named once
 * here so the producer and the drain cannot spell it differently — an extractor
 * draining `extraction` while ingest parks `extract` is a backlog that grows
 * forever and a queue that is always empty.
 *
 * @spec §5.10, §9
 */
export const EXTRACT_JOB_KIND = 'extract';

/**
 * The tier a document's anchor is named at.
 *
 * §15's `observed`: reading a document is reading, not a test and not a guess.
 * It matters beyond the weight — a noun the graph has never held mints at this
 * tier to a posterior below §15's `τ_promote`, so the referent is born
 * provisional and §5.2's *"invisible to gather until corroborated"* holds for a
 * document's anchor exactly as it does for a claim's mention.
 *
 * @spec §4.2, §5.2, §15
 */
const ANCHOR_TIER = 'observed';

/**
 * What names a document's own episode.
 *
 * @spec §4.2, §5.10
 */
const DOCUMENT_EPISODE_PREFIX = 'document';

/** A body of text offered for ingest. @spec §3.6, §5.10 */
export interface TextSource {
  /** The id the document is written at. Re-submitting under it is a revision. @spec §3.6 */
  readonly id: string;
  /** How the document names itself. Free text; nothing here parses it. @spec §3.6 */
  readonly title: string;
  /** The document, whole. @spec §3.6, §5.10 */
  readonly text: string;
  /** §5.10's extraction gate: authored documents are mined, materialized ones never. @spec §5.10 */
  readonly origin: DocumentOrigin;
  /**
   * The noun the document is about, if the submitter names one.
   *
   * Climbs §5.2's ladder like any other noun and is written as the document's
   * `scope`. Absent is a first-class answer: §3.6 makes the anchor *"a prior,
   * not an inheritance"*, members re-resolve their own entities, and a guessed
   * anchor is worse than none.
   *
   * @spec §3.6, §5.2
   */
  readonly anchor?: string | undefined;
  /**
   * Who submitted it, over what pathway.
   *
   * The channel and the agent are carried through to the writes the anchor's
   * resolution makes; the episode is not — see {@link TextReceipt.episodeId}.
   *
   * @spec §3.5, §4.7
   */
  readonly provenance: Origin;
}

/** What one `submitText` did. @spec §5.10, §9 */
export interface TextReceipt {
  readonly documentId: string;
  /** The chunking, in ordinal order. Anchors only: a receipt carries no offset. @spec §3.6 */
  readonly chunks: readonly ChunkAnchor[];
  /**
   * The jobs this submission parked, in ordinal order.
   *
   * Shorter than {@link TextReceipt.chunks} whenever a revision left paragraphs
   * alone, and empty for an unchanged document and for a materialized one.
   *
   * @spec §5.10, §9
   */
  readonly enqueued: readonly number[];
  /** How the anchor resolved, or `undefined` when the submitter named none. @spec §5.2 */
  readonly anchor: Resolution | undefined;
  /**
   * The episode the document *is*.
   *
   * §5.10: *"A document is one episode. Member seeding applies episode caps
   * (§4.2): forty assertions in one ADR are one source, not forty
   * observations."* Derived from the document id rather than taken from the
   * submitter, which is what makes it the same episode across a document's every
   * chunk, a different one for a different document, and — the arm that has
   * teeth — the *same* one again when the document is revised. A revision that
   * minted a fresh episode would let a document corroborate itself, which is
   * §4.4's independence failure with an editor in the middle.
   *
   * @spec §4.2, §4.4, §5.10
   */
  readonly episodeId: string;
}

/**
 * The text ingress.
 *
 * @spec §5.10, §11
 */
export interface TextIngestPort {
  /** Chunks, embeds and anchors a document, and parks its extraction. @spec §5.10 */
  submitText(source: TextSource): Promise<TextReceipt>;
  /**
   * A document's chunks, in ordinal order, each with its verbatim span.
   *
   * Empty for a document the store does not hold — a missing document has no
   * chunks, which is not a different answer from having none.
   *
   * @spec §3.6, §5.10
   */
  chunksOf(documentId: string): ChunkView[];
}

/**
 * What the port needs.
 *
 * The same four as {@link IngestOptions}, and aliased rather than restated for
 * the reason `Regime` is read off `Entity`: these are one set of ports — one
 * store, one embedding provider, one adjudicator, §15's two constants — and a
 * second declaration of them is a second thing that can drift. A document's
 * anchor climbs the same ladder a claim's mention does, so it needs the same
 * dependencies.
 *
 * @spec §5.2, §5.3, §11
 */
export type TextIngestOptions = IngestOptions;

/**
 * A document with nothing in it to chunk.
 *
 * Refused rather than written, because the alternative is worse than a refusal:
 * §7.7 computes a document's health from *"member states plus extraction
 * coverage"*, and a row with no chunks has no coverage to fall short of, so it
 * reads as complete forever while serving nothing.
 *
 * @spec §3.6, §7.7
 */
export class EmptyDocumentError extends Error {
  /** The id that was refused. */
  readonly documentId: string;

  constructor(documentId: string) {
    super(`document ${documentId} has no text to chunk`);
    this.name = 'EmptyDocumentError';
    this.documentId = documentId;
  }
}

/**
 * `chunksOf`'s derivation disagreed with the chunk rows `submitText` wrote.
 *
 * `content_ref` is documented as full text (see this module's head), but §3.6
 * leaves the *choice* to the caller — the store itself accepts either. If a
 * document were ever written with `content_ref` holding a pointer instead,
 * {@link chunkText} would cut that pointer string into its own "chunks", each
 * hashing to something no `document_chunks` row holds for this document. Left
 * unchecked, `chunksOf` would return that pointer text as if it were the
 * paragraph a member was extracted from — exactly the silent wrong answer
 * §5.10's verbatim gate exists to catch, except here on the serving side
 * rather than the model's.
 *
 * Nothing in this codebase writes a pointer today — `putDocument` has exactly
 * one non-test caller, `submitText`, and it always writes `source.text` whole
 * — so this is not a case any test can reach honestly. It is the loud version
 * of that silent failure, paid for with one indexed read this port already
 * knows how to make.
 *
 * @spec §3.6, §5.10
 */
export class ContentRefDivergedError extends Error {
  /** The document whose derivation and rows disagreed. */
  readonly documentId: string;

  constructor(documentId: string) {
    super(
      `document ${documentId}'s content_ref does not re-derive the chunks stored for it — is content_ref a pointer rather than full text?`,
    );
    this.name = 'ContentRefDivergedError';
    this.documentId = documentId;
  }
}

/** The instant, as §3.5 records instants. */
const now = (): string => new Date().toISOString();

/**
 * The episode a document's every chunk is attributed to.
 *
 * A function of the id and of nothing else, which is what buys all three
 * properties {@link TextReceipt.episodeId} needs at once.
 *
 * @spec §4.2, §5.10
 */
const episodeOf = (documentId: string): string => `${DOCUMENT_EPISODE_PREFIX}:${documentId}`;

/** @spec §5.10, §11 */
export const openTextIngest = (options: TextIngestOptions): TextIngestPort => {
  const { store, embeddings, adjudicator } = options;
  const write: WriteContext = {
    store,
    embeddings,
    nextId: createIdMinter(),
    tauPromote: options.tauPromote,
  };
  const ladder: LadderContext = {
    store,
    embeddings,
    adjudicator,
    cosineFloor: options.cosineFloor,
  };

  /**
   * Runs §5.2's ladder for the document's anchor and records the outcome.
   *
   * The claim path's `resolveOne` with one noun instead of a list: an unresolved
   * anchor mints a provisional referent invisible to `visible()`, exactly as a
   * claim's mention does, so a second document about the same unheard-of noun
   * joins the first rather than forking from it. There is deliberately no second
   * ladder here and no shortcut past this one — a document anchored by a private
   * rule would be the one noun in the system that resolves differently from
   * every other.
   *
   * The title travels as the ladder's context: coreference is not decidable from
   * a noun phrase alone, and what a document says it is about is the nearest
   * thing a document has to a claim's text.
   *
   * @spec §5.2
   */
  const resolveAnchor = async (surfaceForm: string, title: string, origin: Origin): Promise<Resolution> => {
    const outcome = await resolveSurfaceForm(ladder, surfaceForm, title);
    if (outcome.rung === 'minted') {
      const minted = await mintReferent(write, {
        surfaceForm,
        origin,
        tier: ANCHOR_TIER,
        level: null,
      });
      return { surfaceForm, referentId: minted.referentId, rung: 'minted' };
    }
    await writeNamingClaim(write, outcome.referentId, surfaceForm, ANCHOR_TIER, origin, false);
    await recordMention(write, outcome.referentId, surfaceForm);
    return { surfaceForm, referentId: outcome.referentId, rung: outcome.rung };
  };

  /**
   * The geometry a document already holds, by anchor.
   *
   * A paragraph whose bytes did not move is a paragraph whose vector is still
   * the vector of its text, so re-embedding it would spend §5.3's budget to
   * arrive back where it started. Keyed by hash rather than by ordinal, so a
   * paragraph that merely *moved* keeps its vector too.
   *
   * @spec §5.3, §5.10
   */
  const geometryOf = (stored: readonly DocumentChunk[]): Map<string, readonly number[]> =>
    new Map(
      stored.flatMap((chunk) =>
        chunk.embedding === null ? [] : [[chunk.hash, chunk.embedding] as const],
      ),
    );

  /**
   * Embeds the chunks whose text the document has no vector for, `document`
   * side.
   *
   * §5.2 makes the read asymmetric and the port says which side is which: a
   * stored chunk is a *document*, and the only `query` in this pipeline is the
   * anchor's surface form climbing the ladder. Embedding a chunk as a query
   * costs measurable top-1 accuracy and nothing in the stored vector records
   * that it happened.
   *
   * @spec §5.2, §5.3, §11
   */
  const embedChunks = async (
    chunks: readonly ChunkView[],
    geometry: Map<string, readonly number[]>,
  ): Promise<void> => {
    const missing = chunks.filter((chunk) => !geometry.has(chunk.hash));
    if (missing.length === 0) return;
    const vectors = await embeddings.embedBatch(
      missing.map((chunk) => chunk.text),
      'document',
    );
    missing.forEach((chunk, at) => {
      const vector = vectors[at];
      if (vector !== undefined) geometry.set(chunk.hash, Array.from(vector));
    });
  };

  const submitText = async (source: TextSource): Promise<TextReceipt> => {
    const chunks = chunkText(source.text);
    // Before anything is written, so a refused document leaves nothing behind.
    if (chunks.length === 0) throw new EmptyDocumentError(source.id);

    const episodeId = episodeOf(source.id);
    const origin: Origin = { ...source.provenance, episodeId };

    const standing = store.getDocument(source.id);
    const stored = store.getChunks(source.id);
    const previous = new Set(stored.map((chunk) => chunk.hash));
    const geometry = geometryOf(stored);

    const anchor =
      source.anchor === undefined
        ? undefined
        : await resolveAnchor(source.anchor, source.title, origin);
    await embedChunks(chunks, geometry);

    // `putDocument` is an upsert that deliberately leaves a document's chunks
    // where they are, which is right for a re-chunk with as many paragraphs as
    // before and wrong for one with fewer: `putChunk` replaces by ordinal, so
    // the ordinals past the end of the new chunking would survive as a tail of
    // paragraphs the author has deleted. There is no `deleteChunk` — a document
    // owns its chunks — so a shrinking revision goes through the cascade.
    //
    // This delete and the rewrite below are not one transaction — see the
    // module head's "does not do atomically" section for what a throw between
    // them costs, and why the fix waits for a cycle that may touch the port.
    if (stored.length > chunks.length) store.deleteDocument(source.id);
    store.putDocument({
      id: source.id,
      title: source.title,
      origin: source.origin,
      contentRef: source.text,
      scope: anchor?.referentId ?? null,
      // A revision is the same document, ingested once and edited since.
      createdAt: standing?.createdAt ?? now(),
    });
    for (const chunk of chunks)
      store.putChunk({
        documentId: source.id,
        ordinal: chunk.ordinal,
        hash: chunk.hash,
        embedding: geometry.get(chunk.hash) ?? null,
      });

    const enqueued =
      source.origin === 'materialized'
        ? []
        : chunks
            .filter((chunk) => !previous.has(chunk.hash))
            .map((chunk) =>
              store.enqueueJob({
                kind: EXTRACT_JOB_KIND,
                payload: {
                  documentId: source.id,
                  ordinal: chunk.ordinal,
                  hash: chunk.hash,
                  episodeId,
                },
              }),
            );

    // §5.8: every stage logs its inputs and its decision, because §13's replay
    // is what tunes the thresholds those decisions were made against. The
    // submitter's own episode is recorded here and nowhere else — it is how the
    // document arrived, while the episode everything else is attributed to is
    // the document's.
    store.appendStageLog({
      episodeId,
      stage: 'text-ingest',
      inputs: {
        documentId: source.id,
        origin: source.origin,
        anchor: source.anchor ?? null,
        submittedBy: source.provenance.episodeId,
        channel: source.provenance.channel,
      },
      decision: {
        chunks: chunks.length,
        enqueued: enqueued.length,
        anchor:
          anchor === undefined ? null : { referentId: anchor.referentId, rung: anchor.rung },
      },
      at: now(),
    });

    return {
      documentId: source.id,
      chunks: chunks.map((chunk) => ({ ordinal: chunk.ordinal, hash: chunk.hash })),
      enqueued,
      anchor,
      episodeId,
    };
  };

  /**
   * Derived from the stored text rather than read off the chunk rows, which is
   * what makes a served span verbatim by construction — see this module's head.
   *
   * Checked against `getChunks` before being returned. The comparison is by
   * ordinal position, not by hash membership: §3.6 permits two chunks with one
   * hash when a paragraph repeats, and a set-based check would call that a
   * match by accident. One indexed read buys the difference between a silent
   * wrong answer and {@link ContentRefDivergedError}.
   *
   * @spec §3.6, §5.10
   */
  const chunksOf = (documentId: string): ChunkView[] => {
    const document = store.getDocument(documentId);
    if (document === undefined) return [];
    const derived = chunkText(document.contentRef);
    const stored = store.getChunks(documentId);
    const agrees =
      derived.length === stored.length &&
      derived.every((chunk, at) => chunk.hash === stored[at]?.hash);
    if (!agrees) throw new ContentRefDivergedError(documentId);
    return derived;
  };

  return { submitText, chunksOf };
};

/**
 * Re-exported so a caller holding a {@link TextSource} or a {@link TextReceipt}
 * needs one import rather than three. Neither is redeclared here.
 *
 * @spec §3.6, §5.2, §11
 */
export type { DocumentOrigin } from '../store/index.js';
export type { Resolution } from '../referents/ladder.js';
