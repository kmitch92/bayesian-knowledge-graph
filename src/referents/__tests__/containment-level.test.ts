/**
 * What a containment claim's level asserts, and what an absent one does not.
 *
 * §3.1 makes `level` nullable so that *"a usage-born referent ('practice', 'the
 * retry pattern') has no level until a containment claim places it"*, and §3.3
 * makes containment *"the materialization of containment claims"* — the only
 * thing in the system that places anything. Both sentences are about the claim
 * that *carries* a level. Neither says anything about a claim that carries none.
 *
 * `childLevel` defaults to `null` (`messages.ts`, `EntityLevel.nullable()
 * .default(null)`), so "the producer omitted the field" and "the producer said
 * the child has no level" arrive at the write path as the same value. Reading
 * that value as an assertion makes every later containment message an eraser: a
 * second producer re-asserting a boundary it cares about, and saying nothing
 * about the level because it has nothing to say, unplaces a referent some
 * earlier claim placed. Nothing in the ledger records that it happened, and the
 * only way back is a message that names the level again.
 *
 * So the ruling this suite pins is: **a null `childLevel` is the absence of
 * placement information, and only a non-null level overwrites.** Explicit
 * unplacement is a message type nobody has needed yet, not the default value of
 * an omitted field.
 *
 * The negative halves matter as much as the positive one. A level still
 * overwrites a *different* level — this is not "first placement wins" — and a
 * referent whose only containment claim carries no level is still unplaced,
 * because `null` remains the correct starting state. It just cannot un-set one.
 *
 * The live write path and `rebuild-index` reach this rule by two separate pieces
 * of code (`ingest/index.ts`'s `submitContainment` and `ingest/rebuild.ts`'s pass
 * 3), so each is asserted on its own. A rule enforced in one of the two is a
 * graph that changes what it believes about a level the first time somebody runs
 * a rebuild.
 *
 * @spec §3.1, §3.3, §11
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContainmentMessage, IngestPort } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import { openGraphStore, type GraphStore } from '../../store/index';

import {
  agentOrigin,
  claimMessage,
  containmentMessage,
  fakeAdjudicator,
  fakeEmbeddings,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from './fixtures';

let store: GraphStore;
let embeddings: FakeEmbeddings;
let adjudicator: FakeAdjudicator;
let ingest: IngestPort;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  embeddings = fakeEmbeddings();
  adjudicator = fakeAdjudicator();
  ingest = openIngest({ store, embeddings, adjudicator });
});

afterEach(() => {
  store.close();
});

/**
 * A containment message with no `childLevel` key at all.
 *
 * The key is dropped rather than set to `null` because the two spellings are the
 * same message — zod's `.default(null)` collapses them before the write path
 * sees either — and the case this suite is about is the one a producer reaches
 * by *not thinking about levels*. Writing `childLevel: null` in every fixture
 * would read as a deliberate assertion of "no level", which is exactly the
 * reading the ruling rejects.
 *
 * @spec §3.1
 */
const unlevelled = (
  parent: string,
  child: string,
  overrides: Partial<Omit<ContainmentMessage, 'type' | 'childLevel'>> = {},
): ContainmentMessage => {
  const { childLevel: _omitted, ...message } = containmentMessage(parent, child, overrides);
  return message;
};

/** The referent id a surface form names. */
const idOf = (surfaceForm: string): string => {
  const id = store.resolveMention(surfaceForm);
  if (id === undefined) throw new Error(`nothing in the index is named "${surfaceForm}"`);
  return id;
};

/** The level a port reports for a referent, or a failure loud enough to read. @spec §3.1 */
const levelOf = (port: IngestPort, referentId: string): string | null => {
  const referent = port.referents.get(referentId);
  if (referent === undefined) throw new Error(`the index holds no row for ${referentId}`);
  return referent.level;
};

/**
 * Drops the three projections and regenerates them through a port that never
 * watched the graph grow.
 *
 * @spec §3.1, §11
 */
const rebuiltFromLedger = async (): Promise<IngestPort> => {
  store.clearViews();
  const rebuilt = openIngest({ store, embeddings, adjudicator });
  await rebuilt.rebuildIndex();
  return rebuilt;
};

/**
 * Two usage-born referents, neither of them placed.
 *
 * Grown from ordinary claims rather than minted by the containment message under
 * test, so the child's *existence* claim records `level: null` and every level
 * this suite reads back came from a containment claim and from nowhere else. A
 * child minted by its own containment message carries that message's level in
 * its existence payload too, which would let a rebuild restore the level from
 * pass 1 and leave pass 3 untested.
 *
 * @spec §3.1
 */
const growUnplacedPair = async (): Promise<void> => {
  await ingest.submit(
    claimMessage('AuthService validates bearer tokens before dispatch.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  await ingest.submit(
    claimMessage('The practice survives its own justification.', ['practice'], {
      origin: agentOrigin(2),
    }),
  );
};

describe('a containment claim carrying no level', () => {
  it('leaves a placement an earlier claim made exactly where it was', async () => {
    await growUnplacedPair();
    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'module',
        origin: agentOrigin(3),
      }),
    );

    await ingest.submit(unlevelled('AuthService', 'practice', { origin: agentOrigin(4) }));

    expect(levelOf(ingest, idOf('practice'))).toBe('module');
  });

  it('leaves it there through a rebuild, so the two views cannot disagree', async () => {
    await growUnplacedPair();
    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'module',
        origin: agentOrigin(3),
      }),
    );
    await ingest.submit(unlevelled('AuthService', 'practice', { origin: agentOrigin(4) }));

    await ingest.rebuildIndex();

    expect(levelOf(ingest, idOf('practice'))).toBe('module');
  });

  it('leaves a child nothing has placed unplaced — null is still where a referent starts', async () => {
    await growUnplacedPair();

    await ingest.submit(unlevelled('AuthService', 'practice', { origin: agentOrigin(3) }));

    expect(levelOf(ingest, idOf('practice'))).toBeNull();
    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([idOf('practice')]);
  });
});

describe('a containment claim carrying a level', () => {
  it('overwrites a different level an earlier claim placed', async () => {
    await growUnplacedPair();
    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'module',
        origin: agentOrigin(3),
      }),
    );

    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'symbol',
        origin: agentOrigin(4),
      }),
    );

    expect(levelOf(ingest, idOf('practice'))).toBe('symbol');
  });

  it('has the rebuild land on the same overwrite', async () => {
    await growUnplacedPair();
    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'module',
        origin: agentOrigin(3),
      }),
    );
    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'symbol',
        origin: agentOrigin(4),
      }),
    );
    const practice = idOf('practice');

    const rebuilt = await rebuiltFromLedger();

    expect(levelOf(rebuilt, practice)).toBe('symbol');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The rebuild's own copy of the rule.
 * ---------------------------------------------------------------------------
 *
 * `rebuild-index` replays the containment claims in ledger order against a
 * cleared index, which is a different piece of code from the live write path and
 * a different set of inputs: the live path compares the message's level against
 * the entity row it is about to patch, the rebuild compares each payload's level
 * against whatever the previous payload left behind. A fix applied to one of them
 * leaves the other free to disagree, and the disagreement only surfaces the first
 * time someone runs a rebuild — long after the message that erased the level.
 */

describe('a ledger holding a levelled containment and then an unlevelled one', () => {
  it('rebuilds to the level, not to null', async () => {
    await growUnplacedPair();
    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'module',
        origin: agentOrigin(3),
      }),
    );
    await ingest.submit(unlevelled('AuthService', 'practice', { origin: agentOrigin(4) }));
    const practice = idOf('practice');

    const rebuilt = await rebuiltFromLedger();

    expect(levelOf(rebuilt, practice)).toBe('module');
  });

  it('still rebuilds the edge the unlevelled claim re-asserted', async () => {
    await growUnplacedPair();
    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'module',
        origin: agentOrigin(3),
      }),
    );
    await ingest.submit(unlevelled('AuthService', 'practice', { origin: agentOrigin(4) }));
    const authService = idOf('AuthService');
    const practice = idOf('practice');

    const rebuilt = await rebuiltFromLedger();

    expect(rebuilt.referents.childrenOf(authService)).toStrictEqual([practice]);
  });
});
