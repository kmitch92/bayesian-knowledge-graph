/**
 * What a half-finished ingest leaves behind, and why re-running does not fix it.
 *
 * §5.10 makes ingest cheap and extraction lazy, which means the queue *is* the
 * promise: a chunk is stored now on the understanding that a job parked beside
 * it will mine the paragraph later. `submitText` breaks that promise in two
 * ways, and both are silent.
 *
 * **A partial write is permanent.** The document row, one chunk row per
 * paragraph and one queue row per changed chunk are separate calls, so a store
 * that stops answering partway through commits everything it reached and drops
 * everything it did not. Measured under six concurrent `kgmem ingest`
 * processes: `chunks=7 jobs=0` beside siblings that got `chunks=8 jobs=8`. The
 * re-run exits zero and reports success — and parks nothing, because a job is
 * parked for a chunk *whose anchor the previous chunking did not hold*, and
 * those seven anchors are now held. Three retries later it is still seven
 * chunks and no jobs, and nothing anywhere reports it.
 *
 * **A shrinking revision can kill a valid job with no contention at all.** A
 * re-chunk with fewer paragraphs deletes the document row and rewrites it as a
 * separate call, and `extraction.ts` reads `getDocument` on the way into every
 * job: finding nothing, it calls `park`, which is terminal and never retried. A
 * drain whose read lands between the delete and the rewrite loses that job
 * outright. The window is microseconds and the loss is forever.
 *
 * ── What the tests here are allowed to use ──────────────────────────────────
 *
 * The store is real SQLite throughout. Two instruments reach inside it, both
 * already established in this repo:
 *
 * 1. **A decorator over a real store**, used in exactly one place — the ingest
 *    that has to be refused partway. It delegates everything and refuses
 *    `submitDocument` with the store's own {@link StoreBusyError}, which is what
 *    a second process holding the write lock produces. Standing a whole store up
 *    as a fake would prove nothing; refusing one method of a real one is the
 *    contention, arranged.
 * 2. **Real triggers through a second connection**, `transaction-rollback.test.ts`'s
 *    technique, in both of its modes: as an *observer* of every row deleted from
 *    `documents`, and as a *fault* that refuses the rewrite. The second is what
 *    makes defect two deterministic — an injected refusal of the rewrite leaves
 *    exactly the state the microsecond window leaves, and it leaves it long
 *    enough to assert against.
 *
 * The embedding provider is scripted rather than replaced: it is already a faked
 * port here, and it is also the only *suspension point* `submitText` has. A hook
 * that runs inside its `await` is how a second writer and a drain get to
 * interleave with an ingest in one process, deterministically, with no timing in
 * it anywhere.
 *
 * @spec §3.6, §5.3, §5.7, §5.10, §9, §11, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COSINE_FLOOR,
  TAU_PROMOTE,
  fakeAdjudicator,
  fakeEmbeddings,
  type FakeEmbeddings,
} from '../../referents/__tests__/fixtures';
import { StoreBusyError, openGraphStore, type GraphStore } from '../../store/index';

import {
  EXTRACT_JOB_KIND,
  chunkText,
  openExtraction,
  openTextIngest,
  type ExtractionPort,
  type TextIngestPort,
} from '../index';

import { fakeExtractor, type FakeExtractor } from './extraction-fixtures';
import {
  DOCUMENT_ID,
  EDITS,
  PARAGRAPH_BREAK,
  SHORT_PARAGRAPHS,
  drainJobs,
  editParagraph,
  notebook,
  notebookParagraph,
  refusalFrom,
  textSource,
} from './fixtures';

/** The document before a shrinking revision, in paragraphs. */
const BEFORE_SHRINK = 12;

/** The document after it. */
const AFTER_SHRINK = 4;

/** The paragraph a revision rewrites, chosen to survive the shrink. */
const EDITED_AT = 1;

/** The document the stale-read case starts from, small enough to read the whole drain. */
const STALE_PARAGRAPHS = 3;

/** The wait a contended `submitDocument` would have given up after. @spec §5.7 */
const REFUSED_AFTER_MS = 250;

/**
 * The embedding provider, with two things scripted onto it.
 *
 * Both exist because `embedBatch` is where `submitText` gives up the thread: it
 * is the longest wall-clock call in the path, it sits between the read that
 * decides what to enqueue and the writes that act on it, and it is a port this
 * suite already fakes. Narrowing a batch makes a later `putChunk` refuse for a
 * real reason (§5.3's width, asserted by the store); running a hook inside one
 * lets another writer and a drain interleave with an ingest deterministically.
 *
 * @spec §5.3, §11
 */
interface ScriptedEmbeddings extends FakeEmbeddings {
  /** Makes the next batch come back one component short of the stored width. */
  narrowNextBatch(): void;
  /** Runs `hook` inside the next batch, before it answers. */
  duringNextBatch(hook: () => Promise<void>): void;
}

/** @spec §5.3, §11 */
const scriptedEmbeddings = (): ScriptedEmbeddings => {
  const base = fakeEmbeddings();
  let narrow = false;
  let hook: (() => Promise<void>) | undefined;
  return {
    ...base,
    embedBatch: async (texts, task) => {
      const during = hook;
      hook = undefined;
      if (during !== undefined) await during();
      const vectors = await base.embedBatch(texts, task);
      if (!narrow) return vectors;
      narrow = false;
      return vectors.map((vector) => vector.slice(0, vector.length - 1));
    },
    narrowNextBatch: () => {
      narrow = true;
    },
    duringNextBatch: (next) => {
      hook = next;
    },
  };
};

/**
 * A real store that refuses one method.
 *
 * A `Proxy` rather than a hand-written stand-in, so every other method is the
 * real store's — bound to the real store, because the methods behind them read
 * private fields and a receiver that is not the instance cannot see them. What
 * it stands in for is a second process holding the write lock at the moment the
 * submission opens its transaction, which is the failure the queue-row loss was
 * measured under.
 *
 * @spec §5.7, §11, §12
 */
const refusingSubmissions = (store: GraphStore, refusing: () => boolean): GraphStore =>
  new Proxy(store, {
    get: (target, property: string | symbol) => {
      if (property === 'submitDocument' && refusing())
        return () => {
          throw new StoreBusyError('submitDocument', REFUSED_AFTER_MS);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

/** A real store on disk, the two write surfaces over it, and the ports they need. */
interface Harness {
  /** The real store, never the decorated one: every assertion reads through this. */
  readonly store: GraphStore;
  /** Ingest, over a store that refuses submissions while {@link Harness.refuseSubmissions} is in force. */
  readonly text: TextIngestPort;
  /** A second ingest port over the same store, for the writer that is not this one. */
  readonly other: TextIngestPort;
  readonly extraction: ExtractionPort;
  readonly extractor: FakeExtractor;
  readonly embeddings: ScriptedEmbeddings;
  /** A second connection, for the triggers that watch and the triggers that refuse. */
  readonly control: Database.Database;
  refuseSubmissions(): void;
  acceptSubmissions(): void;
  close(): void;
}

let directory: string;
let harness: Harness;

/** @spec §5.2, §5.3, §5.10, §11 */
const openHarness = (): Harness => {
  const store = openGraphStore({ path: join(directory, 'graph.db') });
  const embeddings = scriptedEmbeddings();
  const adjudicator = fakeAdjudicator();
  const extractor = fakeExtractor();
  const ports = { store, embeddings, adjudicator, cosineFloor: COSINE_FLOOR, tauPromote: TAU_PROMOTE };
  let refusing = false;
  return {
    store,
    text: openTextIngest({ ...ports, store: refusingSubmissions(store, () => refusing) }),
    other: openTextIngest({ ...ports, embeddings: fakeEmbeddings() }),
    extraction: openExtraction({ ...ports, extractor }),
    extractor,
    embeddings,
    control: new Database(join(directory, 'graph.db')),
    refuseSubmissions: () => {
      refusing = true;
    },
    acceptSubmissions: () => {
      refusing = false;
    },
    close: () => {
      store.close();
    },
  };
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-mcp-partial-write-'));
  harness = openHarness();
});

afterEach(() => {
  harness.control.close();
  harness.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Ingests a text under the document id. @spec §5.10 */
const submit = async (text: string) => harness.text.submitText(textSource({ text }));

/** The document's chunks as (ordinal, anchor) pairs, in the order the store served them. @spec §3.6 */
const chunkPairs = (): (readonly [number, string])[] =>
  harness.store.getChunks(DOCUMENT_ID).map((chunk) => [chunk.ordinal, chunk.hash] as const);

/** The paragraphs the drain handed the model, in the order it handed them over. @spec §5.10 */
const paragraphsMined = (): string[] =>
  harness.extractor.requests.map((request) => request.chunkText);

/**
 * The paragraphs the embedding provider was asked for since its log was dropped.
 *
 * The texts and not the count, for `revision-cost.test.ts`' reason: an ingest
 * that embedded the right *number* of the wrong paragraphs would spend the same
 * budget to store the wrong geometry.
 *
 * @spec §5.3
 */
const embeddedSince = (): string[] => harness.embeddings.calls.map((call) => call.text);

/** More jobs than any fixture here parks, so a drain that never empties fails loudly. */
const DRAIN_CEILING = 1_000;

/** Works every due extraction job, so nothing below asserts against a queue still holding work. @spec §9 */
const drainEverything = async (): Promise<void> => {
  for (let i = 0; i < DRAIN_CEILING; i += 1)
    if ((await harness.extraction.drainOnce()) === undefined) return;
  throw new Error('the extraction drain never emptied');
};

/** How each of those jobs ended. @spec §9 */
const statesOf = (jobIds: readonly number[]): (string | undefined)[] => [
  ...new Set(jobIds.map((id) => harness.store.getJob(id)?.state)),
];

/**
 * Which paragraph each parked job names, in the order they were parked.
 *
 * A receipt's `enqueued` holds queue row ids, and a row id is an accident of how
 * much work the queue has held before. What the assertions below are about is
 * *which paragraphs* got a job, so they read that back off the payload the drain
 * will read.
 *
 * @spec §5.10, §9
 */
const ordinalsParked = (jobIds: readonly number[]): unknown[] =>
  jobIds.map(
    (id) => (harness.store.getJob(id)?.payload as { ordinal?: unknown } | undefined)?.ordinal,
  );

describe('an ingest the store refuses partway through', () => {
  beforeEach(() => {
    harness.refuseSubmissions();
  });

  it('leaves no document and no chunk, so there is nothing for a retry to mistake for work already done', async () => {
    const refusal = await refusalFrom(() => submit(notebook(SHORT_PARAGRAPHS)));

    expect({
      refusal: (refusal as Error | undefined)?.name,
      document: harness.store.getDocument(DOCUMENT_ID),
      chunks: chunkPairs(),
    }).toStrictEqual({ refusal: 'StoreBusyError', document: undefined, chunks: [] });
  });

  it('makes the retry a first ingest, which parks one job for every paragraph', async () => {
    const refusal = await refusalFrom(() => submit(notebook(SHORT_PARAGRAPHS)));
    harness.acceptSubmissions();

    const receipt = await submit(notebook(SHORT_PARAGRAPHS));

    expect({
      refusal: (refusal as Error | undefined)?.name,
      parked: receipt.enqueued.length,
      chunks: receipt.chunks.length,
    }).toStrictEqual({
      refusal: 'StoreBusyError',
      parked: SHORT_PARAGRAPHS,
      chunks: SHORT_PARAGRAPHS,
    });
  });

  it('and those jobs are on the queue, where the refused ingest left none at all', async () => {
    const refusal = await refusalFrom(() => submit(notebook(SHORT_PARAGRAPHS)));
    const stranded = drainJobs(harness.store, EXTRACT_JOB_KIND).length;
    harness.acceptSubmissions();

    await submit(notebook(SHORT_PARAGRAPHS));

    expect({
      refusal: (refusal as Error | undefined)?.name,
      stranded,
      queued: drainJobs(harness.store, EXTRACT_JOB_KIND).length,
    }).toStrictEqual({ refusal: 'StoreBusyError', stranded: 0, queued: SHORT_PARAGRAPHS });
  });

  it('leaves a document it already held exactly as it was, so the retry still parks only what changed', async () => {
    const before = notebook(SHORT_PARAGRAPHS);
    const after = editParagraph(before, EDITED_AT, EDITS[0]!);
    harness.acceptSubmissions();
    await submit(before);
    drainJobs(harness.store, EXTRACT_JOB_KIND);
    harness.refuseSubmissions();

    const refusal = await refusalFrom(() => submit(after));
    const held = chunkPairs();
    harness.acceptSubmissions();
    const receipt = await submit(after);

    expect({
      refusal: (refusal as Error | undefined)?.name,
      held,
      parked: ordinalsParked(receipt.enqueued),
    }).toStrictEqual({
      refusal: 'StoreBusyError',
      held: chunkText(before).map((view) => [view.ordinal, view.hash] as const),
      parked: [EDITED_AT],
    });
  });
});

describe('an ingest nothing interrupted', () => {
  it('parks nothing when it is re-run unchanged, which is what a retry must not be able to buy back', async () => {
    await submit(notebook(SHORT_PARAGRAPHS));
    drainJobs(harness.store, EXTRACT_JOB_KIND);

    const receipt = await submit(notebook(SHORT_PARAGRAPHS));

    expect({
      parked: receipt.enqueued,
      queue: drainJobs(harness.store, EXTRACT_JOB_KIND),
    }).toStrictEqual({ parked: [], queue: [] });
  });
});

describe('a shrinking revision', () => {
  /** Starts recording every row deleted from `documents`. @spec §3.6 */
  const watchDocumentDeletions = (): void => {
    harness.control.exec('CREATE TABLE probe_document_deletions (id TEXT NOT NULL)');
    harness.control.exec(
      `CREATE TRIGGER probe_document_delete AFTER DELETE ON documents
         BEGIN INSERT INTO probe_document_deletions (id) VALUES (old.id); END`,
    );
  };

  /** Every document row deleted since the watch was installed. @spec §3.6 */
  const documentDeletions = (): string[] =>
    harness.control
      .prepare('SELECT id FROM probe_document_deletions ORDER BY rowid')
      .all()
      .map((row) => (row as { id: string }).id);

  /** Refuses the rewrite of this document, as a real constraint would. @spec §3.6, §11 */
  const failDocumentRewrite = (): void => {
    harness.control.exec(
      `CREATE TRIGGER fail_document_rewrite BEFORE INSERT ON documents WHEN NEW.id = '${DOCUMENT_ID}'
         BEGIN SELECT RAISE(ABORT, 'injected document rewrite failure'); END`,
    );
  };

  /** Lifts it, so the drain below runs against a store with nothing injected into it. @spec §11 */
  const stopFailingDocumentRewrite = (): void => {
    harness.control.exec('DROP TRIGGER fail_document_rewrite');
  };

  it('that is refused leaves the document it already had, rather than the fragment it got to', async () => {
    await submit(notebook(BEFORE_SHRINK));
    const held = chunkPairs();
    harness.embeddings.narrowNextBatch();

    const refusal = await refusalFrom(() =>
      submit(editParagraph(notebook(AFTER_SHRINK), EDITED_AT, EDITS[0]!)),
    );

    expect({ refusal: (refusal as Error | undefined)?.name, chunks: chunkPairs() }).toStrictEqual({
      refusal: 'DimensionMismatchError',
      chunks: held,
    });
  });

  it('never deletes the document row on its way to dropping chunks, so no reader finds the document missing', async () => {
    await submit(notebook(BEFORE_SHRINK));
    watchDocumentDeletions();

    await submit(notebook(AFTER_SHRINK));

    expect({
      deleted: documentDeletions(),
      document: harness.store.getDocument(DOCUMENT_ID)?.id,
      chunks: chunkPairs().length,
    }).toStrictEqual({ deleted: [], document: DOCUMENT_ID, chunks: AFTER_SHRINK });
  });

  it('loses no parked job when its own rewrite is refused, since a drain that finds no document parks for good', async () => {
    const first = await submit(notebook(BEFORE_SHRINK));
    failDocumentRewrite();

    const refusal = await refusalFrom(() => submit(notebook(AFTER_SHRINK)));
    stopFailingDocumentRewrite();
    await drainEverything();

    expect({
      refused: refusal !== undefined,
      document: harness.store.getDocument(DOCUMENT_ID)?.id,
      states: statesOf(first.enqueued),
    }).toStrictEqual({ refused: true, document: DOCUMENT_ID, states: ['done'] });
  });
});

describe('an ingest whose document another writer revised while it was embedding', () => {
  /**
   * The interleaving, in the one window this path actually has.
   *
   * `submitText` reads the chunks a document already holds *before* it awaits
   * anything, and uses that read to decide which paragraphs still need a job.
   * The hook runs inside the embedding call that follows, so by the time the
   * writes happen the read is as stale as a model call is long — which is the
   * longest anything in this path takes.
   *
   * What the other writer does is an ordinary shrinking revision through an
   * ordinary ingest port, and what the drain does is take the jobs that revision
   * invalidated. Neither is contrived: they are the two things most likely to be
   * happening while a 3,000-word document is being embedded.
   *
   * @spec §5.3, §5.10, §9
   */
  const shrinkAndDrainMidEmbedding = (): void => {
    harness.embeddings.duringNextBatch(async () => {
      await harness.other.submitText(textSource({ text: notebook(STALE_PARAGRAPHS - 1) }));
      await drainEverything();
    });
  };

  it('parks a job for the paragraph that revision dropped, because this ingest is what put it back', async () => {
    await submit(notebook(STALE_PARAGRAPHS));
    shrinkAndDrainMidEmbedding();

    const receipt = await submit(
      `${notebook(STALE_PARAGRAPHS)}${PARAGRAPH_BREAK}${notebookParagraph(STALE_PARAGRAPHS)}`,
    );

    expect(ordinalsParked(receipt.enqueued)).toStrictEqual([STALE_PARAGRAPHS - 1, STALE_PARAGRAPHS]);
  });

  it('so every paragraph it stored is one the model is eventually handed', async () => {
    await submit(notebook(STALE_PARAGRAPHS));
    shrinkAndDrainMidEmbedding();
    await submit(
      `${notebook(STALE_PARAGRAPHS)}${PARAGRAPH_BREAK}${notebookParagraph(STALE_PARAGRAPHS)}`,
    );
    harness.extractor.forget();

    await drainEverything();

    expect(paragraphsMined()).toStrictEqual([
      notebookParagraph(STALE_PARAGRAPHS - 1),
      notebookParagraph(STALE_PARAGRAPHS),
    ]);
  });

  /**
   * The other half of the asymmetry, and the reason it is deliberate.
   *
   * The enqueue decision re-reads after the awaits because "which anchors did
   * this document already hold" goes stale in a way that costs a paragraph its
   * only chance of being mined. The *geometry* keeps the earlier read on purpose:
   * a vector another writer deleted mid-embedding is still the right vector for
   * that text, and re-deriving it from the fresh read would drop it — storing the
   * chunk with no embedding and buying a re-embed on the next ingest that §5.3's
   * budget says it should never need.
   *
   * So this is the geometry side stated in the currency §5.3 is measured in:
   * after the interleaving above, an unchanged re-ingest still spends nothing.
   *
   * @spec §5.3, §5.10
   */
  it('and re-ingesting it unchanged still embeds nothing, because the geometry kept the read the enqueue decision discarded', async () => {
    const revised = `${notebook(STALE_PARAGRAPHS)}${PARAGRAPH_BREAK}${notebookParagraph(STALE_PARAGRAPHS)}`;
    await submit(notebook(STALE_PARAGRAPHS));
    shrinkAndDrainMidEmbedding();
    await submit(revised);
    harness.embeddings.forget();

    await submit(revised);

    expect(embeddedSince()).toStrictEqual([]);
  });
});
