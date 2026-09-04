/**
 * Shared fixtures for the E3 extraction suite: the port, the drain, the gate.
 *
 * Built on top of `./fixtures`, which E2 already owns, and governed by the same
 * two rules:
 *
 * 1. **Every reference to the unwritten `../index` is type-only**, so esbuild
 *    erases it before this module runs. The RED signal comes from the value
 *    import of `openExtraction` in the `.test.ts` files — a named export the
 *    module does not provide — rather than from a fixture that cannot load.
 *    `openTextIngest` and `EXTRACT_JOB_KIND` are imported as values because E2
 *    wrote them.
 * 2. **The store is never faked.** Real SQLite, `:memory:`, real vectors at the
 *    real width. Three ports are stood in for and no others: the
 *    {@link EmbeddingProvider} (§5.3), the `Adjudicator` (§5.2), and now the
 *    {@link Extractor} (§5.10) — the third model call, and a port for the same
 *    reason the first two are: a graph with no extractor is a graph that mines
 *    nothing, which is humbler than one that is broken.
 *
 * ── Why there is a second corpus ────────────────────────────────────────────
 *
 * `./fixtures`' notebook is built for §5.10's *anchor* question — paragraphs
 * long enough for a chunker to have a decision to make, with a hinge sentence an
 * edit can rewrite. The gate asks a different question, and needs text shaped for
 * it: a span that can be cited exactly, three ways of citing it *almost*
 * exactly, and a span that is verbatim in the wrong paragraph. That is what
 * {@link GATE_PARAGRAPHS} is. The notebook is reused unchanged everywhere the
 * question is about the drain rather than the gate.
 *
 * The gate paragraphs carry straight quotation marks, which nothing in the
 * notebook does, because §3.6 and §5.10 want spans *verbatim* and the cheapest
 * way for a well-meaning implementation to stop being verbatim is to fold a
 * typographic quotation mark onto a straight one on the way in.
 *
 * @spec §3.6, §4.7, §5.2, §5.3, §5.10, §9, §11, §13
 */

import { openIngest, type IngestPort } from '../../ingest/index';
import { scanClaimIds } from '../../referents/index-view';
import { decodeSpineClaim } from '../../referents/spine';
import { openGraphStore, type GraphStore } from '../../store/index';
import {
  COSINE_FLOOR,
  TAU_PROMOTE,
  fakeAdjudicator,
  fakeEmbeddings,
} from '../../referents/__tests__/fixtures';
import { testUlid } from '../../store/__tests__/fixtures';

import { openTextIngest } from '../index';

import { PARAGRAPH_BREAK, harnessFor, type Harness } from './fixtures';

import type {
  DrainOutcome,
  ExtractedClaim,
  ExtractionOptions,
  ExtractionPort,
  ExtractionRequest,
  Extractor,
} from '../index';

/*
 * ---------------------------------------------------------------------------
 * The gate corpus.
 * ---------------------------------------------------------------------------
 */

/** The document the gate is tried against. @spec §3.6 */
export const GATE_DOCUMENT_ID = testUlid('DOC-GATE-CORPUS');

/**
 * Two paragraphs, and everything the gate needs is a substring relation between
 * them.
 *
 * Paragraph zero carries the straight-quoted phrase every citation variant is
 * built from. Paragraph one carries a phrase that is verbatim *in the document*
 * and absent from paragraph zero, which is the only way to ask whether the gate
 * checks a quote against the chunk it cites or against the document at large.
 *
 * @spec §3.6, §5.10
 */
export const GATE_PARAGRAPHS = [
  'Note one. The valve seat "was left as it was found", and the entry gives no reason for it. Whoever wrote this was writing quickly and stopped mid-thought. The margin is annotated in a second hand.',
  'Note two. The inlet gauge was measured twice and recorded once, and nobody initialled the second reading. A later reader has added that the same thing had happened in an earlier season.',
] as const;

/** The gate corpus as one document. @spec §3.6 */
export const gateDocument = (): string => GATE_PARAGRAPHS.join(PARAGRAPH_BREAK);

/** A span of chunk zero, byte for byte. @spec §5.10 */
export const VERBATIM_QUOTE = 'The valve seat "was left as it was found"';

/** {@link VERBATIM_QUOTE} with one space doubled, and nothing else changed. @spec §5.10 */
export const WHITESPACE_VARIANT = 'The valve seat  "was left as it was found"';

/** {@link VERBATIM_QUOTE} with one letter case-folded, and nothing else changed. @spec §5.10 */
export const CASE_VARIANT = 'the valve seat "was left as it was found"';

/** {@link VERBATIM_QUOTE} with its straight quotation marks typeset, and nothing else changed. @spec §5.10 */
export const SMART_QUOTE_VARIANT = 'The valve seat “was left as it was found”';

/**
 * {@link VERBATIM_QUOTE} wrapped in whitespace, and nothing else changed.
 *
 * The variant a JSON-emitting model actually produces — a quote pasted out of a
 * fenced block keeps the newline and the indent that framed it. It is the one
 * near-miss whose *trimmed* form is a verbatim span, which is what separates a
 * gate testing `includes` from one testing `trim().includes(trim())`: the other
 * three variants differ in their interior and survive a trim on either side, so
 * none of them can tell the two gates apart.
 *
 * Two spaces rather than one, and a newline rather than neither: chunk zero has
 * a single space before `The valve seat` and no newline anywhere, so this pads
 * with what the chunk demonstrably does not hold.
 *
 * @spec §5.10
 */
export const PADDED_VARIANT = `\n  ${VERBATIM_QUOTE}\n  `;

/** A span of chunk one. Verbatim in the document, absent from chunk zero. @spec §5.10 */
export const NEIGHBOUR_QUOTE = 'The inlet gauge was measured twice and recorded once';

/** A span the document does not contain anywhere — §5.10's phantom. @spec §5.10, §12 */
export const PHANTOM_QUOTE = 'The valve seat was replaced by the night shift on the fourteenth.';

/**
 * A quote that is nothing but whitespace.
 *
 * One space rather than several, because the point of this constant is that
 * `chunkText.includes(quote)` is `true` for it in every chunk in the corpus — a
 * three-space run is not in this prose, and a fixture that failed `includes`
 * for the ordinary reason would have tested nothing.
 *
 * @spec §5.10
 */
export const BLANK_QUOTE = ' ';

/** The noun chunk zero is about. Undeclared in the semantic space, so it mints. @spec §5.2 */
export const VALVE_SEAT = 'the valve seat';

/** The noun chunk one is about. @spec §5.2 */
export const INLET_GAUGE = 'the inlet gauge';

/** A second noun, so a member naming two referents has two to name. @spec §3.2, §5.2 */
export const SECOND_HAND = 'the second hand';

/** An assertion chunk zero supports. @spec §5.10 */
export const ADMITTED_CLAIM = 'The valve seat was left as it was found during the winter overhaul.';

/** An assertion the document never made. @spec §5.10, §12 */
export const PHANTOM_CLAIM = 'The valve seat was replaced by the night shift.';

/** An assertion chunk one supports. @spec §5.10 */
export const NEIGHBOUR_CLAIM = 'The inlet gauge was measured twice and recorded once.';

/** What marks chunk zero, for an extractor that answers per chunk. */
export const CHUNK_ZERO_MARKER = 'Note one.';

/** What marks chunk one. */
export const CHUNK_ONE_MARKER = 'Note two.';

/*
 * ---------------------------------------------------------------------------
 * The arithmetic corpus.
 * ---------------------------------------------------------------------------
 */

/** The document §5.10's *"forty assertions from one ADR"* is counted over. @spec §4.2, §5.10 */
export const LEDGER_DOCUMENT_ID = testUlid('DOC-OVERHAUL-LEDGER');

/**
 * The one noun every member of the arithmetic document names.
 *
 * One surface form, deliberately: `deriveName` breaks a support tie on the
 * smaller form, so a referent accumulating two forms of equal support has a name
 * that flips, and nothing in this suite is about that.
 *
 * @spec §3.1, §5.2
 */
export const OVERHAUL_LEDGER = 'the overhaul ledger';

/** How many members each chunk of the arithmetic document proposes. @spec §4.2, §5.10 */
export const MEMBERS_PER_CHUNK = 3;

/**
 * A slice of a chunk that is a verbatim span of it by construction.
 *
 * Long enough not to be whitespace, short enough to sit inside the shortest
 * paragraph any fixture here produces.
 *
 * @spec §5.10
 */
export const verbatimSliceOf = (chunkText: string): string => chunkText.slice(0, 48);

/*
 * ---------------------------------------------------------------------------
 * Jobs the drain cannot work.
 * ---------------------------------------------------------------------------
 */

/**
 * A document id nothing ever wrote a row for.
 *
 * §9's `enqueueJob` takes an opaque payload and no foreign key, so a job may
 * legitimately name a document that never existed or that a later
 * `deleteDocument` took away.
 *
 * @spec §3.6, §9
 */
export const ABSENT_DOCUMENT_ID = testUlid('DOC-NEVER-WRITTEN');

/**
 * Payloads that are valid JSON and are not extract jobs.
 *
 * The distinction §9 forces: the column round-trips *any* JSON, so "the store
 * handed something back" says nothing about whether the drain can read it. Each
 * of these is a shape `enqueueJob` accepts without complaint and
 * `ExtractJobPayload` must refuse — a foreign object, a payload missing the
 * ordinal, one whose ordinal is not an integer, and the two the column's own
 * default and an explicit `null` produce.
 *
 * @spec §9, §12
 */
export const UNREADABLE_PAYLOADS: readonly unknown[] = [
  { note: 'a payload from some other clock entirely' },
  { documentId: GATE_DOCUMENT_ID, hash: 'abc', episodeId: 'document:x' },
  { documentId: GATE_DOCUMENT_ID, ordinal: 1.5, hash: 'abc', episodeId: 'document:x' },
  {},
  null,
];

/*
 * ---------------------------------------------------------------------------
 * The third faked port.
 * ---------------------------------------------------------------------------
 */

/** The model under audit, as §13 groups an audit by. @spec §13, §15 */
export const EXTRACTOR_MODEL_ID = 'declared-proposals@fake';

/**
 * An extractor that answers from a script and records what it was asked.
 *
 * Defaults to proposing nothing, so a test that never scripts an answer proves
 * the empty path rather than silently mining something. Mirrors
 * `fakeAdjudicator` in every respect that matters, including the call log:
 * "the extractor was never called" is the assertion that separates a document
 * refused at the drain from one that was mined and produced nothing.
 *
 * @spec §5.10, §11
 */
export interface FakeExtractor extends Extractor {
  /** Every chunk the drain handed over, in order. */
  readonly requests: readonly ExtractionRequest[];
  /** Installs what the extractor proposes for subsequent chunks. */
  answerWith(answer: (request: ExtractionRequest) => readonly ExtractedClaim[]): void;
  /** Makes every subsequent call reject, as a model call that times out does. */
  failWith(error: Error): void;
  /** Drops the call log, so a test can assert about one drain rather than all of them. */
  forget(): void;
}

/** @spec §5.10, §11 */
export const fakeExtractor = (): FakeExtractor => {
  const requests: ExtractionRequest[] = [];
  let answer: (request: ExtractionRequest) => readonly ExtractedClaim[] = () => [];
  let failure: Error | undefined;
  return {
    modelId: EXTRACTOR_MODEL_ID,
    requests,
    answerWith: (next) => {
      answer = next;
      failure = undefined;
    },
    failWith: (error) => {
      failure = error;
    },
    forget: () => {
      requests.length = 0;
    },
    extract: (request) => {
      requests.push(request);
      return failure === undefined ? Promise.resolve(answer(request)) : Promise.reject(failure);
    },
  };
};

/** One proposal, with everything a member needs and nothing a test did not set. @spec §5.10 */
export const proposal = (overrides: Partial<ExtractedClaim> = {}): ExtractedClaim =>
  ({
    text: ADMITTED_CLAIM,
    quote: VERBATIM_QUOTE,
    kind: 'fact',
    tier: 'observed',
    mentions: [VALVE_SEAT],
    ...overrides,
  }) as ExtractedClaim;

/** Proposes these claims for the chunk carrying `marker`, and nothing for any other. */
export const forChunkMarked =
  (marker: string, claims: readonly ExtractedClaim[]) =>
  (request: ExtractionRequest): readonly ExtractedClaim[] =>
    request.chunkText.includes(marker) ? claims : [];

/**
 * Proposes `count` members per chunk, each naming {@link OVERHAUL_LEDGER} and
 * each carrying a verbatim span of the chunk it came from.
 *
 * Every text is distinct, across chunks and within one. It has to be: stage 0
 * keys on `(episode, text)` and §5.10 makes a whole document one episode, so
 * repeated texts would arrive as replays and move no posterior at all — which
 * would make the episode-cap arithmetic pass for entirely the wrong reason.
 *
 * @spec §4.2, §5.1, §5.10
 */
export const membersPerChunk =
  (count: number) =>
  (request: ExtractionRequest): readonly ExtractedClaim[] =>
    Array.from({ length: count }, (_, n) =>
      proposal({
        text: `${request.chunkText.slice(0, 24)} — reading ${String(n)} of the overhaul ledger.`,
        quote: verbatimSliceOf(request.chunkText),
        mentions: [OVERHAUL_LEDGER],
      }),
    );

/*
 * ---------------------------------------------------------------------------
 * The harness.
 * ---------------------------------------------------------------------------
 */

/** The unwritten factory, injected so this module stays loadable. */
export type OpenExtraction = (options: ExtractionOptions) => ExtractionPort;

/** E2's harness, plus the extractor and the drain opened over the same store. */
export interface ExtractionHarness extends Harness {
  readonly extractor: FakeExtractor;
  readonly extraction: ExtractionPort;
}

/**
 * @spec §5.2, §5.3, §5.10, §11
 *
 * The guard on `open` is `isNamedRefusal`'s discipline moved up a level: with the
 * factory unwritten the value import resolves to `undefined`, and calling it
 * raises a `TypeError` that names nothing. A harness that cannot be built should
 * say which export is missing, so a RED run is legible and a later failure for an
 * unrelated reason is not mistaken for this one.
 */
export const extractionHarnessFor = (open: OpenExtraction): ExtractionHarness => {
  if (typeof open !== 'function')
    throw new Error(
      'src/extract/index.ts exports no `openExtraction` — E3’s drain has not been written yet',
    );
  const base = harnessFor(openTextIngest);
  const extractor = fakeExtractor();
  return {
    ...base,
    extractor,
    extraction: open({
      store: base.store,
      embeddings: base.embeddings,
      adjudicator: base.adjudicator,
      extractor,
      cosineFloor: COSINE_FLOOR,
      tauPromote: TAU_PROMOTE,
    }),
  };
};

/**
 * A store and an ingest port and nothing else — the control arm.
 *
 * §5.10's *"forty assertions from one ADR are one source, not forty
 * observations"* is a comparison, and this is the thing it is compared against:
 * the same assertions arriving as forty genuinely independent episodes.
 *
 * @spec §4.2, §4.4, §5.10
 */
export interface ControlHarness {
  readonly store: GraphStore;
  readonly ingest: IngestPort;
  close(): void;
}

/** @spec §4.4, §5.10 */
export const controlHarness = (): ControlHarness => {
  const store = openGraphStore({ path: ':memory:' });
  const ports = {
    store,
    embeddings: fakeEmbeddings(),
    adjudicator: fakeAdjudicator(),
    cosineFloor: COSINE_FLOOR,
    tauPromote: TAU_PROMOTE,
  };
  return {
    store,
    ingest: openIngest(ports),
    close: () => {
      store.close();
    },
  };
};

/*
 * ---------------------------------------------------------------------------
 * Draining, and reading what a drain did.
 * ---------------------------------------------------------------------------
 */

/** More drains than any fixture here needs, so a drain that never empties fails loudly. */
const DRAIN_CEILING = 1_000;

/**
 * Every job the extraction drain will take, until it answers with nothing.
 *
 * The ceiling is the spin detector: a drain that hands a failed job straight
 * back to the queue with a `retryAt` in the past would be claimed again on the
 * next pass, forever, and §9's whole reason for putting the retry instant in the
 * caller's hands is that neither automatic reading is right.
 *
 * @spec §9
 */
export const drainExtraction = async (
  extraction: ExtractionPort,
): Promise<readonly DrainOutcome[]> => {
  const outcomes: DrainOutcome[] = [];
  for (let i = 0; i < DRAIN_CEILING; i += 1) {
    const outcome = await extraction.drainOnce();
    if (outcome === undefined) return outcomes;
    outcomes.push(outcome);
  }
  throw new Error('the extraction drain never emptied');
};

/** Every claim id the drain admitted, across a whole drain. */
export const admittedBy = (outcomes: readonly DrainOutcome[]): string[] =>
  outcomes.flatMap((outcome) => [...outcome.admitted]);

/**
 * Every claim text in the ledger, in id order — spine claims included.
 *
 * The right read for *"nothing reached the graph"*: a refused proposal must not
 * leave an existence claim behind either, and a filtered scan would not notice
 * one.
 *
 * @spec §3.2, §11
 */
export const claimTexts = (store: GraphStore): string[] =>
  scanClaimIds(store).flatMap((id) => {
    const summary = store.getClaimSummary(id);
    return summary === undefined ? [] : [summary.text];
  });

/**
 * The ordinary claims in the ledger — the members, without the spine.
 *
 * Every existence and naming claim a resolution writes is spine-encoded (§3.5),
 * so `decodeSpineClaim` is the exact discriminant. The right read for *"this
 * member and no other landed"*, where the raw scan would also hold whatever
 * §5.2's ladder had to mint on the way.
 *
 * @spec §3.5, §5.2
 */
export const memberTexts = (store: GraphStore): string[] =>
  claimTexts(store).filter((text) => decodeSpineClaim(text) === undefined);

/** The referent a surface form names, or `undefined` if nothing has ever named one. @spec §3.1 */
export const referentFor = (store: GraphStore, surfaceForm: string): string | undefined =>
  store.findReferentsByMention(surfaceForm)[0]?.referentId;

/**
 * The α on a referent's existence claim — what §4.2's episode cap is spent on.
 *
 * @spec §3.1, §4.1, §4.2
 */
export const existenceAlpha = (
  store: GraphStore,
  ingest: IngestPort,
  surfaceForm: string,
): number => {
  const referentId = referentFor(store, surfaceForm);
  if (referentId === undefined) throw new Error(`nothing in the graph is named ${surfaceForm}`);
  const referent = ingest.referents.get(referentId);
  if (referent === undefined) throw new Error(`the referent index holds no row for ${referentId}`);
  const evidence = store.getEvidence(referent.existenceClaimId);
  if (evidence === null || evidence === undefined)
    throw new Error(`${surfaceForm}'s existence claim carries no posterior`);
  return evidence.alpha;
};
