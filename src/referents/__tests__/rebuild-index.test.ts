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
 * One entity row, minus the single field a rebuild does not reconstruct.
 *
 * §9 makes §3.1's facet centroids an *online* summary: moved O(1) per attached
 * claim, with re-clustering handed to a calendar clock. `rebuild-index`
 * therefore neither replays them — an incremental mean run over the ledger
 * would bake in an arrival order the ledger does not record — nor clears them,
 * so a cleared index comes back with no facet geometry and re-earns it as
 * claims re-attach. That is the design, not a gap, and it is the one thing the
 * byte-for-byte comparison below cannot assert.
 *
 * Dropped by *name* rather than by listing the fields kept. A field list stops
 * guarding every entity column added after the day it was written, and the
 * whole point of this snapshot is to notice a rebuild that quietly drops
 * something; naming the exclusion keeps every present and future field under
 * the comparison and leaves exactly one hole — which the test sitting directly
 * beneath the byte-for-byte comparison closes, by asserting that the excluded
 * field was populated before the clear and comes back empty after it.
 *
 * @spec §3.1, §9
 */
const rebuildableEntity = (referentId: string): unknown => {
  const entity = store.getEntity(referentId);
  if (entity === undefined) return undefined;
  const { facets: _facets, ...rebuildable } = entity;
  return rebuildable;
};

/**
 * The three projections, serialized in a fixed order.
 *
 * Reads go through the store rather than only through the referents module,
 * because the claim under test is about the *tables*: the entity row (name,
 * level, locator, gloss vector — but not the facet centroids, for the reason
 * {@link rebuildableEntity} gives), the mention rows, and the `CONTAINS` edges.
 */
const projections = (port: IngestPort): string =>
  JSON.stringify(
    port.referents
      .all()
      .map((referent) => ({
        referent,
        entity: rebuildableEntity(referent.id),
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

  it('brings back no facet geometry — the one field the comparison above excludes', async () => {
    await growMixedGraph();
    const grown = ingest.referents.all().map((referent) => store.getEntity(referent.id)?.facets);
    expect(grown.filter((facets) => facets !== undefined && facets.length > 0)).not.toStrictEqual(
      [],
    );

    store.clearViews();
    const rebuilt = openIngest({ store, embeddings, adjudicator });
    await rebuilt.rebuildIndex();

    expect(
      rebuilt.referents.all().map((referent) => store.getEntity(referent.id)?.facets),
    ).toStrictEqual(rebuilt.referents.all().map(() => []));
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
 * The name a rebuild derives.
 * ---------------------------------------------------------------------------
 *
 * §3.1 makes `entities.name` *"the most-corroborated surface form, a view over
 * its mention cluster — never authoritative"*. That is a claim about the ledger,
 * and `rebuild-index` is the check on it: if "most corroborated" is something
 * only the mention index knows, the name is not derivable, and diagram §4's
 * *"everything on the right is a materialized view, rebuildable from the
 * ledger"* is false for the one entity field §3.1 spends a sentence defining.
 *
 * The byte-for-byte fixture above does not catch that, and the reason is an
 * accident of arithmetic rather than a gap in what it compares.
 * {@link growMixedGraph} names `AuthService` four times and each of its two
 * aliases once, so the minting form leads the tally before the rebuild — and it
 * still leads after a rebuild that has flattened every count to one, because a
 * flat tally is broken by first-naming order and the minting form is always
 * named first. The projections come back identical because the *winner* never
 * moved, not because the corroboration behind it survived.
 *
 * Every fixture below arranges for the minting form to lose. That is where the
 * two answers come apart, and it is also the condition under which a rebuild
 * has to re-derive the name at all: while the replayed tally is flat, the
 * minting form is both the first thing written and the thing that wins, so a
 * rebuild that never re-derived anything would agree with one that did.
 *
 * @spec §3.1, §4.2, §4.4, §11
 */

/**
 * What §3.1's derivation is a function of: the name, and the whole ranking
 * behind it rather than only its head.
 *
 * The ranking travels as surface forms and not as counts on purpose. Whether a
 * referent records "better corroborated" as a counter, as a posterior, or as
 * nothing at all until read time is the write path's business; a test that read
 * an `n` would be pinning today's storage shape instead of §3.1's rule.
 *
 * @spec §3.1
 */
interface NamingView {
  readonly name: string;
  /** Every surface form, most-corroborated first. @spec §3.1 */
  readonly forms: readonly string[];
}

/** @spec §3.1 */
const naming = (port: IngestPort, referentId: string): NamingView => {
  const referent = port.referents.get(referentId);
  if (referent === undefined) throw new Error(`the index holds no row for ${referentId}`);
  return { name: referent.name, forms: port.referents.mentionsOf(referentId) };
};

/**
 * Drops the three projections and regenerates them through a port that never
 * watched the graph grow.
 *
 * @spec §3.1, §11
 */
const rebuiltFromLedger = async (): Promise<IngestPort> => {
  store.clearViews();
  const rebuilt = openIngest({ store, embeddings, adjudicator });
  await rebuilt.rebuildIndex();
  return rebuilt;
};

/** The referent a form names, or a failure loud enough to read. */
const referentNamed = (surfaceForm: string): string => {
  const referentId = store.resolveMention(surfaceForm);
  if (referentId === undefined) throw new Error(`nothing is named ${surfaceForm}`);
  return referentId;
};

/**
 * A referent minted under one surface form and then named, in four further
 * episodes, by a different one.
 *
 * The minting form is deliberately the loser. One naming against four is not a
 * close call under any reading of "most-corroborated", which is what makes the
 * derived name a fact the ledger either does or does not record.
 *
 * @spec §3.1, §4.4
 */
const growLopsidedNaming = async (): Promise<string> => {
  await ingest.submit(
    claimMessage('Chapter Three argues that the regress terminates.', ['Chapter Three'], {
      origin: agentOrigin(1),
    }),
  );
  for (const n of [2, 3, 4, 5])
    await ingest.submit(
      claimMessage(`The third chapter was cited again in episode ${n}.`, ['the third chapter'], {
        origin: agentOrigin(n),
      }),
    );
  return referentNamed('Chapter Three');
};

/**
 * How many times one episode repeats a single form.
 *
 * Larger than {@link INDEPENDENT_EPISODES} by enough that a raw count and an
 * episode-capped one cannot agree: §4.2's ½, ¼, … series sums to under two
 * however long the session runs, so twelve repetitions inside one episode are
 * worth less than four namings in four.
 *
 * @spec §4.2, §4.4
 */
const REPEATS_IN_ONE_EPISODE = 12;

/** How many separate episodes name the rival form. One naming each. @spec §4.4 */
const INDEPENDENT_EPISODES = [3, 4, 5, 6] as const;

/**
 * One referent, named by two rival forms: one repeated inside a single episode,
 * one used once in each of four.
 *
 * §4.4 is what makes "most-corroborated" mean anything at all — *"an agent
 * saying something three times in one session is one observation, not three"*.
 * A naming is evidence about what a referent is called, so it is subject to the
 * same cap; without it, the derived name is decided by whoever typed the most,
 * and the ranking is a transcript statistic rather than a belief.
 *
 * @spec §3.1, §4.2, §4.4
 */
const growCappedNaming = async (): Promise<string> => {
  await ingest.submit(
    claimMessage('AuthService owns the rotation window.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  for (let repeat = 0; repeat < REPEATS_IN_ONE_EPISODE; repeat += 1)
    await ingest.submit(
      claimMessage(`Note ${repeat}: auth-service came up again.`, ['auth-service'], {
        origin: agentOrigin(2),
      }),
    );
  for (const n of INDEPENDENT_EPISODES)
    await ingest.submit(
      claimMessage(`The auth thing surfaced in episode ${n}.`, ['the auth thing'], {
        origin: agentOrigin(n),
      }),
    );
  return referentNamed('AuthService');
};

/** The two forms {@link growTiedNaming} corroborates equally. @spec §3.1 */
const TIED_FORMS = ['auth-service', 'the auth thing'] as const;

/**
 * One referent whose two aliases are corroborated identically — two episodes
 * each — and both better than the form it was minted under.
 *
 * A tie has to resolve *somehow*, and this suite deliberately does not say how:
 * first-naming order, claim id, and creation instant are all defensible, and
 * choosing one here would pin an implementation detail. What is not negotiable
 * is that the rebuilt index resolves it the same way the grown one did, since a
 * tiebreak that reads differently after a rebuild is a graph that changed its
 * mind about its own name for no reason anyone recorded.
 *
 * @spec §3.1, §11
 */
const growTiedNaming = async (): Promise<string> => {
  await ingest.submit(
    claimMessage('AuthService owns the rotation window.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  for (const n of [2, 3])
    await ingest.submit(
      claimMessage(`Note from episode ${n}: auth-service again.`, ['auth-service'], {
        origin: agentOrigin(n),
      }),
    );
  for (const n of [4, 5])
    await ingest.submit(
      claimMessage(`The auth thing surfaced in episode ${n}.`, ['the auth thing'], {
        origin: agentOrigin(n),
      }),
    );
  return referentNamed('AuthService');
};

describe('the name a rebuild derives', () => {
  it('is still the most-corroborated form when the minting form is not it', async () => {
    const referentId = await growLopsidedNaming();
    const before = naming(ingest, referentId);
    expect(before).toStrictEqual({
      name: 'the third chapter',
      forms: ['the third chapter', 'Chapter Three'],
    });

    const rebuilt = await rebuiltFromLedger();

    expect(naming(rebuilt, referentId)).toStrictEqual(before);
  });

  it('ranks four independent namings above twelve inside one episode', async () => {
    const referentId = await growCappedNaming();

    const before = naming(ingest, referentId);

    expect(before.name).toBe('the auth thing');
    expect(before.forms.indexOf('the auth thing')).toBeLessThan(
      before.forms.indexOf('auth-service'),
    );
  });

  it('keeps that ranking through a rebuild', async () => {
    const referentId = await growCappedNaming();
    const before = naming(ingest, referentId);

    const rebuilt = await rebuiltFromLedger();

    expect(naming(rebuilt, referentId)).toStrictEqual(before);
  });

  it('breaks a tie between two forms the same way before and after a rebuild', async () => {
    const referentId = await growTiedNaming();
    const before = naming(ingest, referentId);
    expect(TIED_FORMS).toContain(before.name);

    const rebuilt = await rebuiltFromLedger();

    expect(naming(rebuilt, referentId)).toStrictEqual(before);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A referent attested, withdrawn, and attested again.
 * ---------------------------------------------------------------------------
 */

/**
 * The one lifecycle shape {@link growMixedGraph} never produces: a *live* view
 * claim that is older than a *retired* evidence claim.
 *
 * A source attests, withdraws — which retires the attestation and writes an
 * ordinary evidence-regime successor (§6.2) — and then attests again. The
 * re-attestation lands on the same content-addressed claim id it minted the
 * first time and reinstates it, and the successor is retired in turn. The
 * ledger is left holding an active view claim at the older instant and a
 * deprecated evidence claim at the newer one.
 *
 * That ordering is what makes §6.1's status a load-bearing input to a replay
 * rather than a decoration: a rebuild that walks the ledger in creation order
 * and lets the last claim win reads the regime off the retired one, and the
 * entity row then says `evidence` while every read that goes through the
 * standing claim says `view`. Two answers to one question, from one database.
 *
 * @spec §6.1, §6.2, §11
 */
const growReattestedReferent = async (): Promise<string> => {
  const declared = {
    level: 'component',
    locator: { path: 'src/auth/session.ts', symbolRange: [1, 88] },
  } as const;
  await ingest.submit(attestationMessage('SessionStore', { ...declared, origin: emitterOrigin(1) }));
  await ingest.submit(retractionMessage('SessionStore', { origin: emitterOrigin(2) }));
  await ingest.submit(attestationMessage('SessionStore', { ...declared, origin: emitterOrigin(3) }));
  return referentNamed('SessionStore');
};

describe('rebuilding a referent that was attested, withdrawn, and attested again', () => {
  it('reproduces the three projections byte for byte', async () => {
    await growReattestedReferent();
    const before = projections(ingest);

    const rebuilt = await rebuiltFromLedger();

    expect(projections(rebuilt)).toBe(before);
  });

  it('leaves the entity row and the referent read agreeing on the regime', async () => {
    const referentId = await growReattestedReferent();

    const rebuilt = await rebuiltFromLedger();

    expect(rebuilt.referents.get(referentId)?.regime).toBe('view');
    expect(store.getEntity(referentId)?.regime).toBe('view');
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
