/**
 * Collecting and ranking the claims a query may serve.
 *
 * The orchestrator's design for §7.1 steps 2–3 and §7.2: gathering candidate
 * claims reachable through two paths (spine and ANN), ranking them by a uniform
 * scoring function, and returning them sorted for the next stage.
 *
 * The v1 bands (anchor + containment ancestors; no structural floor or children
 * yet) make this suite deliberately narrow: spine reaches one anchor and every
 * ancestor on the containment spine; ANN reaches all claim embeddings above the
 * cosine floor. The scoring rule combines band relevance, posterior confidence,
 * and status penalty — deprecated and archived claims are dropped outright.
 *
 * @spec §7.1, §7.2, §7.8
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gather } from '../gather';
import { openGraphStore, type GraphStore } from '../../store/index';
import {
  ENTITY_ID,
  OTHER_ENTITY_ID,
  CLAIM_ID,
  RIVAL_CLAIM_ID,
  THIRD_CLAIM_ID,
  makeEntity,
  makeMinimalEntity,
  makeClaim,
  makeMinimalClaim,
  testUlid,
} from '../../store/__tests__/fixtures';
import {
  fakeEmbeddings,
  type FakeEmbeddings,
  declaredVector,
  queriedTexts,
} from '../../referents/__tests__/fixtures';

/** A third spine node, for the ancestor depth test. */
const ROOT_ENTITY_ID = testUlid('ENTITY-ROOT');

/** A fourth spine node, for testing siblings (not ancestors). */
const SIBLING_ENTITY_ID = testUlid('ENTITY-SIBLING');

let store: GraphStore;
let embeddings: FakeEmbeddings;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  embeddings = fakeEmbeddings();
});

afterEach(() => {
  store.close();
});

describe('gather', () => {
  describe('case 1: anchor band with active and provisional claims', () => {
    it('returns both ABOUT the anchor, sorted by score descending', async () => {
      store.putEntity(makeEntity());

      // Active Beta(8,2) claim ABOUT the anchor
      const activeClaim = makeClaim({
        id: CLAIM_ID,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
      });
      store.putClaim(activeClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      // Provisional Beta(1,2) claim ABOUT the anchor
      const provisionalClaim = makeMinimalClaim({
        id: RIVAL_CLAIM_ID,
        status: 'provisional',
        evidence: { alpha: 1, beta: 2 },
      });
      store.putClaim(provisionalClaim);
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(result).toHaveLength(2);
      expect(result[0]!.claim.id).toBe(CLAIM_ID);
      expect(result[0]!.band).toStrictEqual({ kind: 'anchor' });
      expect(result[0]!.score).toBeCloseTo(0.8, 4);

      expect(result[1]!.claim.id).toBe(RIVAL_CLAIM_ID);
      expect(result[1]!.band).toStrictEqual({ kind: 'anchor' });
      expect(result[1]!.score).toBeCloseTo(0.1667, 3);
    });
  });

  describe('case 2: ancestor depth tracking', () => {
    it('returns claims ABOUT parent with depth:1 and root with depth:2, with correct scores', async () => {
      // Build: ROOT > PARENT > ANCHOR
      const parentId = testUlid('ENTITY-PARENT');
      store.putEntity(makeEntity({ id: ROOT_ENTITY_ID }));
      store.putEntity(makeEntity({ id: parentId }));
      store.putEntity(makeEntity({ id: ENTITY_ID }));

      // Active Beta(8,2) claim ABOUT the parent (depth 1)
      const parentClaim = makeClaim({
        id: CLAIM_ID,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
      });
      store.putClaim(parentClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: parentId });

      // Active Beta(8,2) claim ABOUT the root (depth 2)
      const rootClaim = makeClaim({
        id: RIVAL_CLAIM_ID,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
      });
      store.putClaim(rootClaim);
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ROOT_ENTITY_ID });

      // Set up containment: ROOT > PARENT > ENTITY (with ENTITY as anchor)
      store.putContainment({ parent: ROOT_ENTITY_ID, child: parentId });
      store.putContainment({ parent: parentId, child: ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(result).toHaveLength(2);

      // Claim ABOUT parent (depth 1)
      const depth1 = result.find(
        (c: Awaited<ReturnType<typeof gather>>[number]) => c.claim.id === CLAIM_ID,
      );
      expect(depth1).toBeDefined();
      expect(depth1!.band).toStrictEqual({ kind: 'ancestor', depth: 1 });
      expect(depth1!.score).toBeCloseTo(0.64, 4);

      // Claim ABOUT root (depth 2)
      const depth2 = result.find(
        (c: Awaited<ReturnType<typeof gather>>[number]) => c.claim.id === RIVAL_CLAIM_ID,
      );
      expect(depth2).toBeDefined();
      expect(depth2!.band).toStrictEqual({ kind: 'ancestor', depth: 2 });
      expect(depth2!.score).toBeCloseTo(0.512, 4);
    });
  });

  describe('case 3: deprecated claims are not returned', () => {
    it('filters out claims with deprecated status', async () => {
      store.putEntity(makeEntity());

      const deprecatedClaim = makeClaim({
        id: CLAIM_ID,
        status: 'deprecated',
      });
      store.putClaim(deprecatedClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('case 4: claim ABOUT both anchor and ancestor appears once with higher score', () => {
    it('deduplicates a claim reaching via both paths, keeping the anchor band', async () => {
      // Build: ROOT > ENTITY (with ENTITY as anchor)
      store.putEntity(makeEntity({ id: ROOT_ENTITY_ID }));
      store.putEntity(makeEntity({ id: ENTITY_ID }));
      store.putContainment({ parent: ROOT_ENTITY_ID, child: ENTITY_ID });

      // Active claim ABOUT both the anchor and its parent
      const sharedClaim = makeClaim({ id: CLAIM_ID, status: 'active' });
      store.putClaim(sharedClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ROOT_ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.claim.id).toBe(CLAIM_ID);
      expect(result[0]!.band).toStrictEqual({ kind: 'anchor' });
    });
  });

  describe('case 5: sibling claims are not returned', () => {
    it('excludes claims ABOUT siblings (same parent, not an ancestor)', async () => {
      store.putEntity(makeEntity({ id: ROOT_ENTITY_ID }));
      store.putEntity(makeEntity({ id: ENTITY_ID }));
      store.putEntity(makeMinimalEntity({ id: SIBLING_ENTITY_ID }));

      // Set up: ROOT > [ENTITY, SIBLING]
      store.putContainment({ parent: ROOT_ENTITY_ID, child: ENTITY_ID });
      store.putContainment({ parent: ROOT_ENTITY_ID, child: SIBLING_ENTITY_ID });

      // Claim ABOUT the sibling
      const siblingClaim = makeClaim({ id: CLAIM_ID });
      store.putClaim(siblingClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: SIBLING_ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('case 6: spine path makes no embedding call', () => {
    it('does not call embeddings when mode is spine', async () => {
      store.putEntity(makeEntity());
      store.putClaim(makeClaim({ id: CLAIM_ID }));
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(queriedTexts(embeddings)).toStrictEqual([]);
    });
  });

  describe('case 7: ANN path with cosine >= 0.70', () => {
    it('returns claim with high embedding match, task embedded as query', async () => {
      store.putEntity(makeEntity());

      // Claim with embedding declaredVector('RetryPolicy')
      // Task 'the retry knob' has declared cosine ≈0.878 to 'RetryPolicy'
      const annClaim = makeClaim({
        id: CLAIM_ID,
        embedding: Array.from(declaredVector('RetryPolicy')),
      });
      store.putClaim(annClaim);

      const result = await gather(
        { store, embeddings },
        { task: 'the retry knob', modes: ['ann'] },
        undefined,
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.claim.id).toBe(CLAIM_ID);
      expect(result[0]!.band.kind).toBe('ann');
      if (result[0]!.band.kind === 'ann') {
        expect(result[0]!.band.cosine).toBeCloseTo(0.878, 2);
      }

      // Verify task was embedded as query
      expect(queriedTexts(embeddings)).toStrictEqual(['the retry knob']);
    });
  });

  describe('case 8: ANN floor excludes low-cosine claims', () => {
    it('does not return claims below cosine floor 0.70', async () => {
      store.putEntity(makeEntity());

      // Claim with embedding declaredVector('LedgerEntry')
      // Task 'the ledger' has declared cosine ≈0.362 to 'LedgerEntry' (below 0.70)
      const lowCosimClaim = makeClaim({
        id: CLAIM_ID,
        embedding: Array.from(declaredVector('LedgerEntry')),
      });
      store.putClaim(lowCosimClaim);

      const result = await gather(
        { store, embeddings },
        { task: 'the ledger', modes: ['ann'] },
        undefined,
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('case 9: spine mode with no anchor returns empty', () => {
    it('returns [] when anchor is undefined and modes only includes spine', async () => {
      store.putEntity(makeEntity());
      store.putClaim(makeClaim({ id: CLAIM_ID }));
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        undefined,
      );

      expect(result).toHaveLength(0);
      expect(queriedTexts(embeddings)).toStrictEqual([]);
    });
  });

  describe('case 10: ANN path runs when anchor is defined but modes includes ANN', () => {
    it('uses ANN instead of spine when anchor is defined but only ANN mode', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));
      store.putEntity(makeMinimalEntity({ id: OTHER_ENTITY_ID }));

      // Claim ABOUT the anchor with high embedding match
      const anchorClaim = makeClaim({
        id: CLAIM_ID,
        embedding: Array.from(declaredVector('RetryPolicy')),
      });
      store.putClaim(anchorClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      // A different claim with same embedding but not ABOUT the anchor
      const otherClaim = makeClaim({
        id: RIVAL_CLAIM_ID,
        embedding: Array.from(declaredVector('RetryPolicy')),
      });
      store.putClaim(otherClaim);
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: OTHER_ENTITY_ID });

      // A third claim ABOUT the anchor but with non-matching embedding
      const thirdClaim = makeClaim({
        id: THIRD_CLAIM_ID,
        embedding: Array.from(declaredVector('LedgerEntry')),
      });
      store.putClaim(thirdClaim);
      store.putClaimEdge({ from: THIRD_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'the retry knob', modes: ['ann'] },
        { id: ENTITY_ID },
      );

      // Should return only the two matching embeddings (spine path did not run)
      expect(result).toHaveLength(2);
      expect(
        result
          .map((c: Awaited<ReturnType<typeof gather>>[number]) => c.claim.id)
          .sort(),
      ).toStrictEqual([CLAIM_ID, RIVAL_CLAIM_ID].sort());
      expect(queriedTexts(embeddings)).toStrictEqual(['the retry knob']);
    });
  });

  describe('case 11: equal scores order by claim id ascending', () => {
    it('orders two identical active Beta(8,2) claims by id ascending', async () => {
      store.putEntity(makeEntity());

      // Create two claims with identical scoring parameters (active Beta(8,2))
      // First claim with "higher" id
      const claim1 = makeClaim({
        id: testUlid('CLAIM-ZZZ'),
        status: 'active',
      });
      store.putClaim(claim1);
      store.putClaimEdge({ from: testUlid('CLAIM-ZZZ'), kind: 'ABOUT', to: ENTITY_ID });

      // Second claim with "lower" id
      const claim2 = makeClaim({
        id: testUlid('CLAIM-AAA'),
        status: 'active',
      });
      store.putClaim(claim2);
      store.putClaimEdge({ from: testUlid('CLAIM-AAA'), kind: 'ABOUT', to: ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(result).toHaveLength(2);
      // Both should have the same score
      expect(result[0]!.score).toBeCloseTo(result[1]!.score, 4);
      // Lower id should come first
      expect(result[0]!.claim.id).toBe(testUlid('CLAIM-AAA'));
      expect(result[1]!.claim.id).toBe(testUlid('CLAIM-ZZZ'));
    });
  });

  describe('archived claims are dropped', () => {
    it('does not return claims with archived status', async () => {
      store.putEntity(makeEntity());

      const archivedClaim = makeClaim({
        id: CLAIM_ID,
        status: 'archived',
      });
      store.putClaim(archivedClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('disputed claims are scored with status penalty', () => {
    it('returns disputed claims with reduced score', async () => {
      store.putEntity(makeEntity());

      const disputedClaim = makeClaim({
        id: CLAIM_ID,
        status: 'disputed',
        evidence: { alpha: 8, beta: 2 },
      });
      store.putClaim(disputedClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.score).toBeCloseTo(0.6, 4);
    });
  });

  describe('no ancestors traversed twice', () => {
    it('follows every parent but visits no ancestor twice', async () => {
      // Build a diamond: ROOT > [A, B] > ANCHOR
      const rootId = testUlid('ROOT');
      const nodeA = testUlid('NODE-A');
      const nodeB = testUlid('NODE-B');

      store.putEntity(makeEntity({ id: rootId }));
      store.putEntity(makeEntity({ id: nodeA }));
      store.putEntity(makeEntity({ id: nodeB }));
      store.putEntity(makeEntity({ id: ENTITY_ID }));

      // Set up: ROOT > A > ANCHOR, ROOT > B > ANCHOR
      store.putContainment({ parent: rootId, child: nodeA });
      store.putContainment({ parent: rootId, child: nodeB });
      store.putContainment({ parent: nodeA, child: ENTITY_ID });
      store.putContainment({ parent: nodeB, child: ENTITY_ID });

      // Claims ABOUT each node
      const rootClaim = makeClaim({ id: CLAIM_ID });
      store.putClaim(rootClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: rootId });

      const aClaim = makeClaim({ id: RIVAL_CLAIM_ID });
      store.putClaim(aClaim);
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: nodeA });

      const bClaim = makeClaim({ id: THIRD_CLAIM_ID });
      store.putClaim(bClaim);
      store.putClaimEdge({ from: THIRD_CLAIM_ID, kind: 'ABOUT', to: nodeB });

      const result = await gather(
        { store, embeddings },
        { task: 'test', modes: ['spine'] },
        { id: ENTITY_ID },
      );

      // Should have claims from A (depth 1), B (depth 1), and ROOT (depth 2)
      // ROOT should appear once, not twice
      expect(result).toHaveLength(3);

      const rootResults = result.filter(
        (c: Awaited<ReturnType<typeof gather>>[number]) => c.claim.id === CLAIM_ID,
      );
      expect(rootResults).toHaveLength(1);
      expect(rootResults[0]!.band).toStrictEqual({ kind: 'ancestor', depth: 2 });
    });
  });
});
