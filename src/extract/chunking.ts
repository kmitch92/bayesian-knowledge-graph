/**
 * §5.10's chunker: a document cut at the boundaries it already has.
 *
 * §3.6 anchors a chunk by *"hash + fuzzy-quote anchoring, never raw offsets"*,
 * and §12 says what the alternative costs: *"document edits break anchors;
 * retracted assertions keep contributing"*. §5.10 says what the anchors are for
 * — testimony decay, where *"members whose spans changed decay their doc-sourced
 * contribution toward the prior"*. That mechanism is only worth having if it is
 * **selective**, and selectivity is a property of the *chunker*, not of the
 * hash: a chunker that redraws every downstream boundary when a word is inserted
 * at the top reports every member of the document as changed on every edit, so
 * every member decays on every commit while the machinery appears to work.
 *
 * So the boundaries here are the author's own. A chunk is one paragraph — a
 * maximal run of text between blank lines — and nothing about a chunk is a
 * function of anything outside it. Three consequences, each of which is a thing
 * `anchor-stability.test.ts` asks for:
 *
 * 1. **An edit costs only the region it lands in.** Rewriting a sentence in
 *    paragraph 31 changes paragraph 31's bytes and no others, so it changes one
 *    hash and no others.
 * 2. **The cost does not scale with the document.** Nothing downstream of an
 *    edit is even read when the chunk containing it is hashed, so the same edit
 *    costs the same single anchor under sixty trailing paragraphs as under four.
 *    A size-driven chunker fails this at *every* size, because the byte count it
 *    splits on moves for the whole remainder of the document.
 * 3. **Appending renumbers nothing.** The new paragraph is a new ordinal at the
 *    end; every ordinal before it keeps its hash and its position.
 *
 * The chunks **partition** the document: in order, without gaps, without
 * overlap. Overlap is not a tuning choice here but a correctness one — a
 * sentence carried by two chunks is a sentence two extractions can each propose
 * a member from, which manufactures exactly the §4.4 provenance overlap the
 * independence machinery exists to discount. Only whitespace *between*
 * paragraphs is dropped, which is why §3.6 calls the field chunk *boundaries*.
 *
 * Chunk size is not a constant here, because §5.10 does not have one. What size
 * this produces is whatever the document's own paragraphs are, which is also the
 * grain §5.10 costs its argument in — *"a 3,000-word ADR never pays forty inline
 * adjudications"* is forty paragraph-sized units, not forty documents and not
 * three thousand sentences.
 *
 * Pure, and deliberately: the same text chunks the same way in a store that has
 * never seen it, under any document id, in any process. §5.10's re-anchoring
 * pass over a *moved* quote is a later cycle's problem and is not here.
 *
 * @spec §3.6, §4.4, §5.10, §12
 */

import { createHash } from 'node:crypto';

/**
 * Where a chunk sits and what it is — the pair §3.6 records on an extraction
 * rejection, *"the ordinal is where the paragraph sat at the time, and the hash
 * is what ties the rejection to the text after a re-chunk moves it"*.
 *
 * No third field, and that absence is the shape of §3.6's rule: there is no
 * `start`, no `end` and no `span`, because an offset survives no edit above it
 * and would hand a consumer an anchor that rots while looking well.
 *
 * @spec §3.6, §12
 */
export interface ChunkAnchor {
  /** Where the chunk sits in the document, counting from zero. @spec §3.6 */
  readonly ordinal: number;
  /** The chunk's anchor: a hash of its text, byte for byte. @spec §3.6 */
  readonly hash: string;
}

/**
 * An anchor and the verbatim span it anchors.
 *
 * The text is here because §5.10's gate needs it: *"claim-with-quote spans"*
 * checked against the paragraph they were attributed to. A chunk whose text had
 * been normalized, folded or re-wrapped on the way through would fail that check
 * for quotes the document really does contain, so what a chunk yields is the
 * source's own bytes and nothing else.
 *
 * @spec §5.10, §12
 */
export interface ChunkView extends ChunkAnchor {
  /** A verbatim span of the document, exactly as its author wrote it. @spec §5.10 */
  readonly text: string;
}

/**
 * What separates one paragraph from the next: a blank line.
 *
 * Greedy across the whitespace between them, so any number of blank lines is one
 * boundary rather than a run of empty chunks.
 */
const PARAGRAPH_BREAK = /\n[^\S\n]*(?:\n[^\S\n]*)+/u;

/**
 * A chunk's anchor.
 *
 * SHA-256 of the text as it stands. Not normalized and not case-folded, for the
 * reason `DocumentChunk.hash` gives: the hash is what says *this* span is still
 * the span a member was extracted from, and a hash that ignored whitespace would
 * call a re-wrapped paragraph unchanged.
 *
 * @spec §3.6, §5.10
 */
export const hashChunk = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Cuts a document into chunks, in reading order, numbered from zero.
 *
 * Empty for text with no paragraph in it. That is an answer and not a failure —
 * whether a document with nothing to chunk is refused or accepted is the ingest
 * port's ruling, and this function is not the place where a document exists.
 *
 * @spec §3.6, §5.10
 */
export const chunkText = (text: string): ChunkView[] =>
  text
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph, ordinal) => ({
      ordinal,
      hash: hashChunk(paragraph),
      text: paragraph,
    }));
