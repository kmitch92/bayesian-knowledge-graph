/**
 * The three store reads §5.2's resolution ladder and §3.1's facets need, and
 * that P1 did not build.
 *
 * - {@link GraphStore.findReferentsByMention} serves rungs 1 and 2. It is not
 *   {@link GraphStore.resolveMention}: that one answers with `ORDER BY rowid
 *   LIMIT 1` and so *hides* the case the ladder exists to handle — the mentions
 *   primary key is `(surface_form, referent_id)` precisely so that "a form that
 *   has come to name two referents keeps both, for §5.2 to sort out rather than
 *   for this layer to overwrite". A read that silently picks one is a read that
 *   makes the ambiguity unresolvable.
 * - {@link GraphStore.searchReferentGlosses} serves rung 3. `entity_gloss_vectors`
 *   has been written since migration 0 and never read; §3.1 says the gloss
 *   embedding is "used for anchor resolution and vague-query entry", which is a
 *   read.
 * - {@link GraphStore.updateReferentFacets} maintains §3.1's 1–4 centroids on
 *   the episode clock, without rewriting the entity row's name, level, locator
 *   or gloss around them.
 *
 * The store stays mechanical throughout (see `port.ts`): it reports which
 * referents a form has named, it does not decide which one was meant; it
 * reports cosines, it does not apply §15's floor. Both judgments are §5.2's.
 *
 * Two tallying reads sit beside those three, and only one of them counts.
 * {@link GraphStore.getMentionTally} hands over the tally §3.1's "most-corroborated
 * surface form" is a function of — and a naming *is* a corroboration, so §4.2's
 * cap and §4.4's discount have already been applied to the weight by the time it
 * reaches the row. The store does not apply them and cannot: the weight is the
 * naming claim's own support, and this layer caches what it is handed.
 * {@link GraphStore.getFacetCounts} hands over how many claims each §3.1 centroid
 * is the mean of, which is the only thing keeping that mean's update O(1). Both
 * are positional or ordered promises, and both are the kind of promise a store
 * can keep numerically while breaking structurally: a count that has drifted out
 * of line with the centroid it counts silently re-weights the wrong mean on the
 * next update.
 *
 * @spec §3.1, §5.2, §5.3, §9, §11
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DimensionMismatchError,
  UnknownEntityError,
  openGraphStore,
  type GraphStore,
} from '../index';

import {
  ENTITY_ID,
  OTHER_ENTITY_ID,
  STORE_ANN_WIDTH,
  makeEntity,
  makeMinimalEntity,
  testUlid,
  unitVector,
  unitVectorArray,
} from './fixtures';

/** A third referent, for the case where one surface form has come to name several. @spec §5.2 */
const THIRD_ENTITY_ID = testUlid('ENTITY-RETRYBVDGET');

/**
 * What one untainted, uncapped naming is worth at §15's observed tier.
 *
 * The unit every weight below is written in, so a case about two forms tied on
 * support reads as two forms with the same number of independent namings behind
 * them rather than as two arbitrary reals that happen to be equal.
 *
 * @spec §4.2, §15
 */
const ONE_NAMING = 1;

/**
 * What §4.2 leaves behind after a form is named twice inside one episode: the
 * first naming at full weight, the repeat capped at a half.
 *
 * A fraction, and it has to be one — the cap series is 1, ½, ¼, …, so no column
 * that stored counts could hold this and no tally built on counts could tell it
 * apart from two independent namings.
 *
 * @spec §4.2, §4.4
 */
const A_NAMING_AND_A_CAPPED_REPEAT = 1.5;

let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('findReferentsByMention', () => {
  it('finds nothing for a surface form nothing has been named by', () => {
    store.putEntity(makeEntity());

    expect(store.findReferentsByMention('AuthService')).toStrictEqual([]);
  });

  it('finds the referent a recorded form names', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });

    expect(store.findReferentsByMention('AuthService')).toStrictEqual([
      { referentId: ENTITY_ID, canonicalName: true },
    ]);
  });

  it('marks the form that is the referent\'s derived name, which is what rung 1 is', () => {
    store.putEntity(makeEntity({ name: 'AuthService' }));
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_NAMING });

    expect(store.findReferentsByMention('auth-service')).toStrictEqual([
      { referentId: ENTITY_ID, canonicalName: false },
    ]);
  });

  it('keeps every referent a form has come to name, canonical first', () => {
    store.putEntity(makeMinimalEntity({ name: 'the retry knob' }));
    store.putEntity(makeEntity({ id: THIRD_ENTITY_ID, name: 'RetryBudget' }));
    store.putMention({
      surfaceForm: 'the retry knob',
      referentId: THIRD_ENTITY_ID,
      weight: ONE_NAMING,
    });
    store.putMention({
      surfaceForm: 'the retry knob',
      referentId: OTHER_ENTITY_ID,
      weight: ONE_NAMING,
    });

    expect(store.findReferentsByMention('the retry knob')).toStrictEqual([
      { referentId: OTHER_ENTITY_ID, canonicalName: true },
      { referentId: THIRD_ENTITY_ID, canonicalName: false },
    ]);
  });

  it('records a repeated form once, so nine namings in an episode are one candidate', () => {
    store.putEntity(makeEntity());
    for (let i = 0; i < 9; i += 1)
      store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });

    expect(store.findReferentsByMention('AuthService')).toHaveLength(1);
  });

  it('reads the form exactly as written, folding nothing — coreference is not the store\'s call', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });

    expect(store.findReferentsByMention('authservice')).toStrictEqual([]);
    expect(store.findReferentsByMention('auth-service')).toStrictEqual([]);
  });

  it('finds nothing once the mention index is dropped, because it is a view', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });

    store.clearViews();

    expect(store.findReferentsByMention('AuthService')).toStrictEqual([]);
  });
});

describe('getMentionTally', () => {
  it('finds no forms for a referent nothing has named', () => {
    store.putEntity(makeEntity());

    expect(store.getMentionTally(ENTITY_ID)).toStrictEqual([]);
  });

  it('finds no forms for a referent the index does not hold', () => {
    expect(store.getMentionTally(THIRD_ENTITY_ID)).toStrictEqual([]);
  });

  it('reports a single naming as one form at the support behind it', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_NAMING });

    expect(store.getMentionTally(ENTITY_ID)).toStrictEqual([
      { surfaceForm: 'auth-service', weight: ONE_NAMING },
    ]);
  });

  it('replaces the weight rather than adding a row when one episode names it nine times', () => {
    store.putEntity(makeEntity());
    // Nine namings inside one episode, weighed as §4.2 weighs them: the first at
    // full weight and each repeat halved, converging on two observations without
    // ever reaching them. The caller does that arithmetic against the naming
    // claim; what the store must do is hold the answer rather than accumulate it.
    let support = 0;
    for (let naming = 0; naming < 9; naming += 1) {
      support += 2 ** -naming;
      store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: support });
    }

    expect(store.getMentionTally(ENTITY_ID)).toStrictEqual([
      { surfaceForm: 'auth-service', weight: support },
    ]);
    expect(support).toBeLessThan(2 * ONE_NAMING);
  });

  it('keeps each surface form of one referent at its own weight', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_NAMING });
    store.putMention({
      surfaceForm: 'auth-service',
      referentId: ENTITY_ID,
      weight: A_NAMING_AND_A_CAPPED_REPEAT,
    });

    expect(store.getMentionTally(ENTITY_ID)).toStrictEqual([
      { surfaceForm: 'auth-service', weight: A_NAMING_AND_A_CAPPED_REPEAT },
      { surfaceForm: 'AuthService', weight: ONE_NAMING },
    ]);
  });

  it('puts the most-corroborated form first, which is the form §3.1 derives a name from', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'AuthSvc', referentId: ENTITY_ID, weight: ONE_NAMING });
    store.putMention({
      surfaceForm: 'the auth thing',
      referentId: ENTITY_ID,
      weight: 3 * ONE_NAMING,
    });

    expect(store.getMentionTally(ENTITY_ID).map((tally) => tally.surfaceForm)).toStrictEqual([
      'the auth thing',
      'AuthSvc',
    ]);
  });

  it('keeps first-naming order between forms tied on weight, so the read is deterministic', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_NAMING });
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: 2 * ONE_NAMING });
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: 2 * ONE_NAMING });

    expect(store.getMentionTally(ENTITY_ID)).toStrictEqual([
      { surfaceForm: 'auth-service', weight: 2 * ONE_NAMING },
      { surfaceForm: 'AuthService', weight: 2 * ONE_NAMING },
    ]);
  });

  it('weighs a form per referent it names, not once across the index', () => {
    store.putEntity(makeEntity());
    store.putEntity(makeMinimalEntity());
    store.putMention({ surfaceForm: 'the retry knob', referentId: ENTITY_ID, weight: ONE_NAMING });
    store.putMention({
      surfaceForm: 'the retry knob',
      referentId: ENTITY_ID,
      weight: 2 * ONE_NAMING,
    });
    store.putMention({
      surfaceForm: 'the retry knob',
      referentId: OTHER_ENTITY_ID,
      weight: ONE_NAMING,
    });

    expect([
      store.getMentionTally(ENTITY_ID),
      store.getMentionTally(OTHER_ENTITY_ID),
    ]).toStrictEqual([
      [{ surfaceForm: 'the retry knob', weight: 2 * ONE_NAMING }],
      [{ surfaceForm: 'the retry knob', weight: ONE_NAMING }],
    ]);
  });

  it('tallies two spellings apart, because the index folds nothing', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });
    store.putMention({ surfaceForm: 'authservice', referentId: ENTITY_ID, weight: ONE_NAMING });

    expect(store.getMentionTally(ENTITY_ID)).toStrictEqual([
      { surfaceForm: 'AuthService', weight: ONE_NAMING },
      { surfaceForm: 'authservice', weight: ONE_NAMING },
    ]);
  });

  it('tallies a referent the index does not hold, since mentions are never checked against it', () => {
    store.putMention({ surfaceForm: 'RetryBudget', referentId: THIRD_ENTITY_ID, weight: ONE_NAMING });

    expect(store.getMentionTally(THIRD_ENTITY_ID)).toStrictEqual([
      { surfaceForm: 'RetryBudget', weight: ONE_NAMING },
    ]);
  });

  it('keeps a fractional weight a fraction, because §4.2 caps do not land on integers', () => {
    store.putEntity(makeEntity());
    store.putMention({
      surfaceForm: 'auth-service',
      referentId: ENTITY_ID,
      weight: A_NAMING_AND_A_CAPPED_REPEAT,
    });

    expect(store.getMentionTally(ENTITY_ID)).toStrictEqual([
      { surfaceForm: 'auth-service', weight: A_NAMING_AND_A_CAPPED_REPEAT },
    ]);
  });

  it('finds nothing once the mention index is dropped, because it is a view', () => {
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_NAMING });

    store.clearViews();

    expect(store.getMentionTally(ENTITY_ID)).toStrictEqual([]);
  });
});

describe('searchReferentGlosses', () => {
  const NEAR = unitVector(41);
  const FAR = unitVector(42);

  it('finds nothing in an empty referent index', () => {
    expect(store.searchReferentGlosses({ embedding: NEAR, limit: 10 })).toStrictEqual([]);
  });

  it('makes the gloss vector migration 0 has only ever written readable', () => {
    store.putEntity(makeEntity({ glossEmbedding: Array.from(NEAR) }));

    expect(
      store.searchReferentGlosses({ embedding: NEAR, limit: 10 }).map((hit) => hit.referentId),
    ).toStrictEqual([ENTITY_ID]);
  });

  it('returns the nearest gloss first', () => {
    store.putEntity(makeEntity({ glossEmbedding: Array.from(FAR) }));
    store.putEntity(makeMinimalEntity({ glossEmbedding: Array.from(NEAR) }));

    expect(
      store.searchReferentGlosses({ embedding: NEAR, limit: 10 }).map((hit) => hit.referentId),
    ).toStrictEqual([OTHER_ENTITY_ID, ENTITY_ID]);
  });

  it('honours the candidate cap', () => {
    store.putEntity(makeEntity({ glossEmbedding: Array.from(FAR) }));
    store.putEntity(makeMinimalEntity({ glossEmbedding: Array.from(NEAR) }));

    expect(store.searchReferentGlosses({ embedding: NEAR, limit: 1 })).toHaveLength(1);
  });

  it('reports a real cosine, clamped, so §5.2 can compare it against the §15 floor', () => {
    store.putEntity(makeEntity({ glossEmbedding: Array.from(NEAR) }));

    const hit = store.searchReferentGlosses({ embedding: NEAR, limit: 1 })[0];

    expect(hit?.cosine).toBeLessThanOrEqual(1);
    expect(hit?.cosine).toBeGreaterThan(0.99);
  });

  it('separates an unrelated gloss far enough for a floor to mean something', () => {
    store.putEntity(makeEntity({ glossEmbedding: Array.from(FAR) }));

    const hit = store.searchReferentGlosses({ embedding: NEAR, limit: 1 })[0];

    expect(hit?.cosine).toBeLessThan(0.7);
    expect(hit?.cosine).toBeGreaterThanOrEqual(-1);
  });

  it('re-indexes rather than duplicating when a referent is upserted', () => {
    store.putEntity(makeEntity({ glossEmbedding: Array.from(FAR) }));
    store.putEntity(makeEntity({ glossEmbedding: Array.from(NEAR) }));

    const hits = store.searchReferentGlosses({ embedding: NEAR, limit: 10 });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.cosine).toBeGreaterThan(0.99);
  });

  it('finds nothing once the referent index is dropped, because it is a view', () => {
    store.putEntity(makeEntity({ glossEmbedding: Array.from(NEAR) }));

    store.clearViews();

    expect(store.searchReferentGlosses({ embedding: NEAR, limit: 10 })).toStrictEqual([]);
  });
});

describe('updateReferentFacets', () => {
  it('writes centroids the referent row hands back', () => {
    store.putEntity(makeMinimalEntity());
    const centroid = unitVectorArray(51);

    store.updateReferentFacets(OTHER_ENTITY_ID, [centroid]);

    expect(store.getEntity(OTHER_ENTITY_ID)?.facets).toStrictEqual([centroid]);
  });

  it('replaces the set rather than accumulating, since a mean update rewrites a centroid', () => {
    store.putEntity(makeEntity());
    const moved = unitVectorArray(52);

    store.updateReferentFacets(ENTITY_ID, [moved]);

    expect(store.getEntity(ENTITY_ID)?.facets).toStrictEqual([moved]);
  });

  it('holds §3.1\'s four', () => {
    store.putEntity(makeMinimalEntity());
    const four = [61, 62, 63, 64].map((seed) => unitVectorArray(seed));

    store.updateReferentFacets(OTHER_ENTITY_ID, four);

    expect(store.getEntity(OTHER_ENTITY_ID)?.facets).toStrictEqual(four);
  });

  it('refuses a fifth, leaving the four that were already there', () => {
    store.putEntity(makeMinimalEntity());
    const four = [61, 62, 63, 64].map((seed) => unitVectorArray(seed));
    store.updateReferentFacets(OTHER_ENTITY_ID, four);

    expect(() =>
      store.updateReferentFacets(OTHER_ENTITY_ID, [...four, unitVectorArray(65)]),
    ).toThrow();

    expect(store.getEntity(OTHER_ENTITY_ID)?.facets).toStrictEqual(four);
  });

  it('empties the set for a referent no claim has attached to yet', () => {
    store.putEntity(makeEntity());

    store.updateReferentFacets(ENTITY_ID, []);

    expect(store.getEntity(ENTITY_ID)?.facets).toStrictEqual([]);
  });

  it('refuses a centroid at the ANN width — facets are means of full-precision claims', () => {
    store.putEntity(makeMinimalEntity());

    expect(() =>
      store.updateReferentFacets(OTHER_ENTITY_ID, [unitVectorArray(66, STORE_ANN_WIDTH)]),
    ).toThrow(DimensionMismatchError);
  });

  it('refuses a referent the index does not hold', () => {
    expect(() => store.updateReferentFacets(ENTITY_ID, [unitVectorArray(67)])).toThrow(
      UnknownEntityError,
    );
  });

  it('leaves the rest of the referent row alone', () => {
    store.putEntity(makeEntity());
    const before = store.getEntity(ENTITY_ID);

    store.updateReferentFacets(ENTITY_ID, [unitVectorArray(68)]);
    const after = store.getEntity(ENTITY_ID);

    expect(after?.name).toBe(before?.name);
    expect(after?.level).toBe(before?.level);
    expect(after?.regime).toBe(before?.regime);
    expect(after?.locator).toStrictEqual(before?.locator);
    expect(after?.glossEmbedding).toStrictEqual(before?.glossEmbedding);
  });

  it('leaves the gloss index alone, so a facet update is not a re-embed', () => {
    const gloss = unitVector(69);
    store.putEntity(makeEntity({ glossEmbedding: Array.from(gloss) }));

    store.updateReferentFacets(ENTITY_ID, [unitVectorArray(70)]);

    expect(
      store.searchReferentGlosses({ embedding: gloss, limit: 1 }).map((hit) => hit.referentId),
    ).toStrictEqual([ENTITY_ID]);
  });
});

describe('getFacetCounts', () => {
  const THREE_CENTROIDS = [71, 72, 73].map((seed) => unitVectorArray(seed));
  const TWO_CENTROIDS = [74, 75].map((seed) => unitVectorArray(seed));

  it('finds no counts for a referent the index does not hold', () => {
    expect(store.getFacetCounts(ENTITY_ID)).toStrictEqual([]);
  });

  it('finds no counts for a referent carrying no centroids', () => {
    store.putEntity(makeMinimalEntity());

    expect(store.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([]);
  });

  it('reports one count per centroid the referent arrived with, each a fresh mean of one', () => {
    store.putEntity(makeEntity());

    expect(store.getFacetCounts(ENTITY_ID)).toStrictEqual([1, 1]);
  });

  it('records the counts supplied alongside the centroids', () => {
    store.putEntity(makeMinimalEntity());

    store.updateReferentFacets(OTHER_ENTITY_ID, THREE_CENTROIDS, [5, 6, 7]);

    expect(store.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([5, 6, 7]);
  });

  it('records a fresh mean of one per centroid when no counts are supplied', () => {
    store.putEntity(makeMinimalEntity());

    store.updateReferentFacets(OTHER_ENTITY_ID, THREE_CENTROIDS);

    expect(store.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([1, 1, 1]);
  });

  it('stays positionally aligned with the facets through an update that drops a centroid', () => {
    store.putEntity(makeMinimalEntity());
    store.updateReferentFacets(OTHER_ENTITY_ID, THREE_CENTROIDS, [5, 6, 7]);

    store.updateReferentFacets(OTHER_ENTITY_ID, TWO_CENTROIDS, [8, 9]);

    expect(store.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([8, 9]);
    expect(store.getEntity(OTHER_ENTITY_ID)?.facets).toStrictEqual(TWO_CENTROIDS);
  });

  it('empties along with the facet set', () => {
    store.putEntity(makeEntity());

    store.updateReferentFacets(ENTITY_ID, []);

    expect(store.getFacetCounts(ENTITY_ID)).toStrictEqual([]);
  });

  it('refuses a count vector that does not line up with the centroids it counts', () => {
    store.putEntity(makeMinimalEntity());

    expect(() => store.updateReferentFacets(OTHER_ENTITY_ID, TWO_CENTROIDS, [1, 2, 3])).toThrow(
      DimensionMismatchError,
    );
  });

  it('leaves the counts that were already there when it refuses a misaligned vector', () => {
    store.putEntity(makeMinimalEntity());
    store.updateReferentFacets(OTHER_ENTITY_ID, THREE_CENTROIDS, [5, 6, 7]);

    expect(() => store.updateReferentFacets(OTHER_ENTITY_ID, TWO_CENTROIDS, [8])).toThrow(
      DimensionMismatchError,
    );

    expect(store.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([5, 6, 7]);
  });

  it('leaves the counts that were already there when it refuses a fifth centroid', () => {
    store.putEntity(makeMinimalEntity());
    const four = [61, 62, 63, 64].map((seed) => unitVectorArray(seed));
    store.updateReferentFacets(OTHER_ENTITY_ID, four, [2, 3, 4, 5]);

    expect(() =>
      store.updateReferentFacets(OTHER_ENTITY_ID, [...four, unitVectorArray(65)]),
    ).toThrow();

    expect(store.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([2, 3, 4, 5]);
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a %s count, which no centroid could be the mean of', (_description, count) => {
    store.putEntity(makeMinimalEntity());

    expect(() => store.updateReferentFacets(OTHER_ENTITY_ID, TWO_CENTROIDS, [1, count])).toThrow(
      RangeError,
    );
  });

  it('resets to one per centroid when the referent is upserted, since Entity carries no counts', () => {
    store.putEntity(makeEntity());
    store.updateReferentFacets(ENTITY_ID, TWO_CENTROIDS, [40, 50]);

    store.putEntity(makeEntity());

    expect(store.getFacetCounts(ENTITY_ID)).toStrictEqual([1, 1]);
  });

  it('resets to nothing when the upsert carries no centroids', () => {
    store.putEntity(makeMinimalEntity());
    store.updateReferentFacets(OTHER_ENTITY_ID, TWO_CENTROIDS, [40, 50]);

    store.putEntity(makeMinimalEntity());

    expect(store.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([]);
  });

  it('counts one referent without reaching another', () => {
    store.putEntity(makeEntity());
    store.putEntity(makeMinimalEntity());

    store.updateReferentFacets(OTHER_ENTITY_ID, THREE_CENTROIDS, [5, 6, 7]);

    expect(store.getFacetCounts(ENTITY_ID)).toStrictEqual([1, 1]);
  });

  it('finds no counts once the referent index is dropped, because it is a view', () => {
    store.putEntity(makeEntity());
    store.updateReferentFacets(ENTITY_ID, TWO_CENTROIDS, [40, 50]);

    store.clearViews();

    expect(store.getFacetCounts(ENTITY_ID)).toStrictEqual([]);
  });
});

/**
 * The same positional promise, kept against a writer that is not this store.
 *
 * `updateReferentFacets` refuses a count vector that does not line up, so
 * nothing above can produce a misaligned column — but `facet_counts` is a plain
 * TEXT column on a view table, and `rebuild-index` regenerates that table
 * wholesale. The threat model is the same one migration 0's claim CHECK already
 * accepts as real: the writer that is not this store.
 *
 * Degrading rather than throwing is right, because a lost count is recoverable —
 * `rebuild-index` restores it, and taking a referent read down over a number
 * nothing believes would be the larger failure. But it has to degrade to *no
 * counts*, not to whichever entries survived a filter. §3.1 promises the counts
 * are "positionally aligned with `facets`", and a short vector keeps that
 * promise's shape while breaking its content: `[1,-1,2]` filtered to `[1,2]`
 * makes `counts[1]` describe the second centroid, so the next O(1) mean update
 * re-weights a centroid nobody attached a claim to. An absent count vector is a
 * mean that has to be re-derived; a wrong one is a mean that is quietly wrong
 * from here on.
 *
 * @spec §3.1, §9
 */
describe('getFacetCounts against a count vector this store did not write', () => {
  const THREE_CENTROIDS = [81, 82, 83].map((seed) => unitVectorArray(seed));

  let directory: string;
  let dbPath: string;
  let fileStore: GraphStore;

  /**
   * Overwrites the counts column alone, leaving the centroids the store wrote.
   *
   * A temp file rather than `:memory:`, because a second connection to
   * `:memory:` is a second, empty database.
   *
   * @spec §9
   */
  const writeRawCounts = (counts: string): void => {
    const db = new Database(dbPath);
    try {
      db.prepare<{ counts: string; id: string }>(
        'UPDATE entities SET facet_counts = @counts WHERE id = @id',
      ).run({ counts, id: OTHER_ENTITY_ID });
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kg-mcp-facet-counts-'));
    dbPath = join(directory, 'graph.db');
    fileStore = openGraphStore({ path: dbPath });
    fileStore.putEntity(makeMinimalEntity());
    fileStore.updateReferentFacets(OTHER_ENTITY_ID, THREE_CENTROIDS, [5, 6, 7]);
  });

  afterEach(() => {
    fileStore.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['a negative count, which no centroid could be the mean of', '[1,-1,2]'],
    ['a count JSON spelled as null because it was not a finite number', '[1,null,2]'],
    ['a count that is a string rather than a number', '[1,"2",3]'],
    ['fewer counts than there are centroids', '[1,2]'],
    ['more counts than there are centroids', '[1,2,3,4]'],
  ])('reports no counts rather than a prefix when the column holds %s', (_description, counts) => {
    writeRawCounts(counts);

    expect(fileStore.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([]);
  });

  it('reports no counts for a referent that has no centroids for them to line up with', () => {
    fileStore.updateReferentFacets(OTHER_ENTITY_ID, []);
    writeRawCounts('[1,2]');

    expect(fileStore.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([]);
  });

  it.each([
    ['an object rather than an array', '{"0":1,"1":2,"2":3}'],
    ['a bare number', '5'],
    ['a NaN, which no JSON parser will read', '[1,NaN,2]'],
    ['text that is not JSON at all', 'the counts got away'],
  ])('degrades rather than throwing when the column holds %s', (_description, counts) => {
    writeRawCounts(counts);

    expect(fileStore.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([]);
  });

  it('still reads a raw count vector that does line up, so the guard refuses only the broken ones', () => {
    writeRawCounts('[5,6,7]');

    expect(fileStore.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([5, 6, 7]);
  });

  it('keeps a zero count, which is what a centroid no claim has landed on since a rebuild has', () => {
    writeRawCounts('[0,6,7]');

    expect(fileStore.getFacetCounts(OTHER_ENTITY_ID)).toStrictEqual([0, 6, 7]);
  });

  it('leaves the centroids themselves alone, since only the counts were corrupted', () => {
    writeRawCounts('[1,-1,2]');

    expect(fileStore.getEntity(OTHER_ENTITY_ID)?.facets).toStrictEqual(THREE_CENTROIDS);
  });
});
