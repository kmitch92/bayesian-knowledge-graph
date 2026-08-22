/**
 * §6.1: "archived claims leave candidate retrieval entirely (consolidator and
 * audit reads only — if ANN surfaces one, that is a bug)."
 *
 * Pinned here as a test rather than left as prose, because it is a bug that
 * cannot be noticed by looking at a result set: an archived claim resurfacing in
 * §5.3's candidate set reads as an ordinary near-duplicate, and the adjudicator
 * will happily route fresh evidence onto a claim the graph has already retired.
 *
 * Both §5.3 candidate channels are covered, because "leaves candidate retrieval
 * entirely" is not satisfied by filtering the semantic channel alone. The
 * structural channel — claims already attached via `ABOUT` to the same entities,
 * "regardless of cosine" — is exactly the path a cosine filter cannot protect.
 *
 * Archived claims stay reachable by id. `archived` is orthogonal to the
 * provisional → active → disputed → deprecated line and the ledger is
 * append-only (principle 4), so lineage and audit reads must still resolve.
 *
 * @spec §5.3, §6.1, §11
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Claim } from '../../schema/index';
import { openGraphStore, type GraphStore } from '../index';

import {
  CLAIM_ID,
  ENTITY_ID,
  RIVAL_CLAIM_ID,
  makeClaim,
  makeEntity,
  unitVector,
  unitVectorArray,
} from './fixtures';

/** The query vector every search in this file uses: the archived claim's own embedding, so it would rank first if it were eligible at all. @spec §5.3 */
const QUERY = unitVector(70);

let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  store.putEntity(makeEntity());
  store.putClaim(makeClaim({ embedding: Array.from(QUERY) }));
  store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
});

afterEach(() => {
  store.close();
});

describe('an archived claim in the semantic candidate channel', () => {
  it('is returned while it is still active', () => {
    const hits = store.searchClaims({ embedding: QUERY, limit: 10 });

    expect(hits.map((hit) => hit.claimId)).toContain(CLAIM_ID);
  });

  it('disappears the moment it is archived, even as the nearest neighbour by a mile', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    const hits = store.searchClaims({ embedding: QUERY, limit: 10 });

    expect(hits.map((hit) => hit.claimId)).not.toContain(CLAIM_ID);
  });

  it('leaves the live claims that remain, rather than emptying the channel', () => {
    store.putClaim(
      makeClaim({
        id: RIVAL_CLAIM_ID,
        text: 'A live rival proposition about the same handler.',
        embedding: unitVectorArray(71),
      }),
    );
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    const hits = store.searchClaims({ embedding: QUERY, limit: 10 });

    expect(hits.map((hit) => hit.claimId)).toStrictEqual([RIVAL_CLAIM_ID]);
  });

  it('is still excluded when it was archived straight from provisional, since archived is orthogonal', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'provisional' });
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.searchClaims({ embedding: QUERY, limit: 10 })).toStrictEqual([]);
  });

  it('is excluded from the very first write if it was minted archived', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });
    store.putClaim(
      makeClaim({
        id: RIVAL_CLAIM_ID,
        text: 'A claim consolidated away before it ever served.',
        status: 'archived',
        embedding: unitVectorArray(72),
      }),
    );

    expect(store.searchClaims({ embedding: QUERY, limit: 10 })).toStrictEqual([]);
  });
});

describe('an archived claim in the structural candidate channel', () => {
  it('is returned by the ABOUT reverse index while it is live', () => {
    expect(store.getClaimsAbout(ENTITY_ID)).toContain(CLAIM_ID);
  });

  it('disappears from the ABOUT reverse index once archived, where no cosine floor could have caught it', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.getClaimsAbout(ENTITY_ID)).not.toContain(CLAIM_ID);
  });

  it('leaves the live claims attached to the same entity in place', () => {
    store.putClaim(
      makeClaim({
        id: RIVAL_CLAIM_ID,
        text: 'A live rival proposition about the same handler.',
        embedding: unitVectorArray(73),
      }),
    );
    store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.getClaimsAbout(ENTITY_ID)).toStrictEqual([RIVAL_CLAIM_ID]);
  });
});

describe('the four non-archived states stay candidates', () => {
  it('keeps a provisional claim in the semantic channel, since dedupe must see unproven claims', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'provisional' });

    expect(store.searchClaims({ embedding: QUERY, limit: 10 })).toHaveLength(1);
  });

  it('keeps an active claim in the semantic channel', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'active' });

    expect(store.searchClaims({ embedding: QUERY, limit: 10 })).toHaveLength(1);
  });

  it('keeps a disputed claim in the semantic channel, because both sides stay live until resolution', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'disputed' });

    expect(store.searchClaims({ embedding: QUERY, limit: 10 })).toHaveLength(1);
  });

  it('keeps a deprecated claim in the semantic channel, since it is kept for lineage and can be refined', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'deprecated' });

    expect(store.searchClaims({ embedding: QUERY, limit: 10 })).toHaveLength(1);
  });

  it('keeps all four in the structural channel too', () => {
    const states = ['provisional', 'active', 'disputed', 'deprecated'] as const;

    const seen = states.map((status) => {
      store.setClaimStatus({ claimId: CLAIM_ID, status });
      return store.getClaimsAbout(ENTITY_ID).includes(CLAIM_ID);
    });

    expect(seen).toStrictEqual([true, true, true, true]);
  });
});

describe('audit and consolidator reads still resolve an archived claim', () => {
  it('returns it by id, because the ledger is append-only and lineage must never break', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(Claim.parse(store.getClaim(CLAIM_ID)).status).toBe('archived');
  });

  it('keeps its posterior readable for audit', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.getEvidence(CLAIM_ID)).toStrictEqual(makeClaim().evidence);
  });

  it('keeps its full-precision embedding, so the consolidator can still reason over it', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.getRerankVector(CLAIM_ID)).toStrictEqual(QUERY);
  });

  it('surfaces it in the semantic channel only under an explicit audit opt-in', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    const hits = store.searchClaims({ embedding: QUERY, limit: 10, includeArchived: true });

    expect(hits.map((hit) => hit.claimId)).toStrictEqual([CLAIM_ID]);
  });

  it('surfaces it in the structural channel only under the same explicit opt-in', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.getClaimsAbout(ENTITY_ID, { includeArchived: true })).toStrictEqual([CLAIM_ID]);
  });

  it('defaults the opt-in to off, so a caller that forgets it gets the safe behaviour', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.searchClaims({ embedding: QUERY, limit: 10 })).toStrictEqual([]);
  });
});
