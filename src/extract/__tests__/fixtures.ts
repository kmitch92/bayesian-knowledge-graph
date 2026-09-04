/**
 * Shared fixtures for the E2 text-ingest suite.
 *
 * Two rules govern this module, both inherited from
 * `src/referents/__tests__/fixtures.ts`:
 *
 * 1. **Every reference to the unwritten `../index` is type-only**, so esbuild
 *    erases it before the module runs. The RED signal then comes from the value
 *    imports in the `.test.ts` files rather than from a fixture module that
 *    cannot load. Everything else imported here — the store, the ingest port,
 *    the two faked model ports — exists today.
 * 2. **The store is never faked.** Real SQLite, `:memory:` or a temp file, real
 *    vectors at the real width. Only the {@link EmbeddingProvider} (§5.3) and
 *    the {@link Adjudicator} (§5.2) are stood in for, which is this repo's
 *    established line.
 *
 * **Nothing here knows a programming language.** The corpus is a field
 * notebook — §5.10's ingress is universal, and a philosophy notebook, an ADR
 * and a repository enter by the same door.
 *
 * ── The corpus is built for one question ────────────────────────────────────
 *
 * §5.10 anchors chunks by *"hash + fuzzy-quote anchoring, never raw offsets"*
 * and §12 names span rot as the failure that causes: *"document edits break
 * anchors; retracted assertions keep contributing"*. Testimony decay is only
 * worth having if it is *selective* — *"members whose spans changed decay their
 * doc-sourced contribution toward the prior; members whose quotes vanish flag
 * `retracted_in_source`"*. A chunker that shifts every downstream boundary when
 * a word is inserted at the top decays every member of the document on every
 * edit, which makes the mechanism worthless while appearing to work.
 *
 * So {@link notebookParagraph} produces paragraphs that are unique (a chunk's
 * text can be located in the document by `indexOf`, exactly), long enough that
 * a chunker has something to decide (~75 words), and all carrying one constant
 * {@link HINGE} sentence in the middle that {@link EDITS} can rewrite. Every
 * edit changes bytes strictly *inside* one paragraph and changes its length, so
 * "before the edit" and "after the edit" are well-defined byte regions and a
 * reflowing chunker has something to reflow.
 *
 * Chunk *size* is deliberately absent from every constant here. §5.10 never
 * specifies one, and nothing in this suite may guess it.
 *
 * @spec §3.6, §5.2, §5.3, §5.10, §11, §12
 */

import { openIngest, type IngestPort, type Origin } from '../../ingest/index';
import { openGraphStore, type GraphStore, type Job } from '../../store/index';
import {
  COSINE_FLOOR,
  TAU_PROMOTE,
  fakeAdjudicator,
  fakeEmbeddings,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from '../../referents/__tests__/fixtures';
import { testUlid } from '../../store/__tests__/fixtures';

import type { ChunkView, TextIngestOptions, TextIngestPort, TextSource } from '../index';

/*
 * ---------------------------------------------------------------------------
 * The corpus.
 * ---------------------------------------------------------------------------
 */

/**
 * The sentence every paragraph carries in its middle, and the only thing
 * {@link EDITS} rewrite.
 *
 * Constant across paragraphs so an edit can be expressed without knowing which
 * paragraph it lands in, and positioned mid-paragraph so the changed bytes are
 * never adjacent to a paragraph boundary — an edit that happened to sit on a
 * boundary would let a chunker that redraws boundaries look local by accident.
 */
export const HINGE = 'The margin is annotated in a second hand.';

/** Nouns the notebook is about. Domain-neutral: none of this is code. */
const SUBJECTS = [
  'The valve seat',
  'The inlet gauge',
  'The night shift',
  'The spare relay',
  'The winter tarpaulin',
  'The signing-off clerk',
  'The delivery of oil',
  'The overhaul schedule',
] as const;

/** What the notebook records happening to them. */
const HAPPENINGS = [
  'was left as it was found',
  'was replaced without a note',
  'was measured twice and recorded once',
  'was moved to the far bench',
  'was written up a season late',
  'was reported and then forgotten',
  'was signed for by nobody',
] as const;

/**
 * One paragraph of the notebook, unique in `n` and about 75 words long.
 *
 * Unique because `Note ${n}.` opens it: a chunk's verbatim text can then be
 * located in the document with `indexOf`, which is how "wholly before the edit"
 * and "wholly after the edit" are decided without the chunker exposing an
 * offset it is forbidden to have.
 */
export const notebookParagraph = (n: number): string =>
  [
    `Note ${n}.`,
    `${SUBJECTS[n % SUBJECTS.length]!} ${HAPPENINGS[(n * 3 + 1) % HAPPENINGS.length]!}, and the entry gives no reason for it.`,
    `Whoever wrote this was writing quickly and stopped mid-thought.`,
    HINGE,
    `A later reader has added that the same thing had happened in an earlier season, and that nobody wrote that down either.`,
    `What note ${n} leaves open is whether the omission was carelessness or a judgement that the thing was not worth recording.`,
    `Nothing in the surrounding pages settles it.`,
  ].join(' ');

/** The paragraph separator. Blank lines, as prose is written. */
export const PARAGRAPH_BREAK = '\n\n';

/** The first `count` paragraphs of the notebook, as one document. */
export const notebook = (count: number): string =>
  Array.from({ length: count }, (_, n) => notebookParagraph(n)).join(PARAGRAPH_BREAK);

/**
 * The short document's length, in paragraphs. ~600 words.
 *
 * Its paragraphs are a prefix of the long document's, because
 * {@link notebookParagraph} is a pure function of `n` — which is what lets the
 * scaling test hand a chunker the *same* leading text under two different
 * amounts of trailing text.
 */
export const SHORT_PARAGRAPHS = 8;

/** The long document's length, in paragraphs. ~4,800 words — §5.10's 3,000-word ADR and then some. */
export const LONG_PARAGRAPHS = 64;

/**
 * Which paragraph the scaling test edits: the middle of the short document, and
 * therefore near the top of the long one, so the two differ most in how much
 * unedited text sits downstream of the change.
 */
export const SHARED_EDIT_AT = 4;

/** Which paragraph the locality tests edit: the middle of the long document. */
export const MIDDLE_EDIT_AT = 31;

/** One way a document gets edited. @spec §5.10, §12 */
export interface Edit {
  readonly name: string;
  /** Rewrites one paragraph. Changes bytes strictly inside it, and changes its length. */
  readonly apply: (paragraph: string) => string;
}

/**
 * The three edits §5.10's testimony decay has to survive selectively.
 *
 * Each changes the paragraph's length, because a reflowing chunker only
 * reflows when the byte count moves.
 *
 * @spec §5.10, §12
 */
export const EDITS: readonly Edit[] = [
  {
    name: 'an inserted sentence',
    apply: (paragraph) =>
      paragraph.replace(
        HINGE,
        `${HINGE} The annotation is dated three seasons later and initialled by somebody else.`,
      ),
  },
  {
    name: 'a deleted sentence',
    apply: (paragraph) => paragraph.replace(`${HINGE} `, ''),
  },
  {
    name: 'a replaced sentence',
    apply: (paragraph) =>
      paragraph.replace(HINGE, 'The margin is blank, which is unusual for this notebook.'),
  },
];

/** Applies one edit to one paragraph of a document, leaving every other byte alone. */
export const editParagraph = (text: string, index: number, edit: Edit): string => {
  const paragraphs = text.split(PARAGRAPH_BREAK);
  const target = paragraphs[index];
  if (target === undefined) throw new Error(`the fixture document has no paragraph ${index}`);
  return paragraphs
    .map((paragraph, at) => (at === index ? edit.apply(paragraph) : paragraph))
    .join(PARAGRAPH_BREAK);
};

/** A half-open byte range of a document. */
export interface Region {
  readonly start: number;
  readonly end: number;
}

/**
 * Where one paragraph sits in a document.
 *
 * The test's own arithmetic, never the chunker's: §3.6 forbids the chunker from
 * having an offset at all, so the only honest way to ask "is this chunk
 * downstream of the edit?" is to locate its verbatim text ourselves.
 *
 * @spec §3.6
 */
export const paragraphRegion = (text: string, index: number): Region => {
  const paragraph = text.split(PARAGRAPH_BREAK)[index];
  if (paragraph === undefined) throw new Error(`the fixture document has no paragraph ${index}`);
  const start = text.indexOf(paragraph);
  if (start < 0) throw new Error(`paragraph ${index} is not in the document`);
  return { start, end: start + paragraph.length };
};

/*
 * ---------------------------------------------------------------------------
 * Reading a chunking.
 * ---------------------------------------------------------------------------
 */

/** Where a chunk's verbatim text sits in a document, or `-1` if it is not in it. */
export const positionOf = (view: ChunkView, text: string): number => text.indexOf(view.text);

/** The chunks lying wholly before a region — untouched by an edit inside it. @spec §5.10 */
export const whollyBefore = (
  views: readonly ChunkView[],
  text: string,
  region: Region,
): ChunkView[] =>
  views.filter((view) => {
    const at = positionOf(view, text);
    return at >= 0 && at + view.text.length <= region.start;
  });

/** The chunks lying wholly after a region — untouched by an edit inside it. @spec §5.10 */
export const whollyAfter = (
  views: readonly ChunkView[],
  text: string,
  region: Region,
): ChunkView[] =>
  views.filter((view) => {
    const at = positionOf(view, text);
    return at >= region.end;
  });

/**
 * How many chunks the edit disturbed that it had no business disturbing.
 *
 * A chunk whose verbatim text still occurs in the edited document is a region
 * the edit did not touch. If its hash is gone, the chunker redrew a boundary
 * somewhere it did not need to — which is span rot manufactured by the
 * ingester rather than by the author.
 *
 * @spec §5.10, §12
 */
export const disturbedCount = (
  views: readonly ChunkView[],
  editedText: string,
  hashesAfter: readonly string[],
): number =>
  views.filter((view) => editedText.includes(view.text) && !hashesAfter.includes(view.hash)).length;

/**
 * How many *untouched* chunks an edit may cost before it has stopped being
 * local: the chunk the edit landed in is not counted here at all, so this is
 * the budget for boundary movement on either side of it.
 *
 * A constant, and asserted alongside the scaling test rather than instead of
 * it: a budget alone would be vacuous against a chunker that emits two enormous
 * chunks, while the scaling test is decisive at any chunk size.
 *
 * @spec §5.10
 */
export const BOUNDARY_ALLOWANCE = 2;

/**
 * The text with every run of whitespace removed.
 *
 * §3.6 calls the field `chunks[]` — *chunk boundaries*. Boundaries partition:
 * comparing the squashed concatenation of the chunks against the squashed
 * document is how "nothing dropped, nothing invented, nothing overlapped,
 * nothing reordered" is asserted while leaving the chunker free to discard the
 * whitespace between one chunk and the next.
 *
 * @spec §3.6
 */
export const squash = (text: string): string => text.replace(/\s+/gu, '');

/*
 * ---------------------------------------------------------------------------
 * The sources.
 * ---------------------------------------------------------------------------
 */

/** The authored notebook under test. @spec §3.6 */
export const DOCUMENT_ID = testUlid('DOC-NOTEBOOK-A');

/** A second document, so nothing here is satisfied by a one-row table. @spec §3.6 */
export const OTHER_DOCUMENT_ID = testUlid('DOC-NOTEBOOK-B');

/** A document the graph generated from its own canonicals. @spec §3.6, §5.10 */
export const MATERIALIZED_DOCUMENT_ID = testUlid('DOC-MATERIALIZED-OVERVIEW');

/** @spec §3.6 */
export const TITLE = 'Field notebook — the winter overhaul';

/**
 * A noun the graph has never heard, so §5.2's ladder mints for it.
 *
 * Undeclared in {@link SEMANTIC_CLUSTERS}, so it lands in its own private plane
 * and the gloss channel returns nothing at all — the mint path, reached
 * honestly rather than by an adjudicator that declined.
 *
 * @spec §5.2
 */
export const UNKNOWN_ANCHOR = 'the winter overhaul notebook';

/**
 * A noun plane 0 already holds. Seeded into the graph by an ordinary claim
 * before the document arrives, so the document's anchor has something to
 * resolve *to*.
 *
 * @spec §5.2
 */
export const KNOWN_ANCHOR = 'AuthService';

/** The submitting episode. What E2 derives the document's own episode from is E2's business. @spec §3.5, §5.10 */
export const SUBMITTING_ORIGIN: Origin = {
  episodeId: 'ep-2026-09-04-01',
  channel: 'document-ingest',
};

/** @spec §3.6, §5.10 */
export const textSource = (overrides: Partial<TextSource> = {}): TextSource =>
  ({
    id: DOCUMENT_ID,
    title: TITLE,
    text: notebook(LONG_PARAGRAPHS),
    origin: 'authored',
    provenance: SUBMITTING_ORIGIN,
    ...overrides,
  }) as TextSource;

/*
 * ---------------------------------------------------------------------------
 * The harness.
 * ---------------------------------------------------------------------------
 */

/** The unwritten factory, injected so this module stays loadable. */
export type OpenTextIngest = (options: TextIngestOptions) => TextIngestPort;

/** A real store, two faked model ports, and both write surfaces over them. */
export interface Harness {
  readonly store: GraphStore;
  readonly embeddings: FakeEmbeddings;
  readonly adjudicator: FakeAdjudicator;
  readonly text: TextIngestPort;
  /** The claim-side port, used to seed known nouns and to read §3.1's index. */
  readonly ingest: IngestPort;
  close(): void;
}

/** @spec §5.2, §5.3, §5.10, §11 */
export const harnessFor = (open: OpenTextIngest, path = ':memory:'): Harness => {
  const store = openGraphStore({ path });
  const embeddings = fakeEmbeddings();
  const adjudicator = fakeAdjudicator();
  const ports = { store, embeddings, adjudicator, cosineFloor: COSINE_FLOOR, tauPromote: TAU_PROMOTE };
  return {
    store,
    embeddings,
    adjudicator,
    text: open(ports),
    ingest: openIngest(ports),
    close: () => {
      store.close();
    },
  };
};

/*
 * ---------------------------------------------------------------------------
 * Reading the queue.
 * ---------------------------------------------------------------------------
 */

/** More jobs than any fixture here enqueues, so a drain that never empties fails loudly. */
const DRAIN_CEILING = 10_000;

/** Every due job of one kind, claimed until the queue answers with nothing. @spec §9 */
export const drainJobs = (store: GraphStore, kind: string): Job[] => {
  const taken: Job[] = [];
  for (let i = 0; i < DRAIN_CEILING; i += 1) {
    const job = store.claimJob(kind);
    if (job === undefined) return taken;
    taken.push(job);
  }
  throw new Error(`the ${kind} queue never emptied`);
};

/**
 * The refusal an act produced, or `undefined` if it did not refuse.
 *
 * Returned rather than matched with `rejects.toThrow`, for the reason
 * `pathway-signature.test.ts` gives: with the module absent a bare throw
 * assertion is satisfied by a `TypeError`, and a refusal for an unrelated
 * reason would look like the refusal under test.
 */
export const refusalFrom = async (act: () => Promise<unknown>): Promise<unknown> => {
  try {
    await act();
    return undefined;
  } catch (error) {
    return error;
  }
};

/**
 * Whether a refusal is a decision rather than a crash.
 *
 * `TypeError` and `ReferenceError` are what an absent module and a mistyped
 * call produce, so they are exactly what must not count as "the module
 * declined".
 */
export const isNamedRefusal = (refusal: unknown): boolean =>
  refusal instanceof Error && refusal.name !== 'TypeError' && refusal.name !== 'ReferenceError';
