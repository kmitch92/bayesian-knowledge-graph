/**
 * Shared fixtures for the P1 store suite.
 *
 * Everything here is deliberately resolvable *today*: the only reference to the
 * unwritten `../index` is a type-only import, which esbuild erases before the
 * module ever runs. That keeps the RED signal unambiguous — the suite fails on
 * the value imports in the `.test.ts` files, not on a broken fixture module.
 *
 * Two rules govern the vectors built here:
 *
 * 1. **Every vector crossing the store boundary is {@link STORE_RERANK_WIDTH}
 *    (768) f32.** §11 keeps "full precision retained for final rerank only" and
 *    stores a quantized copy for in-traversal scoring. The narrow copy is the
 *    store's business, derived internally by Matryoshka slice + int8 quantize,
 *    so callers only ever hand over full-width vectors.
 * 2. **Fixture components are f32-exact.** They are produced through a
 *    `Float32Array` and then widened back to `number[]`, so a lossless f32
 *    persistence layer must return them bit-for-bit. Without this the round-trip
 *    assertions would be testing f64→f32 rounding rather than the store.
 *
 * @spec §3.1, §3.2, §3.5, §11
 */

import type { Claim, Entity } from '../../schema/index';
import type { GraphStore } from '../index';

/**
 * Width of the full-precision copy every vector arrives at and leaves by.
 *
 * Migration 0 is final on this column (§11, spike S2). Asserted equal to the S2
 * adapter's own pin in `vectors.test.ts` rather than imported here, so the bulk
 * of the suite never pays transformers.js' module load.
 *
 * @spec §11
 */
export const STORE_RERANK_WIDTH = 768;

/**
 * Width of the int8 ANN index. Rebuildable, not final: Matryoshka slicing a
 * stored 768d f32 vector reproduces any narrower width exactly, so narrowing or
 * widening this later is an index rebuild rather than a re-embed.
 *
 * @spec §11
 */
export const STORE_ANN_WIDTH = 512;

/**
 * Largest per-component error a sane int8 scheme can introduce: half a
 * quantization step at the widest plausible scale (127 over a unit component).
 * Any implementation using 128, or a per-vector max-abs scale, lands inside it.
 *
 * @spec §11
 */
export const INT8_COMPONENT_TOLERANCE = 1 / 254;

/** Beta-Bernoulli prior α₀. @spec §4.1, §15 */
export const PRIOR_ALPHA = 1;

/** Beta-Bernoulli prior β₀ for verified- and observed-tier claims. @spec §4.1, §15 */
export const PRIOR_BETA = 1;

/** Skeptical prior β₀ seeded for inferred-tier claims. @spec §3.2, §15 */
export const PRIOR_BETA_INFERRED = 2;

/** §15 tier weights. Non-integer by construction — inferred is a half-observation. @spec §4.2, §15 */
export const TIER_WEIGHT = { verified: 3.0, observed: 1.0, inferred: 0.5 } as const;

/** §4.2 episode caps for the 1st, 2nd and 3rd contribution from one episode. @spec §4.2, §15 */
export const EPISODE_CAP = [1, 0.5, 0.25] as const;

/** Default churn-decay retention factor. @spec §4.5, §15 */
export const CHURN_GAMMA = 0.8;

/** Crockford base32 minus I, L, O and U — the ULID alphabet. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Substitutions that keep a human-readable label inside the ULID alphabet. */
const ULID_SUBSTITUTIONS: Readonly<Record<string, string>> = { I: '1', L: '1', O: '0', U: 'V' };

/**
 * Turns a readable label into a deterministic, schema-valid ULID.
 *
 * Zod's `.ulid()` refinement checks alphabet and length only, so a padded label
 * satisfies it while keeping assertion failures legible: a mismatch names
 * `CLA1M-A00000000000000000` rather than an opaque 26-character blob.
 *
 * @spec §3.1, §3.2
 */
export const testUlid = (label: string): string => {
  const mapped = [...label.toUpperCase()]
    .map((char) => ULID_SUBSTITUTIONS[char] ?? char)
    .filter((char) => ULID_ALPHABET.includes(char))
    .join('');
  return mapped.slice(0, 26).padEnd(26, '0');
};

/** The `AuthService` spine node most claim fixtures anchor to. @spec §3.1 */
export const ENTITY_ID = testUlid('ENTITY-AUTHSERVICE');

/** A second spine node, for tests that need a distinct scope. @spec §3.1 */
export const OTHER_ENTITY_ID = testUlid('ENTITY-COGNITOCLIENT');

/** The primary claim fixture. @spec §3.2 */
export const CLAIM_ID = testUlid('CLAIM-A');

/** A second claim, used as edge target and rival. @spec §3.2, §6.3 */
export const RIVAL_CLAIM_ID = testUlid('CLAIM-B');

/** A third claim, for lineage and supersession edges. @spec §3.3 */
export const THIRD_CLAIM_ID = testUlid('CLAIM-C');

/** Claim creation instant. Zod 3's `.datetime()` defaults to UTC-only. @spec §3.2 */
export const CREATED_AT = '2026-08-22T09:14:03.000Z';

/** Most recent corroboration instant. @spec §3.2 */
export const LAST_CORROBORATED = '2026-08-22T11:47:52.000Z';

/** Invalidation instant, stamped when a claim is deprecated. @spec §3.2, §6.1 */
export const INVALIDATED_AT = '2026-08-22T16:02:19.000Z';

/** Instant of the last commit whose churn touched the claim's provenance files. @spec §4.5 */
export const LAST_CHURN_EVENT = '2026-08-22T15:30:00.000Z';

/**
 * Line a concurrency worker writes to stdout once it has opened the shared
 * database and is parked at the barrier.
 *
 * @spec §5.7
 */
export const WORKER_READY = 'READY';

/**
 * Line the parent writes to a parked worker's stdin to release it. A handshake
 * rather than a wall-clock delay: a timing guess that a slow machine misses
 * degrades the test into three sequential runs, which a read-modify-write
 * implementation passes.
 *
 * @spec §5.7
 */
export const WORKER_GO = 'GO';

/** A session identifier, the key the taint set is recorded under. @spec §4.3, §7.5 */
export const SESSION_ID = 'sess-2026-08-22-0914';

/** A second session, used to prove taint does not leak between sessions. @spec §4.3 */
export const OTHER_SESSION_ID = 'sess-2026-08-22-1147';

/** An episode identifier, the second half of the stage-0 dedupe key. @spec §5.1 */
export const EPISODE_ID = 'ep-2026-08-22-0914';

/** A second episode: the same text from here is not a replay. @spec §5.1 */
export const OTHER_EPISODE_ID = 'ep-2026-08-22-1147';

/** Deterministic 32-bit PRNG, so every fixture vector is reproducible. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * A deterministic L2-normalized vector of the given width, exact in f32.
 *
 * The `EmbeddingProvider` port guarantees unit norm, so fixtures match that
 * contract: quantization error, not input scale, is what the §11 tolerance
 * assertions are measuring.
 *
 * @spec §11
 */
export const unitVector = (seed: number, width: number = STORE_RERANK_WIDTH): Float32Array => {
  const next = mulberry32(seed);
  const raw = new Float32Array(width);
  let norm = 0;
  for (let i = 0; i < width; i += 1) {
    const value = next() * 2 - 1;
    raw[i] = value;
    norm += value * value;
  }
  const inverse = 1 / Math.sqrt(norm);
  for (let i = 0; i < width; i += 1) raw[i] = raw[i]! * inverse;
  return raw;
};

/**
 * The same vector as a plain `number[]`, which is what `Claim.embedding` and
 * `Entity.glossEmbedding` are typed as. Widening f32 to f64 is exact, so a
 * lossless store must hand these back unchanged.
 *
 * @spec §3.2, §3.5, §11
 */
export const unitVectorArray = (seed: number, width: number = STORE_RERANK_WIDTH): number[] =>
  Array.from(unitVector(seed, width));

/**
 * Seeds whose 512d int8 copy dequantizes to an L2 norm *above* one.
 *
 * Round-to-nearest quantization perturbs a unit vector's norm in both
 * directions, and only about 60% of random unit vectors come back inflated. So
 * the choice of seed decides whether the §11 clamp is actually under test: on a
 * deflated vector an unclamped scorer reports 0.998 and sails through
 * `toBeLessThanOrEqual(1)`, testing nothing.
 *
 * Measured for each seed here, at both plausible int8 scales (127 and 128):
 * a scorer that dequantizes the stored copy and dots it against a unit query
 * reports ≥ 1.004; one that quantizes the query too reports ≥ 1.011. Both are
 * above 1.0 by far more than float noise, so a missing clamp fails loudly.
 *
 * @spec §11
 */
export const NORM_INFLATING_SEEDS = [8, 14, 29] as const;

/** The canonical member of {@link NORM_INFLATING_SEEDS}: unclamped self-similarity measures 1.0066. @spec §11 */
export const NORM_INFLATING_SEED = 29;

/** Cosine similarity computed in f64, the reference the store's ANN score is checked against. @spec §11 */
export const cosine = (left: Float32Array, right: Float32Array): number => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
};

/**
 * A complete entity: a parsed `component` node with every optional and every
 * defaulted field explicitly present, so a round-trip must return it exactly.
 *
 * @spec §3.1, §3.5
 */
export const makeEntity = (overrides: Partial<Entity> = {}): Entity =>
  ({
    id: ENTITY_ID,
    name: 'AuthService',
    aliases: ['auth-service', 'the auth thing'],
    level: 'component',
    origin: 'parsed',
    ref: { path: 'src/auth/index.ts', symbolRange: [1, 412] },
    glossEmbedding: unitVectorArray(1),
    facets: [unitVectorArray(2), unitVectorArray(3)],
    ...overrides,
  }) as Entity;

/**
 * The same entity stripped to required fields, so `aliases` and `facets`
 * defaults must materialize on the way back out.
 *
 * @spec §3.1, §3.5
 */
export const makeMinimalEntity = (overrides: Partial<Entity> = {}): Entity =>
  ({
    id: OTHER_ENTITY_ID,
    name: 'CognitoClient',
    level: 'module',
    origin: 'asserted',
    glossEmbedding: unitVectorArray(4),
    ...overrides,
  }) as Entity;

/**
 * A complete claim: observed-tier convention, active, anchored at
 * {@link ENTITY_ID}, carrying all four `temporal` fields and a populated
 * provenance triple.
 *
 * @spec §3.2, §3.5
 */
export const makeClaim = (overrides: Partial<Claim> = {}): Claim =>
  ({
    id: CLAIM_ID,
    text: 'Session refresh handlers in AuthService are idempotent under retry.',
    embedding: unitVectorArray(10),
    kind: 'convention',
    tier: 'observed',
    status: 'active',
    evidence: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA },
    scope: ENTITY_ID,
    temporal: {
      createdAt: CREATED_AT,
      lastCorroborated: LAST_CORROBORATED,
      invalidatedAt: INVALIDATED_AT,
      lastChurnEvent: LAST_CHURN_EVENT,
    },
    provenance: {
      episodes: [EPISODE_ID, OTHER_EPISODE_ID],
      commits: ['9f2c1ab4e7d05b3c8a6f41d29e0b7c5a3d81f6e2'],
      files: ['src/auth/session.ts', 'src/auth/refresh.ts'],
    },
    canonical: true,
    ...overrides,
  }) as Claim;

/**
 * A freshly minted raw claim: required fields only, empty provenance arrays,
 * nothing corroborated or churned yet, so `canonical` must default to `false`.
 *
 * @spec §3.2, §3.5
 */
export const makeMinimalClaim = (overrides: Partial<Claim> = {}): Claim =>
  ({
    id: RIVAL_CLAIM_ID,
    text: 'AuthService.refresh retries twice before surfacing an error.',
    embedding: unitVectorArray(11),
    kind: 'fact',
    tier: 'inferred',
    status: 'provisional',
    evidence: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA_INFERRED },
    scope: ENTITY_ID,
    temporal: { createdAt: CREATED_AT },
    provenance: { episodes: [], commits: [], files: [] },
    ...overrides,
  }) as Claim;

/**
 * Puts the spine node every claim fixture is anchored to, then one claim on it.
 * Returns nothing: the ids are module constants, and a helper that re-returned
 * them would invite tests to depend on call order.
 *
 * @spec §3.1, §3.2
 */
export const seedEntityAndClaim = (store: GraphStore, claim: Claim = makeClaim()): void => {
  store.putEntity(makeEntity());
  store.putClaim(claim);
};
