/**
 * §5.7 concurrency, in-process half.
 *
 * "α/β updates are atomic increments in the database, never read-modify-write in
 * the MCP server. Two agents updating the same claim concurrently must not drop
 * evidence." The §12 registry files this as *lost updates*, mitigated day one.
 *
 * These cases pin the shape of the increment API — additive, commutative,
 * fraction-preserving, refusing to move evidence downward. The proof that the
 * mechanism survives *separate OS processes* lives in
 * `multi-process-increments.test.ts`; in-process ordering games cannot establish
 * it, because a single Node process serializes every better-sqlite3 call anyway.
 *
 * @spec §4.1, §4.2, §5.7, §12, §15
 */

import { afterEach, describe, expect, it } from 'vitest';

import { Evidence } from '../../schema/index';
import { openGraphStore, UnknownClaimError, type GraphStore } from '../index';

import {
  CLAIM_ID,
  ENTITY_ID,
  EPISODE_CAP,
  makeClaim,
  PRIOR_ALPHA,
  PRIOR_BETA,
  seedEntityAndClaim,
  TIER_WEIGHT,
} from './fixtures';

let store: GraphStore | undefined;

/**
 * Opens a real in-memory SQLite store. No store is ever mocked: the failure
 * this file guards lives in SQL statement shape, and a fake would assert the
 * mock rather than the mechanism (plan §6).
 *
 * @spec §11
 */
const openSeeded = (claim = makeClaim()): GraphStore => {
  const opened = openGraphStore({ path: ':memory:' });
  seedEntityAndClaim(opened, claim);
  store = opened;
  return opened;
};

afterEach(() => {
  store?.close();
  store = undefined;
});

describe('atomic evidence increments', () => {
  it('adds the increment to the stored alpha rather than replacing it', () => {
    const graph = openSeeded();

    graph.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID))).toStrictEqual({
      alpha: PRIOR_ALPHA + 1,
      beta: PRIOR_BETA,
    });
  });

  it('adds the increment to the stored beta rather than replacing it', () => {
    const graph = openSeeded();

    graph.incrementEvidence({ claimId: CLAIM_ID, beta: 1 });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID))).toStrictEqual({
      alpha: PRIOR_ALPHA,
      beta: PRIOR_BETA + 1,
    });
  });

  it('moves alpha and beta together in one call without either overwriting the other', () => {
    const graph = openSeeded();

    graph.incrementEvidence({ claimId: CLAIM_ID, alpha: 2, beta: 3 });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID))).toStrictEqual({
      alpha: PRIOR_ALPHA + 2,
      beta: PRIOR_BETA + 3,
    });
  });

  it('accumulates every increment in a long run, losing none', () => {
    const graph = openSeeded();

    for (let i = 0; i < 500; i += 1) graph.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 500);
  });

  it('reaches the same posterior whatever order the increments arrive in', () => {
    const contributions = [
      { alpha: TIER_WEIGHT.verified },
      { beta: TIER_WEIGHT.observed },
      { alpha: TIER_WEIGHT.inferred },
      { beta: TIER_WEIGHT.verified * EPISODE_CAP[1] },
      { alpha: TIER_WEIGHT.observed * EPISODE_CAP[2] },
    ];

    const forwards = openSeeded();
    for (const contribution of contributions)
      forwards.incrementEvidence({ claimId: CLAIM_ID, ...contribution });
    const forwardEvidence = Evidence.parse(forwards.getEvidence(CLAIM_ID));
    forwards.close();

    const backwards = openSeeded();
    for (const contribution of [...contributions].reverse())
      backwards.incrementEvidence({ claimId: CLAIM_ID, ...contribution });

    expect(Evidence.parse(backwards.getEvidence(CLAIM_ID))).toStrictEqual(forwardEvidence);
  });

  it('interleaves alpha-only and beta-only increments without either channel dropping a contribution', () => {
    const graph = openSeeded();

    for (let i = 0; i < 40; i += 1) {
      graph.incrementEvidence({ claimId: CLAIM_ID, alpha: 0.5 });
      graph.incrementEvidence({ claimId: CLAIM_ID, beta: 0.25 });
    }

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID))).toStrictEqual({
      alpha: PRIOR_ALPHA + 20,
      beta: PRIOR_BETA + 10,
    });
  });

  it('leaves the untouched parameter exactly as it was', () => {
    const graph = openSeeded();

    graph.incrementEvidence({ claimId: CLAIM_ID, alpha: 7.5 });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID)).beta).toBe(PRIOR_BETA);
  });
});

describe('fractional weights, because §15 tier weights and episode caps are not integers', () => {
  it('stores an inferred-tier half-observation without rounding it to a whole one', () => {
    const graph = openSeeded();

    graph.incrementEvidence({ claimId: CLAIM_ID, alpha: TIER_WEIGHT.inferred });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 0.5);
  });

  it('stores a verified-tier weight of 3.0 at full strength', () => {
    const graph = openSeeded();

    graph.incrementEvidence({ claimId: CLAIM_ID, alpha: TIER_WEIGHT.verified });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 3);
  });

  it('stores a quarter-capped repeat contribution as a quarter, not as zero and not as one', () => {
    const graph = openSeeded();
    const weight = TIER_WEIGHT.observed * EPISODE_CAP[2];

    graph.incrementEvidence({ claimId: CLAIM_ID, alpha: weight });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 0.25);
  });

  it('accumulates a decaying episode-capped series to its exact fractional sum', () => {
    const graph = openSeeded();
    const weights = EPISODE_CAP.map((cap) => cap * TIER_WEIGHT.verified);

    for (const weight of weights) graph.incrementEvidence({ claimId: CLAIM_ID, alpha: weight });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 3 + 1.5 + 0.75);
  });

  it('survives a thousand fractional increments without integer truncation', () => {
    const graph = openSeeded();

    for (let i = 0; i < 1000; i += 1)
      graph.incrementEvidence({ claimId: CLAIM_ID, alpha: TIER_WEIGHT.inferred });

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID)).alpha).toBe(PRIOR_ALPHA + 500);
  });
});

describe('the increment boundary', () => {
  it('refuses a negative alpha, because decay is the only path that moves evidence down', () => {
    const graph = openSeeded();

    expect(() => {
      graph.incrementEvidence({ claimId: CLAIM_ID, alpha: -1 });
    }).toThrow(RangeError);
  });

  it('refuses a negative beta for the same reason', () => {
    const graph = openSeeded();

    expect(() => {
      graph.incrementEvidence({ claimId: CLAIM_ID, beta: -0.5 });
    }).toThrow(RangeError);
  });

  it('refuses a non-finite increment rather than poisoning the posterior with NaN', () => {
    const graph = openSeeded();

    expect(() => {
      graph.incrementEvidence({ claimId: CLAIM_ID, alpha: Number.NaN });
    }).toThrow(RangeError);
  });

  it('refuses to increment a claim that does not exist instead of silently doing nothing', () => {
    const graph = openSeeded();

    expect(() => {
      graph.incrementEvidence({ claimId: makeClaim().id.replace(/.$/, 'Z'), alpha: 1 });
    }).toThrow(UnknownClaimError);
  });

  it('refuses to put evidence on an entity, which carries no posterior at all', () => {
    const graph = openSeeded();

    expect(() => {
      graph.incrementEvidence({ claimId: ENTITY_ID, alpha: 1 });
    }).toThrow(UnknownClaimError);
  });

  it('leaves the posterior untouched after a rejected increment', () => {
    const graph = openSeeded();

    expect(() => {
      graph.incrementEvidence({ claimId: CLAIM_ID, alpha: -1 });
    }).toThrow(RangeError);

    expect(Evidence.parse(graph.getEvidence(CLAIM_ID))).toStrictEqual({
      alpha: PRIOR_ALPHA,
      beta: PRIOR_BETA,
    });
  });
});
