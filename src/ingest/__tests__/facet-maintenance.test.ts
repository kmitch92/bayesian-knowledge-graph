/**
 * §3.1's facet centroids, maintained by the write path.
 *
 * §3.1 gives every referent *"1–4 facet centroids"* and §9 says how they move:
 * an incremental mean, O(1) per attached claim, with re-clustering left to a
 * calendar-clock job. They are the substrate Mode C retrieval and A13 stand on,
 * and the implementation plan lists them as non-deferrable — so a referent whose
 * facets stay empty however much is claimed about it is not a referent with a
 * cheap approximation of its geometry, it is a referent with none.
 *
 * The store already holds up its end: `updateReferentFacets` replaces a
 * referent's centroids and the counts they are means of, `getFacetCounts` reads
 * those counts back, and both are covered. Nothing in ingest calls either. This
 * file is about the wiring, and about the four decisions the wiring has to make
 * for every claim:
 *
 * ```
 * which referents      every referent the claim named, not only §3.2's anchor
 * which vector         the claim's own stored f32 rerank embedding
 * which centroid       nearest by cosine above the floor; a new one below it
 *                      while fewer than four exist; the nearest unconditionally
 *                      once four do
 * how it moves         m ← m + (x − m)/(n + 1), with n read from the store
 * ```
 *
 * **Spine claims are excluded.** Existence, naming and containment payloads
 * mint and place a referent; they are not knowledge *about* it. A facet set that
 * absorbed them would summarize the scaffolding rather than the subject, and
 * would move every time a form was corroborated. `decodeSpineClaim` is how those
 * payloads are recognised everywhere else in this system.
 *
 * The floor and the ceiling are ⚙ constants (§13 replays to tune them), restated
 * here the way `COSINE_FLOOR` and `TAU_PROMOTE` already are rather than imported
 * from the module that will own them — a test that imported one would be
 * asserting where the constant lives, which is not a claim this file is making.
 *
 * The store is never faked: real SQLite at `:memory:`, real vectors at the real
 * width. Only the two ports §5 calls model calls — the embedding provider and
 * the coreference adjudicator — are stood in for, over the declared semantic
 * space in `../../referents/__tests__/fixtures`. That fake is what lets a claim
 * be placed in a chosen region, so every relation these cases assume is asserted
 * before it is used (see *the geometry these arrangements assume*): a fixture
 * text moved into another plane fails there, loudly, instead of quietly turning
 * one case into a different one.
 *
 * @spec §3.1, §5.3, §9, §11, §13
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort } from '../index';
import { openIngest } from '../index';
import { openGraphStore, type GraphStore } from '../../store/index';
import { decodeSpineClaim, encodeSpineClaim } from '../../referents/spine';

import {
  COSINE_FLOOR,
  FACET_BELOW_FLOOR_OF_A,
  FACET_NEAR_A,
  FACET_REGION_A,
  FACET_REGION_B,
  FACET_REGION_C,
  FACET_REGION_D,
  agentOrigin,
  attestationMessage,
  claimMessage,
  containmentMessage,
  declaredCosine,
  declaredVector,
  emitterOrigin,
  fakeAdjudicator,
  fakeEmbeddings,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from '../../referents/__tests__/fixtures';

/**
 * §15's `facet_assign_floor`, at its initial value.
 *
 * A claim whose best cosine to an existing centroid clears this joins that
 * centroid. Below it, the claim is about something the referent's existing
 * facets do not cover, and §3.1's remaining budget — if there is any — is spent
 * on a new one rather than on averaging two unrelated things together.
 *
 * ⚙ per §13: restated rather than imported, so this file pins the behaviour at
 * the initial value without pinning where the knob lives.
 *
 * @spec §3.1, §13, §15
 */
const FACET_ASSIGN_FLOOR = 0.5;

/** §3.1's ceiling: *"1–4 facet centroids"*, and the store refuses a fifth. @spec §3.1 */
const FACET_CEILING = 4;

/**
 * How far a stored centroid may sit from the mean this file computed for it.
 *
 * Centroids are stored as f32, so a mean computed in f64 comes back rounded —
 * measured at 3.0e-8 across these fixtures. The nearest *wrong* answer is four
 * orders of magnitude further out: dividing by `n` rather than `n + 1` leaves
 * the centroid 9.9e-2 away (it never moves off the newest claim at all), and
 * dividing by `n + 2` leaves it 3.3e-2 away. So this slack admits the rounding
 * and admits nothing else.
 *
 * @spec §9, §11
 */
const F32_SLACK = 1e-6;

/**
 * The nouns these claims are about.
 *
 * Undeclared in the semantic space, and therefore orthogonal to each other and
 * to every claim text — asserted below. A form that reached a claim text through
 * §5.2's gloss rung would let a fixture resolve to a referent it did not mean.
 *
 * @spec §5.2
 */
const SUBJECT = 'the pumping station';
const OTHER_SUBJECT = 'the standby generator';

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

/*
 * ---------------------------------------------------------------------------
 * Reading the geometry back.
 * ---------------------------------------------------------------------------
 */

/** One centroid and the number of claims it is the mean of. @spec §3.1, §9 */
interface Facet {
  readonly centroid: readonly number[];
  readonly count: number;
}

/** The vector this suite declares for a claim text. @spec §5.3 */
const vectorOf = (text: string): number[] => Array.from(declaredVector(text));

/**
 * A referent's facets, read as the aligned pairs §3.1 promises they are.
 *
 * The centroids and the counts come from two different reads, and §3.1 says
 * they are positionally aligned. A misalignment is checked here rather than
 * assumed, because every assertion below indexes one by the other.
 *
 * @spec §3.1, §9
 */
const facetsOf = (referentId: string): Facet[] => {
  const entity = store.getEntity(referentId);
  if (entity === undefined) throw new Error(`the index holds no referent ${referentId}`);
  const counts = store.getFacetCounts(referentId);
  if (counts.length !== entity.facets.length)
    throw new Error(
      `${referentId} has ${String(entity.facets.length)} centroids and ${String(counts.length)} counts`,
    );
  return entity.facets.map((centroid, at) => ({ centroid, count: counts[at]! }));
};

/** How many claims a referent's centroids account for between them. @spec §3.1, §9 */
const claimsAccountedFor = (referentId: string): number =>
  facetsOf(referentId).reduce((total, facet) => total + facet.count, 0);

/** Cosine, as the store computes one: a dot product over two stored vectors. @spec §11 */
const cosine = (left: readonly number[], right: readonly number[]): number => {
  if (left.length !== right.length)
    throw new Error(
      `cannot compare a vector of ${String(left.length)} with one of ${String(right.length)}`,
    );
  const dot = left.reduce((sum, value, at) => sum + value * right[at]!, 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (leftNorm * rightNorm);
};

/**
 * The four regions, by the claim text that anchors each.
 *
 * A centroid is labelled by the anchor it is nearest, which survives the
 * centroid moving: a mean of {@link FACET_REGION_A} and {@link FACET_NEAR_A}
 * still answers to A at cosine 0.995, and a mean of {@link FACET_REGION_A} and
 * {@link FACET_BELOW_FLOOR_OF_A} still answers to it at 0.825, while every other
 * anchor sits at exactly 0. Labelling by *plane* rather than by nearest neighbour
 * is the point — the off-angle texts share A's plane, so a label read off the
 * closest text would call a moved A-centroid something else.
 *
 * @spec §3.1
 */
const REGION_ANCHORS: Readonly<Record<string, string>> = {
  A: FACET_REGION_A,
  B: FACET_REGION_B,
  C: FACET_REGION_C,
  D: FACET_REGION_D,
};

/** The region a centroid lies in. @spec §3.1 */
const regionOf = (centroid: readonly number[]): string =>
  Object.entries(REGION_ANCHORS).reduce(
    (best, [label, anchor]) =>
      cosine(centroid, vectorOf(anchor)) > cosine(centroid, vectorOf(REGION_ANCHORS[best]!))
        ? label
        : best,
    'A',
  );

/**
 * A referent's facets keyed by region, refusing an arrangement where two
 * centroids answer to one region.
 *
 * The refusal is what keeps this readout honest: it is only a name for a
 * centroid while the fixture puts at most one centroid per region, and the cases
 * that deliberately put two in one plane read the centroids directly instead.
 *
 * @spec §3.1
 */
const byRegion = (referentId: string): Readonly<Record<string, Facet>> =>
  facetsOf(referentId).reduce<Readonly<Record<string, Facet>>>((found, facet) => {
    const label = regionOf(facet.centroid);
    if (label in found) throw new Error(`two centroids both lie in region ${label}`);
    return { ...found, [label]: facet };
  }, {});

/** Each region's count, or nothing where the region has no centroid. @spec §3.1, §9 */
const countsByRegion = (referentId: string): Readonly<Record<string, number>> =>
  Object.fromEntries(
    Object.entries(byRegion(referentId)).map(([label, facet]) => [label, facet.count]),
  );

/** The centroid nearest a text, or a failure loud enough to read. @spec §3.1 */
const centroidNearest = (referentId: string, text: string): Facet => {
  const facets = facetsOf(referentId);
  const best = facets.reduce<Facet | undefined>(
    (found, facet) =>
      found === undefined ||
      cosine(facet.centroid, vectorOf(text)) > cosine(found.centroid, vectorOf(text))
        ? facet
        : found,
    undefined,
  );
  if (best === undefined) throw new Error(`${referentId} has no facet centroids at all`);
  return best;
};

/**
 * The furthest any component of one vector sits from the same component of
 * another — one number, so a failure reports the size of the disagreement rather
 * than 768 lines of it.
 */
const furthestComponent = (actual: readonly number[], expected: readonly number[]): number => {
  if (actual.length !== expected.length)
    throw new Error(
      `a vector of ${String(actual.length)} cannot be the mean of vectors of ${String(expected.length)}`,
    );
  return actual.reduce((worst, value, at) => Math.max(worst, Math.abs(value - expected[at]!)), 0);
};

/** The plain arithmetic mean, which §9's incremental update has to agree with. @spec §9 */
const meanOf = (vectors: readonly (readonly number[])[]): number[] => {
  const first = vectors[0];
  if (first === undefined) throw new Error('no vectors to average');
  return first.map(
    (_, at) => vectors.reduce((sum, vector) => sum + vector[at]!, 0) / vectors.length,
  );
};

/*
 * ---------------------------------------------------------------------------
 * Writing.
 * ---------------------------------------------------------------------------
 */

/** Submits one claim, in its own episode, and hands back the row it wrote. @spec §5 */
const say = async (text: string, forms: readonly string[], n: number): Promise<string> => {
  const receipt = await ingest.submit(
    claimMessage(text, forms, { origin: agentOrigin(n) }),
  );
  if (receipt.claimId === undefined) throw new Error(`the ingest port wrote no claim for "${text}"`);
  return receipt.claimId;
};

/** The referent a form names, or a failure loud enough to read. @spec §3.1 */
const referentNamed = (surfaceForm: string): string => {
  const referentId = store.resolveMention(surfaceForm);
  if (referentId === undefined) throw new Error(`nothing is named ${surfaceForm}`);
  return referentId;
};

/** The embedding a claim was stored with. @spec §3.5, §5.3 */
const embeddingOf = (claimId: string): number[] => {
  const claim = store.getClaim(claimId);
  if (claim === undefined) throw new Error(`the ledger holds no claim ${claimId}`);
  return claim.embedding;
};

/**
 * Says a series of things about {@link SUBJECT}, one per episode, and hands back
 * the referent they all landed on.
 *
 * One form throughout, deliberately: a second form that outranked the first
 * would move §3.1's derived name, and moving a name rewrites the entity row.
 * These cases are about facets and should not be describing that collision by
 * accident.
 *
 * @spec §3.1, §5.2
 */
const saidAbout = async (texts: readonly string[]): Promise<string> => {
  for (const [at, text] of texts.entries()) await say(text, [SUBJECT], at + 1);
  return referentNamed(SUBJECT);
};

/**
 * Archives every spine claim standing behind one referent, and says how many.
 *
 * Reached through the store rather than through a message, because no ingest
 * message retires a referent outright: §6.1's retraction withdraws one source's
 * attestation and mints a successor, so the referent stays supported. The store
 * is the real one either way — this is the ledger being written, not faked.
 *
 * The count comes back so a caller can refuse an arrangement in which nothing
 * was retired. A loop that matched no claim would leave the referent fully
 * alive, and every assertion about a ledger that dropped it would pass for the
 * wrong reason.
 *
 * @spec §6.1
 */
const retireSpineClaimsAbout = (referentId: string): number => {
  let retired = 0;
  for (const claimId of store.getClaimsAbout(referentId, { includeArchived: true })) {
    const claim = store.getClaim(claimId);
    if (claim === undefined || decodeSpineClaim(claim.text) === undefined) continue;
    store.setClaimStatus({ claimId, status: 'archived' });
    retired += 1;
  }
  return retired;
};

/** Drops the three projections and regenerates them through a port that never watched them grow. @spec §11 */
const rebuiltFromLedger = async (): Promise<IngestPort> => {
  store.clearViews();
  const rebuilt = openIngest({ store, embeddings, adjudicator });
  await rebuilt.rebuildIndex();
  return rebuilt;
};

/*
 * ---------------------------------------------------------------------------
 * The geometry these arrangements assume.
 * ---------------------------------------------------------------------------
 */

describe('the geometry these arrangements assume', () => {
  it('embeds a claim at exactly the vector the fixture declares for its text', async () => {
    const claimId = await say(FACET_REGION_A, [SUBJECT], 1);

    expect(furthestComponent(embeddingOf(claimId), vectorOf(FACET_REGION_A))).toBe(0);
  });

  it('keeps the four regions out of reach of one another', () => {
    const anchors = Object.values(REGION_ANCHORS);
    for (const left of anchors)
      for (const right of anchors)
        if (left !== right) expect(declaredCosine(left, right)).toBeLessThan(FACET_ASSIGN_FLOOR);
  });

  it('puts one text within reach of region A, and no other region', () => {
    expect(declaredCosine(FACET_NEAR_A, FACET_REGION_A)).toBeGreaterThan(FACET_ASSIGN_FLOOR);
    for (const [label, anchor] of Object.entries(REGION_ANCHORS))
      if (label !== 'A')
        expect(declaredCosine(FACET_NEAR_A, anchor)).toBeLessThan(FACET_ASSIGN_FLOOR);
  });

  it('puts one text below the floor of every region, nearest A', () => {
    expect(declaredCosine(FACET_BELOW_FLOOR_OF_A, FACET_REGION_A)).toBeLessThan(
      FACET_ASSIGN_FLOOR,
    );
    for (const [label, anchor] of Object.entries(REGION_ANCHORS))
      if (label !== 'A')
        expect(declaredCosine(FACET_BELOW_FLOOR_OF_A, FACET_REGION_A)).toBeGreaterThan(
          declaredCosine(FACET_BELOW_FLOOR_OF_A, anchor),
        );
  });

  it('leaves a moved region-A centroid still nearest region A, and still out of reach', () => {
    const movedByNear = meanOf([vectorOf(FACET_REGION_A), vectorOf(FACET_NEAR_A)]);
    const movedByFar = meanOf([vectorOf(FACET_REGION_A), vectorOf(FACET_BELOW_FLOOR_OF_A)]);

    expect(regionOf(movedByNear)).toBe('A');
    expect(regionOf(movedByFar)).toBe('A');
    expect(cosine(vectorOf(FACET_BELOW_FLOOR_OF_A), movedByNear)).toBeLessThan(
      FACET_ASSIGN_FLOOR,
    );
  });

  it('puts the two off-angle texts within reach of each other, which no case here relies on', () => {
    // Stated rather than assumed: `FACET_NEAR_A` and `FACET_BELOW_FLOOR_OF_A`
    // share plane 6 at 1.0rad apart, so they clear the floor for one another.
    // No case below ever holds a centroid at one while assigning a claim at the
    // other, and this line is what makes adding such a case a visible decision.
    expect(declaredCosine(FACET_NEAR_A, FACET_BELOW_FLOOR_OF_A)).toBeGreaterThan(
      FACET_ASSIGN_FLOOR,
    );
  });

  it('keeps the two subjects out of reach of each other and of every claim text', () => {
    expect(declaredCosine(SUBJECT, OTHER_SUBJECT)).toBeLessThan(COSINE_FLOOR);
    for (const text of [
      FACET_REGION_A,
      FACET_NEAR_A,
      FACET_BELOW_FLOOR_OF_A,
      FACET_REGION_B,
      FACET_REGION_C,
      FACET_REGION_D,
    ])
      for (const form of [SUBJECT, OTHER_SUBJECT])
        expect(declaredCosine(form, text)).toBeLessThan(COSINE_FLOOR);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Claims in distinct regions.
 * ---------------------------------------------------------------------------
 */

describe('three claims about one referent, each in its own region', () => {
  const threeRegions = (): Promise<string> =>
    saidAbout([FACET_REGION_A, FACET_REGION_B, FACET_REGION_C]);

  it('leaves the referent no more centroids than §3.1 allows', async () => {
    const referentId = await threeRegions();

    expect(facetsOf(referentId).length).toBeLessThanOrEqual(FACET_CEILING);
  });

  it('accounts for every one of the three claims in the counts', async () => {
    const referentId = await threeRegions();

    expect(claimsAccountedFor(referentId)).toBe(3);
  });

  it('gives each region a centroid of its own, because none reaches the others', async () => {
    const referentId = await threeRegions();

    expect(countsByRegion(referentId)).toStrictEqual({ A: 1, B: 1, C: 1 });
  });
});

/*
 * ---------------------------------------------------------------------------
 * A claim that joins a centroid already there.
 * ---------------------------------------------------------------------------
 */

describe('a claim near a centroid the referent already has', () => {
  const threeThenNear = async (): Promise<{
    referentId: string;
    before: Readonly<Record<string, Facet>>;
  }> => {
    const referentId = await saidAbout([FACET_REGION_A, FACET_REGION_B, FACET_REGION_C]);
    const before = byRegion(referentId);
    await say(FACET_NEAR_A, [SUBJECT], 4);
    return { referentId, before };
  };

  it('joins that centroid rather than spending the fourth on itself', async () => {
    const { referentId } = await threeThenNear();

    expect(facetsOf(referentId)).toHaveLength(3);
  });

  it('increments that centroid’s count and no other', async () => {
    const { referentId } = await threeThenNear();

    expect(countsByRegion(referentId)).toStrictEqual({ A: 2, B: 1, C: 1 });
  });

  it('moves that centroid to the mean of the two claims it now covers', async () => {
    const { referentId } = await threeThenNear();

    expect(
      furthestComponent(
        byRegion(referentId).A!.centroid,
        meanOf([vectorOf(FACET_REGION_A), vectorOf(FACET_NEAR_A)]),
      ),
    ).toBeLessThan(F32_SLACK);
  });

  it('leaves every other centroid exactly where it was', async () => {
    const { referentId, before } = await threeThenNear();
    const after = byRegion(referentId);

    for (const label of ['B', 'C'])
      expect(furthestComponent(after[label]!.centroid, before[label]!.centroid)).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * §9's incremental mean, as arithmetic.
 * ---------------------------------------------------------------------------
 *
 * `m ← m + (x − m)/(n + 1)` is the whole of §9's O(1) promise, and the denominator
 * is the whole of the rule. Dividing by `n` leaves the centroid sitting on the
 * newest claim and forgetting the ones before it; dividing by `n + 2` drags every
 * mean toward the origin. Both still *move* the centroid, which is why these
 * cases assert the value.
 */

describe('a centroid two claims were folded into', () => {
  const twoIntoOne = (): Promise<string> => saidAbout([FACET_REGION_A, FACET_NEAR_A]);

  it('is one centroid, counted as the mean of two claims', async () => {
    const referentId = await twoIntoOne();

    expect(facetsOf(referentId).map((facet) => facet.count)).toStrictEqual([2]);
  });

  it('sits at the arithmetic mean of the two claim embeddings, to f32', async () => {
    const first = await say(FACET_REGION_A, [SUBJECT], 1);
    const second = await say(FACET_NEAR_A, [SUBJECT], 2);
    const referentId = referentNamed(SUBJECT);

    expect(
      furthestComponent(
        centroidNearest(referentId, FACET_REGION_A).centroid,
        meanOf([embeddingOf(first), embeddingOf(second)]),
      ),
    ).toBeLessThan(F32_SLACK);
  });

  it('is not left sitting on the newer of the two claims', async () => {
    const referentId = await twoIntoOne();
    const centroid = centroidNearest(referentId, FACET_REGION_A).centroid;

    expect(furthestComponent(centroid, vectorOf(FACET_NEAR_A))).toBeGreaterThan(F32_SLACK);
    expect(furthestComponent(centroid, vectorOf(FACET_REGION_A))).toBeGreaterThan(F32_SLACK);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The ceiling.
 * ---------------------------------------------------------------------------
 */

describe('a claim in a fifth region, with four centroids already there', () => {
  const fourThenFifth = async (): Promise<string> => {
    const referentId = await saidAbout([
      FACET_REGION_A,
      FACET_REGION_B,
      FACET_REGION_C,
      FACET_REGION_D,
    ]);
    expect(facetsOf(referentId)).toHaveLength(FACET_CEILING);
    await say(FACET_BELOW_FLOOR_OF_A, [SUBJECT], 5);
    return referentId;
  };

  it('does not mint a fifth centroid', async () => {
    const referentId = await fourThenFifth();

    expect(facetsOf(referentId)).toHaveLength(FACET_CEILING);
  });

  it('joins the nearest centroid even though it is below the floor', async () => {
    const referentId = await fourThenFifth();

    expect(countsByRegion(referentId)).toStrictEqual({ A: 2, B: 1, C: 1, D: 1 });
  });

  it('still accounts for all five claims', async () => {
    const referentId = await fourThenFifth();

    expect(claimsAccountedFor(referentId)).toBe(5);
  });

  it('moves the centroid it joined to the mean of both claims', async () => {
    const referentId = await fourThenFifth();

    expect(
      furthestComponent(
        byRegion(referentId).A!.centroid,
        meanOf([vectorOf(FACET_REGION_A), vectorOf(FACET_BELOW_FLOOR_OF_A)]),
      ),
    ).toBeLessThan(F32_SLACK);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The tie.
 * ---------------------------------------------------------------------------
 *
 * "Nearest" is only a rule while something is nearest. At the ceiling every
 * claim joins a centroid however far away it is, so a claim equidistant from all
 * four is not a pathology to be reasoned away — it is the ordinary case of an
 * unrelated claim arriving at a referent whose facet budget is spent, and this
 * fixture reaches it exactly rather than approximately: a declared vector puts
 * its whole mass in one plane, so two texts in different planes have disjoint
 * support and a dot product of exactly zero. Four centroids in four planes all
 * answer 0.0 to a claim in a fifth.
 *
 * Which one it joins has to be *decided*, because it is observable: the joined
 * centroid moves halfway to a claim that is about none of it, and the referent's
 * geometry from then on depends on which. The implementation decides it by
 * arrival — the comparison is strict, so the first centroid to reach a given
 * cosine keeps it — and arrival order here is minting order, so the oldest
 * centroid absorbs the outsider. That is the conservative reading: the youngest
 * centroid is the one still closest to a single claim and the one a later claim
 * in its own region is most likely to want intact, while the oldest has already
 * been averaged the most and is the least injured by one more.
 *
 * Pinned because nothing else in this file can see it. Every other case here has
 * a strictly nearest centroid, so a comparison flipped from `>` to `>=` — from
 * oldest-wins to newest-wins — changes no other outcome in this suite.
 */

describe('a claim exactly equidistant from every centroid a referent has', () => {
  /** Undeclared, and therefore in a plane of its own: exactly orthogonal to all four regions. */
  const UNRELATED = 'The canteen reopens at seven on weekdays.';

  const fourThenUnrelated = async (): Promise<string> => {
    const referentId = await saidAbout([
      FACET_REGION_A,
      FACET_REGION_B,
      FACET_REGION_C,
      FACET_REGION_D,
    ]);
    expect(facetsOf(referentId)).toHaveLength(FACET_CEILING);
    await say(UNRELATED, [SUBJECT], 5);
    return referentId;
  };

  it('is equidistant at exactly zero, not merely nearly so', () => {
    for (const anchor of Object.values(REGION_ANCHORS))
      expect(declaredCosine(UNRELATED, anchor)).toBe(0);
  });

  it('joins the oldest centroid, the one minted first', async () => {
    const referentId = await fourThenUnrelated();

    expect(countsByRegion(referentId)).toStrictEqual({ A: 2, B: 1, C: 1, D: 1 });
  });

  it('leaves the youngest centroid sitting on the single claim that made it', async () => {
    const referentId = await fourThenUnrelated();

    expect(furthestComponent(byRegion(referentId).D!.centroid, vectorOf(FACET_REGION_D))).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The replay.
 * ---------------------------------------------------------------------------
 *
 * §5.1's stage 0 dedupes on `(episode, text)`, and a message that fails it is
 * admitted as a *replay*: the claim row is still there, the receipt still points
 * at it, and §4.2 refuses to move the posterior, because an episode saying a
 * thing twice has not observed it twice.
 *
 * Facets take the same refusal, and for the same reason rather than an
 * analogous one. Folding the identical vector again would leave the centroid
 * exactly where it is — the mean of x and x is x — so the damage is entirely in
 * the *denominator*: the count would say two, and the next genuinely different
 * claim in that region would move the centroid a third of the way instead of
 * half. That is a geometry weighted by insistence, which is precisely the thing
 * §4.2 caps and §5.1 dedupes to prevent, arriving through a column neither of
 * them is looking at.
 *
 * So the count is what the second case below asserts and the movement is what
 * the third one does. A test that only compared centroids would pass on a
 * replay that had already broken the mean.
 */

describe('a claim its episode has already made', () => {
  const saidTwiceInOneEpisode = async (): Promise<string> => {
    await say(FACET_REGION_A, [SUBJECT], 1);
    const replay = await ingest.submit(
      claimMessage(FACET_REGION_A, [SUBJECT], { origin: agentOrigin(1) }),
    );
    expect(replay.duplicate).toBe(true);
    return referentNamed(SUBJECT);
  };

  it('leaves the centroid the mean of one claim, not of two', async () => {
    const referentId = await saidTwiceInOneEpisode();

    expect(facetsOf(referentId).map((facet) => facet.count)).toStrictEqual([1]);
  });

  it('leaves the next distinct claim to move the centroid half way, not a third', async () => {
    const referentId = await saidTwiceInOneEpisode();

    await say(FACET_NEAR_A, [SUBJECT], 2);

    expect(
      furthestComponent(
        centroidNearest(referentId, FACET_REGION_A).centroid,
        meanOf([vectorOf(FACET_REGION_A), vectorOf(FACET_NEAR_A)]),
      ),
    ).toBeLessThan(F32_SLACK);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The floor, while there is still budget.
 * ---------------------------------------------------------------------------
 */

describe('a claim below the floor of every centroid, with budget left', () => {
  const oneThenFar = (): Promise<string> =>
    saidAbout([FACET_REGION_A, FACET_BELOW_FLOOR_OF_A]);

  it('is given a centroid of its own rather than folded into the nearest', async () => {
    const referentId = await oneThenFar();

    expect(facetsOf(referentId)).toHaveLength(2);
  });

  it('leaves both centroids the mean of exactly one claim', async () => {
    const referentId = await oneThenFar();

    expect(facetsOf(referentId).map((facet) => facet.count)).toStrictEqual([1, 1]);
  });

  it('leaves each centroid sitting on the claim that made it', async () => {
    const referentId = await oneThenFar();

    expect(
      furthestComponent(
        centroidNearest(referentId, FACET_REGION_A).centroid,
        vectorOf(FACET_REGION_A),
      ),
    ).toBe(0);
    expect(
      furthestComponent(
        centroidNearest(referentId, FACET_BELOW_FLOOR_OF_A).centroid,
        vectorOf(FACET_BELOW_FLOOR_OF_A),
      ),
    ).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A claim that names two referents.
 * ---------------------------------------------------------------------------
 */

describe('one claim naming two referents', () => {
  const bothNamed = async (): Promise<{ subject: string; other: string }> => {
    await say(FACET_REGION_A, [SUBJECT, OTHER_SUBJECT], 1);
    return { subject: referentNamed(SUBJECT), other: referentNamed(OTHER_SUBJECT) };
  };

  it('gives the anchor a centroid at the claim it was named by', async () => {
    const { subject } = await bothNamed();

    expect(facetsOf(subject).map((facet) => facet.count)).toStrictEqual([1]);
    expect(furthestComponent(facetsOf(subject)[0]!.centroid, vectorOf(FACET_REGION_A))).toBe(0);
  });

  it('gives the referent the claim merely referenced one too', async () => {
    const { other } = await bothNamed();

    expect(facetsOf(other).map((facet) => facet.count)).toStrictEqual([1]);
    expect(furthestComponent(facetsOf(other)[0]!.centroid, vectorOf(FACET_REGION_A))).toBe(0);
  });

  it('keeps the two referents’ facets separate as they go on being claimed about', async () => {
    await bothNamed();
    await say(FACET_REGION_B, [SUBJECT], 2);

    expect(claimsAccountedFor(referentNamed(SUBJECT))).toBe(2);
    expect(claimsAccountedFor(referentNamed(OTHER_SUBJECT))).toBe(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Spine claims are not knowledge about a referent.
 * ---------------------------------------------------------------------------
 *
 * The guardrail. The cases in this first block go through the messages a spine
 * claim is actually written by — an attestation, a containment — and they hold
 * for a structural reason rather than because anything checks a payload: those
 * messages are served by the spine writer, which never reaches the facet
 * maintenance the claim path calls. They are the end-to-end statement, and they
 * would catch a future wiring that ran the spine writer through it.
 *
 * They cannot, therefore, stand in for the payload check itself, and the block
 * below is what does. `decodeSpineClaim` reads a claim's *text*, and the ledger
 * has exactly one door: an ordinary claim message whose text happens to carry a
 * spine envelope goes into the ledger as an ordinary claim, and every reader
 * that decodes text — `rebuild-index` scanning the whole ledger, most of all —
 * treats it as structure from then on. So a text that decodes as spine is spine
 * to the rest of this system whichever message wrote it, and the write path
 * that summarizes a referent has to agree, or the same row is knowledge on the
 * way in and scaffolding on the way back.
 */

describe('a spine claim about a referent that already has facets', () => {
  const withFacets = async (): Promise<{
    referentId: string;
    facets: readonly Facet[];
  }> => {
    const referentId = await saidAbout([FACET_REGION_A, FACET_NEAR_A, FACET_REGION_B]);
    return { referentId, facets: facetsOf(referentId) };
  };

  it('moves nothing when a noun source attests the referent', async () => {
    const { referentId, facets } = await withFacets();

    await ingest.submit(
      attestationMessage(SUBJECT, { tier: 'observed', origin: emitterOrigin(9) }),
    );

    expect(facetsOf(referentId)).toStrictEqual(facets);
  });

  it('moves nothing when a containment claim places the referent', async () => {
    const { referentId, facets } = await withFacets();

    await ingest.submit(
      containmentMessage(OTHER_SUBJECT, SUBJECT, { origin: agentOrigin(9) }),
    );

    expect(facetsOf(referentId)).toStrictEqual(facets);
  });

  it('gives the referent a containment claim mints no facets of its own', async () => {
    await withFacets();

    await ingest.submit(
      containmentMessage(OTHER_SUBJECT, SUBJECT, { origin: agentOrigin(9) }),
    );

    expect(facetsOf(referentNamed(OTHER_SUBJECT))).toStrictEqual([]);
  });

  it('gives an attested referent nothing but the naming that minted it', async () => {
    await ingest.submit(
      attestationMessage(OTHER_SUBJECT, { tier: 'observed', origin: emitterOrigin(9) }),
    );

    expect(facetsOf(referentNamed(OTHER_SUBJECT))).toStrictEqual([]);
  });
});

describe('an ordinary claim whose text carries a spine payload', () => {
  /** A claim message saying, in its text, the thing an existence claim says. @spec §3.5 */
  const impersonation = (): string =>
    encodeSpineClaim({
      v: 1,
      claim: 'existence',
      referent: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      surfaceForm: SUBJECT,
      level: null,
      locator: undefined,
    });

  const saidAsAClaim = async (): Promise<{ referentId: string; facets: readonly Facet[] }> => {
    const referentId = await saidAbout([FACET_REGION_A, FACET_REGION_B]);
    const facets = facetsOf(referentId);
    await say(impersonation(), [SUBJECT], 9);
    return { referentId, facets };
  };

  it('is read as spine by the reader that decides what a rebuild replays', () => {
    expect(decodeSpineClaim(impersonation())).toBeDefined();
  });

  it('moves no centroid, because that is what the rest of the system calls it', async () => {
    const { referentId, facets } = await saidAsAClaim();

    expect(facetsOf(referentId)).toStrictEqual(facets);
  });

  it('accounts for no extra claim in the counts', async () => {
    const { referentId } = await saidAsAClaim();

    expect(claimsAccountedFor(referentId)).toBe(2);
  });
});

/*
 * ---------------------------------------------------------------------------
 * What a rebuild restores, and what it deliberately does not.
 * ---------------------------------------------------------------------------
 *
 * Facets are the one thing on an entity row `rebuild-index` does not reconstruct,
 * and that is a decision rather than a gap. §9 makes the centroids an *online*
 * summary maintained O(1) per attachment, with re-clustering a calendar-clock
 * job; replaying a whole ledger through the incremental mean would reproduce
 * arrival-order artefacts the ledger does not record, and re-clustering inside a
 * rebuild would put a batch job on the recovery path. So a rebuilt graph starts
 * with no facet geometry and re-earns it as claims re-attach.
 *
 * The property has two halves, and they need pinning separately because the
 * implementation gets them from two different places. A *cleared* index comes
 * back empty because `writeEntity`'s base for an absent row carries no facets;
 * a rebuild against a *live* index leaves the geometry alone because pass 1
 * writes no `facets` key at all, so `writeEntity` carries the stored one back
 * through. Assert only the first and a pass that wiped a live index's geometry
 * would still pass; assert only the second and a pass that reconstructed a
 * cleared one would.
 *
 * `rebuild-index.test.ts` cannot stand in for either. Its byte-for-byte
 * snapshot excludes facets, precisely so the exclusion is stated once rather
 * than smuggled into a field list — which leaves the excluded field's behaviour
 * to this file.
 */

describe('the facets a rebuild restores', () => {
  const grownThenRebuilt = async (): Promise<{ referentId: string; rebuilt: IngestPort }> => {
    const referentId = await saidAbout([FACET_REGION_A, FACET_NEAR_A, FACET_REGION_B]);
    return { referentId, rebuilt: await rebuiltFromLedger() };
  };

  it('are none, on a referent the rebuild otherwise brought back whole', async () => {
    const { referentId, rebuilt } = await grownThenRebuilt();

    expect(rebuilt.referents.get(referentId)?.name).toBe(SUBJECT);
    expect(facetsOf(referentId)).toStrictEqual([]);
  });

  it('are none for every referent in the index, not only the one asked about', async () => {
    const { rebuilt } = await grownThenRebuilt();

    expect(
      rebuilt.referents.all().map((referent) => facetsOf(referent.id)),
    ).toStrictEqual(rebuilt.referents.all().map(() => []));
  });

  it('are re-earned by the next claim that attaches, not lost for good', async () => {
    const { referentId, rebuilt } = await grownThenRebuilt();

    await rebuilt.submit(
      claimMessage(FACET_REGION_C, [SUBJECT], { origin: agentOrigin(7) }),
    );

    expect(claimsAccountedFor(referentId)).toBe(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The facets a rebuild leaves alone.
 * ---------------------------------------------------------------------------
 *
 * The other half. A rebuild run *without* a clear is a maintenance operation on
 * a serving index — §11's answer to a view that drifted — and it has to be a
 * no-op on everything it is not re-deriving. Facets are the one thing it is not
 * re-deriving at all, so they are the one thing it can only leave where it
 * found them.
 *
 * Both the centroids and the counts are checked. Only the centroids are on
 * `Entity`; the counts live in a column beside them, and a rebuild that carried
 * the centroids through while resetting every denominator to one would look
 * untouched here and quietly re-weight §9's next incremental mean — the very
 * failure {@link GraphStore.putEntity} preserves its counts to prevent.
 */

describe('a rebuild run against a live index', () => {
  const grownThenRebuiltInPlace = async (): Promise<{
    referentId: string;
    before: readonly Facet[];
  }> => {
    const referentId = await saidAbout([FACET_REGION_A, FACET_NEAR_A, FACET_REGION_B]);
    const before = facetsOf(referentId);
    await ingest.rebuildIndex();
    return { referentId, before };
  };

  it('leaves every centroid exactly where it found it', async () => {
    const { referentId, before } = await grownThenRebuiltInPlace();

    expect(facetsOf(referentId).map((facet) => facet.centroid)).toStrictEqual(
      before.map((facet) => facet.centroid),
    );
  });

  it('leaves the count beside each centroid alone, denominators included', async () => {
    const { referentId, before } = await grownThenRebuiltInPlace();

    expect(facetsOf(referentId).map((facet) => facet.count)).toStrictEqual(
      before.map((facet) => facet.count),
    );
  });

  it('leaves the next mean to carry on from the count the rebuild passed over', async () => {
    const { referentId } = await grownThenRebuiltInPlace();

    await say(FACET_REGION_A, [SUBJECT], 9);

    // Region A was the mean of two before the rebuild, so this third claim in
    // its plane must land the centroid on the mean of three. A denominator the
    // rebuild had reset to one would put it halfway back onto this claim.
    expect(countsByRegion(referentId)).toStrictEqual({ A: 3, B: 1 });
    expect(
      furthestComponent(
        byRegion(referentId).A!.centroid,
        meanOf([vectorOf(FACET_REGION_A), vectorOf(FACET_NEAR_A), vectorOf(FACET_REGION_A)]),
      ),
    ).toBeLessThan(F32_SLACK);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Geometry the ledger stopped supporting.
 * ---------------------------------------------------------------------------
 *
 * A rebuild reads only *live* spine claims (§6.1), so a referent whose existence
 * claim has been retired is skipped by pass 1 — and a rebuild deletes nothing,
 * so against a live index its row survives the pass that ignored it. Every field
 * on that row survives, not only the facets: the name, the gloss vector and the
 * mention cluster are all still there afterwards. Stale geometry on such a row is
 * therefore not a new hole this wiring opened, it is the same hole the whole row
 * already sat in.
 *
 * Pinned rather than argued, because the distinction is what makes the pass-1
 * change safe to keep: if a rebuild against a live index *did* prune referents
 * the ledger no longer supports, then leaving their facets behind would be a leak
 * with a name. It does not, so the facets are as stale as the name beside them
 * and no staler, and a clear is what removes both.
 *
 * The claim is retired through the store rather than through a message, because
 * no ingest message retires a referent outright — §6.1's retraction mints a
 * successor and the referent stays supported. The store is real either way.
 */

/*
 * §9 hands the repair to a calendar clock, and this is the shape of the debt.
 *
 * An incremental mean keeps a point and a count, and no member list. Backing a
 * claim out of one would need two things the store does not hold: the vector
 * that went in, and the fact that it went into *this* centroid rather than a
 * sibling — nothing records which centroid a claim was folded into, so even the
 * arithmetically exact `(n·m − x)/(n − 1)` has no way to know which `m` to run
 * it on. Re-clustering is not a nicer way to do the same repair, it is the only
 * one available at O(1) storage, which is why §9 puts it on a clock.
 *
 * The cost is that a retired claim keeps voting on the geometry until that job
 * runs. Pinned rather than left to be true by omission: nothing on the write
 * path reads a claim's status, so this holds today for no reason at all, and
 * the first attempt at a back-out would be free to get the denominator wrong
 * with no test to say so.
 */

describe('a claim already folded in, then retired', () => {
  const twoThenOneRetired = async (): Promise<{
    referentId: string;
    facets: readonly Facet[];
  }> => {
    const referentId = await saidAbout([FACET_REGION_A, FACET_NEAR_A]);
    const facets = facetsOf(referentId);
    let archived = 0;
    for (const claimId of store.getClaimsAbout(referentId)) {
      const claim = store.getClaim(claimId);
      if (claim === undefined || claim.text !== FACET_NEAR_A) continue;
      store.setClaimStatus({ claimId, status: 'archived' });
      archived += 1;
    }
    expect(archived).toBe(1);
    return { referentId, facets };
  };

  it('leaves the centroid where its vector helped put it', async () => {
    const { referentId, facets } = await twoThenOneRetired();

    expect(facetsOf(referentId)).toStrictEqual(facets);
  });

  it('leaves the denominator counting it, so the next claim moves a third', async () => {
    const { referentId } = await twoThenOneRetired();

    await say(FACET_REGION_A, [SUBJECT], 9);

    expect(facetsOf(referentId).map((facet) => facet.count)).toStrictEqual([3]);
  });
});

describe('a referent the ledger has stopped supporting', () => {
  const retiredThenRebuilt = async (): Promise<{
    referentId: string;
    before: readonly Facet[];
  }> => {
    const referentId = await saidAbout([FACET_REGION_A, FACET_REGION_B]);
    const before = facetsOf(referentId);
    const retired = retireSpineClaimsAbout(referentId);
    expect(retired).toBeGreaterThan(0);
    await ingest.rebuildIndex();
    return { referentId, before };
  };

  it('is gone from a rebuild that starts from nothing', async () => {
    const { referentId } = await retiredThenRebuilt();

    const rebuilt = await rebuiltFromLedger();

    expect(rebuilt.referents.get(referentId)).toBeUndefined();
    expect(store.getEntity(referentId)).toBeUndefined();
  });

  it('keeps its whole row through a rebuild in place, not merely its facets', async () => {
    const { referentId } = await retiredThenRebuilt();

    expect(store.getEntity(referentId)?.name).toBe(SUBJECT);
  });

  it('keeps the geometry too, exactly as stale as the row carrying it', async () => {
    const { referentId, before } = await retiredThenRebuilt();

    expect(facetsOf(referentId)).toStrictEqual(before);
  });

});
