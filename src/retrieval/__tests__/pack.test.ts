/**
 * Shaping ranked claims into ServedClaim objects and fitting them to the token budget.
 *
 * This module shapes retrieved claims for serving: copying the fields the client
 * needs, computing posterior summaries from Beta evidence, and packing claims
 * into a token budget by ranked order. v1 has no canonical views, so every
 * served claim is a raw claim with canonical false and no disclosure; the
 * 4-characters-per-token estimate is a v1 choice.
 *
 * @spec §7.1 step 4, §10
 */

import { describe, expect, it } from 'vitest';

import { ServedClaim } from '../../schema/index';
import {
  makeClaim,
  makeMinimalClaim,
  makeViewClaim,
} from '../../store/__tests__/fixtures';
import { packClaims, servedClaimOf, estimateTokens } from '../pack';

describe('pack', () => {
  describe('servedClaimOf', () => {
    it('copies id, text, kind, tier, status, scope, canonical from claim', () => {
      const claim = makeClaim();
      const served = servedClaimOf(claim);

      expect(served.id).toBe(claim.id);
      expect(served.text).toBe(claim.text);
      expect(served.kind).toBe(claim.kind);
      expect(served.tier).toBe(claim.tier);
      expect(served.status).toBe(claim.status);
      expect(served.scope).toBe(claim.scope);
      expect(served.canonical).toBe(claim.canonical);
    });

    it('computes posteriorMean as alpha/(alpha+beta) for evidence claim', () => {
      const claim = makeClaim({ evidence: { alpha: 8, beta: 2 } });
      const served = servedClaimOf(claim);

      expect(served.posteriorMean).toBeCloseTo(0.8, 4);
    });

    it('computes posteriorMean as 1 for view claim with null evidence', () => {
      const claim = makeViewClaim();
      const served = servedClaimOf(claim);

      expect(served.posteriorMean).toBe(1);
    });

    it('computes posteriorWidth as ~0.4728 for Beta(8,2)', () => {
      const claim = makeClaim({ evidence: { alpha: 8, beta: 2 } });
      const served = servedClaimOf(claim);

      expect(served.posteriorWidth).toBeCloseTo(0.4728, 4);
    });

    it('computes posteriorWidth as 0 for view claim with null evidence', () => {
      const claim = makeViewClaim();
      const served = servedClaimOf(claim);

      expect(served.posteriorWidth).toBe(0);
    });

    it('returns object without disclosure key', () => {
      const claim = makeClaim();
      const served = servedClaimOf(claim);

      expect(served).not.toHaveProperty('disclosure');
    });

    it('returns object without rivals key', () => {
      const claim = makeClaim();
      const served = servedClaimOf(claim);

      expect(served).not.toHaveProperty('rivals');
    });

    it('satisfies ServedClaim.parse without throwing', () => {
      const claim = makeClaim();
      const served = servedClaimOf(claim);

      expect(() => ServedClaim.parse(served)).not.toThrow();
    });

    it('returns exact structure without undefined keys for toStrictEqual', () => {
      const claim = makeClaim();
      const served = servedClaimOf(claim);

      const expected = {
        id: claim.id,
        text: claim.text,
        kind: claim.kind,
        tier: claim.tier,
        status: claim.status,
        scope: claim.scope,
        canonical: claim.canonical,
        posteriorMean: expect.any(Number),
        posteriorWidth: expect.any(Number),
      };

      expect(served).toStrictEqual(expected);
    });

    it('view claim produces posteriorMean 1 and posteriorWidth 0', () => {
      const claim = makeViewClaim();
      const served = servedClaimOf(claim);

      expect(served.posteriorMean).toBe(1);
      expect(served.posteriorWidth).toBe(0);
    });

    it('minimal claim with Beta(1,2) produces correct posteriors', () => {
      const claim = makeMinimalClaim({ evidence: { alpha: 1, beta: 2 } });
      const served = servedClaimOf(claim);

      expect(served.posteriorMean).toBeCloseTo(1 / 3, 4);
      expect(served.posteriorWidth).toBeCloseTo(0.9239, 4);
    });
  });

  describe('estimateTokens', () => {
    it('returns a positive integer', () => {
      const claim = makeClaim();
      const served = servedClaimOf(claim);
      const tokens = estimateTokens(served);

      expect(Number.isInteger(tokens)).toBe(true);
      expect(tokens).toBeGreaterThan(0);
    });

    it('claims with 400 character longer text estimate exactly 100 more tokens', () => {
      const shortClaim = makeClaim({ text: 'x' });
      const shortServed = servedClaimOf(shortClaim);
      const shortTokens = estimateTokens(shortServed);

      const longClaim = makeClaim({ text: 'x'.repeat(401) });
      const longServed = servedClaimOf(longClaim);
      const longTokens = estimateTokens(longServed);

      expect(longTokens - shortTokens).toBe(100);
    });
  });

  describe('packClaims', () => {
    it('returns all claims when all fit the budget', () => {
      const ranked = [
        { claim: makeClaim({ text: 'Short text 1' }) },
        { claim: makeClaim({ text: 'Short text 2' }) },
        { claim: makeClaim({ text: 'Short text 3' }) },
      ];

      const budgetTokens = 10000;
      const packed = packClaims(ranked, budgetTokens);

      expect(packed).toHaveLength(3);
      expect(packed[0]?.text).toBe('Short text 1');
      expect(packed[1]?.text).toBe('Short text 2');
      expect(packed[2]?.text).toBe('Short text 3');
    });

    it('returns empty array when budget is 0', () => {
      const ranked = [{ claim: makeClaim() }];
      const packed = packClaims(ranked, 0);

      expect(packed).toStrictEqual([]);
    });

    it('serves smaller lower-ranked claims when a large first claim does not fit', () => {
      const largeClaim = makeClaim({
        id: 'A'.repeat(26),
        text: 'x'.repeat(4000),
      });
      const largeServed = servedClaimOf(largeClaim);
      estimateTokens(largeServed);

      const smallClaim1 = makeClaim({
        id: 'B'.repeat(26),
        text: 'small claim 1',
      });
      const smallServed1 = servedClaimOf(smallClaim1);
      const smallTokens1 = estimateTokens(smallServed1);

      const smallClaim2 = makeClaim({
        id: 'C'.repeat(26),
        text: 'small claim 2',
      });
      const smallServed2 = servedClaimOf(smallClaim2);
      const smallTokens2 = estimateTokens(smallServed2);

      const ranked = [{ claim: largeClaim }, { claim: smallClaim1 }, { claim: smallClaim2 }];
      const budgetTokens = smallTokens1 + smallTokens2 + 10; // Fits both small claims, not large

      const packed = packClaims(ranked, budgetTokens);

      expect(packed.length).toBe(2);
      expect(packed[0]?.id).toBe(smallClaim1.id);
      expect(packed[1]?.id).toBe(smallClaim2.id);
    });

    it('returns all claims when budget exactly equals sum of estimates', () => {
      const claim1 = makeClaim({ id: 'CLAIM1111111111111111111111', text: 'text one' });
      const claim2 = makeClaim({ id: 'CLAIM2222222222222222222222', text: 'text two' });

      const served1 = servedClaimOf(claim1);
      const served2 = servedClaimOf(claim2);
      const tokens1 = estimateTokens(served1);
      const tokens2 = estimateTokens(served2);

      const ranked = [{ claim: claim1 }, { claim: claim2 }];
      const budgetTokens = tokens1 + tokens2;

      const packed = packClaims(ranked, budgetTokens);

      expect(packed.map((c: ServedClaim) => c.id)).toStrictEqual(['CLAIM1111111111111111111111', 'CLAIM2222222222222222222222']);
    });

    it('boundary: budget = tokens1 + tokens2 - 1 serves only claim1', () => {
      const claim1 = makeClaim({ id: 'CLAIM1111111111111111111111', text: 'text one' });
      const claim2 = makeClaim({ id: 'CLAIM2222222222222222222222', text: 'text two' });

      const served1 = servedClaimOf(claim1);
      const served2 = servedClaimOf(claim2);
      const tokens1 = estimateTokens(served1);
      const tokens2 = estimateTokens(served2);

      const ranked = [{ claim: claim1 }, { claim: claim2 }];
      const budgetTokens = tokens1 + tokens2 - 1;

      const packed = packClaims(ranked, budgetTokens);

      expect(packed.map((c: ServedClaim) => c.id)).toStrictEqual(['CLAIM1111111111111111111111']);
    });

    it('continues walking after skipping a claim that does not fit', () => {
      const claim1 = makeClaim({ id: 'CLAIM1111111111111111111111', text: 'x'.repeat(3000) });
      const served1 = servedClaimOf(claim1);
      const tokens1 = estimateTokens(served1);

      const claim2 = makeClaim({ id: 'CLAIM2222222222222222222222', text: 'small' });
      const served2 = servedClaimOf(claim2);
      const tokens2 = estimateTokens(served2);

      const claim3 = makeClaim({ id: 'CLAIM3333333333333333333333', text: 'x'.repeat(2000) });
      const served3 = servedClaimOf(claim3);
      const tokens3 = estimateTokens(served3);

      const ranked = [{ claim: claim1 }, { claim: claim2 }, { claim: claim3 }];
      const budgetTokens = tokens2 + tokens3 + 10; // Fits claims 2 and 3, not 1

      expect(budgetTokens).toBeLessThan(tokens1); // Verify claim 1 doesn't fit

      const packed = packClaims(ranked, budgetTokens);

      expect(packed.map((c: ServedClaim) => c.id)).toStrictEqual(['CLAIM2222222222222222222222', 'CLAIM3333333333333333333333']);
    });

    it('preserves input order in output', () => {
      const claims = [
        makeClaim({ id: 'CLAIM1111111111111111111111' }),
        makeClaim({ id: 'CLAIM2222222222222222222222' }),
        makeClaim({ id: 'CLAIM3333333333333333333333' }),
      ];

      const ranked = claims.map((claim) => ({ claim }));
      const budgetTokens = 50000;

      const packed = packClaims(ranked, budgetTokens);

      expect(packed[0]?.id).toBe('CLAIM1111111111111111111111');
      expect(packed[1]?.id).toBe('CLAIM2222222222222222222222');
      expect(packed[2]?.id).toBe('CLAIM3333333333333333333333');
    });
  });
});
