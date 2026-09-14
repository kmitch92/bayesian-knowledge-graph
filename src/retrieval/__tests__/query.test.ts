/**
 * Composition of a complete retrieval query: resolving the anchor, gathering
 * claims, packing to budget, handling rivals, and recording taint.
 *
 * This module composes the full retrieval pipeline from the five simpler steps
 * (resolveAnchor, gather claims by relevance and posterior mean, pack to
 * token budget, attach rival contests, record taint). v1 serves raw claims
 * only with containment bands and no traverse mode; rivals travel outside the
 * budget; taint is recorded but not yet enforced as weight 0 (that needs P3
 * matching).
 *
 * @spec §7.1, §7.2, §7.4, §7.5, §10
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runQuery } from '../query';
import { servedClaimOf, estimateTokens } from '../pack';
import { openGraphStore, type GraphStore } from '../../store/index';
import {
  ENTITY_ID,
  CLAIM_ID,
  RIVAL_CLAIM_ID,
  THIRD_CLAIM_ID,
  SERVED_EPISODE_ID,
  OTHER_SERVED_EPISODE_ID,
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
} from '../../referents/__tests__/fixtures';
import { QueryRequest, QueryResponse } from '../../schema/index';

const ONE_NAMING = 1;

let store: GraphStore;
let embeddings: FakeEmbeddings;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  embeddings = fakeEmbeddings();
});

afterEach(() => {
  store.close();
});

describe('runQuery', () => {
  describe('1. Envelope: anchored query returns anchor, claims, structural edges, taintRecorded', () => {
    it('returns anchor with id, name, level (no rung key), claims in rank order, taintRecorded true, and parses', async () => {
      // Seed: entity with mention, level, under a parent entity
      const parentId = testUlid('ENTITY-PARENT00');
      store.putEntity(makeEntity({ id: parentId, level: 'workspace' }));
      store.putEntity(
        makeEntity({
          id: ENTITY_ID,
          name: 'RetryPolicy',
          level: 'component',
        }),
      );
      store.putContainment({ parent: parentId, child: ENTITY_ID });

      // Active claim ABOUT anchor: Beta(8, 2), posterior mean ≈ 0.8
      const activeClaim = makeClaim({
        id: CLAIM_ID,
        scope: ENTITY_ID,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
        text: 'RetryPolicy backs off exponentially.',
      });
      store.putClaim(activeClaim);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      // Provisional claim ABOUT anchor: Beta(1, 2), posterior mean ≈ 0.333
      const provisionalClaim = makeMinimalClaim({
        id: RIVAL_CLAIM_ID,
        scope: ENTITY_ID,
        status: 'provisional',
        evidence: { alpha: 1, beta: 2 },
        text: 'RetryPolicy uses linear backoff.',
      });
      store.putClaim(provisionalClaim);
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      // Active claim ABOUT parent: Beta(8, 2)
      const parentClaim = makeClaim({
        id: THIRD_CLAIM_ID,
        scope: parentId,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
        text: 'The workspace has retry policies.',
      });
      store.putClaim(parentClaim);
      store.putClaimEdge({ from: THIRD_CLAIM_ID, kind: 'ABOUT', to: parentId });

      const request = QueryRequest.parse({
        task: 'why does RetryPolicy back off',
        anchor: ENTITY_ID,
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      // Response must parse
      expect(() => QueryResponse.parse(response)).not.toThrow();

      // Anchor present with id, name, level (no rung)
      expect(response.anchor).toBeDefined();
      expect(response.anchor!.id).toBe(ENTITY_ID);
      expect(response.anchor!.name).toBe('RetryPolicy');
      expect(response.anchor!.level).toBe('component');
      expect('rung' in response.anchor!).toBe(false);

      // Claims in order: anchor-active (0.8), parent-active (0.64), anchor-provisional (0.167)
      expect(response.claims).toHaveLength(3);
      expect(response.claims[0]!.id).toBe(CLAIM_ID);
      expect(response.claims[1]!.id).toBe(THIRD_CLAIM_ID);
      expect(response.claims[2]!.id).toBe(RIVAL_CLAIM_ID);

      // Statuses carried through
      expect(response.claims[0]!.status).toBe('active');
      expect(response.claims[1]!.status).toBe('active');
      expect(response.claims[2]!.status).toBe('provisional');

      // Taint recorded
      expect(response.taintRecorded).toBe(true);
    });
  });

  describe('2. Anchor entity with level null is reported with level unplaced', () => {
    it('surfaces level "unplaced" when entity.level is null', async () => {
      store.putEntity(makeMinimalEntity({ id: ENTITY_ID, level: null }));
      store.putMention({ surfaceForm: 'unplaced-entity', referentId: ENTITY_ID, weight: ONE_NAMING });

      const request = QueryRequest.parse({
        task: 'about unplaced-entity',
        anchor: ENTITY_ID,
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      expect(response.anchor).toBeDefined();
      expect(response.anchor!.level).toBe('unplaced');
    });
  });

  describe('3. Structural edges: containment parents first, then children', () => {
    it('returns structural edges with parents before children', async () => {
      const parentId = testUlid('ENTITY-PARENT00');
      const childId = testUlid('ENTITY-CHILD000');

      store.putEntity(makeEntity({ id: parentId, level: 'workspace' }));
      store.putEntity(makeEntity({ id: ENTITY_ID, level: 'component' }));
      store.putEntity(makeEntity({ id: childId, level: 'module' }));

      store.putContainment({ parent: parentId, child: ENTITY_ID });
      store.putContainment({ parent: ENTITY_ID, child: childId });

      const request = QueryRequest.parse({
        task: 'why test',
        anchor: ENTITY_ID,
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      expect(response.structural).toStrictEqual([
        { from: parentId, edge: 'CONTAINS', to: ENTITY_ID },
        { from: ENTITY_ID, edge: 'CONTAINS', to: childId },
      ]);
    });
  });

  describe('4. Taint: after query, store.getTaintSet equals exactly served claim ids', () => {
    it('records exactly the served claim ids in taint for this episode', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));

      const claim1 = makeClaim({
        id: CLAIM_ID,
        scope: ENTITY_ID,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
      });
      const claim2 = makeMinimalClaim({
        id: RIVAL_CLAIM_ID,
        scope: ENTITY_ID,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
      });

      store.putClaim(claim1);
      store.putClaim(claim2);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const request = QueryRequest.parse({
        task: 'test',
        anchor: ENTITY_ID,
      });

      await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      const taintSet = store.getTaintSet(SERVED_EPISODE_ID);
      expect(taintSet).toStrictEqual(new Set([CLAIM_ID, RIVAL_CLAIM_ID]));
    });

    it('does not leak taint between episodes', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));
      store.putClaim(makeClaim({ id: CLAIM_ID, scope: ENTITY_ID }));
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const request = QueryRequest.parse({
        task: 'test',
        anchor: ENTITY_ID,
      });

      await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      const otherEpisodeTaint = store.getTaintSet(OTHER_SERVED_EPISODE_ID);
      expect(otherEpisodeTaint).toStrictEqual(new Set());
    });
  });

  describe('5. Budget: large budget serves multiple claims, small budget serves one', () => {
    it('serves only one short claim when budgetTokens fits only it', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));

      // Short claim that fits in budget
      const shortClaim = makeClaim({
        id: CLAIM_ID,
        scope: ENTITY_ID,
        status: 'active',
        text: 'Short.',
      });
      store.putClaim(shortClaim);

      // Long claim that does not fit
      const longText = 'x'.repeat(2000);
      store.putClaim(
        makeMinimalClaim({
          id: RIVAL_CLAIM_ID,
          scope: ENTITY_ID,
          status: 'active',
          text: longText,
        }),
      );

      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      // Budget: exactly the size of the short claim only
      const budgetTokens = estimateTokens(servedClaimOf(shortClaim));
      const request = QueryRequest.parse({
        task: 'test',
        anchor: ENTITY_ID,
        budgetTokens,
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      expect(response.claims).toHaveLength(1);
      expect(response.claims[0]!.id).toBe(CLAIM_ID);

      // Only the served claim is tainted
      const taintSet = store.getTaintSet(SERVED_EPISODE_ID);
      expect(taintSet).toStrictEqual(new Set([CLAIM_ID]));
    });
  });

  describe('6. Rivals travel together outside budget', () => {
    it('serves rival pair even when one does not fit the budget alone', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));

      // Claim A: active, fits budget
      const claimA = makeClaim({
        id: CLAIM_ID,
        scope: ENTITY_ID,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
        text: 'Retry uses exponential backoff.',
      });
      store.putClaim(claimA);

      // Claim B: provisional, long text (2000 chars), does not fit budget alone
      const longText = 'Retry does not use exponential backoff because ' + 'x'.repeat(1960);
      const claimB = makeMinimalClaim({
        id: RIVAL_CLAIM_ID,
        scope: ENTITY_ID,
        status: 'provisional',
        evidence: { alpha: 1, beta: 2 },
        text: longText,
      });
      store.putClaim(claimB);

      // A CONTRADICTS B
      store.putClaimEdge({ from: CLAIM_ID, kind: 'CONTRADICTS', to: RIVAL_CLAIM_ID });
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      // Budget: fits A only
      const budgetTokens = estimateTokens(servedClaimOf(claimA));
      const request = QueryRequest.parse({
        task: 'test',
        anchor: ENTITY_ID,
        budgetTokens,
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      // Both claims served
      expect(response.claims).toHaveLength(2);
      expect(response.claims[0]!.id).toBe(CLAIM_ID);
      expect(response.claims[1]!.id).toBe(RIVAL_CLAIM_ID);

      // A has B in rivals, B has A in rivals
      expect(response.claims[0]!.rivals).toStrictEqual([RIVAL_CLAIM_ID]);
      expect(response.claims[1]!.rivals).toStrictEqual([CLAIM_ID]);

      // Both tainted
      const taintSet = store.getTaintSet(SERVED_EPISODE_ID);
      expect(taintSet).toStrictEqual(new Set([CLAIM_ID, RIVAL_CLAIM_ID]));
    });
  });

  describe('7. Deprecated rival is not served', () => {
    it('does not serve a deprecated rival, and does not list it in rivals', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));

      // Claim A: active
      const claimA = makeClaim({
        id: CLAIM_ID,
        scope: ENTITY_ID,
        status: 'active',
        text: 'Retry backs off exponentially.',
      });
      store.putClaim(claimA);

      // Claim B: deprecated
      const claimB = makeMinimalClaim({
        id: RIVAL_CLAIM_ID,
        scope: ENTITY_ID,
        status: 'deprecated',
        text: 'Retry backs off linearly.',
      });
      store.putClaim(claimB);

      // A CONTRADICTS B
      store.putClaimEdge({ from: CLAIM_ID, kind: 'CONTRADICTS', to: RIVAL_CLAIM_ID });
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const request = QueryRequest.parse({
        task: 'test',
        anchor: ENTITY_ID,
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      // Only A served
      expect(response.claims).toHaveLength(1);
      expect(response.claims[0]!.id).toBe(CLAIM_ID);

      // A has no rivals key
      expect('rivals' in response.claims[0]!).toBe(false);
    });
  });

  describe('8. Mode B (ANN): no anchor resolves, claims matched by embedding', () => {
    it('serves claims matched by semantic similarity when no anchor found', async () => {
      // Create a claim with embedding for "RetryPolicy"
      const claimWithEmbedding = makeClaim({
        id: CLAIM_ID,
        scope: ENTITY_ID,
        status: 'active',
        embedding: Array.from(declaredVector('RetryPolicy')),
        text: 'The retry knob controls backoff.',
      });

      // Use makeMinimalEntity with glossEmbedding orthogonal to 'the retry knob'
      // (plane 4 vs plane 1) so gloss search does not anchor it
      store.putEntity(
        makeMinimalEntity({
          id: ENTITY_ID,
          glossEmbedding: Array.from(declaredVector('LedgerEntry')),
        }),
      );
      store.putClaim(claimWithEmbedding);
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      // No anchor, no name matches; task will trigger semantic search
      const request = QueryRequest.parse({
        task: 'the retry knob',
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      // Mode B: no anchor key
      expect('anchor' in response).toBe(false);

      // Structural empty
      expect(response.structural).toStrictEqual([]);

      // Claim served
      expect(response.claims).toHaveLength(1);
      expect(response.claims[0]!.id).toBe(CLAIM_ID);
    });
  });

  describe('9. Nothing matches at all', () => {
    it('returns empty claims, no taint rows, taintRecorded true', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));

      const request = QueryRequest.parse({
        task: 'completely unrelated query with no matches',
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      expect(response.claims).toStrictEqual([]);
      expect(response.taintRecorded).toBe(true);

      // No taint rows for the episode
      const taintSet = store.getTaintSet(SERVED_EPISODE_ID);
      expect(taintSet).toStrictEqual(new Set());
    });
  });

  describe('edge case: status penalties apply', () => {
    it('applies status multipliers: active 1, disputed 0.75, provisional 0.5, never deprecated/archived', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));

      // All claims ABOUT same entity, all with same posterior (8, 2) = 0.8
      // But different statuses

      // Active: multiplier 1
      const activeClaim = makeClaim({
        id: CLAIM_ID,
        scope: ENTITY_ID,
        status: 'active',
        evidence: { alpha: 8, beta: 2 },
        text: 'Active claim.',
      });
      store.putClaim(activeClaim);

      // Disputed: multiplier 0.75
      const disputedClaim = makeMinimalClaim({
        id: RIVAL_CLAIM_ID,
        scope: ENTITY_ID,
        status: 'disputed',
        evidence: { alpha: 8, beta: 2 },
        text: 'Disputed claim.',
      });
      store.putClaim(disputedClaim);

      // Provisional: multiplier 0.5
      const provisionalClaim = makeMinimalClaim({
        id: THIRD_CLAIM_ID,
        scope: ENTITY_ID,
        status: 'provisional',
        evidence: { alpha: 8, beta: 2 },
        text: 'Provisional claim.',
      });
      store.putClaim(provisionalClaim);

      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
      store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
      store.putClaimEdge({ from: THIRD_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

      const request = QueryRequest.parse({
        task: 'test',
        anchor: ENTITY_ID,
      });

      const response = await runQuery(
        { store, embeddings, episodeId: SERVED_EPISODE_ID },
        request,
      );

      // Expected scores: active 0.8, disputed 0.6, provisional 0.4
      // Rank: active, disputed, provisional
      expect(response.claims).toHaveLength(3);
      expect(response.claims[0]!.id).toBe(CLAIM_ID); // active
      expect(response.claims[1]!.id).toBe(RIVAL_CLAIM_ID); // disputed
      expect(response.claims[2]!.id).toBe(THIRD_CLAIM_ID); // provisional
    });
  });
});
