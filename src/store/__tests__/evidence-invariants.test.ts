/**
 * Property tests over the evidence the store actually persists.
 *
 * Two invariants are non-negotiable. §4.1 makes each claim's confidence a
 * Beta-Bernoulli posterior, and a Beta with a zero parameter is not a
 * distribution — so α and β must stay strictly positive through every
 * increment and every decay, and the posterior mean α/(α+β) must stay strictly
 * inside (0,1). Parsing the stored pair through `Evidence` is the assertion:
 * a persistence bug that rounds, truncates or nulls a parameter surfaces as a
 * schema violation rather than a silently wrong number.
 *
 * §4.5's churn decay is the easy one to get backwards. It moves both parameters
 * **toward the prior, never toward zero** — "churn makes the graph uncertain
 * again; it does not make claims false". Decaying toward zero would drive the
 * posterior mean nowhere in particular while collapsing the credible interval's
 * meaning; decaying toward the prior widens it, which is the whole point. These
 * properties pin direction, non-overshoot, and the fixed point.
 *
 * Every iteration runs against a fresh real in-memory SQLite store. Nothing is
 * mocked (plan §6).
 *
 * @spec §4.1, §4.5, §11, §15
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Evidence } from '../../schema/index';
import { openGraphStore, type GraphStore } from '../index';

import {
  CHURN_GAMMA,
  CLAIM_ID,
  LAST_CHURN_EVENT,
  makeClaim,
  PRIOR_ALPHA,
  PRIOR_BETA,
  seedEntityAndClaim,
} from './fixtures';

/** Property runs. Low enough that a fresh migrated database per iteration stays cheap. */
const NUM_RUNS = 50;

/**
 * Runs `body` against a freshly migrated in-memory store seeded with one claim
 * at the given starting evidence, and always closes it.
 *
 * @spec §4.1, §11
 */
export const withSeededStore = <T,>(evidence: Evidence, body: (store: GraphStore) => T): T => {
  const store = openGraphStore({ path: ':memory:' });
  try {
    seedEntityAndClaim(store, makeClaim({ evidence }));
    return body(store);
  } finally {
    store.close();
  }
};

/** One weighted contribution as §4.2 produces them: a non-negative nudge to one parameter or both. @spec §4.2 */
const contributionArb = fc.record({
  alpha: fc.double({ min: 0, max: 5, noNaN: true }),
  beta: fc.double({ min: 0, max: 5, noNaN: true }),
});

/** A plausible standing posterior: anything from an untouched prior to a well-corroborated claim. @spec §4.1 */
const evidenceArb = fc.record({
  alpha: fc.double({ min: 0.5, max: 500, noNaN: true }),
  beta: fc.double({ min: 0.5, max: 500, noNaN: true }),
});

/** A prior pair, covering both α₀=β₀=1 and the inferred-tier skeptical β₀=2. @spec §3.2, §15 */
const priorArb = fc.record({
  alpha: fc.double({ min: 0.5, max: 3, noNaN: true }),
  beta: fc.double({ min: 0.5, max: 3, noNaN: true }),
});

/** The per-commit retention factor γ, a genuine proportion. @spec §4.5, §15 */
const gammaArb = fc.double({ min: 0, max: 1, noNaN: true });

describe('the Beta-Bernoulli posterior the store hands back', () => {
  it('keeps alpha and beta strictly positive through any sequence of increments', () => {
    fc.assert(
      fc.property(fc.array(contributionArb, { maxLength: 20 }), (contributions) => {
        withSeededStore({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA }, (store) => {
          for (const contribution of contributions)
            store.incrementEvidence({ claimId: CLAIM_ID, ...contribution });

          expect(() => Evidence.parse(store.getEvidence(CLAIM_ID))).not.toThrow();
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps the posterior mean strictly inside the open interval (0,1) through any sequence of increments', () => {
    fc.assert(
      fc.property(fc.array(contributionArb, { maxLength: 20 }), (contributions) => {
        withSeededStore({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA }, (store) => {
          for (const contribution of contributions)
            store.incrementEvidence({ claimId: CLAIM_ID, ...contribution });

          const { alpha, beta } = Evidence.parse(store.getEvidence(CLAIM_ID));
          const mean = alpha / (alpha + beta);

          expect(mean).toBeGreaterThan(0);
          expect(mean).toBeLessThan(1);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps alpha and beta strictly positive through any decay', () => {
    fc.assert(
      fc.property(evidenceArb, priorArb, gammaArb, (start, prior, gamma) => {
        withSeededStore(start, (store) => {
          store.decayEvidence({ claimId: CLAIM_ID, gamma, prior, at: LAST_CHURN_EVENT });

          expect(() => Evidence.parse(store.getEvidence(CLAIM_ID))).not.toThrow();
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps the posterior mean strictly inside (0,1) through any decay', () => {
    fc.assert(
      fc.property(evidenceArb, priorArb, gammaArb, (start, prior, gamma) => {
        withSeededStore(start, (store) => {
          store.decayEvidence({ claimId: CLAIM_ID, gamma, prior, at: LAST_CHURN_EVENT });

          const { alpha, beta } = Evidence.parse(store.getEvidence(CLAIM_ID));
          const mean = alpha / (alpha + beta);

          expect(mean).toBeGreaterThan(0);
          expect(mean).toBeLessThan(1);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('churn decay moves evidence toward the prior', () => {
  it('never leaves a parameter further from the prior than it started', () => {
    fc.assert(
      fc.property(evidenceArb, priorArb, gammaArb, (start, prior, gamma) => {
        withSeededStore(start, (store) => {
          store.decayEvidence({ claimId: CLAIM_ID, gamma, prior, at: LAST_CHURN_EVENT });
          const after = Evidence.parse(store.getEvidence(CLAIM_ID));

          expect(Math.abs(after.alpha - prior.alpha)).toBeLessThanOrEqual(
            Math.abs(start.alpha - prior.alpha) + Number.EPSILON,
          );
          expect(Math.abs(after.beta - prior.beta)).toBeLessThanOrEqual(
            Math.abs(start.beta - prior.beta) + Number.EPSILON,
          );
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never crosses the prior, so a decayed parameter never overshoots into the other side', () => {
    fc.assert(
      fc.property(evidenceArb, priorArb, gammaArb, (start, prior, gamma) => {
        withSeededStore(start, (store) => {
          store.decayEvidence({ claimId: CLAIM_ID, gamma, prior, at: LAST_CHURN_EVENT });
          const after = Evidence.parse(store.getEvidence(CLAIM_ID));

          expect(Math.sign(after.alpha - prior.alpha) * Math.sign(start.alpha - prior.alpha)).not.toBe(-1);
          expect(Math.sign(after.beta - prior.beta) * Math.sign(start.beta - prior.beta)).not.toBe(-1);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('pulls a well-corroborated claim down toward the prior and not toward zero', () => {
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store, makeClaim({ evidence: { alpha: 41, beta: 13 } }));
      const prior = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA };

      for (let commit = 0; commit < 200; commit += 1)
        store.decayEvidence({ claimId: CLAIM_ID, gamma: CHURN_GAMMA, prior, at: LAST_CHURN_EVENT });
      const after = Evidence.parse(store.getEvidence(CLAIM_ID));

      expect(after.alpha).toBeCloseTo(prior.alpha, 9);
      expect(after.beta).toBeCloseTo(prior.beta, 9);
      expect(after.alpha).toBeGreaterThan(0.5);
      expect(after.beta).toBeGreaterThan(0.5);
    } finally {
      store.close();
    }
  });

  it('pulls a claim seeded on the skeptical inferred prior back to beta zero of two, not to one', () => {
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store, makeClaim({ evidence: { alpha: 30, beta: 9 } }));
      const prior = { alpha: PRIOR_ALPHA, beta: 2 };

      for (let commit = 0; commit < 200; commit += 1)
        store.decayEvidence({ claimId: CLAIM_ID, gamma: CHURN_GAMMA, prior, at: LAST_CHURN_EVENT });

      expect(Evidence.parse(store.getEvidence(CLAIM_ID)).beta).toBeCloseTo(2, 9);
    } finally {
      store.close();
    }
  });

  it('raises a parameter that sits below the prior, because decay is a pull and not a shrink', () => {
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store, makeClaim({ evidence: { alpha: 1, beta: 0.5 } }));

      store.decayEvidence({
        claimId: CLAIM_ID,
        gamma: CHURN_GAMMA,
        prior: { alpha: PRIOR_ALPHA, beta: 2 },
        at: LAST_CHURN_EVENT,
      });

      expect(Evidence.parse(store.getEvidence(CLAIM_ID)).beta).toBeGreaterThan(0.5);
    } finally {
      store.close();
    }
  });

  it('is a fixed point once evidence has reached the prior, so further commits change nothing', () => {
    const prior = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA };
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store, makeClaim({ evidence: prior }));

      for (let commit = 0; commit < 25; commit += 1)
        store.decayEvidence({ claimId: CLAIM_ID, gamma: CHURN_GAMMA, prior, at: LAST_CHURN_EVENT });

      expect(Evidence.parse(store.getEvidence(CLAIM_ID))).toStrictEqual(prior);
    } finally {
      store.close();
    }
  });

  it('leaves evidence untouched at gamma of one, the no-forgetting end of the dial', () => {
    fc.assert(
      fc.property(evidenceArb, priorArb, (start, prior) => {
        withSeededStore(start, (store) => {
          store.decayEvidence({ claimId: CLAIM_ID, gamma: 1, prior, at: LAST_CHURN_EVENT });
          const after = Evidence.parse(store.getEvidence(CLAIM_ID));

          expect(after.alpha).toBeCloseTo(start.alpha, 9);
          expect(after.beta).toBeCloseTo(start.beta, 9);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('collapses evidence straight onto the prior at gamma of zero, the total-forgetting end', () => {
    fc.assert(
      fc.property(evidenceArb, priorArb, (start, prior) => {
        withSeededStore(start, (store) => {
          store.decayEvidence({ claimId: CLAIM_ID, gamma: 0, prior, at: LAST_CHURN_EVENT });
          const after = Evidence.parse(store.getEvidence(CLAIM_ID));

          expect(after.alpha).toBeCloseTo(prior.alpha, 9);
          expect(after.beta).toBeCloseTo(prior.beta, 9);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('applies the spec formula exactly for a single commit', () => {
    const start = { alpha: 41, beta: 13 };
    const prior = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA };
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store, makeClaim({ evidence: start }));

      store.decayEvidence({ claimId: CLAIM_ID, gamma: CHURN_GAMMA, prior, at: LAST_CHURN_EVENT });
      const after = Evidence.parse(store.getEvidence(CLAIM_ID));

      expect(after.alpha).toBeCloseTo(prior.alpha + CHURN_GAMMA * (start.alpha - prior.alpha), 9);
      expect(after.beta).toBeCloseTo(prior.beta + CHURN_GAMMA * (start.beta - prior.beta), 9);
    } finally {
      store.close();
    }
  });

  it('stamps the churn instant on the claim, which is what the commit clock reads next time', () => {
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store, makeClaim({ temporal: { createdAt: '2026-08-01T00:00:00.000Z' } }));

      store.decayEvidence({
        claimId: CLAIM_ID,
        gamma: CHURN_GAMMA,
        prior: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA },
        at: LAST_CHURN_EVENT,
      });

      expect(store.getClaim(CLAIM_ID)?.temporal.lastChurnEvent).toBe(LAST_CHURN_EVENT);
    } finally {
      store.close();
    }
  });

  it('refuses a gamma above one, which would push evidence away from the prior instead of toward it', () => {
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store);

      expect(() => {
        store.decayEvidence({
          claimId: CLAIM_ID,
          gamma: 1.2,
          prior: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA },
          at: LAST_CHURN_EVENT,
        });
      }).toThrow(RangeError);
    } finally {
      store.close();
    }
  });

  it('refuses a negative gamma, which would flip the posterior across the prior', () => {
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store);

      expect(() => {
        store.decayEvidence({
          claimId: CLAIM_ID,
          gamma: -0.1,
          prior: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA },
          at: LAST_CHURN_EVENT,
        });
      }).toThrow(RangeError);
    } finally {
      store.close();
    }
  });

  it('refuses a non-positive prior, since the prior is itself a Beta parameter pair', () => {
    const store = openGraphStore({ path: ':memory:' });
    try {
      seedEntityAndClaim(store);

      expect(() => {
        store.decayEvidence({
          claimId: CLAIM_ID,
          gamma: CHURN_GAMMA,
          prior: { alpha: 0, beta: PRIOR_BETA },
          at: LAST_CHURN_EVENT,
        });
      }).toThrow(RangeError);
    } finally {
      store.close();
    }
  });
});
