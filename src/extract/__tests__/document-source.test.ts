/**
 * E4's second source, and the one whose job is to prove the pipeline is not
 * transcript-shaped: a file becomes a {@link TextSource}, and nothing between
 * here and §5.10's queue notices the difference.
 *
 * Same contract as its sibling. It reads, and it returns a value. It chunks
 * nothing, embeds nothing, anchors nothing and writes nothing — `submitText`
 * does all of that, if the caller decides to hand the value over.
 *
 * ── The ruling this file makes: the id is the path, not the content ─────────
 *
 * E2 treats a changed id as a different document entirely, so what the id is
 * made of decides what "the same document, revised" means. This suite pins the
 * **path**, and refuses the content hash, for three reasons:
 *
 * 1. **A content hash makes every edit a new document.** E2's revision story —
 *    re-chunk, enqueue only what moved, keep the episode — is addressed by id.
 *    Under a content hash an edited file arrives as a stranger: a fresh
 *    document, a fresh episode, and every one of its assertions re-mined and
 *    re-corroborated at full strength beside the ones the previous read already
 *    wrote. That is §4.4's independence failure with the editor in the middle,
 *    and it is the same failure `text-ingest.test.ts` already refuses for
 *    transcripts.
 * 2. **A content hash makes testimony decay unreachable.** §5.10 decays
 *    *"members whose spans changed"* and flags *"members whose quotes vanish"* —
 *    both are relations between a document's old chunking and its new one. If
 *    the edited file is a different document, the old one never changes and
 *    never decays; it is simply abandoned, still serving, still contributing.
 * 3. **Nothing is lost.** `content_ref` holds the bytes and every chunk already
 *    carries its own hash, so content identity is recorded where §3.6 puts it.
 *    The id is left to do the one job an id does.
 *
 * The cost is named and accepted: a file that is **moved or renamed** is a new
 * document, and its old id keeps the members mined under it. That is a rename
 * problem, not an identity problem, and the spec has no rename story yet — see
 * the report. The converse cost of the other ruling is worse and is pinned here
 * as a test: two files with byte-identical contents are two documents, because
 * merging them would make the second file's arrival a silent no-op revision and
 * throw its testimony away, where §4.4 wants near-verbatim duplicates
 * *discounted* rather than *disappeared*.
 *
 * ── Title and anchor ────────────────────────────────────────────────────────
 *
 * A title is what a human calls the thing, so it comes off the file's name and
 * survives an edit. An **anchor is not guessed** — §3.6 makes it *"a prior, not
 * an inheritance"* and §5.2 resolves it through the ladder, minting a
 * provisional referent for a noun the graph has never heard. A source that
 * anchored a document at its own filename would mint referents named after
 * files, which is precisely the path-shaped noun source this project threw out.
 *
 * @spec §3.6, §4.4, §5.2, §5.10, §9, §11, §12
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTRACT_JOB_KIND,
  documentSource,
  openTextIngest,
  transcriptSource,
  type DocumentSourceOptions,
  type TextSource,
} from '../index';

import {
  UNKNOWN_ANCHOR,
  drainJobs,
  harnessFor,
  isNamedRefusal,
  refusalFrom,
  type Harness,
} from './fixtures';

import {
  AWKWARD_DOCUMENT,
  CALLER_TITLE,
  CODE_DOCUMENT,
  DOCUMENT_ORIGIN,
  EDITED_DOCUMENT,
  LEDGER_FILE,
  NOTEBOOK_FILE,
  NOUN_NAMED_FILE,
  VERSE_DOCUMENT,
  chunksOfText,
  documentOptions,
  overhaulSession,
  workspace,
  type Workspace,
  MARKED_FILE,
} from './source-fixtures';

/** A path with no file behind it. */
const ABSENT_FILE = 'never-written.md';

/** A file with nothing in it, which is not the same thing as a document with nothing in it. */
const EMPTY_FILE = 'blank.md';

/** A copy of {@link AWKWARD_DOCUMENT} under a second name. @spec §4.4 */
const COPIED_FILE = 'winter-overhaul (copy).md';

/** The stem a title made out of a file's name would carry. */
const NOTEBOOK_STEM = 'winter-overhaul';

let harness: Harness;
let files: Workspace;

beforeEach(() => {
  harness = harnessFor(openTextIngest);
  files = workspace();
});

afterEach(() => {
  harness.close();
  files.close();
});

/** What one call answered with: a source, or the refusal instead of one. */
interface Attempt {
  readonly source?: TextSource | undefined;
  readonly refusal?: unknown;
}

/**
 * Returned rather than matched with `rejects.toThrow`, for the reason
 * `pathway-signature.test.ts` gives: a bare throw assertion is satisfied by the
 * `TypeError` an unwritten export produces, so a refusal for an unrelated reason
 * would look like the refusal under test.
 */
const attempt = async (options: DocumentSourceOptions): Promise<Attempt> => {
  try {
    return { source: await documentSource(options) };
  } catch (refusal) {
    return { refusal };
  }
};

describe('a file is a document, and the document is the file’s bytes', () => {
  it('carries the file’s text unchanged, down to the bytes a normalizer would tidy', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    const source = await documentSource(documentOptions(path));

    expect(source.text).toStrictEqual(AWKWARD_DOCUMENT);
  });

  it('marks the document authored, so §5.10 lets it be mined at all', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    const source = await documentSource(documentOptions(path));
    const receipt = await harness.text.submitText(source);

    expect(source.origin).toStrictEqual('authored');
    expect(receipt.enqueued.length).toStrictEqual(receipt.chunks.length);
    expect(receipt.chunks.length).toBeGreaterThan(1);
  });

  it('carries the provenance of whoever filed it, and nothing it made up', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    const source = await documentSource(documentOptions(path));

    expect(source.provenance).toStrictEqual(DOCUMENT_ORIGIN);
  });

  it('cuts a TypeScript file at its blank lines like any other document, having parsed nothing', async () => {
    const path = files.write('origin.ts', CODE_DOCUMENT);

    const source = await documentSource(documentOptions(path));

    expect(chunksOfText(source.text).map((chunk) => chunk.text)).toStrictEqual([
      'import { z } from "zod";',
      'export const Origin = z.object({ episodeId: z.string().min(1), channel: z.string().min(1) });',
      'export type Origin = z.input<typeof Origin>;',
    ]);
  });

  it('reads a notebook, a source file and a poem into the same shape of source', async () => {
    const sources = await Promise.all([
      documentSource(documentOptions(files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT))),
      documentSource(documentOptions(files.write('origin.ts', CODE_DOCUMENT))),
      documentSource(documentOptions(files.write('tarpaulin.txt', VERSE_DOCUMENT))),
    ]);
    const shapes = sources.map((source) => ({
      origin: source.origin,
      provenance: source.provenance,
      anchor: source.anchor,
      chunks: chunksOfText(source.text).length,
    }));

    expect(shapes.slice(1)).toStrictEqual([shapes[0], shapes[0]]);
  });
});

describe('a document id names the artifact, not what it currently says', () => {
  it('gives the same id on every read of the same file', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    const first = await documentSource(documentOptions(path));
    const second = await documentSource(documentOptions(path));

    expect(second.id).toStrictEqual(first.id);
  });

  it('gives an edited file the id it already had, so a revision is a revision', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);
    const before = await documentSource(documentOptions(path));
    const first = await harness.text.submitText(before);

    files.write(NOTEBOOK_FILE, EDITED_DOCUMENT);
    const after = await documentSource(documentOptions(path));
    const second = await harness.text.submitText(after);

    expect(after.id).toStrictEqual(before.id);
    expect(second.episodeId).toStrictEqual(first.episodeId);
    expect(second.enqueued.length).toStrictEqual(1);
  });

  it('re-reads an untouched file at no cost at all', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    await harness.text.submitText(await documentSource(documentOptions(path)));
    const again = await harness.text.submitText(await documentSource(documentOptions(path)));

    expect(again.enqueued).toStrictEqual([]);
  });

  it('gives two files two ids', async () => {
    const notebook = await documentSource(
      documentOptions(files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT)),
    );
    const ledger = await documentSource(documentOptions(files.write(LEDGER_FILE, VERSE_DOCUMENT)));

    expect(ledger.id).not.toStrictEqual(notebook.id);
  });

  it('gives two files with byte-identical contents two ids, so neither swallows the other', async () => {
    const original = await documentSource(
      documentOptions(files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT)),
    );
    const copy = await documentSource(documentOptions(files.write(COPIED_FILE, AWKWARD_DOCUMENT)));

    const first = await harness.text.submitText(original);
    const second = await harness.text.submitText(copy);

    expect(copy.id).not.toStrictEqual(original.id);
    expect(second.episodeId).not.toStrictEqual(first.episodeId);
    expect(second.enqueued.length).toStrictEqual(second.chunks.length);
  });

  it('does not collide with a session that happens to name itself after the same path', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    const file = await documentSource(documentOptions(path));
    const session = transcriptSource(overhaulSession({ id: path }));

    expect(session.id).not.toStrictEqual(file.id);
  });
});

describe('the title names the file, and the anchor names nothing nobody named', () => {
  it('takes a title from the file’s own name when the caller supplies none', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    const source = await documentSource(documentOptions(path));

    expect(source.title.length).toBeGreaterThan(0);
    expect(source.title).toContain(NOTEBOOK_STEM);
  });

  it('keeps that title after the file is edited, because a title names the artifact', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);
    const before = await documentSource(documentOptions(path));

    files.write(NOTEBOOK_FILE, EDITED_DOCUMENT);
    const after = await documentSource(documentOptions(path));

    expect(after.title).toStrictEqual(before.title);
  });

  it('prefers the title the caller gave it', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    const source = await documentSource(documentOptions(path, { title: CALLER_TITLE }));

    expect(source.title).toStrictEqual(CALLER_TITLE);
  });

  it('guesses no anchor from a filename, so no referent is minted after a file', async () => {
    const path = files.write(NOUN_NAMED_FILE, AWKWARD_DOCUMENT);
    const referentsBefore = harness.ingest.referents.all().length;

    const source = await documentSource(documentOptions(path));
    const receipt = await harness.text.submitText(source);

    expect(source.anchor).toBeUndefined();
    expect(receipt.anchor).toBeUndefined();
    expect(harness.store.getDocument(source.id)?.scope).toBeNull();
    expect(harness.ingest.referents.all().length).toStrictEqual(referentsBefore);
  });

  it('carries an anchor the caller did name, all the way to §5.2’s ladder', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);

    const source = await documentSource(documentOptions(path, { anchor: UNKNOWN_ANCHOR }));
    const receipt = await harness.text.submitText(source);

    expect(source.anchor).toStrictEqual(UNKNOWN_ANCHOR);
    expect(receipt.anchor).toMatchObject({ surfaceForm: UNKNOWN_ANCHOR });
  });
});

describe('a file that is not there, and a file with nothing in it', () => {
  it('refuses a path with no file behind it, by name rather than by crash', async () => {
    const missing = await attempt(documentOptions(join(files.directory, ABSENT_FILE)));

    expect(missing.source).toBeUndefined();
    expect(isNamedRefusal(missing.refusal)).toBe(true);
  });

  it('never lands an empty file as a document with no chunks in it', async () => {
    const path = files.write(EMPTY_FILE, '');

    const empty = await attempt(documentOptions(path));
    const source = empty.source;
    const landed =
      source === undefined ? undefined : await refusalFrom(async () => harness.text.submitText(source));

    const outcome =
      source === undefined
        ? { declinedAt: isNamedRefusal(empty.refusal) ? 'the source' : 'a crash' }
        : { declinedAt: isNamedRefusal(landed) ? 'the door' : 'a crash' };

    expect([{ declinedAt: 'the source' }, { declinedAt: 'the door' }]).toContainEqual(outcome);
    expect(harness.store.getDocument(source?.id ?? EMPTY_FILE)).toBeUndefined();
  });
});

describe('a source is a value, and writes nothing itself', () => {
  it('reads the file, and leaves the file and the store exactly as it found them', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);
    const ledgerBefore = harness.store.listClaimIds();

    const source = await documentSource(documentOptions(path));

    expect(files.read(path)).toStrictEqual(AWKWARD_DOCUMENT);
    expect(harness.store.getDocument(source.id)).toBeUndefined();
    expect(drainJobs(harness.store, EXTRACT_JOB_KIND)).toStrictEqual([]);
    expect(harness.store.listClaimIds()).toStrictEqual(ledgerBefore);
  });
});

describe('one file is one document, however the caller spells the way to it', () => {
  it('gives two spellings of one path one document, and charges for the second read nothing', async () => {
    const path = files.write(NOTEBOOK_FILE, AWKWARD_DOCUMENT);
    const roundabout = join(files.directory, '.', NOTEBOOK_FILE);
    const doubled = `${files.directory}//${NOTEBOOK_FILE}`;

    const direct = await documentSource(documentOptions(path));
    const viaDot = await documentSource(documentOptions(roundabout));
    const viaDoubleSlash = await documentSource(documentOptions(doubled));

    const first = await harness.text.submitText(direct);
    const second = await harness.text.submitText(viaDot);

    expect([viaDot.id, viaDoubleSlash.id]).toStrictEqual([direct.id, direct.id]);
    expect(second.episodeId).toStrictEqual(first.episodeId);
    expect(second.enqueued).toStrictEqual([]);
  });

  it('reads a file whose name is not in ASCII, and names the document after it', async () => {
    const path = files.write(MARKED_FILE, AWKWARD_DOCUMENT);

    const first = await documentSource(documentOptions(path));
    const second = await documentSource(documentOptions(join(files.directory, MARKED_FILE)));

    expect(first.text).toStrictEqual(AWKWARD_DOCUMENT);
    expect(second.id).toStrictEqual(first.id);
    expect(first.title).toContain(MARKED_FILE);
  });
});
