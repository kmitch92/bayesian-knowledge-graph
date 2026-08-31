/**
 * Draining the port's ledger scans: `scanClaimIds` and `scanReferentIds`.
 *
 * `src/store/__tests__/ledger-scan.test.ts` pins what one page of a scan is.
 * This file pins what the layer above does with a sequence of them, and there is
 * exactly one thing it does: it asks for the next page until a page comes back
 * empty. `rebuild-index` replays whatever these two return, so a drain that
 * stops one page early does not fail — it rebuilds a prefix of the graph and
 * reports success, which is the failure mode F1 exists to remove.
 *
 * The seam is between two numbers that live in different modules: the store's
 * page size, and the caller's stop condition. Every other ledger in the suite
 * ends on a *short* page, and a short page is a stop condition a caller can get
 * right by accident — stopping there gives the same answer as stopping on the
 * empty page after it. Sizing a table at an exact multiple of the page size is
 * the case where the two part company: the last page holding rows is full, and
 * the only thing that ends the walk is the empty page nobody would have asked
 * for if a full page had been treated as the end.
 *
 * The rows are written straight at the store rather than grown through
 * `openIngest`. What is under test is an enumeration, not a resolution: these
 * scans read ids and nothing else, the ladder that `openIngest` would run per
 * mint is quadratic, and a thousand referents grown that way would cost a minute
 * to prove something about a `for` loop.
 *
 * @spec §3.1, §3.2, §11, §16
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openGraphStore, type GraphStore } from '../../store/index';
import { LEDGER_SCAN_PAGE } from '../../store/sqlite-graph-store';
import { makeClaim, makeEntity, testUlid, unitVectorArray } from '../../store/__tests__/fixtures';

import { scanClaimIds, scanReferentIds } from '../index-view';

/**
 * Referents written: exactly one page.
 *
 * The exact-multiple case. One full page, then an empty one, and a drain that
 * mistook the full page for the end would return every row and still be wrong —
 * so this test is here for the walk's *shape*, and {@link DRAINED_CLAIMS} is
 * here for its length.
 *
 * @spec §3.1, §11
 */
const DRAINED_REFERENTS = LEDGER_SCAN_PAGE;

/**
 * Claims written: one more than a page.
 *
 * The smallest ledger a drain that stopped on a full page gets wrong, and it
 * gets it wrong by exactly one row. Paired with {@link DRAINED_REFERENTS}
 * because neither number alone distinguishes the two ways the loop can be
 * written: an exact multiple proves the empty page is asked for, and a multiple
 * plus one proves a full page is not mistaken for the end.
 *
 * @spec §3.2, §11
 */
const DRAINED_CLAIMS = LEDGER_SCAN_PAGE + 1;

/** One vector for every row. A drain reads ids; the geometry decides nothing here. @spec §11 */
const DRAIN_EMBEDDING = unitVectorArray(31);

/** The claim id at a given position in the ledger's id order. @spec §3.2 */
const drainClaimId = (index: number): string =>
  testUlid(`DRAINCLAIM${String(index).padStart(4, '0')}`);

/** The referent id at a given position in the index's id order. @spec §3.1 */
const drainEntityId = (index: number): string =>
  testUlid(`DRAINENTITY${String(index).padStart(4, '0')}`);

/** Every claim id written, in the order a complete drain must return them. */
const CLAIM_IDS: readonly string[] = Array.from({ length: DRAINED_CLAIMS }, (_, index) =>
  drainClaimId(index),
);

/** Every referent id written, in the order a complete drain must return them. */
const ENTITY_IDS: readonly string[] = Array.from({ length: DRAINED_REFERENTS }, (_, index) =>
  drainEntityId(index),
);

/**
 * The order rows are written in: odd positions, then even ones.
 *
 * Neither id order nor its reverse, so a drain that came back in arrival order
 * cannot pass by looking sorted. `scanClaimIds` lost its trailing `.sort()` when
 * it stopped being a KNN probe, on the grounds that the statement underneath
 * orders by id — this is what holds that reasoning to account.
 */
const arrivalOrder = (rows: number): readonly number[] => {
  const positions = Array.from({ length: rows }, (_, index) => index);
  return [...positions.filter((index) => index % 2 === 1), ...positions.filter((index) => index % 2 === 0)];
};

/** Refuses a fixture whose ids are not strictly ascending. A broken fixture is a broken test. */
const assertStrictlyAscending = (ids: readonly string[]): void => {
  for (let index = 1; index < ids.length; index += 1)
    if (ids[index - 1]! >= ids[index]!)
      throw new Error(`fixture ids are not ascending at ${index}`);
};

describe('draining a ledger that does not end on a short page', () => {
  /**
   * Written once. Nothing here mutates the rows, and two thousand writes is
   * under a second, so a per-test fixture would buy an isolation these reads
   * have no way to spend.
   */
  let store: GraphStore;

  beforeAll(() => {
    assertStrictlyAscending(CLAIM_IDS);
    assertStrictlyAscending(ENTITY_IDS);
    store = openGraphStore({ path: ':memory:' });
    for (const index of arrivalOrder(DRAINED_REFERENTS))
      store.putEntity(
        makeEntity({
          id: drainEntityId(index),
          name: `Drained${index}`,
          glossEmbedding: DRAIN_EMBEDDING,
          facets: [],
        }),
      );
    for (const index of arrivalOrder(DRAINED_CLAIMS))
      store.putClaim(
        makeClaim({
          id: drainClaimId(index),
          text: `Drained row ${index} was written.`,
          embedding: DRAIN_EMBEDDING,
          scope: drainEntityId(0),
        }),
      );
  });

  afterAll(() => {
    store.close();
  });

  it('returns every referent when the index holds exactly one page of them', () => {
    expect(scanReferentIds(store)).toStrictEqual([...ENTITY_IDS]);
  });

  it('returns every claim when the ledger holds one row more than a page', () => {
    expect(scanClaimIds(store)).toStrictEqual([...CLAIM_IDS]);
  });

  it('returns each id once, so no page is served twice on the way to the empty one', () => {
    const claims = scanClaimIds(store);
    const referents = scanReferentIds(store);

    expect(new Set(claims).size).toBe(claims.length);
    expect(new Set(referents).size).toBe(referents.length);
  });

  it('crosses more than one page, so the walk is a walk and not a single read', () => {
    expect(scanClaimIds(store).length).toBeGreaterThan(LEDGER_SCAN_PAGE);
  });
});
