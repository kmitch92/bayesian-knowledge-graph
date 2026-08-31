/**
 * A real ledger scan on the port: `listClaimIds` and `listEntityIds`.
 *
 * The `GraphStore` port has no enumeration. The only way to list everything
 * today is a KNN probe with a fixed unit vector capped at `sqlite-vec`'s
 * ceiling, which is not an enumeration at all — it is the first page of one,
 * silently. `rebuild-index` stands on that probe, so a graph larger than the cap
 * rebuilds an arbitrary subset of itself and reports success. §16 asks for 100k
 * claims; the cap is 4096.
 *
 * What replaces it is deliberately the dullest read in the file:
 * `SELECT id FROM <table> WHERE id > ? ORDER BY id LIMIT ?`. Ids only, ascending,
 * no joins, no filters, keyset-paginated on the primary key. Every property this
 * suite pins follows from that one statement, and each is a way the statement can
 * be written wrong:
 *
 * - **Ascending by id, not by arrival.** The rows are written out of id order
 *   here on purpose (see {@link ARRIVAL_ORDER}), because `ORDER BY id` and
 *   `ORDER BY rowid` agree on a ledger inserted in order — and insertion order
 *   is the one thing a rebuild cannot assume it still has.
 * - **`>` and not `>=`.** The off-by-one that repeats one row per page and drops
 *   the last row of the ledger. A test that only checks the concatenation is a
 *   set can miss it; {@link ARRIVAL_ORDER}'s boundary tests cannot.
 * - **Positional, not a membership check.** `afterId` says where to resume, never
 *   which row to resume from. A caller that pages a large ledger will hand back
 *   an id that was archived, superseded or rewritten between pages, and a scan
 *   that looked the row up first would return nothing and call the ledger
 *   exhausted.
 * - **Two tables, two scans.** Claims are not referents, and neither leaks into
 *   the other's page.
 *
 * There is no `includeArchived` here and there is not meant to be. §6.1's
 * archived filter is a *retrieval* policy — it keeps dead claims out of
 * candidates, where "if ANN surfaces one, that is a bug". A ledger scan is the
 * opposite kind of read: it enumerates rows so that a view can be rebuilt from
 * them, and a rebuild that skipped the retired claims would regenerate an index
 * that has forgotten every referent whose existence claim was ever withdrawn.
 * The scan reports rows. Lifecycle is somebody else's question.
 *
 * @spec §3.1, §3.2, §3.5, §6.1, §11, §16
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openGraphStore, type GraphStore } from '../index';
import { LEDGER_SCAN_PAGE } from '../sqlite-graph-store';

import { INVALIDATED_AT, makeClaim, makeEntity, testUlid, unitVectorArray } from './fixtures';

/**
 * Rows written per table.
 *
 * Chosen against {@link PAGE_SIZE} rather than for size: 25 over 7 is four
 * pages, three full and one short, which is the smallest ledger that exercises
 * a middle page at all and the final partial page as well. A ledger that fits
 * in one page proves nothing about paging, and one that divides evenly never
 * asks what the last page looks like.
 */
const LEDGER_ROWS = 25;

/** Ids per page. Coprime with {@link LEDGER_ROWS}, so the final page is short. */
const PAGE_SIZE = 7;

/** A limit no page can reach, for the reads that want the whole table at once. */
const WHOLE_TABLE = LEDGER_ROWS * 4;

/** The claim id at a given position in the ledger's id order. @spec §3.2 */
const claimScanId = (index: number): string =>
  testUlid(`CLAIMSCAN${String(index).padStart(3, '0')}`);

/** The referent id at a given position in the index's id order. @spec §3.1 */
const entityScanId = (index: number): string =>
  testUlid(`ENTITYSCAN${String(index).padStart(3, '0')}`);

/** Every claim id this suite writes, in the order a correct scan must serve them. */
const CLAIM_IDS: readonly string[] = Array.from({ length: LEDGER_ROWS }, (_, index) =>
  claimScanId(index),
);

/** Every referent id this suite writes, in the order a correct scan must serve them. */
const ENTITY_IDS: readonly string[] = Array.from({ length: LEDGER_ROWS }, (_, index) =>
  entityScanId(index),
);

/**
 * The order rows are written in: every odd position, then every even one.
 *
 * Neither the id order nor its reverse, which matters because `ORDER BY id` and
 * `ORDER BY rowid` are indistinguishable on a table filled in id order. A scan
 * that pages by insertion passes a suite that writes in order and then fails the
 * first time a real ledger interleaves two episodes.
 */
const ARRIVAL_ORDER: readonly number[] = [
  ...Array.from({ length: LEDGER_ROWS }, (_, index) => index).filter((index) => index % 2 === 1),
  ...Array.from({ length: LEDGER_ROWS }, (_, index) => index).filter((index) => index % 2 === 0),
];

/**
 * One vector, reused by every row.
 *
 * A ledger scan is not a vector query, and giving each row its own embedding
 * would suggest the geometry decides something here. It decides nothing: these
 * rows are indistinguishable in vector space and the scan must still enumerate
 * all of them in id order.
 *
 * @spec §11
 */
const SCAN_EMBEDDING = unitVectorArray(30);

/** The anchor the scanned claims name. Written in some tests, absent in others — `putClaim` checks neither. @spec §3.5 */
const SCAN_ANCHOR_ID = entityScanId(0);

/**
 * Refuses a fixture whose ids are not strictly ascending.
 *
 * The suite asserts that a scan returns {@link CLAIM_IDS} verbatim, which only
 * means "ascending" while the fixture is. Thrown rather than expected, because
 * a broken fixture is a broken test rather than a failing behaviour.
 */
const assertStrictlyAscending = (ids: readonly string[]): void => {
  for (let index = 1; index < ids.length; index += 1)
    if (ids[index - 1]! >= ids[index]!)
      throw new Error(`fixture ids are not ascending at ${index}: ${ids.join(', ')}`);
};

/**
 * An id no row holds, sorting strictly between the two written ids either side
 * of `index`.
 *
 * The bound a keyset scan is asked to resume from when the row it names is gone.
 * Built by lifting the last character of the id below it, and checked rather
 * than assumed, so the fixture cannot rot into an id that sorts somewhere else
 * entirely and quietly weaken the assertion into a full-table read.
 */
const unwrittenMidpoint = (ids: readonly string[], index: number): string => {
  const below = ids[index - 1]!;
  const above = ids[index]!;
  const midpoint = `${below.slice(0, -1)}1`;
  if (midpoint <= below || midpoint >= above)
    throw new Error(`${midpoint} does not sort between ${below} and ${above}`);
  return midpoint;
};

/**
 * Bounds a caller can hand back that are not ids at all.
 *
 * `afterId` is a bound, not a lookup, so nothing constrains its text: it is
 * whatever the caller last saw, and a caller can be wrong about that. Each of
 * these is a way the bound could stop being a value — spliced into the SQL, or
 * read as a `LIKE` pattern, or compared by something other than the column's
 * collation — and each is asserted against the ids that sort above it rather
 * than against a hand-written answer, so the expectation cannot drift out of
 * agreement with the alphabet the fixture ids are drawn from.
 *
 * The first three sort below every ULID and must therefore serve the whole
 * table; the last three sort above and must serve none of it. That the set
 * splits both ways is the point — a scan that ignored the bound entirely would
 * pass one half and fail the other.
 *
 * @spec §11
 */
const FOREIGN_BOUNDS = [
  { label: 'a statement terminator and a comment', text: "'; DROP TABLE claims; --" },
  { label: "LIKE's multi-character wildcard", text: '%' },
  { label: 'a double quote', text: '"' },
  { label: "LIKE's single-character wildcard", text: '_' },
  { label: 'text outside ASCII', text: '日本語' },
  { label: 'an astral-plane emoji', text: '🙂' },
] as const;

/** An id above everything either table holds — the ULID alphabet's last character, repeated. */
const ABOVE_EVERY_ID = 'Z'.repeat(26);

/** Where {@link unwrittenMidpoint} cuts the ledger: high enough that a full read would look nothing like it. */
const MIDPOINT_INDEX = 12;

/**
 * The real SQLite store, reached directly. Nothing is stubbed and nothing is
 * mocked, and nothing is cast: both scans are on {@link GraphStore} now, so a
 * store that stopped offering them fails this file at the typecheck rather than
 * at the call.
 */
let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

/** Writes {@link LEDGER_ROWS} claims, out of id order. @spec §3.2 */
const writeClaims = (): void => {
  assertStrictlyAscending(CLAIM_IDS);
  for (const index of ARRIVAL_ORDER)
    store.putClaim(
      makeClaim({
        id: claimScanId(index),
        text: `Ledger row ${index} was written.`,
        embedding: SCAN_EMBEDDING,
        scope: SCAN_ANCHOR_ID,
      }),
    );
};

/** Writes {@link LEDGER_ROWS} referent-index rows, out of id order. @spec §3.1 */
const writeEntities = (): void => {
  assertStrictlyAscending(ENTITY_IDS);
  for (const index of ARRIVAL_ORDER)
    store.putEntity(
      makeEntity({
        id: entityScanId(index),
        name: `Referent${index}`,
        glossEmbedding: SCAN_EMBEDDING,
        facets: [],
      }),
    );
};

/**
 * Pages a scan to exhaustion the way a caller has to: start with no bound, hand
 * back the last id of the previous page, stop when a page comes back empty.
 *
 * The loop is bounded so that a scan which never advances — the `>=` bug, which
 * re-serves the same page forever — fails loudly instead of hanging the suite.
 */
const pageThrough = (
  list: (afterId?: string, limit?: number) => string[],
  pageSize: number,
): string[][] => {
  const pages: string[][] = [];
  let afterId: string | undefined;
  while (pages.length <= LEDGER_ROWS) {
    const page = list(afterId, pageSize);
    if (page.length === 0) return pages;
    pages.push(page);
    afterId = page[page.length - 1];
  }
  throw new Error(`the scan served ${pages.length} pages without exhausting the table`);
};

/** Pages the claim ledger to exhaustion. @spec §3.2, §11 */
const pageClaimIds = (pageSize: number): string[][] =>
  pageThrough((afterId, limit) => store.listClaimIds(afterId, limit), pageSize);

/** Pages the referent index to exhaustion. @spec §3.1, §11 */
const pageEntityIds = (pageSize: number): string[][] =>
  pageThrough((afterId, limit) => store.listEntityIds(afterId, limit), pageSize);

/**
 * One scan under test, with the table it enumerates.
 *
 * The two scans make identical promises over different tables, so they are
 * asserted identically rather than in two hand-copied blocks that could drift
 * into asserting different things about the same contract.
 */
interface ScanUnderTest {
  /** The port method's name, so a failure says which scan broke. */
  readonly label: string;
  /** What it enumerates, for test names that read as sentences. */
  readonly rows: string;
  readonly write: () => void;
  readonly list: (afterId?: string, limit?: number) => string[];
  /** Every id {@link ScanUnderTest.write} writes, ascending. */
  readonly ids: readonly string[];
}

const SCANS: readonly ScanUnderTest[] = [
  {
    label: 'listClaimIds',
    rows: 'claims',
    write: () => {
      writeClaims();
    },
    list: (afterId, limit) => store.listClaimIds(afterId, limit),
    ids: CLAIM_IDS,
  },
  {
    label: 'listEntityIds',
    rows: 'referents',
    write: () => {
      writeEntities();
    },
    list: (afterId, limit) => store.listEntityIds(afterId, limit),
    ids: ENTITY_IDS,
  },
];

for (const scan of SCANS) {
  describe(`${scan.label}: enumerating every one of the ${scan.rows} by paging`, () => {
    beforeEach(() => {
      scan.write();
    });

    it('serves the whole table, in ascending id order, when paged to exhaustion', () => {
      const pages = pageThrough(scan.list, PAGE_SIZE);

      expect(pages.flat()).toStrictEqual([...scan.ids]);
    });

    it('serves each id exactly once, with nothing repeated and nothing skipped', () => {
      const served = pageThrough(scan.list, PAGE_SIZE).flat();

      expect(new Set(served).size).toBe(served.length);
      expect(new Set(served)).toStrictEqual(new Set(scan.ids));
    });

    it('ends on a short final page rather than a full one', () => {
      const pages = pageThrough(scan.list, PAGE_SIZE);

      expect(pages.map((page) => page.length)).toStrictEqual([7, 7, 7, 4]);
    });

    it('starts from the beginning of the table when no afterId is given', () => {
      expect(scan.list(undefined, PAGE_SIZE)).toStrictEqual(scan.ids.slice(0, PAGE_SIZE));
    });

    it('never serves more ids than the limit allows', () => {
      expect(scan.list(undefined, 1)).toStrictEqual(scan.ids.slice(0, 1));
      expect(scan.list(undefined, PAGE_SIZE)).toHaveLength(PAGE_SIZE);
    });

    it('serves the whole table in one page when the limit is large enough', () => {
      expect(scan.list(undefined, WHOLE_TABLE)).toStrictEqual([...scan.ids]);
    });
  });

  describe(`${scan.label}: the page boundary`, () => {
    beforeEach(() => {
      scan.write();
    });

    it('does not repeat the last id of a page as the first id of the next', () => {
      const first = scan.list(undefined, PAGE_SIZE);
      const boundary = first[first.length - 1];

      const second = scan.list(boundary, PAGE_SIZE);

      expect(second[0]).not.toBe(boundary);
      expect(second).not.toContain(boundary);
    });

    it('resumes at the id immediately above the last one served', () => {
      const first = scan.list(undefined, PAGE_SIZE);
      expect(first[first.length - 1]).toBe(scan.ids[PAGE_SIZE - 1]);

      const second = scan.list(first[first.length - 1], PAGE_SIZE);

      expect(second[0]).toBe(scan.ids[PAGE_SIZE]);
      expect(second).toStrictEqual(scan.ids.slice(PAGE_SIZE, PAGE_SIZE * 2));
    });

    it('leaves no id unserved across the seam of every page it draws', () => {
      const pages = pageThrough(scan.list, PAGE_SIZE);

      const seams = pages.slice(1).map((page, index) => {
        const previous = pages[index]!;
        return [previous[previous.length - 1], page[0]] as const;
      });
      expect(seams).toStrictEqual(
        [1, 2, 3].map((page) => [scan.ids[page * PAGE_SIZE - 1], scan.ids[page * PAGE_SIZE]]),
      );
    });
  });

  describe(`${scan.label}: where afterId points`, () => {
    beforeEach(() => {
      scan.write();
    });

    it('serves nothing once the scan reaches the last id in the table', () => {
      expect(scan.list(scan.ids[scan.ids.length - 1], PAGE_SIZE)).toStrictEqual([]);
    });

    it('serves nothing for an afterId above every id in the table', () => {
      expect(scan.list(ABOVE_EVERY_ID, PAGE_SIZE)).toStrictEqual([]);
    });

    it('is positional rather than a membership check: an afterId no row holds still serves everything above it', () => {
      const midpoint = unwrittenMidpoint(scan.ids, MIDPOINT_INDEX);

      expect(scan.list(midpoint, WHOLE_TABLE)).toStrictEqual(scan.ids.slice(MIDPOINT_INDEX));
    });

    it('resumes from an id that has since left the table rather than reporting the table exhausted', () => {
      const midpoint = unwrittenMidpoint(scan.ids, MIDPOINT_INDEX);

      expect(scan.list(midpoint, PAGE_SIZE)).toStrictEqual(
        scan.ids.slice(MIDPOINT_INDEX, MIDPOINT_INDEX + PAGE_SIZE),
      );
    });

  });

  describe(`${scan.label}: an afterId that is not an id`, () => {
    beforeEach(() => {
      scan.write();
    });

    for (const bound of FOREIGN_BOUNDS)
      it(`compares ${bound.label} as a value rather than splicing it into the statement`, () => {
        expect(scan.list(bound.text, WHOLE_TABLE)).toStrictEqual(
          scan.ids.filter((id) => id > bound.text),
        );
      });

    it('still holds every row after a bound that reads like a statement of its own', () => {
      for (const bound of FOREIGN_BOUNDS) scan.list(bound.text, WHOLE_TABLE);

      expect(scan.list(undefined, WHOLE_TABLE)).toStrictEqual([...scan.ids]);
    });
  });

  describe(`${scan.label}: an empty table`, () => {
    it('serves nothing, rather than failing, when nothing has been written', () => {
      expect(scan.list(undefined, PAGE_SIZE)).toStrictEqual([]);
    });

    it('serves nothing for an afterId when nothing has been written', () => {
      expect(scan.list(scan.ids[0], PAGE_SIZE)).toStrictEqual([]);
    });
  });
}

describe('the two scans do not leak into each other', () => {
  beforeEach(() => {
    writeEntities();
    writeClaims();
  });

  it('serves only claim ids from listClaimIds, never a referent id', () => {
    expect(store.listClaimIds(undefined, WHOLE_TABLE)).toStrictEqual([...CLAIM_IDS]);
  });

  it('serves only referent ids from listEntityIds, never a claim id', () => {
    expect(store.listEntityIds(undefined, WHOLE_TABLE)).toStrictEqual([...ENTITY_IDS]);
  });

  it('keeps the two enumerations disjoint', () => {
    const claims = new Set(store.listClaimIds(undefined, WHOLE_TABLE));
    const referents = new Set(store.listEntityIds(undefined, WHOLE_TABLE));

    expect([...referents].filter((id) => claims.has(id))).toStrictEqual([]);
  });

  it('pages the two tables independently, so one exhausting does not end the other', () => {
    expect(pageClaimIds(PAGE_SIZE).flat()).toStrictEqual([...CLAIM_IDS]);
    expect(pageEntityIds(PAGE_SIZE).flat()).toStrictEqual([...ENTITY_IDS]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A ledger scan enumerates rows. It does not apply lifecycle policy.
 * ---------------------------------------------------------------------------
 *
 * `searchClaims` takes an `includeArchived` because §6.1 puts archived claims
 * out of candidate retrieval entirely. This scan takes no such flag and must
 * not grow one: `rebuild-index` replays the ledger to regenerate a view, and the
 * status of a claim is part of what the replay reads — a rebuild that could not
 * see the retired existence claims would restore an index that had forgotten
 * every referent ever withdrawn, and would restore the wrong regime for every
 * referent attested, retracted and attested again.
 *
 * @spec §6.1, §11
 */

/**
 * Which rows get retired: one early, one mid-table, one late.
 *
 * Spread across the pages on purpose. A single retired row at the head would
 * leave a filtered scan's first page looking like a short page, which is a shape
 * this suite already produces legitimately at the end of the table.
 *
 * @spec §6.1
 */
const RETIRED_INDICES = [3, 10, 20] as const;

describe('the scan is a ledger scan, not a lifecycle read', () => {
  it('lists a claim that has been archived', () => {
    store.putClaim(
      makeClaim({ id: claimScanId(0), embedding: SCAN_EMBEDDING, scope: SCAN_ANCHOR_ID }),
    );
    store.setClaimStatus({
      claimId: claimScanId(0),
      status: 'archived',
      invalidatedAt: INVALIDATED_AT,
    });

    expect(store.listClaimIds(undefined, WHOLE_TABLE)).toStrictEqual([claimScanId(0)]);
  });

  it('lists a claim that has been deprecated', () => {
    store.putClaim(
      makeClaim({ id: claimScanId(0), embedding: SCAN_EMBEDDING, scope: SCAN_ANCHOR_ID }),
    );
    store.setClaimStatus({
      claimId: claimScanId(0),
      status: 'deprecated',
      invalidatedAt: INVALIDATED_AT,
    });

    expect(store.listClaimIds(undefined, WHOLE_TABLE)).toStrictEqual([claimScanId(0)]);
  });

  it('serves retired and live claims in one ascending run, with no gap where the retired ones were', () => {
    writeClaims();
    for (const index of RETIRED_INDICES)
      store.setClaimStatus({
        claimId: claimScanId(index),
        status: 'archived',
        invalidatedAt: INVALIDATED_AT,
      });

    expect(pageClaimIds(PAGE_SIZE).flat()).toStrictEqual([...CLAIM_IDS]);
  });

  it('does not let a retired claim shorten the page it falls in', () => {
    writeClaims();
    for (const index of RETIRED_INDICES)
      store.setClaimStatus({
        claimId: claimScanId(index),
        status: 'archived',
        invalidatedAt: INVALIDATED_AT,
      });

    expect(store.listClaimIds(undefined, PAGE_SIZE)).toStrictEqual(CLAIM_IDS.slice(0, PAGE_SIZE));
  });
});

/*
 * ---------------------------------------------------------------------------
 * The two numbers twenty-five rows cannot reach.
 * ---------------------------------------------------------------------------
 *
 * Everything above pages seven ids at a time through twenty-five rows, which is
 * enough to pin the shape of a keyset walk and not enough to reach either number
 * that decides whether a §16-sized rebuild is complete:
 *
 * - {@link LEDGER_SCAN_PAGE}, what one page holds when the caller names no
 *   limit. Every read above passes an explicit limit, so nothing above would
 *   notice if the default were one, or the whole table.
 * - 4096, the `sqlite-vec` `k` ceiling this scan exists to get out from under.
 *   A twenty-five-row ledger passes just as happily against the KNN probe F1
 *   deleted as against the statement that replaced it.
 *
 * @spec §11, §16
 */

/**
 * The ceiling the KNN probe enumerated under.
 *
 * A literal rather than an import: the constant that used to spell it was
 * deleted with the probe, and a regression guard that fails to compile once the
 * cap is reintroduced somewhere else is not a guard.
 *
 * @spec §11
 */
const ANN_CEILING = 4_096;

/**
 * Claims in the large ledger: one more than the ceiling.
 *
 * The smallest ledger that proves the cap is gone. Sized at the ceiling rather
 * than at {@link LEDGER_SCAN_PAGE} because a cap and a page size fail
 * differently — a page size that is too small costs another round trip, and a
 * cap costs rows — and this section is about the second.
 *
 * @spec §11, §16
 */
const BULK_ROWS = ANN_CEILING + 1;

/**
 * Rows left above {@link BULK_BOUND}: four full pages and no remainder.
 *
 * The seam between the store's page size and a caller's stop condition. A caller
 * pages until a page comes back empty, and on every other ledger this file
 * writes the last page is short — which is a stop condition a caller could get
 * right by accident, by stopping on a page thinner than it asked for. Here the
 * last page holding rows is *full*, so the only thing that ends the walk is the
 * empty page after it.
 *
 * @spec §11
 */
const EXACT_MULTIPLE = LEDGER_SCAN_PAGE * 4;

/** The bound that leaves {@link EXACT_MULTIPLE} rows above it. */
const BULK_BOUND_INDEX = BULK_ROWS - EXACT_MULTIPLE - 1;

/** The claim id at a given position in the large ledger's id order. @spec §3.2 */
const bulkClaimId = (index: number): string =>
  testUlid(`BULKSCAN${String(index).padStart(4, '0')}`);

/** Every id the large ledger holds, in the order a correct scan must serve them. */
const BULK_IDS: readonly string[] = Array.from({ length: BULK_ROWS }, (_, index) =>
  bulkClaimId(index),
);

describe('a ledger larger than one page and larger than the ANN ceiling', () => {
  /**
   * Written once for the whole block.
   *
   * Four thousand rows is under a second of writes and no test here mutates
   * them, so re-seeding per test would buy an isolation this section has
   * nothing to spend it on. The store is its own — the file-level `beforeEach`
   * keeps handing out fresh empty ones, and this block simply does not use them.
   */
  let bulk: GraphStore;

  beforeAll(() => {
    assertStrictlyAscending(BULK_IDS);
    bulk = openGraphStore({ path: ':memory:' });
    for (const index of [
      ...Array.from({ length: BULK_ROWS }, (_, i) => i).filter((i) => i % 2 === 1),
      ...Array.from({ length: BULK_ROWS }, (_, i) => i).filter((i) => i % 2 === 0),
    ])
      bulk.putClaim(
        makeClaim({
          id: bulkClaimId(index),
          text: `Bulk row ${index} was written.`,
          embedding: SCAN_EMBEDDING,
          scope: SCAN_ANCHOR_ID,
        }),
      );
  });

  afterAll(() => {
    bulk.close();
  });

  /**
   * Pages the large ledger at whatever the store's default page size is, which
   * is the walk `rebuild-index` performs: it names no limit, so the number of
   * round trips is the store's business and the caller's only job is to stop on
   * an empty page.
   */
  const drainAtDefaultPage = (from?: string): string[][] => {
    const pages: string[][] = [];
    let afterId = from;
    while (pages.length <= BULK_ROWS / LEDGER_SCAN_PAGE + 2) {
      const page = bulk.listClaimIds(afterId);
      if (page.length === 0) return pages;
      pages.push(page);
      afterId = page[page.length - 1];
    }
    throw new Error(`the scan served ${pages.length} pages without exhausting the table`);
  };

  it('serves every id in a ledger past the ANN ceiling, not the first page of them', () => {
    const served = drainAtDefaultPage().flat();

    expect(served.length).toBeGreaterThan(ANN_CEILING);
    expect(served).toStrictEqual([...BULK_IDS]);
  });

  it('serves each id exactly once across a walk of several pages', () => {
    const served = drainAtDefaultPage().flat();

    expect(new Set(served).size).toBe(served.length);
  });

  it('serves one default page when the caller names no limit', () => {
    expect(bulk.listClaimIds()).toStrictEqual(BULK_IDS.slice(0, LEDGER_SCAN_PAGE));
  });

  it('ends on an empty page rather than a short one when the rows left divide evenly', () => {
    const pages = drainAtDefaultPage(BULK_IDS[BULK_BOUND_INDEX]);

    expect(pages.map((page) => page.length)).toStrictEqual(
      Array.from({ length: EXACT_MULTIPLE / LEDGER_SCAN_PAGE }, () => LEDGER_SCAN_PAGE),
    );
    expect(pages.flat()).toStrictEqual(BULK_IDS.slice(BULK_BOUND_INDEX + 1));
  });
});
