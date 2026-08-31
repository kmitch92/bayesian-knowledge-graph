/**
 * `rebuild-index`: the operation that makes "these are views" a fact rather
 * than a slogan.
 *
 * Diagram §4: *"Claims are the only primitive. Everything on the right is a
 * materialized view, rebuildable from the ledger. No foreign keys point from
 * the ledger onto views."* §3.1 says the same of the referent index
 * specifically — it is *"the materialized clustering of noun mentions into
 * referents, rebuildable from the ledger (`rebuild-index`)"*.
 *
 * The test is blunt on purpose. Grow a graph through the public port; snapshot
 * the three projections — referent index, mention index, containment index —
 * byte for byte; drop all three; rebuild from the claims ledger alone; compare.
 * Anything the projections know that the ledger does not is destroyed by the
 * clear and cannot come back, so a byte-identical result is a proof of
 * derivability and nothing less would be.
 *
 * The rebuild runs on a *freshly constructed* ingest port, so an implementation
 * that kept the index alive in a private field cannot pass by handing back what
 * it never lost.
 *
 * The last section grows the graph past the size one KNN page can enumerate.
 * That is the same claim at a size §16 actually asks for, and it is a separate
 * test because the mixed graph above is small enough that a rebuild which can
 * only see the first page still sees all of it — a suite that only ever
 * rebuilds a dozen referents proves derivability for a dozen referents.
 *
 * @spec §3.1, §3.3, §5.2, §11, §16
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import type { EmbeddingProvider } from '../../store/ports/embedding-provider';
import { openGraphStore, type GraphStore } from '../../store/index';

import {
  RERANK_WIDTH,
  agentOrigin,
  attestationMessage,
  claimMessage,
  containmentMessage,
  emitterOrigin,
  fakeAdjudicator,
  fakeEmbeddings,
  picks,
  retractionMessage,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from './fixtures';

let store: GraphStore;
let embeddings: FakeEmbeddings;
let adjudicator: FakeAdjudicator;
let ingest: IngestPort;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  embeddings = fakeEmbeddings();
  adjudicator = fakeAdjudicator();
  ingest = openIngest({ store, embeddings, adjudicator });
});

afterEach(() => {
  store.close();
});

/**
 * The three projections, serialized in a fixed order.
 *
 * Reads go through the store rather than only through the referents module,
 * because the claim under test is about the *tables*: the entity row (name,
 * level, locator, gloss vector, facet centroids), the mention rows, and the
 * `CONTAINS` edges.
 */
const projections = (port: IngestPort): string =>
  JSON.stringify(
    port.referents
      .all()
      .map((referent) => ({
        referent,
        entity: store.getEntity(referent.id),
        mentions: [...port.referents.mentionsOf(referent.id)].sort(),
        children: [...port.referents.childrenOf(referent.id)].sort(),
        edges: store
          .getStructuralEdges(referent.id)
          .map((edge) => `${edge.kind}:${edge.to}`)
          .sort(),
      }))
      .sort((left, right) => (left.referent.id < right.referent.id ? -1 : 1)),
  );

/** Every claim id in the ledger that any referent points at, so the ledger can be checked untouched. */
const ledgerFingerprint = (port: IngestPort): string =>
  JSON.stringify(
    port.referents
      .all()
      .map((referent) => store.getClaim(referent.existenceClaimId))
      .sort((left, right) => ((left?.id ?? '') < (right?.id ?? '') ? -1 : 1)),
  );

/**
 * A graph with something of every kind in it: a usage-born referent, an
 * attested one, one that changed regime, one carrying three surface forms, one
 * that only a tiebreak could have resolved, and a containment claim.
 */
const growMixedGraph = async (): Promise<void> => {
  for (const n of [1, 2, 3, 4])
    await ingest.submit(
      claimMessage(`AuthService was read in episode ${n}.`, ['AuthService'], {
        origin: agentOrigin(n),
      }),
    );
  await ingest.submit(
    claimMessage('The auth-service rotation window is fifteen minutes.', ['auth-service'], {
      origin: agentOrigin(5),
    }),
  );
  await ingest.submit(
    claimMessage('The auth thing drops idle sockets after a minute.', ['the auth thing'], {
      origin: agentOrigin(6),
    }),
  );

  await ingest.submit(
    claimMessage('The practice survives its own justification.', ['practice'], {
      origin: agentOrigin(7),
    }),
  );
  await ingest.submit(
    containmentMessage('AuthService', 'practice', {
      childLevel: 'module',
      origin: agentOrigin(8),
    }),
  );

  await ingest.submit(
    attestationMessage('LedgerEntry', {
      level: 'component',
      locator: { path: 'ledger/entry', symbolRange: [1, 20] },
      origin: emitterOrigin(9),
    }),
  );

  await ingest.submit(
    attestationMessage('SessionStore', {
      level: 'component',
      locator: { path: 'src/auth/session.ts', symbolRange: [1, 88] },
      origin: emitterOrigin(10),
    }),
  );
  await ingest.submit(retractionMessage('SessionStore', { origin: emitterOrigin(11) }));

  await ingest.submit(
    claimMessage('RetryPolicy caps attempts at three.', ['RetryPolicy'], {
      origin: agentOrigin(12),
    }),
  );
  await ingest.submit(
    claimMessage('RetryBudget is spent per session, not per call.', ['RetryBudget'], {
      origin: agentOrigin(13),
    }),
  );
  adjudicator.answerWith(picks('RetryPolicy'));
  await ingest.submit(
    claimMessage('The retry knob is not a per-call setting.', ['the retry knob'], {
      origin: agentOrigin(14),
    }),
  );
};

describe('clearing the three projections', () => {
  it('empties them', async () => {
    await growMixedGraph();

    store.clearViews();

    const cleared = openIngest({ store, embeddings, adjudicator });
    expect(cleared.referents.all()).toStrictEqual([]);
    expect(store.resolveMention('AuthService')).toBeUndefined();
  });

  it('leaves every claim exactly where it was', async () => {
    await growMixedGraph();
    const before = ledgerFingerprint(ingest);

    store.clearViews();
    await openIngest({ store, embeddings, adjudicator }).rebuildIndex();

    expect(ledgerFingerprint(openIngest({ store, embeddings, adjudicator }))).toBe(before);
  });
});

describe('rebuilding from the claims ledger alone', () => {
  it('reproduces the three projections byte for byte', async () => {
    await growMixedGraph();
    const before = projections(ingest);

    store.clearViews();
    const rebuilt = openIngest({ store, embeddings, adjudicator });
    await rebuilt.rebuildIndex();

    expect(projections(rebuilt)).toBe(before);
  });

  it('re-derives the gloss vectors rather than remembering them', async () => {
    await growMixedGraph();
    store.clearViews();
    const rebuilt = openIngest({ store, embeddings, adjudicator });
    embeddings.forget();

    await rebuilt.rebuildIndex();

    expect(embeddings.calls.length).toBeGreaterThan(0);
  });

  it('is idempotent — rebuilding a rebuilt index changes nothing', async () => {
    await growMixedGraph();
    store.clearViews();
    const rebuilt = openIngest({ store, embeddings, adjudicator });
    await rebuilt.rebuildIndex();
    const once = projections(rebuilt);

    await rebuilt.rebuildIndex();

    expect(projections(rebuilt)).toBe(once);
  });

  it('is a no-op against a live index — rebuilding without clearing changes nothing', async () => {
    await growMixedGraph();
    const before = projections(ingest);

    await ingest.rebuildIndex();

    expect(projections(ingest)).toBe(before);
  });

  it('restores the regime a referent had, not the one its first claim had', async () => {
    await growMixedGraph();

    store.clearViews();
    const rebuilt = openIngest({ store, embeddings, adjudicator });
    await rebuilt.rebuildIndex();

    const byName = new Map(rebuilt.referents.all().map((entry) => [entry.name, entry.regime]));
    expect(byName.get('LedgerEntry')).toBe('view');
    expect(byName.get('SessionStore')).toBe('evidence');
    expect(byName.get('practice')).toBe('evidence');
  });

  it('restores the mention cluster a tiebreak produced, without asking the model again', async () => {
    await growMixedGraph();
    const authService = store.resolveMention('AuthService')!;
    const escalations = adjudicator.requests.length;

    store.clearViews();
    const rebuilt = openIngest({ store, embeddings, adjudicator });
    await rebuilt.rebuildIndex();

    expect(rebuilt.referents.mentionsOf(authService).sort()).toStrictEqual([
      'AuthService',
      'auth-service',
      'the auth thing',
    ]);
    expect(store.resolveMention('the retry knob')).toBe(store.resolveMention('RetryPolicy'));
    expect(adjudicator.requests).toHaveLength(escalations);
  });

  it('restores containment and the level it placed', async () => {
    await growMixedGraph();

    store.clearViews();
    const rebuilt = openIngest({ store, embeddings, adjudicator });
    await rebuilt.rebuildIndex();

    const authService = store.resolveMention('AuthService')!;
    const practice = store.resolveMention('practice')!;
    expect(rebuilt.referents.childrenOf(authService)).toStrictEqual([practice]);
    expect(rebuilt.referents.get(practice)?.level).toBe('module');
  });

  it('keeps serving after the rebuild — the port picks up where it left off', async () => {
    await growMixedGraph();
    store.clearViews();
    const rebuilt = openIngest({ store, embeddings, adjudicator });
    await rebuilt.rebuildIndex();

    const receipt = await rebuilt.submit(
      claimMessage('AuthService rotates its signing key nightly.', ['AuthService'], {
        origin: agentOrigin(20),
      }),
    );

    expect(receipt.resolutions[0]?.rung).toBe('exact');
    expect(receipt.resolutions[0]?.referentId).toBe(store.resolveMention('AuthService'));
  });
});

/*
 * ---------------------------------------------------------------------------
 * A graph too large to enumerate in one ANN page.
 * ---------------------------------------------------------------------------
 */

/**
 * How many rows one KNN query can return.
 *
 * `sqlite-vec` refuses a `k` above this, and a KNN query is the only enumeration
 * the `GraphStore` port offers — there is no `listClaims` and no `listEntities`.
 * A number, not an import: the fix for what this section demonstrates may well
 * delete whatever constant the implementation currently spells it with, and a
 * test that fails to compile is not a test that passed.
 *
 * @spec §11
 */
const ANN_PAGE = 4096;

/**
 * Referents to grow.
 *
 * Above the ceiling on purpose, and chosen at the *claims* end rather than the
 * referents end, because that is where it actually binds. One noun-naming claim
 * costs two ledger rows — the claim itself and the existence claim that minted
 * its referent — so a replay that can only see {@link ANN_PAGE} claims stops
 * being complete at about half that many referents, not at {@link ANN_PAGE} of
 * them. §16's S3 target is 100k claims, which is twenty-four of these pages.
 *
 * Sized for the smallest graph that crosses the ceiling with headroom rather
 * than the largest one the machine will tolerate: the ladder runs a KNN per
 * mint, so growing the graph is quadratic and 2,100 referents is a few seconds
 * where 4,100 is most of a minute. {@link crossesTheCeiling} asserts the
 * crossing happened rather than assuming it, so this number cannot quietly
 * become too small.
 *
 * @spec §11, §16
 */
const BULK_REFERENTS = 2_100;

/** A noun no other noun in this section is near. */
const bulkNoun = (index: number): string => `n${index}`;

/**
 * The vector this section declares for a text.
 *
 * Two non-zero components at unit weight, placed so that any two distinct nouns
 * share at most one dimension and therefore sit at cosine 0.5 or 0 — below
 * §15's `cos_floor`, so every noun mints its own referent and none of them
 * resolves onto a neighbour. Both components land inside the store's 512-wide
 * ANN slice, since a vector whose mass sits beyond that slice has no cosine to
 * anything.
 *
 * The pairing is `{a, a + d mod 512}` with `d` in 1..255, which is injective on
 * unordered pairs: two offsets collide only when `d' = 512 − d`, and 512 − d is
 * above 255 for every `d` this uses.
 *
 * @spec §11, §15
 */
const bulkVector = (text: string): Float32Array => {
  const noun = /^n(\d+)$/.exec(text);
  const index = noun === null ? 130_000 + (text.length % 500) : Number(noun[1]);
  const first = index % 512;
  const second = (first + 1 + Math.floor(index / 512)) % 512;
  const vector = new Float32Array(RERANK_WIDTH);
  const weight = Math.fround(Math.SQRT1_2);
  vector[first] = weight;
  vector[second] = weight;
  return vector;
};

/** @spec §11 */
const bulkEmbeddings: EmbeddingProvider = {
  modelId: 'orthogonal-pairs@768',
  dimensions: RERANK_WIDTH,
  embed: (text) => Promise.resolve(bulkVector(text)),
  embedBatch: (texts) => Promise.resolve(texts.map(bulkVector)),
};

/** Every referent id the index currently holds, in a stable order. */
const referentIds = (port: IngestPort): string[] =>
  port.referents
    .all()
    .map((referent) => referent.id)
    .sort();

describe('a graph with more referents than one ANN page holds', () => {
  /**
   * Grows {@link BULK_REFERENTS} referents through the public port, one noun per
   * claim, one claim per episode, and hands back what the port said it wrote.
   */
  const growBulkGraph = async (port: IngestPort): Promise<{ referents: string[]; rows: Set<string> }> => {
    const referents: string[] = [];
    const rows = new Set<string>();
    for (let index = 0; index < BULK_REFERENTS; index += 1) {
      const noun = bulkNoun(index);
      const receipt = await port.submit(
        claimMessage(`${noun} was seen.`, [noun], { origin: agentOrigin(index) }),
      );
      const resolution = receipt.resolutions[0];
      if (resolution === undefined) throw new Error(`no resolution for ${noun}`);
      if (resolution.rung !== 'minted')
        throw new Error(`${noun} resolved at rung ${resolution.rung}; the nouns are not distinct`);
      referents.push(resolution.referentId);
      if (receipt.claimId !== undefined) rows.add(receipt.claimId);
    }
    for (const id of referents) {
      const referent = port.referents.get(id);
      if (referent === undefined) throw new Error(`the index holds no row for ${id}`);
      rows.add(referent.existenceClaimId);
    }
    return { referents, rows };
  };

  /**
   * The guard that stops this section passing for the wrong reason.
   *
   * Every id here came out of the port's own receipts, so it counts ledger rows
   * without a `listClaims` the port does not have. If a future write path spends
   * fewer rows per referent, this fails loudly rather than letting the graph
   * shrink back under the ceiling and the invariant below hold vacuously.
   */
  const crossesTheCeiling = (rows: Set<string>): void => {
    expect(rows.size).toBeGreaterThan(ANN_PAGE);
  };

  it(
    'rebuilds every referent it was holding, not the first page of them',
    async () => {
      const growing = openIngest({ store, embeddings: bulkEmbeddings, adjudicator });
      const { referents, rows } = await growBulkGraph(growing);
      crossesTheCeiling(rows);
      const before = referentIds(growing);
      expect(before).toStrictEqual([...referents].sort());

      store.clearViews();
      const rebuilt = openIngest({ store, embeddings: bulkEmbeddings, adjudicator });
      await rebuilt.rebuildIndex();

      const after = referentIds(rebuilt);
      expect(after).toHaveLength(before.length);
      expect(after).toStrictEqual(before);
    },
    120_000,
  );
});
