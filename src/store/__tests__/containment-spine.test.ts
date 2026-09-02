/**
 * The containment index: `putContainment` writes it, `getChildren` reads it, and
 * neither is a graph algorithm.
 *
 * Two claims are pinned here, and they pull in opposite directions.
 *
 * The first is that this index is a *view over another view*, so both ends of an
 * edge must already be in the referent index. That is stricter than the mention
 * index next door, which is keyed by referent id and never checked against
 * anything — a surface form may outlive the row it names, but an edge to a
 * referent the spine does not hold is an emitter bug rather than a fact to keep.
 * The strictness stops at the ledger: a containment *claim* is written whatever
 * the index says, because a view that could refuse a ledger write is a ledger the
 * view constrains, and `clearViews` would then be able to invalidate history.
 *
 * The second is that {@link GraphStore.getChildren} returns *direct* children.
 * The transitive closure is a traversal with a depth budget and a cycle guard,
 * and a read that looks like a column must not quietly be one. A three-level
 * spine is the only shape that can tell the two apart: a two-level one passes
 * under either implementation.
 *
 * The separate table earns its keep in the last section. `putStructuralEdges`
 * replaces a source entity's whole edge set on every parse, so containment
 * sharing that table meant an emitter re-deriving a module's call graph deleted
 * that module's spine — silently, because deleting edges is what a re-parse is
 * for.
 *
 * Real SQLite, `:memory:`, no mocks.
 *
 * @spec §3.1, §3.3
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UnknownEntityError, openGraphStore, type GraphStore } from '../index';

import {
  ENTITY_ID,
  OTHER_ENTITY_ID,
  THIRD_CLAIM_ID,
  makeEntity,
  makeMinimalEntity,
  makeViewClaim,
  testUlid,
} from './fixtures';

/**
 * The third rung of the spine, so the chain is genuinely three deep.
 *
 * Two rungs cannot distinguish a direct read from a transitive one: the closure
 * of a two-level tree *is* its direct child set.
 *
 * @spec §3.1, §3.3
 */
const GRANDCHILD_ENTITY_ID = testUlid('ENTITY-REFRESHTOKEN');

/** A referent nothing ever mints, for the ends the index does not hold. @spec §3.1 */
const UNINDEXED_ENTITY_ID = testUlid('ENTITY-NEVER-MINTED');

let store: GraphStore;

/** The grandchild referent: a symbol inside the child, placed one rung further down. @spec §3.1 */
const makeGrandchild = (): ReturnType<typeof makeEntity> =>
  makeEntity({ id: GRANDCHILD_ENTITY_ID, name: 'refreshToken', level: 'symbol' });

/**
 * `AuthService` contains `CognitoClient` contains `refreshToken`.
 *
 * Written as two direct edges and never as a third from root to grandchild —
 * the whole point is that the third is something a caller has to traverse for.
 *
 * @spec §3.1, §3.3
 */
const seedThreeLevelSpine = (): void => {
  store.putEntity(makeEntity());
  store.putEntity(makeMinimalEntity());
  store.putEntity(makeGrandchild());
  store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });
  store.putContainment({ parent: OTHER_ENTITY_ID, child: GRANDCHILD_ENTITY_ID });
};

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('putContainment refuses an end the referent index does not hold', () => {
  it('refuses a parent nothing has minted', () => {
    store.putEntity(makeMinimalEntity());

    expect(() =>
      store.putContainment({ parent: UNINDEXED_ENTITY_ID, child: OTHER_ENTITY_ID }),
    ).toThrow(UnknownEntityError);
  });

  it('refuses a child nothing has minted', () => {
    store.putEntity(makeEntity());

    expect(() =>
      store.putContainment({ parent: ENTITY_ID, child: UNINDEXED_ENTITY_ID }),
    ).toThrow(UnknownEntityError);
  });

  it('names the end that did not resolve, rather than the edge as a whole', () => {
    store.putEntity(makeEntity());

    let refused: unknown;
    try {
      store.putContainment({ parent: ENTITY_ID, child: UNINDEXED_ENTITY_ID });
    } catch (error) {
      refused = error;
    }

    expect((refused as UnknownEntityError | undefined)?.entityId).toBe(UNINDEXED_ENTITY_ID);
  });

  it('refuses an edge whose ends are both unminted', () => {
    expect(() =>
      store.putContainment({ parent: UNINDEXED_ENTITY_ID, child: ENTITY_ID }),
    ).toThrow(UnknownEntityError);
  });

  it('records nothing when it refuses', () => {
    store.putEntity(makeEntity());

    expect(() =>
      store.putContainment({ parent: ENTITY_ID, child: UNINDEXED_ENTITY_ID }),
    ).toThrow(UnknownEntityError);

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([]);
  });

  it('leaves the containment claim in the ledger, because a view cannot refuse a write to it', () => {
    const containmentClaim = makeViewClaim();
    store.putClaim(containmentClaim);
    store.putEntity(makeEntity());

    expect(() =>
      store.putContainment({ parent: ENTITY_ID, child: UNINDEXED_ENTITY_ID }),
    ).toThrow(UnknownEntityError);

    expect(store.getClaim(THIRD_CLAIM_ID)).toStrictEqual(containmentClaim);
  });

  it('is stricter than the mention index, which is keyed by referent id and never checked', () => {
    store.putMention({
      surfaceForm: 'the thing nobody minted',
      referentId: UNINDEXED_ENTITY_ID,
      weight: 1,
    });

    expect(store.getMentionTally(UNINDEXED_ENTITY_ID)).toStrictEqual([
      { surfaceForm: 'the thing nobody minted', weight: 1 },
    ]);
    expect(() =>
      store.putContainment({ parent: UNINDEXED_ENTITY_ID, child: UNINDEXED_ENTITY_ID }),
    ).toThrow(UnknownEntityError);
  });
});

describe('putContainment records the pair once', () => {
  beforeEach(() => {
    store.putEntity(makeEntity());
    store.putEntity(makeMinimalEntity());
  });

  it('records the edge it was given', () => {
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });

  it('leaves one edge behind however many times the same pair arrives', () => {
    for (let recording = 0; recording < 5; recording += 1)
      store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });

  it('is directed: recording parent to child does not record child to parent', () => {
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect(store.getChildren(OTHER_ENTITY_ID)).toStrictEqual([]);
  });

  it('keeps several children of one parent in the order they were recorded', () => {
    store.putEntity(makeGrandchild());

    store.putContainment({ parent: ENTITY_ID, child: GRANDCHILD_ENTITY_ID });
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([GRANDCHILD_ENTITY_ID, OTHER_ENTITY_ID]);
  });

  it('lets one referent sit under two parents', () => {
    store.putEntity(makeGrandchild());
    store.putContainment({ parent: ENTITY_ID, child: GRANDCHILD_ENTITY_ID });
    store.putContainment({ parent: OTHER_ENTITY_ID, child: GRANDCHILD_ENTITY_ID });

    expect([store.getChildren(ENTITY_ID), store.getChildren(OTHER_ENTITY_ID)]).toStrictEqual([
      [GRANDCHILD_ENTITY_ID],
      [GRANDCHILD_ENTITY_ID],
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `deleteContainment` removes the pair and only the pair.
 * ---------------------------------------------------------------------------
 *
 * The other half of immediate materialization, and the half with teeth: a write
 * that is too broad here silently unbuilds a spine, and `rebuild-index` puts it
 * straight back, so the damage shows up as two answers to "what contains what"
 * rather than as a failure.
 *
 * It is deliberately looser than `putContainment` in one place and must not be
 * looser in any other. Neither end is checked against the referent index — a
 * removal that refused because a referent went missing would strand the edge it
 * was asked to take out — but the pair is still a pair: both halves of the key
 * decide the row, the direction is still the direction, and a pair the table does
 * not hold is already the state the caller asked for.
 *
 * @spec §3.1, §3.3, §6.1
 */

describe('deleteContainment removes the pair and only the pair', () => {
  beforeEach(() => {
    store.putEntity(makeEntity());
    store.putEntity(makeMinimalEntity());
    store.putEntity(makeGrandchild());
  });

  it('removes the edge it was given', () => {
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    store.deleteContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([]);
  });

  it('leaves the parent its other children', () => {
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });
    store.putContainment({ parent: ENTITY_ID, child: GRANDCHILD_ENTITY_ID });

    store.deleteContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([GRANDCHILD_ENTITY_ID]);
  });

  it('leaves the child its other parents', () => {
    store.putContainment({ parent: ENTITY_ID, child: GRANDCHILD_ENTITY_ID });
    store.putContainment({ parent: OTHER_ENTITY_ID, child: GRANDCHILD_ENTITY_ID });

    store.deleteContainment({ parent: ENTITY_ID, child: GRANDCHILD_ENTITY_ID });

    expect([store.getChildren(ENTITY_ID), store.getChildren(OTHER_ENTITY_ID)]).toStrictEqual([
      [],
      [GRANDCHILD_ENTITY_ID],
    ]);
  });

  it('is directed: removing child to parent does not remove parent to child', () => {
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    store.deleteContainment({ parent: OTHER_ENTITY_ID, child: ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });

  it('is silent on a pair the table does not hold', () => {
    expect(() => {
      store.deleteContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });
    }).not.toThrow();
  });

  it('does not check either end against the referent index, unlike putContainment', () => {
    expect(() => {
      store.deleteContainment({ parent: UNINDEXED_ENTITY_ID, child: UNINDEXED_ENTITY_ID });
    }).not.toThrow();
  });

  it('takes the edge and not the referents', () => {
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    store.deleteContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect([store.getEntity(ENTITY_ID)?.id, store.getEntity(OTHER_ENTITY_ID)?.id]).toStrictEqual([
      ENTITY_ID,
      OTHER_ENTITY_ID,
    ]);
  });

  it('lets the same pair be recorded again afterwards', () => {
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });
    store.deleteContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });
});

describe('getChildren returns direct children and not the closure', () => {
  it('finds nothing under a parent nothing has been recorded beneath', () => {
    store.putEntity(makeEntity());

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([]);
  });

  it('finds nothing under a referent the index does not hold', () => {
    expect(store.getChildren(UNINDEXED_ENTITY_ID)).toStrictEqual([]);
  });

  it('finds nothing under an id that is not a referent id at all', () => {
    expect(store.getChildren('')).toStrictEqual([]);
  });

  it('omits the grandchild, which is what makes this a column and not a traversal', () => {
    seedThreeLevelSpine();

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });

  it('still reaches the grandchild when the middle referent is asked directly', () => {
    seedThreeLevelSpine();

    expect(store.getChildren(OTHER_ENTITY_ID)).toStrictEqual([GRANDCHILD_ENTITY_ID]);
  });

  it('bottoms out at the leaf', () => {
    seedThreeLevelSpine();

    expect(store.getChildren(GRANDCHILD_ENTITY_ID)).toStrictEqual([]);
  });

  it('does not report a sibling recorded under a different parent', () => {
    seedThreeLevelSpine();
    store.putContainment({ parent: OTHER_ENTITY_ID, child: ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });
});

describe('the containment index lives apart from the parsed edge set', () => {
  beforeEach(() => {
    store.putEntity(makeEntity());
    store.putEntity(makeMinimalEntity());
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });
  });

  it('survives a re-parse that replaces the parent\'s whole structural edge set', () => {
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CALLS', to: OTHER_ENTITY_ID }]);

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });

  it('survives a re-parse that emits no edges at all', () => {
    store.putStructuralEdges(ENTITY_ID, []);

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });

  it('survives an upsert of the parent referent', () => {
    store.putEntity(makeEntity({ name: 'AuthenticationService' }));

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });

  it('surfaces alongside the parse\'s own edges as CONTAINS', () => {
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CALLS', to: OTHER_ENTITY_ID }]);

    expect(store.getStructuralEdges(ENTITY_ID)).toStrictEqual([
      { from: ENTITY_ID, kind: 'CALLS', to: OTHER_ENTITY_ID },
      { from: ENTITY_ID, kind: 'CONTAINS', to: OTHER_ENTITY_ID },
    ]);
  });

  it('goes when the views go, because it is one of the three', () => {
    store.clearViews();

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([]);
  });

  it('can be recorded again over a rebuilt referent index', () => {
    store.clearViews();
    store.putEntity(makeEntity());
    store.putEntity(makeMinimalEntity());
    store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });

    expect(store.getChildren(ENTITY_ID)).toStrictEqual([OTHER_ENTITY_ID]);
  });
});
