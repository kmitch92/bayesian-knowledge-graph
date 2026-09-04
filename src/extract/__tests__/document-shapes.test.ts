/**
 * The same prose, however it happened to be typed.
 *
 * §5.10's ingress is universal — *"an ADR, a philosophy notebook, a runbook, a
 * transcript or a repository"* — and those arrive from editors that disagree
 * about three things this chunker has to be right about: what ends a line, what
 * ends a file, and whether a paragraph occupies one line or six. The rest of
 * this suite is written against a corpus whose paragraphs are each a single
 * unwrapped LF-terminated line, which is the one shape that makes all three
 * questions moot. So none of it can see the failures below.
 *
 * ── Hard wrapping is the failure with the largest blast radius ──────────────
 *
 * Prose is wrapped. An ADR, a git commit body, a notebook and a transcript are
 * all written at some column, so a paragraph is a *run of lines* and a chunker
 * that treats every line break as a boundary emits one chunk per line. Three
 * things break at once, and none of them are visible to a single-line corpus:
 *
 * 1. §5.10's cost argument inverts. *"A 3,000-word ADR never pays forty inline
 *    adjudications"* is an argument about forty paragraph-sized units; one job
 *    per wrapped line is two hundred.
 * 2. A chunk stops being a thing a claim can be entailed by. §5.10 gates
 *    insertion on *"span ⊨ claim"*, and half a sentence entails nothing.
 * 3. The locality property degrades to nothing on the commonest edit there is.
 *    Adding a word to the top of a paragraph re-wraps every line below it
 *    inside that paragraph, so every one of its lines changes — the reflow this
 *    chunker exists to avoid, merely confined to one paragraph.
 *
 * ── What ends a file, and what ends a line ─────────────────────────────────
 *
 * Editors add and remove the trailing newline at the end of a file routinely,
 * and on a whole-file basis. If the last paragraph's anchor moved when one
 * appeared, §5.10's testimony decay would fire on the last paragraph of every
 * document on every save that touched nothing — *"members whose spans changed
 * decay their doc-sourced contribution toward the prior"*, for an edit no
 * author made. The same argument covers the blank lines at the top of a file
 * and the `\r` a Windows editor leaves at the end of every line.
 *
 * ── What is asserted about a separator this chunker does not know ───────────
 *
 * A document that arrives with U+2028 or U+2029 in place of newlines — which a
 * PDF or rich-text extractor emits — has no boundary this chunker can find, so
 * it becomes one chunk, exactly as *"one enormous unbroken paragraph"* does in
 * `extraction-gate.test.ts`. §5.10 specifies no chunk size and nothing here
 * rules on whether that is the right answer. What is asserted is that the
 * answer is an *honest* one: the invariants every chunking owes — verbatim
 * spans, a partition of the document, contiguous ordinals, no empty chunk —
 * hold for it exactly as they do for prose, so it degrades rather than
 * corrupts.
 *
 * Real SQLite, `:memory:`. Every shape below goes in through `submitText` and
 * comes back out through `chunksOf`, so the store round-trip is under test too.
 *
 * @spec §3.6, §5.10, §12
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTextIngest } from '../index';

import { DOCUMENT_ID, OTHER_DOCUMENT_ID, harnessFor, squash, textSource, type Harness } from './fixtures';

/**
 * A paragraph of prose wrapped at a column, as an editor leaves it.
 *
 * Three lines, so a chunker that splits on a line break produces three chunks
 * where there is one paragraph, and the difference is not a rounding error.
 */
const wrappedParagraph = (n: number): string =>
  [
    `Note ${n} was written in the margin of the previous page and`,
    `carried over without a heading, which is why the reference to`,
    `the earlier season reads as though it were a fresh observation.`,
  ].join('\n');

/** A hard-wrapped document of `count` paragraphs, separated by blank lines. */
const wrappedDocument = (count: number): string =>
  Array.from({ length: count }, (_, n) => wrappedParagraph(n)).join('\n\n');

/** The same document as a Windows editor writes it. */
const asCrlf = (text: string): string => text.replace(/\n/gu, '\r\n');

/** Prose whose paragraphs each occupy exactly one line. */
const FLAT = [
  'The valve seat was left as it was found, and the entry gives no reason.',
  'The margin is annotated in a second hand, dated three seasons later.',
  'Nothing in the surrounding pages settles whether that was deliberate.',
].join('\n\n');

let harness: Harness;

beforeEach(() => {
  harness = harnessFor(openTextIngest);
});

afterEach(() => {
  harness.close();
});

/** Ingests a text and hands back the chunking the port then serves for it. @spec §5.10 */
const ingest = async (text: string, id = DOCUMENT_ID): Promise<readonly string[]> => {
  await harness.text.submitText(textSource({ id, text }));
  return harness.text.chunksOf(id).map((view) => view.hash);
};

/** The invariants every chunking owes, whatever boundaries it found. @spec §3.6, §5.10 */
const invariantsOf = (
  text: string,
  id = DOCUMENT_ID,
): {
  readonly everySpanIsVerbatim: boolean;
  readonly partitionsTheDocument: boolean;
  readonly ordinalsAreContiguous: boolean;
  readonly noEmptyChunk: boolean;
} => {
  const views = harness.text.chunksOf(id);
  return {
    everySpanIsVerbatim: views.every((view) => text.includes(view.text)),
    partitionsTheDocument: squash(views.map((view) => view.text).join('')) === squash(text),
    ordinalsAreContiguous:
      JSON.stringify(views.map((view) => view.ordinal)) ===
      JSON.stringify(Array.from({ length: views.length }, (_, at) => at)),
    noEmptyChunk: views.every((view) => view.text.trim().length > 0),
  };
};

/** Every invariant, held. */
const HONEST = {
  everySpanIsVerbatim: true,
  partitionsTheDocument: true,
  ordinalsAreContiguous: true,
  noEmptyChunk: true,
} as const;

describe('a paragraph wrapped across lines is one chunk, not one chunk per line', () => {
  it('cuts a hard-wrapped document at its blank lines and nowhere else', async () => {
    const text = wrappedDocument(5);
    await harness.text.submitText(textSource({ text }));

    const views = harness.text.chunksOf(DOCUMENT_ID);

    expect(views.map((view) => view.text)).toStrictEqual(
      Array.from({ length: 5 }, (_, n) => wrappedParagraph(n)),
    );
    expect(views.filter((view) => !view.text.includes('\n'))).toStrictEqual([]);
  });

  it('keeps the line breaks inside a paragraph, so the span quotes the document verbatim', async () => {
    const text = wrappedDocument(5);
    await harness.text.submitText(textSource({ text }));

    expect(invariantsOf(text)).toStrictEqual(HONEST);
  });

  it('charges a re-wrap to the paragraph re-wrapped and to no other', async () => {
    const before = wrappedDocument(5);
    const after = before.replace(wrappedParagraph(2), wrappedParagraph(2).replace(/\n/gu, ' '));
    const original = await ingest(before);

    const survivors = await ingest(after);

    expect(after).not.toStrictEqual(before);
    expect(original.filter((hash) => !survivors.includes(hash))).toStrictEqual([original[2]]);
  });
});

describe('the same prose anchors the same way however the editor ended its lines', () => {
  it('cuts a CRLF document at its blank lines rather than reading it as one paragraph', async () => {
    const text = asCrlf(FLAT);
    await harness.text.submitText(textSource({ text }));

    expect(harness.text.chunksOf(DOCUMENT_ID).length).toBe(3);
    expect(invariantsOf(text)).toStrictEqual(HONEST);
  });

  it('anchors a CRLF document identically to the LF document it is a copy of', async () => {
    const asWritten = await ingest(FLAT);

    const asSavedOnWindows = await ingest(asCrlf(FLAT), OTHER_DOCUMENT_ID);

    expect(asSavedOnWindows).toStrictEqual(asWritten);
  });

  it('does not carry the boundary carriage return into the span it hands E3', async () => {
    const text = asCrlf(FLAT);
    await harness.text.submitText(textSource({ text }));

    expect(harness.text.chunksOf(DOCUMENT_ID).map((view) => view.text)).toStrictEqual(
      FLAT.split('\n\n'),
    );
  });
});

describe('whitespace at the edges of a file moves no anchor', () => {
  it.each([
    ['a trailing newline', (text: string): string => `${text}\n`],
    ['a trailing CRLF newline', (text: string): string => `${text}\r\n`],
    ['trailing blank lines', (text: string): string => `${text}\n\n\n`],
    ['leading blank lines', (text: string): string => `\n\n${text}`],
    ['leading and trailing whitespace', (text: string): string => `\n  \n${text}\n  \n`],
  ])('%s leaves every hash exactly where it was', async (_name, reshape) => {
    const asWritten = await ingest(FLAT);

    const asSaved = await ingest(reshape(FLAT), OTHER_DOCUMENT_ID);

    expect(asSaved).toStrictEqual(asWritten);
  });

  it('adds no chunk for the blank space, so §7.7 counts no coverage that is not there', async () => {
    const text = `\n\n${FLAT}\n\n`;
    await harness.text.submitText(textSource({ text }));

    expect(harness.text.chunksOf(DOCUMENT_ID).length).toBe(3);
    expect(invariantsOf(text)).toStrictEqual(HONEST);
  });
});

describe('a document with no boundary this chunker knows degrades honestly', () => {
  const UNKNOWN_SEPARATORS = [
    ['a Unicode line separator', ' '],
    ['a Unicode paragraph separator', ' '],
    ['a doubled Unicode paragraph separator', '  '],
    ['a next-line control', ''],
    ['a form feed', '\f\f'],
    ['a carriage return alone, as a classic Mac editor wrote it', '\r\r'],
    ['no blank line at all', '\n'],
  ] as const;

  it.each(UNKNOWN_SEPARATORS)(
    'given %s, still serves verbatim spans that partition the document',
    async (_name, separator) => {
      const text = FLAT.split('\n\n').join(separator);
      await harness.text.submitText(textSource({ text }));

      expect(harness.text.chunksOf(DOCUMENT_ID).length).toBeGreaterThan(0);
      expect(invariantsOf(text)).toStrictEqual(HONEST);
    },
  );

  it('is never silently emptied by one: the text it serves is still the text submitted', async () => {
    const text = FLAT.split('\n\n').join(' ');
    await harness.text.submitText(textSource({ text }));

    expect(harness.text.chunksOf(DOCUMENT_ID).map((view) => view.text).join('')).toStrictEqual(text);
  });
});
