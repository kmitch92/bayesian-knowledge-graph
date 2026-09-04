/**
 * §5.10's gate: *"Every member carries its verbatim source span; an entailment
 * gate (span ⊨ claim, floor ⚙) guards insertion; failures go to the
 * extraction-rejection log — never the graph."*
 *
 * This build ships the cheap half of that sentence and defers the expensive
 * half. The verbatim check is a string comparison against text the store already
 * holds, and it kills fabricated spans outright: a model cannot cite text that is
 * not there. Semantic entailment — does the span actually *support* the claim —
 * is a second model call against a floor §13 has no replay data to tune, so
 * `entailmentBelowFloor` sits in `ExtractionRejectionReason` unwritten, exactly
 * as `RESERVED_EDGE_KINDS` sits in the edge vocabulary unwritten, and the seam
 * stays open.
 *
 * ── What "literally" means, and why it is the strict reading ────────────────
 *
 * **A quote passes only if the chunk contains it byte for byte.** No trimming,
 * no case folding, no whitespace collapsing, no typographic-quote folding. Three
 * things force it:
 *
 * 1. **§3.6 and §5.10 want the span verbatim, not normalized.** A chunk's text
 *    is not stored — E2's `chunksOf` re-derives it from `content_ref`, so a
 *    chunk is by construction an exact substring of the document. Exact
 *    containment in the chunk therefore implies exact containment in the
 *    document. A folded match implies nothing about the document at all, which
 *    is the only thing the citation was ever a citation *of*.
 * 2. **§5.10's testimony decay reads the same relation later.** *"Members whose
 *    quotes vanish flag `retracted_in_source`."* A member admitted under a fold
 *    would vanish under an exact search, so every normalization admitted here
 *    has to be re-admitted there, forever, by a subsystem that has no reason to
 *    know about it. One decision, two places, and the failure is silent in both.
 * 3. **The store already assumes it.** `ExtractionRejection.quote` is stored
 *    *"neither trimmed nor folded"* because *"a quote that fails the verbatim
 *    check only on whitespace is a different diagnosis from one the paragraph
 *    never contained"*. That sentence describes nothing unless a whitespace-only
 *    difference is a failure.
 *
 * The cost of the strict reading is real and is accepted: a model that pastes a
 * span through a renderer that curls quotation marks loses every member of every
 * paragraph containing one. That is a *legible* failure — the rejection log
 * carries the quote byte for byte, and §13's counting question ("how often did
 * this model fail this way") answers it in one query. A fold, chosen to avoid
 * that cost, would instead admit spans the document does not contain, which is
 * §12's phantom member with the evidence of its phantomhood erased.
 *
 * ── Two arms, two diagnoses ─────────────────────────────────────────────────
 *
 * `quoteAbsent` is a model that cited nothing — *"broken in a way no threshold
 * fixes"*, and the reason `ExtractionRejection.chunkOrdinal` is nullable at all
 * (*"a `quoteAbsent` rejection has no span to anchor"*). `quoteNotVerbatim` is a
 * model that cited loosely — *"exactly what a floor is for"*. A blank quote is
 * the first and not the second, and it is the one case a naive
 * `chunkText.includes(quote)` gets wrong in the dangerous direction: every chunk
 * contains the empty string.
 *
 * Real SQLite, `:memory:`, no mocks of the store. Only the extractor, the
 * adjudicator and the embedding provider are faked.
 *
 * @spec §3.6, §5.10, §12, §13, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chunkText, openExtraction } from '../index';

import {
  ADMITTED_CLAIM,
  BLANK_QUOTE,
  CASE_VARIANT,
  CHUNK_ONE_MARKER,
  CHUNK_ZERO_MARKER,
  EXTRACTOR_MODEL_ID,
  GATE_DOCUMENT_ID,
  INLET_GAUGE,
  NEIGHBOUR_CLAIM,
  NEIGHBOUR_QUOTE,
  PADDED_VARIANT,
  PHANTOM_CLAIM,
  PHANTOM_QUOTE,
  SMART_QUOTE_VARIANT,
  VALVE_SEAT,
  VERBATIM_QUOTE,
  WHITESPACE_VARIANT,
  claimTexts,
  drainExtraction,
  extractionHarnessFor,
  forChunkMarked,
  gateDocument,
  memberTexts,
  proposal,
  referentFor,
  type ExtractionHarness,
} from './extraction-fixtures';

import { textSource } from './fixtures';

/**
 * The corpus, checked against the chunker directly.
 *
 * Deliberately outside the harness: every relation below is a fact about strings
 * and about `chunkText`, both of which exist today, so these guards are green
 * from the moment they are written and the RED signal in the rest of the file
 * cannot be mistaken for a corpus that never said what it claimed to. A guard
 * that only runs once the thing it guards exists is not a guard.
 *
 * @spec §3.6, §5.10
 */
describe('the gate corpus, before anything relies on it', () => {
  const chunks = chunkText(gateDocument());

  it('cuts into the two chunks the substring relations below are stated over', () => {
    expect(chunks.map((chunk) => chunk.ordinal)).toStrictEqual([0, 1]);
  });

  it('holds the verbatim quote in chunk zero, so admitting it is admitting a real span', () => {
    expect(chunks[0]!.text).toContain(VERBATIM_QUOTE);
  });

  it.each([
    ['a doubled space', WHITESPACE_VARIANT],
    ['a folded case', CASE_VARIANT],
    ['typeset quotation marks', SMART_QUOTE_VARIANT],
    ['surrounding whitespace', PADDED_VARIANT],
  ])('holds no span differing from it by %s, anywhere in the document', (_name, variant) => {
    expect(gateDocument()).not.toContain(variant);
  });

  it('holds the padded variant’s trimmed form, which is what makes it a trim’s witness', () => {
    expect([
      chunks[0]!.text.includes(PADDED_VARIANT.trim()),
      chunks[0]!.text.trim().includes(PADDED_VARIANT.trim()),
    ]).toStrictEqual([true, true]);
  });

  it.each([
    ['a doubled space', WHITESPACE_VARIANT],
    ['a folded case', CASE_VARIANT],
    ['typeset quotation marks', SMART_QUOTE_VARIANT],
  ])('holds no trimmed span matching the one differing by %s either', (_name, variant) => {
    expect(chunks[0]!.text.trim().includes(variant.trim())).toBe(false);
  });

  it('holds the neighbour quote in chunk one and nowhere in chunk zero', () => {
    expect([
      chunks[1]!.text.includes(NEIGHBOUR_QUOTE),
      chunks[0]!.text.includes(NEIGHBOUR_QUOTE),
    ]).toStrictEqual([true, false]);
  });

  it('holds the phantom quote nowhere at all', () => {
    expect(gateDocument()).not.toContain(PHANTOM_QUOTE);
  });

  it('holds the blank quote in every chunk, which is what makes it the dangerous case', () => {
    expect(chunks.map((chunk) => chunk.text.includes(BLANK_QUOTE))).toStrictEqual([true, true]);
  });
});

let harness: ExtractionHarness;

/**
 * Opens a store, a drain and a faked extractor for one test.
 *
 * Called per describe rather than once at file scope, so the corpus guards above
 * — which need none of it — still run while `openExtraction` is unwritten.
 */
const usingHarness = (): void => {
  beforeEach(() => {
    harness = extractionHarnessFor(openExtraction);
  });

  afterEach(() => {
    harness?.close();
  });
};

/** Puts the gate corpus in the graph, with no anchor, so the ledger starts empty of claims. */
const submitGateDocument = async (): Promise<void> => {
  await harness.text.submitText(textSource({ id: GATE_DOCUMENT_ID, text: gateDocument() }));
};

/** The document's chunks, as the drain will read them back. */
const gateChunks = () => harness.text.chunksOf(GATE_DOCUMENT_ID);

/** What the extraction-rejection log holds for the gate corpus. @spec §5.10, §13 */
const rejections = (ordinal?: number) =>
  ordinal === undefined
    ? harness.store.readExtractionRejections(GATE_DOCUMENT_ID)
    : harness.store.readExtractionRejections(GATE_DOCUMENT_ID, ordinal);

describe('a span the cited chunk does not contain', () => {
  usingHarness();

  beforeEach(async () => {
    await submitGateDocument();
  });

  it('refuses a fabricated quote, and lands no claim, referent or edge in the graph', async () => {
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [
        proposal({ text: PHANTOM_CLAIM, quote: PHANTOM_QUOTE }),
      ]),
    );

    await drainExtraction(harness.extraction);

    expect({
      claims: claimTexts(harness.store),
      referents: harness.ingest.referents.all(),
      named: referentFor(harness.store, VALVE_SEAT),
    }).toStrictEqual({ claims: [], referents: [], named: undefined });
  });

  it('logs that refusal against the chunk that cited it, with what the model offered', async () => {
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [
        proposal({ text: PHANTOM_CLAIM, quote: PHANTOM_QUOTE }),
      ]),
    );

    await drainExtraction(harness.extraction);

    expect(rejections()).toMatchObject([
      {
        documentId: GATE_DOCUMENT_ID,
        chunkOrdinal: 0,
        chunkHash: gateChunks()[0]!.hash,
        claimText: PHANTOM_CLAIM,
        quote: PHANTOM_QUOTE,
        reason: 'quoteNotVerbatim',
        modelId: EXTRACTOR_MODEL_ID,
      },
    ]);
  });

  it('refuses a span that is verbatim in another chunk of the same document', async () => {
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [
        proposal({ text: NEIGHBOUR_CLAIM, quote: NEIGHBOUR_QUOTE, mentions: [INLET_GAUGE] }),
      ]),
    );

    await drainExtraction(harness.extraction);

    expect({
      claims: claimTexts(harness.store),
      logged: rejections().map((entry) => [entry.chunkOrdinal, entry.reason]),
    }).toStrictEqual({ claims: [], logged: [[0, 'quoteNotVerbatim']] });
  });

  it('admits that same span when it is the chunk being extracted, so the refusal was about the chunk', async () => {
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ONE_MARKER, [
        proposal({ text: NEIGHBOUR_CLAIM, quote: NEIGHBOUR_QUOTE, mentions: [INLET_GAUGE] }),
      ]),
    );

    await drainExtraction(harness.extraction);

    expect({ members: memberTexts(harness.store), refused: rejections().length }).toStrictEqual({
      members: [NEIGHBOUR_CLAIM],
      refused: 0,
    });
  });
});

describe('a span the chunk almost contains', () => {
  usingHarness();

  beforeEach(async () => {
    await submitGateDocument();
  });

  it.each([
    ['whitespace', WHITESPACE_VARIANT],
    ['case', CASE_VARIANT],
    ['a typeset quotation mark', SMART_QUOTE_VARIANT],
    ['whitespace around it', PADDED_VARIANT],
  ])(
    'refuses a quote differing from the span only by %s — §3.6 wants spans verbatim, not normalized',
    async (_name, variant) => {
      harness.extractor.answerWith(
        forChunkMarked(CHUNK_ZERO_MARKER, [proposal({ quote: variant })]),
      );

      await drainExtraction(harness.extraction);

      expect({
        claims: claimTexts(harness.store),
        logged: rejections().map((entry) => [entry.reason, entry.quote]),
      }).toStrictEqual({ claims: [], logged: [['quoteNotVerbatim', variant]] });
    },
  );

  it('will not trim its way to a match, and logs the padding it was offered', async () => {
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [proposal({ quote: PADDED_VARIANT })]),
    );

    await drainExtraction(harness.extraction);

    // The whole difference between this quote and an admitted one is whitespace
    // at its edges, and `ExtractionRejection.quote` is stored "neither trimmed
    // nor folded" precisely so §13 can tell that diagnosis from a phantom. A
    // gate that trimmed either side would admit this, write no row, and leave
    // §5.10's later exact search for a span the document does not contain.
    expect({
      claims: claimTexts(harness.store),
      logged: rejections().map((entry) => [entry.reason, entry.quote]),
      trimsToARealSpan: gateChunks()[0]!.text.includes(PADDED_VARIANT.trim()),
    }).toStrictEqual({
      claims: [],
      logged: [['quoteNotVerbatim', PADDED_VARIANT]],
      trimsToARealSpan: true,
    });
  });

  it('admits the span it actually contains, so the four refusals are about the difference', async () => {
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [proposal({ quote: VERBATIM_QUOTE })]),
    );

    await drainExtraction(harness.extraction);

    expect({ members: memberTexts(harness.store), refused: rejections().length }).toStrictEqual({
      members: [ADMITTED_CLAIM],
      refused: 0,
    });
  });
});

describe('a model that cites nothing', () => {
  usingHarness();

  beforeEach(async () => {
    await submitGateDocument();
  });

  it.each([
    ['an empty quote', ''],
    ['a quote that is only whitespace', BLANK_QUOTE],
  ])('refuses %s rather than letting String.includes wave it through', async (_name, quote) => {
    harness.extractor.answerWith(forChunkMarked(CHUNK_ZERO_MARKER, [proposal({ quote })]));

    await drainExtraction(harness.extraction);

    expect({
      claims: claimTexts(harness.store),
      reasons: rejections().map((entry) => entry.reason),
    }).toStrictEqual({ claims: [], reasons: ['quoteAbsent'] });
  });

  it('anchors that refusal to no chunk, because there is no span to attribute one by', async () => {
    harness.extractor.answerWith(forChunkMarked(CHUNK_ZERO_MARKER, [proposal({ quote: '' })]));

    await drainExtraction(harness.extraction);

    expect(rejections()).toMatchObject([
      { chunkOrdinal: null, chunkHash: null, quote: null, claimText: ADMITTED_CLAIM },
    ]);
  });
});

describe('the rejection log, as §13 audits it', () => {
  usingHarness();

  beforeEach(async () => {
    await submitGateDocument();
    harness.extractor.answerWith((request) => [
      proposal({
        text: request.chunkText.includes(CHUNK_ZERO_MARKER) ? PHANTOM_CLAIM : NEIGHBOUR_CLAIM,
        quote: PHANTOM_QUOTE,
      }),
    ]);
  });

  it('holds one row per refused proposal, readable by document', async () => {
    await drainExtraction(harness.extraction);

    expect(rejections().map((entry) => entry.claimText).sort()).toStrictEqual(
      [NEIGHBOUR_CLAIM, PHANTOM_CLAIM].sort(),
    );
  });

  it('narrows to one chunk, so a paragraph the model keeps inventing about is separable', async () => {
    await drainExtraction(harness.extraction);

    expect(rejections(0).map((entry) => entry.claimText)).toStrictEqual([PHANTOM_CLAIM]);
  });

  it('names the model behind every refusal, and when it ran', async () => {
    await drainExtraction(harness.extraction);

    expect(
      rejections().map((entry) => [entry.modelId, Number.isNaN(Date.parse(entry.at))]),
    ).toStrictEqual([
      [EXTRACTOR_MODEL_ID, false],
      [EXTRACTOR_MODEL_ID, false],
    ]);
  });
});

describe('a batch the gate splits', () => {
  usingHarness();

  beforeEach(async () => {
    await submitGateDocument();
  });

  it('admits the survivor and refuses its siblings, rather than taking the batch whole', async () => {
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [
        proposal({ text: PHANTOM_CLAIM, quote: PHANTOM_QUOTE }),
        proposal({ text: ADMITTED_CLAIM, quote: VERBATIM_QUOTE }),
        proposal({ text: NEIGHBOUR_CLAIM, quote: BLANK_QUOTE, mentions: [INLET_GAUGE] }),
      ]),
    );

    await drainExtraction(harness.extraction);

    expect({
      members: memberTexts(harness.store),
      reasons: rejections().map((entry) => entry.reason).sort(),
    }).toStrictEqual({
      members: [ADMITTED_CLAIM],
      reasons: ['quoteAbsent', 'quoteNotVerbatim'],
    });
  });

  it('leaves the refused siblings’ nouns out of the referent index', async () => {
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [
        proposal({ text: PHANTOM_CLAIM, quote: PHANTOM_QUOTE, mentions: [INLET_GAUGE] }),
        proposal({ text: ADMITTED_CLAIM, quote: VERBATIM_QUOTE, mentions: [VALVE_SEAT] }),
      ]),
    );

    await drainExtraction(harness.extraction);

    expect({
      admittedNounIsKnown: referentFor(harness.store, VALVE_SEAT) !== undefined,
      refusedNounIsKnown: referentFor(harness.store, INLET_GAUGE) !== undefined,
    }).toStrictEqual({ admittedNounIsKnown: true, refusedNounIsKnown: false });
  });
});
