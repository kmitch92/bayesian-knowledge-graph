/**
 * §3.3 edge types: the closed set, plus the parsed structural edges that live
 * alongside it.
 *
 * Three separate obligations are pinned here.
 *
 * **The six live claim edges round-trip.** `ABOUT` anchors a claim to the
 * entities it references (exactly one of them the scope anchor); `SUPPORTS`,
 * `CONTRADICTS`, `REFINES`, `DERIVED_FROM` and `SUPERSEDED_BY` connect claims to
 * claims. `CONTRADICTS` is the odd one — §3.3 writes it as `claim ↔ claim` and
 * §6 keeps both sides live until resolution, so it has to be readable from
 * either end or §7.4's rivals-travel-together rule has no reverse lookup to
 * stand on.
 *
 * **Parsed structural edges carry no evidence.** Principle 2: symbols, imports
 * and call edges "come deterministically from tree-sitter/LSP, carry no
 * confidence machinery, and are true until the next parse". So they hold no α/β,
 * and re-parsing replaces the set rather than accumulating duplicates of it.
 *
 * **The reserved edge kinds are seams, not features.** `MERGES`, `STATED_IN`,
 * `INSTANCE_OF` and `SPECIALIZES` belong to the consolidator, documents and the
 * conceptual vertical — all v1 non-goals (plan §7). The vocabulary admits them
 * so migration 0 does not need changing when those land; the write path refuses
 * them so nothing in v1 can quietly start minting them.
 *
 * @spec §3.3, §5.3, §6.3, §7.4
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ClaimEdgeKind,
  LIVE_CLAIM_EDGE_KINDS,
  RESERVED_EDGE_KINDS,
  ReservedEdgeKindError,
  UnknownClaimError,
  UnknownEntityError,
  openGraphStore,
  type GraphStore,
} from '../index';

import {
  CLAIM_ID,
  ENTITY_ID,
  OTHER_ENTITY_ID,
  RIVAL_CLAIM_ID,
  THIRD_CLAIM_ID,
  makeClaim,
  makeEntity,
  makeMinimalEntity,
  unitVectorArray,
} from './fixtures';

let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  store.putEntity(makeEntity());
  store.putEntity(makeMinimalEntity());
  store.putClaim(makeClaim());
  store.putClaim(
    makeClaim({
      id: RIVAL_CLAIM_ID,
      text: 'AuthService.refresh is not idempotent under retry.',
      embedding: unitVectorArray(80),
    }),
  );
  store.putClaim(
    makeClaim({
      id: THIRD_CLAIM_ID,
      text: 'AuthService.refresh is idempotent only for the same request id.',
      embedding: unitVectorArray(81),
    }),
  );
});

afterEach(() => {
  store.close();
});

describe('the ABOUT edge from a claim to the entities it references', () => {
  it('round-trips an edge to the scope anchor', () => {
    store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

    expect(store.getClaimEdges(CLAIM_ID)).toStrictEqual([
      { from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID },
    ]);
  });

  it('carries several targets, since a claim may reference more than one entity', () => {
    store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
    store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: OTHER_ENTITY_ID });

    expect(store.getClaimEdges(CLAIM_ID).map((edge) => edge.to)).toStrictEqual([
      ENTITY_ID,
      OTHER_ENTITY_ID,
    ]);
  });

  it('is readable from the entity end, which is the §5.3 structural candidate channel', () => {
    store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
    store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

    expect(store.getClaimsAbout(ENTITY_ID)).toStrictEqual([CLAIM_ID, RIVAL_CLAIM_ID]);
  });

  it('records the same edge once however many times a re-resolve writes it', () => {
    store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
    store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });

    expect(store.getClaimEdges(CLAIM_ID)).toHaveLength(1);
  });

  it('refuses a target entity that does not exist, rather than minting one eagerly', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID.replace(/.$/, 'Z') });
    }).toThrow(UnknownEntityError);
  });
});

describe('the five claim-to-claim edges', () => {
  it('round-trips SUPPORTS, which attaches a corroborating raw to the claim it supports', () => {
    store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'SUPPORTS', to: CLAIM_ID });

    expect(store.getClaimEdges(RIVAL_CLAIM_ID)).toStrictEqual([
      { from: RIVAL_CLAIM_ID, kind: 'SUPPORTS', to: CLAIM_ID },
    ]);
  });

  it('round-trips REFINES, where the successor narrows the original', () => {
    store.putClaimEdge({ from: THIRD_CLAIM_ID, kind: 'REFINES', to: CLAIM_ID });

    expect(store.getClaimEdges(THIRD_CLAIM_ID)).toStrictEqual([
      { from: THIRD_CLAIM_ID, kind: 'REFINES', to: CLAIM_ID },
    ]);
  });

  it('round-trips DERIVED_FROM, the lineage edge from a canonical to what it absorbed', () => {
    store.putClaimEdge({ from: CLAIM_ID, kind: 'DERIVED_FROM', to: RIVAL_CLAIM_ID });

    expect(store.getClaimEdges(CLAIM_ID)).toStrictEqual([
      { from: CLAIM_ID, kind: 'DERIVED_FROM', to: RIVAL_CLAIM_ID },
    ]);
  });

  it('round-trips SUPERSEDED_BY, where the loser of a resolution points at the winner', () => {
    store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'SUPERSEDED_BY', to: CLAIM_ID });

    expect(store.getClaimEdges(RIVAL_CLAIM_ID)).toStrictEqual([
      { from: RIVAL_CLAIM_ID, kind: 'SUPERSEDED_BY', to: CLAIM_ID },
    ]);
  });

  it('round-trips CONTRADICTS from the end that wrote it', () => {
    store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'CONTRADICTS', to: CLAIM_ID });

    expect(store.getClaimEdges(RIVAL_CLAIM_ID)).toStrictEqual([
      { from: RIVAL_CLAIM_ID, kind: 'CONTRADICTS', to: CLAIM_ID },
    ]);
  });

  it('reads CONTRADICTS from the other end too, because rivalry is symmetric and rivals travel together', () => {
    store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'CONTRADICTS', to: CLAIM_ID });

    expect(store.getClaimEdges(CLAIM_ID)).toStrictEqual([
      { from: CLAIM_ID, kind: 'CONTRADICTS', to: RIVAL_CLAIM_ID },
    ]);
  });

  it('does not make the one-directional edges symmetric', () => {
    store.putClaimEdge({ from: RIVAL_CLAIM_ID, kind: 'SUPPORTS', to: CLAIM_ID });

    expect(store.getClaimEdges(CLAIM_ID)).toStrictEqual([]);
  });

  it('keeps every edge a claim carries, across kinds', () => {
    store.putClaimEdge({ from: CLAIM_ID, kind: 'ABOUT', to: ENTITY_ID });
    store.putClaimEdge({ from: CLAIM_ID, kind: 'DERIVED_FROM', to: RIVAL_CLAIM_ID });
    store.putClaimEdge({ from: CLAIM_ID, kind: 'REFINES', to: THIRD_CLAIM_ID });

    expect(store.getClaimEdges(CLAIM_ID).map((edge) => edge.kind)).toStrictEqual([
      'ABOUT',
      'DERIVED_FROM',
      'REFINES',
    ]);
  });

  it('refuses a target claim that does not exist', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID, kind: 'SUPPORTS', to: CLAIM_ID.replace(/.$/, 'Z') });
    }).toThrow(UnknownClaimError);
  });

  it('refuses a source claim that does not exist', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID.replace(/.$/, 'Z'), kind: 'SUPPORTS', to: CLAIM_ID });
    }).toThrow(UnknownClaimError);
  });

  it('refuses an entity as the target of a claim-to-claim edge', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID, kind: 'SUPPORTS', to: ENTITY_ID });
    }).toThrow(UnknownClaimError);
  });

  it('returns no edges for a claim that has none', () => {
    expect(store.getClaimEdges(CLAIM_ID)).toStrictEqual([]);
  });
});

describe('parsed entity-to-entity structural edges', () => {
  it('round-trips the CONTAINS spine edge', () => {
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CONTAINS', to: OTHER_ENTITY_ID }]);

    expect(store.getStructuralEdges(ENTITY_ID)).toStrictEqual([
      { from: ENTITY_ID, kind: 'CONTAINS', to: OTHER_ENTITY_ID },
    ]);
  });

  it('round-trips the open parser vocabulary alongside it', () => {
    store.putStructuralEdges(ENTITY_ID, [
      { kind: 'CALLS', to: OTHER_ENTITY_ID },
      { kind: 'IMPORTS', to: OTHER_ENTITY_ID },
    ]);

    expect(store.getStructuralEdges(ENTITY_ID).map((edge) => edge.kind)).toStrictEqual([
      'CALLS',
      'IMPORTS',
    ]);
  });

  it('carries no evidence fields at all, because the parser is not believed but re-derived', () => {
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CALLS', to: OTHER_ENTITY_ID }]);

    const [edge] = store.getStructuralEdges(ENTITY_ID);

    expect(Object.keys(edge ?? {}).sort()).toStrictEqual(['from', 'kind', 'to']);
  });

  it('offers no way to put a posterior on an entity, which is where a structural edge would have to live', () => {
    expect(() => {
      store.incrementEvidence({ claimId: ENTITY_ID, alpha: 1 });
    }).toThrow(UnknownClaimError);
  });

  it('replaces the whole set on re-parse rather than accumulating duplicates', () => {
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CALLS', to: OTHER_ENTITY_ID }]);
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CALLS', to: OTHER_ENTITY_ID }]);

    expect(store.getStructuralEdges(ENTITY_ID)).toHaveLength(1);
  });

  it('drops an edge the latest parse no longer sees', () => {
    store.putStructuralEdges(ENTITY_ID, [
      { kind: 'CALLS', to: OTHER_ENTITY_ID },
      { kind: 'IMPORTS', to: OTHER_ENTITY_ID },
    ]);
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CALLS', to: OTHER_ENTITY_ID }]);

    expect(store.getStructuralEdges(ENTITY_ID).map((edge) => edge.kind)).toStrictEqual(['CALLS']);
  });

  it('clears the set entirely when a re-parse finds nothing', () => {
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CALLS', to: OTHER_ENTITY_ID }]);
    store.putStructuralEdges(ENTITY_ID, []);

    expect(store.getStructuralEdges(ENTITY_ID)).toStrictEqual([]);
  });

  it('leaves another entity edges alone when one entity is re-parsed', () => {
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CALLS', to: OTHER_ENTITY_ID }]);
    store.putStructuralEdges(OTHER_ENTITY_ID, [{ kind: 'CALLS', to: ENTITY_ID }]);
    store.putStructuralEdges(ENTITY_ID, []);

    expect(store.getStructuralEdges(OTHER_ENTITY_ID)).toHaveLength(1);
  });

  it('refuses a target entity that does not exist', () => {
    expect(() => {
      store.putStructuralEdges(ENTITY_ID, [
        { kind: 'CALLS', to: ENTITY_ID.replace(/.$/, 'Z') },
      ]);
    }).toThrow(UnknownEntityError);
  });
});

describe('the reserved edge kinds, which are deferred-feature seams', () => {
  it('names exactly the four kinds v1 defers', () => {
    expect([...RESERVED_EDGE_KINDS].sort()).toStrictEqual([
      'INSTANCE_OF',
      'MERGES',
      'SPECIALIZES',
      'STATED_IN',
    ]);
  });

  it('names exactly the six kinds v1 uses', () => {
    expect([...LIVE_CLAIM_EDGE_KINDS].sort()).toStrictEqual([
      'ABOUT',
      'CONTRADICTS',
      'DERIVED_FROM',
      'REFINES',
      'SUPERSEDED_BY',
      'SUPPORTS',
    ]);
  });

  it('keeps the live and reserved sets disjoint', () => {
    const live = new Set<string>(LIVE_CLAIM_EDGE_KINDS);

    expect(RESERVED_EDGE_KINDS.some((kind) => live.has(kind))).toBe(false);
  });

  it('admits every reserved kind into the edge vocabulary, so migration 0 needs no change later', () => {
    const parsed = RESERVED_EDGE_KINDS.map((kind) => ClaimEdgeKind.safeParse(kind).success);

    expect(parsed).toStrictEqual([true, true, true, true]);
  });

  it('admits every live kind into the same vocabulary', () => {
    const parsed = LIVE_CLAIM_EDGE_KINDS.map((kind) => ClaimEdgeKind.safeParse(kind).success);

    expect(parsed).toStrictEqual([true, true, true, true, true, true]);
  });

  it('rejects a kind that is in neither set', () => {
    expect(ClaimEdgeKind.safeParse('ENDORSES').success).toBe(false);
  });

  it('refuses to write a MERGES edge, because the consolidator is a v1 non-goal', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID, kind: 'MERGES', to: RIVAL_CLAIM_ID });
    }).toThrow(ReservedEdgeKindError);
  });

  it('refuses to write a STATED_IN edge, because documents are a v1 non-goal', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID, kind: 'STATED_IN', to: RIVAL_CLAIM_ID });
    }).toThrow(ReservedEdgeKindError);
  });

  it('refuses to write an INSTANCE_OF edge, because the conceptual vertical is a v1 non-goal', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID, kind: 'INSTANCE_OF', to: RIVAL_CLAIM_ID });
    }).toThrow(ReservedEdgeKindError);
  });

  it('refuses to write a SPECIALIZES edge for the same reason', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID, kind: 'SPECIALIZES', to: RIVAL_CLAIM_ID });
    }).toThrow(ReservedEdgeKindError);
  });

  it('leaves no reserved edge behind after refusing one', () => {
    expect(() => {
      store.putClaimEdge({ from: CLAIM_ID, kind: 'MERGES', to: RIVAL_CLAIM_ID });
    }).toThrow(ReservedEdgeKindError);

    expect(store.getClaimEdges(CLAIM_ID)).toStrictEqual([]);
  });
});
