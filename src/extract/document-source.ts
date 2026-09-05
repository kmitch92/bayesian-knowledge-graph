/**
 * E4's second source, and the one whose job is to prove the pipeline is not
 * transcript-shaped: a file becomes a {@link TextSource}, and nothing between
 * here and §5.10's queue notices the difference.
 *
 * Same contract as its sibling. It reads, and it returns a value. It chunks
 * nothing, embeds nothing, anchors nothing and writes nothing — `submitText`
 * does all of that, if the caller decides to hand the value over. It is `async`
 * for one reason only, which is that a file is on a disk.
 *
 * **Nothing here knows what the file is.** A notebook, a TypeScript module and
 * a poem are read the same way, cut at the same blank lines and land in the
 * same shape of source. The tree-sitter emitter this replaced was rejected for
 * knowing the difference.
 *
 * ── The id is the path, not the content ─────────────────────────────────────
 *
 * E2 treats a changed id as a different document entirely, so what the id is
 * made of decides what *"the same document, revised"* means. It is the path,
 * and not a hash of the bytes, for three reasons:
 *
 * 1. **A content hash makes every edit a new document.** E2's revision story —
 *    re-chunk, enqueue only what moved, keep the episode — is addressed by id.
 *    Under a content hash an edited file arrives as a stranger: a fresh
 *    document, a fresh episode, and every one of its assertions re-mined and
 *    re-corroborated at full strength beside the ones the previous read already
 *    wrote. That is §4.4's independence failure with the editor in the middle.
 * 2. **A content hash makes testimony decay unreachable.** §5.10 decays
 *    *"members whose spans changed"* and flags *"members whose quotes vanish"*.
 *    Both are relations between one document's old chunking and its new one. If
 *    the edited file is a different document, the old one never changes and
 *    never decays; it is abandoned, still serving, still contributing.
 * 3. **Nothing is lost.** `content_ref` holds the bytes and every chunk carries
 *    its own hash, so content identity is recorded where §3.6 puts it. The id
 *    is left to do the one job an id does.
 *
 * The cost is named and accepted: a file that is **moved or renamed** is a new
 * document, and its old id keeps the members mined under it. That is a rename
 * problem rather than an identity problem, and the spec has no rename story
 * yet. The converse is worse — two files with byte-identical contents are two
 * documents here, because merging them would make the second file's arrival a
 * silent no-op revision and throw its testimony away, where §4.4 wants
 * near-verbatim duplicates *discounted* rather than *disappeared*.
 *
 * ── Title and anchor ────────────────────────────────────────────────────────
 *
 * A title is what a human calls the thing, so it comes off the file's name and
 * survives an edit; a caller who knows better beats it.
 *
 * An **anchor is not guessed**. §3.6 makes it *"a prior, not an inheritance"*
 * and §5.2 resolves it through the ladder, minting a provisional referent for a
 * noun the graph has never heard. A source that anchored a document at its own
 * filename would mint referents named after files — which is exactly the
 * path-shaped noun source this project threw out.
 *
 * @spec §3.6, §4.4, §5.2, §5.10, §9, §11, §12
 */

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import type { Origin } from '../ingest/index.js';

import type { TextSource } from './text-ingest.js';

/**
 * What a caller hands the document source.
 *
 * @spec §3.6, §5.10
 */
export interface DocumentSourceOptions {
  /** Where the file is. The document's identity, once resolved. @spec §3.6 */
  readonly path: string;
  /** Who filed it, over what pathway. @spec §3.5, §4.7 */
  readonly provenance: Origin;
  /** What to call it, if the file's own name will not do. @spec §3.6 */
  readonly title?: string | undefined;
  /** The noun the document is about, if the submitter names one. Never guessed. @spec §3.6, §5.2 */
  readonly anchor?: string | undefined;
}

/**
 * There was no document at that path to read.
 *
 * Named rather than left as whatever the filesystem threw, so a caller can tell
 * *"this file is not there"* from the `TypeError` a mistyped call produces. The
 * original failure travels as `cause`, because the distinction between absent,
 * unreadable and a directory is the operating system's to make and not this
 * module's to relitigate.
 *
 * @spec §5.10
 */
export class UnreadableDocumentError extends Error {
  /** The path that was refused, as resolved. */
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`no document could be read at ${path}`, { cause });
    this.name = 'UnreadableDocumentError';
    this.path = path;
  }
}

/**
 * What a file's document id is made of.
 *
 * Namespaced so a file and a session that happen to name themselves the same
 * string are two documents and two episodes, rather than one artifact that
 * silently revises the other away.
 *
 * @spec §3.6, §5.10
 */
const FILE_ID_PREFIX = 'file:';

/**
 * A file, as a document.
 *
 * The bytes arrive unchanged — no re-wrapping, no trimming, no line-ending
 * normalization — because §5.10 serves a chunk verbatim and E3 tests a quote
 * against it byte for byte. A source that tidied a CRLF hard wrap or a run of
 * trailing spaces would break quotes the file really does contain, and would
 * break them for the paragraphs it tidied only: the failure mode that looks
 * like a model problem.
 *
 * A file with nothing in it is read and returned like any other. §5.10's door
 * is where a document with nothing to chunk is refused, and one refusal in one
 * place is what keeps the two answers from drifting apart.
 *
 * @spec §3.6, §5.10
 */
export const documentSource = async (options: DocumentSourceOptions): Promise<TextSource> => {
  const path = resolve(options.path);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (failure) {
    throw new UnreadableDocumentError(path, failure);
  }
  return {
    id: `${FILE_ID_PREFIX}${path}`,
    title: options.title ?? basename(path),
    text,
    origin: 'authored',
    anchor: options.anchor,
    provenance: options.provenance,
  };
};
