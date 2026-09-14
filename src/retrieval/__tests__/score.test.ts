/**
 * Scoring a gathered claim for serving: relevance × confidence × status_penalty × freshness.
 *
 * This module decides when claims are served and how they rank. The values chosen for
 * STATUS_PENALTY (active 1, disputed 0.75, provisional 0.5, deprecated/archived unserved),
 * ANCESTOR_DECAY (0.8), and freshness (1 in v1) are deliberate v1 choices left open by
 * §7.1 and §15, to be reviewed at the phase-1 checkpoint.
 *
 * @spec §7.1 step 3, §15
 */

import { describe, expect, it } from 'vitest';

import { type ClaimStatus } from '../../schema/index';
import {
  ANCESTOR_DECAY,
  bandRelevance,
  confidence,
  posteriorWidth,
  scoreClaim,
  statusPenalty,
} from '../score';

describe('score', () => {
  describe('posteriorWidth', () => {
    it('returns 0 for null evidence (view-regime claim)', () => {
      expect(posteriorWidth(null)).toBe(0);
    });

    it('computes Beta(1,2) width as ~0.9239', () => {
      expect(posteriorWidth({ alpha: 1, beta: 2 })).toBeCloseTo(0.9239, 4);
    });

    it('computes Beta(8,2) width as ~0.4728', () => {
      expect(posteriorWidth({ alpha: 8, beta: 2 })).toBeCloseTo(0.4728, 4);
    });

    it('computes Beta(40,10) width as ~0.2196', () => {
      expect(posteriorWidth({ alpha: 40, beta: 10 })).toBeCloseTo(0.2196, 4);
    });

    it('clamps Beta(1,1) width to 1', () => {
      expect(posteriorWidth({ alpha: 1, beta: 1 })).toBe(1);
    });
  });

  describe('confidence', () => {
    it('returns 1 for null evidence (view-regime claim)', () => {
      expect(confidence(null)).toBe(1);
    });

    it('computes Beta(8,2) confidence as 0.8', () => {
      expect(confidence({ alpha: 8, beta: 2 })).toBeCloseTo(0.8, 4);
    });

    it('computes Beta(1,2) confidence as ~0.3333', () => {
      expect(confidence({ alpha: 1, beta: 2 })).toBeCloseTo(0.3333, 4);
    });
  });

  describe('statusPenalty', () => {
    it('assigns penalties to all five claim statuses', () => {
      const penalties: Record<ClaimStatus, number | undefined> = {
        active: statusPenalty('active'),
        disputed: statusPenalty('disputed'),
        provisional: statusPenalty('provisional'),
        deprecated: statusPenalty('deprecated'),
        archived: statusPenalty('archived'),
      };

      expect(penalties).toStrictEqual({
        active: 1,
        disputed: 0.75,
        provisional: 0.5,
        deprecated: undefined,
        archived: undefined,
      });
    });
  });

  describe('ANCESTOR_DECAY', () => {
    it('is 0.8', () => {
      expect(ANCESTOR_DECAY).toBe(0.8);
    });
  });

  describe('bandRelevance', () => {
    it('returns 1 for anchor band', () => {
      expect(bandRelevance({ kind: 'anchor' })).toBe(1);
    });

    it('returns 0.8 for ancestor depth 1', () => {
      expect(bandRelevance({ kind: 'ancestor', depth: 1 })).toBe(0.8);
    });

    it('returns 0.64 for ancestor depth 2', () => {
      expect(bandRelevance({ kind: 'ancestor', depth: 2 })).toBeCloseTo(0.64, 4);
    });

    it('returns cosine similarity for ann band', () => {
      expect(bandRelevance({ kind: 'ann', cosine: 0.83 })).toBe(0.83);
    });
  });

  describe('scoreClaim', () => {
    it('multiplies bandRelevance × confidence × statusPenalty', () => {
      expect(
        scoreClaim({
          band: { kind: 'anchor' },
          evidence: { alpha: 8, beta: 2 },
          status: 'active',
        }),
      ).toBeCloseTo(0.8, 4);
    });

    it('scores ancestor depth 1, Beta(1,2), provisional as ~0.1333', () => {
      expect(
        scoreClaim({
          band: { kind: 'ancestor', depth: 1 },
          evidence: { alpha: 1, beta: 2 },
          status: 'provisional',
        }),
      ).toBeCloseTo(0.1333, 4);
    });

    it('scores ann cosine 0.9, null evidence, disputed as 0.675', () => {
      expect(
        scoreClaim({
          band: { kind: 'ann', cosine: 0.9 },
          evidence: null,
          status: 'disputed',
        }),
      ).toBeCloseTo(0.675, 4);
    });

    it('returns undefined for deprecated status', () => {
      expect(
        scoreClaim({
          band: { kind: 'anchor' },
          evidence: { alpha: 8, beta: 2 },
          status: 'deprecated',
        }),
      ).toBeUndefined();
    });

    it('ranks active Beta(1,1) two ancestors up above provisional Beta(1,2) at anchor', () => {
      const activeAncestorScore = scoreClaim({
        band: { kind: 'ancestor', depth: 2 },
        evidence: { alpha: 1, beta: 1 },
        status: 'active',
      });

      const provisionalAnchorScore = scoreClaim({
        band: { kind: 'anchor' },
        evidence: { alpha: 1, beta: 2 },
        status: 'provisional',
      });

      expect(activeAncestorScore).toBeDefined();
      expect(provisionalAnchorScore).toBeDefined();
      expect(activeAncestorScore).toBeGreaterThan(provisionalAnchorScore!);
    });
  });
});
