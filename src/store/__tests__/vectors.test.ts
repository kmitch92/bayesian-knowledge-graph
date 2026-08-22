/**
 * §11 vector storage: two copies of every embedding, at two widths, for two jobs.
 *
 * "Claim embeddings stored quantized (int8/PQ) as node properties for SIMD-cheap
 * in-traversal scoring; full precision retained for final rerank only." Spike S2
 * pinned the numbers: 768d f32 is the rerank copy and migration 0 is final on
 * that column; 512d int8 is the ANN index width, and *that* one is rebuildable,
 * because Matryoshka slicing a stored 768d vector reproduces any narrower width
 * exactly.
 *
 * The consequence these tests exist for: a dequantized int8 vector is no longer
 * unit-norm. Scoring it as though it were — the obvious optimization, since the
 * `EmbeddingProvider` port promises normalized output and cosine is then a plain
 * dot product — produces similarities above 1.0; 1.001 has been measured. A
 * score outside [-1, 1] silently breaks the §5.3 cosine floor, the §8.2 diameter
 * cap δ_max and every threshold in §15 expressed as a cosine. The store has to
 * clamp or renormalize, and the self-similarity case pins it — using the
 * {@link NORM_INFLATING_SEEDS} fixtures, because only a vector whose dequantized
 * norm exceeds one makes an unclamped scorer overshoot, and a seed picked at
 * random is as likely as not to deflate instead and pass vacuously.
 *
 * The schema deliberately does not constrain vector width — `embedding` is a
 * bare `z.array(z.number())` (back-annotation A22) — so the store boundary is
 * the only place a wrong-width vector can be caught. Those cases assert both
 * halves of that: the schema accepts, the store refuses.
 *
 * @spec §5.3, §11
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Claim, Entity } from '../../schema/index';
import {
  PINNED_DIMENSIONS,
  RERANK_DIMENSIONS,
  truncateEmbedding,
} from '../adapters/nomic-embedding-provider';
import {
  ANN_INDEX_DIMENSIONS,
  DimensionMismatchError,
  STORED_VECTOR_DIMENSIONS,
  dequantizeAnnVector,
  openGraphStore,
  type GraphStore,
} from '../index';

import {
  CLAIM_ID,
  ENTITY_ID,
  INT8_COMPONENT_TOLERANCE,
  NORM_INFLATING_SEED,
  NORM_INFLATING_SEEDS,
  RIVAL_CLAIM_ID,
  STORE_ANN_WIDTH,
  STORE_RERANK_WIDTH,
  cosine,
  makeClaim,
  makeEntity,
  unitVector,
  unitVectorArray,
} from './fixtures';

let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  store.putEntity(makeEntity());
});

afterEach(() => {
  store.close();
});

describe('the widths migration 0 pins', () => {
  it('keeps the full-precision copy at the width spike S2 pinned for rerank', () => {
    expect(STORED_VECTOR_DIMENSIONS).toBe(RERANK_DIMENSIONS);
  });

  it('keeps the ANN index at the width spike S2 pinned for retrieval', () => {
    expect(ANN_INDEX_DIMENSIONS).toBe(PINNED_DIMENSIONS);
  });

  it('agrees with the widths this suite builds its fixtures at', () => {
    expect([STORED_VECTOR_DIMENSIONS, ANN_INDEX_DIMENSIONS]).toStrictEqual([
      STORE_RERANK_WIDTH,
      STORE_ANN_WIDTH,
    ]);
  });

  it('keeps the ANN index narrower than the copy it is derived from', () => {
    expect(ANN_INDEX_DIMENSIONS).toBeLessThan(STORED_VECTOR_DIMENSIONS);
  });
});

describe('the full-precision rerank copy', () => {
  it('reloads a 768d vector with every component bit-identical', () => {
    const embedding = unitVector(20);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    expect(store.getRerankVector(CLAIM_ID)).toStrictEqual(embedding);
  });

  it('hands the rerank copy back as a Float32Array at full width', () => {
    store.putClaim(makeClaim({ embedding: unitVectorArray(21) }));

    const reloaded = store.getRerankVector(CLAIM_ID);

    expect(reloaded).toBeInstanceOf(Float32Array);
    expect(reloaded?.length).toBe(STORED_VECTOR_DIMENSIONS);
  });

  it('reloads the same vector through the claim schema as a plain number array', () => {
    const embedding = unitVectorArray(22);
    store.putClaim(makeClaim({ embedding }));

    expect(Claim.parse(store.getClaim(CLAIM_ID)).embedding).toStrictEqual(embedding);
  });

  it('preserves the extreme components a normalized vector can legitimately contain', () => {
    const embedding = new Float32Array(STORE_RERANK_WIDTH);
    embedding[0] = 1;
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    expect(store.getRerankVector(CLAIM_ID)).toStrictEqual(embedding);
  });

  it('preserves negative zero as distinct from the surrounding zeros it sits among', () => {
    const embedding = new Float32Array(STORE_RERANK_WIDTH);
    embedding[0] = 1;
    embedding[1] = -0;
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    expect(store.getRerankVector(CLAIM_ID)?.length).toBe(STORE_RERANK_WIDTH);
  });

  it('reloads the entity gloss embedding at full precision too, since §5.2 resolves against it', () => {
    const gloss = unitVectorArray(23);
    store.putEntity(makeEntity({ glossEmbedding: gloss }));

    expect(Entity.parse(store.getEntity(ENTITY_ID)).glossEmbedding).toStrictEqual(gloss);
  });

  it('returns undefined for a claim that was never written', () => {
    expect(store.getRerankVector(CLAIM_ID)).toBeUndefined();
  });
});

describe('the quantized ANN copy', () => {
  it('stores the in-graph copy as int8 rather than as another float array', () => {
    store.putClaim(makeClaim({ embedding: unitVectorArray(30) }));

    expect(store.getAnnVector(CLAIM_ID)).toBeInstanceOf(Int8Array);
  });

  it('narrows the in-graph copy to the ANN index width', () => {
    store.putClaim(makeClaim({ embedding: unitVectorArray(31) }));

    expect(store.getAnnVector(CLAIM_ID)?.length).toBe(ANN_INDEX_DIMENSIONS);
  });

  it('derives the narrow copy by Matryoshka slice, so it round-trips within the measured int8 tolerance', () => {
    const embedding = unitVector(32);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    const expected = truncateEmbedding(embedding, PINNED_DIMENSIONS);
    const actual = dequantizeAnnVector(store.getAnnVector(CLAIM_ID)!);

    for (let i = 0; i < ANN_INDEX_DIMENSIONS; i += 1)
      expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(INT8_COMPONENT_TOLERANCE);
  });

  it('stays close to the vector it was derived from, well above the §5.3 candidate floor', () => {
    const embedding = unitVector(33);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    const expected = truncateEmbedding(embedding, PINNED_DIMENSIONS);
    const actual = dequantizeAnnVector(store.getAnnVector(CLAIM_ID)!);

    expect(cosine(actual, expected)).toBeGreaterThan(0.999);
  });

  it('is rebuildable from the stored full-precision copy, which is why the ANN width is not a one-way door', () => {
    const embedding = unitVector(34);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    const rebuilt = truncateEmbedding(store.getRerankVector(CLAIM_ID)!, PINNED_DIMENSIONS);
    const expected = truncateEmbedding(embedding, PINNED_DIMENSIONS);

    expect(rebuilt).toStrictEqual(expected);
  });

  it('returns undefined for a claim that was never written', () => {
    expect(store.getAnnVector(CLAIM_ID)).toBeUndefined();
  });
});

describe('similarity scores the store reports', () => {
  it('never reports a similarity above 1.0 for a claim searched with its own embedding', () => {
    const embedding = unitVector(NORM_INFLATING_SEED);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    const [best] = store.searchClaims({ embedding, limit: 1 });

    expect(best?.claimId).toBe(CLAIM_ID);
    expect(best?.cosine).toBeLessThanOrEqual(1);
  });

  it.each(NORM_INFLATING_SEEDS)(
    'never reports a similarity above 1.0 for norm-inflating vector %i, where an unclamped scorer reports about 1.005',
    (seed) => {
      const embedding = unitVector(seed);
      store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

      const [best] = store.searchClaims({ embedding, limit: 1 });

      expect(best?.cosine).toBeLessThanOrEqual(1);
    },
  );

  it('still reports near-identity for its own embedding, so the clamp is not just flattening scores', () => {
    const embedding = unitVector(NORM_INFLATING_SEED);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    const [best] = store.searchClaims({ embedding, limit: 1 });

    expect(best?.cosine).toBeGreaterThan(0.99);
  });

  it('keeps every reported similarity inside the closed interval a cosine can occupy', () => {
    const embedding = unitVector(NORM_INFLATING_SEEDS[0]);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));
    store.putClaim(
      makeClaim({
        id: RIVAL_CLAIM_ID,
        text: 'A wholly unrelated proposition about the build system.',
        embedding: unitVectorArray(NORM_INFLATING_SEEDS[1]),
      }),
    );

    const scores = store.searchClaims({ embedding, limit: 10 }).map((hit) => hit.cosine);

    expect(scores.every((score) => score >= -1 && score <= 1)).toBe(true);
  });

  it('never reports a similarity below -1.0 for the antipode of a stored claim either', () => {
    const embedding = unitVector(NORM_INFLATING_SEED);
    const opposite = embedding.map((component) => -component);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));

    const scores = store.searchClaims({ embedding: opposite, limit: 10 }).map((hit) => hit.cosine);

    expect(scores.every((score) => score >= -1)).toBe(true);
  });

  it('ranks the nearer claim above the unrelated one', () => {
    const embedding = unitVector(45);
    store.putClaim(makeClaim({ embedding: Array.from(embedding) }));
    store.putClaim(
      makeClaim({
        id: RIVAL_CLAIM_ID,
        text: 'A wholly unrelated proposition about the build system.',
        embedding: unitVectorArray(46),
      }),
    );

    const hits = store.searchClaims({ embedding, limit: 10 });

    expect(hits.map((hit) => hit.claimId)[0]).toBe(CLAIM_ID);
  });

  it('honours the candidate cap, since §5.3 unions and dedupes to about fifteen', () => {
    for (let i = 0; i < 5; i += 1)
      store.putClaim(
        makeClaim({
          id: `${'0'.repeat(24)}V${i}`,
          text: `Proposition number ${String(i)}.`,
          embedding: unitVectorArray(50 + i),
        }),
      );

    expect(store.searchClaims({ embedding: unitVector(50), limit: 3 })).toHaveLength(3);
  });
});

describe('the dimension boundary the schema deliberately leaves open', () => {
  it('accepts a four-element claim embedding at schema level, which is why the store must check', () => {
    expect(Claim.safeParse(makeClaim({ embedding: [0.1, 0.2, 0.3, 0.4] })).success).toBe(true);
  });

  it('refuses a claim embedding narrower than the stored width', () => {
    expect(() => {
      store.putClaim(makeClaim({ embedding: unitVectorArray(60, STORE_ANN_WIDTH) }));
    }).toThrow(DimensionMismatchError);
  });

  it('refuses a claim embedding wider than the stored width', () => {
    expect(() => {
      store.putClaim(makeClaim({ embedding: unitVectorArray(61, STORE_RERANK_WIDTH + 1) }));
    }).toThrow(DimensionMismatchError);
  });

  it('refuses an empty claim embedding rather than storing a zero-length vector', () => {
    expect(() => {
      store.putClaim(makeClaim({ embedding: [] }));
    }).toThrow(DimensionMismatchError);
  });

  it('refuses an entity gloss embedding at the wrong width', () => {
    expect(() => {
      store.putEntity(makeEntity({ glossEmbedding: unitVectorArray(62, STORE_ANN_WIDTH) }));
    }).toThrow(DimensionMismatchError);
  });

  it('refuses a facet centroid at the wrong width, since facets are means of full-precision claims', () => {
    expect(() => {
      store.putEntity(makeEntity({ facets: [unitVectorArray(63, STORE_ANN_WIDTH)] }));
    }).toThrow(DimensionMismatchError);
  });

  it('refuses a query vector at the wrong width instead of returning nonsense neighbours', () => {
    store.putClaim(makeClaim({ embedding: unitVectorArray(64) }));

    expect(() => {
      store.searchClaims({ embedding: unitVector(65, STORE_ANN_WIDTH), limit: 5 });
    }).toThrow(DimensionMismatchError);
  });

  it('leaves nothing behind after a rejected write', () => {
    expect(() => {
      store.putClaim(makeClaim({ embedding: unitVectorArray(66, STORE_ANN_WIDTH) }));
    }).toThrow(DimensionMismatchError);

    expect(store.getClaim(CLAIM_ID)).toBeUndefined();
  });
});
