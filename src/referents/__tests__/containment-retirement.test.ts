/**
 * What happens to a spine edge when the claim behind it stops standing.
 *
 * §3.3 makes `CONTAINS` *"the materialization of containment claims"*, and §3.1
 * makes the containment index one of the three projections `rebuild-index` must
 * be able to drop and regenerate from the ledger alone. Put together, those two
 * say the index holds exactly the edges the *live* containment claims assert —
 * no more, because `rebuild-index` already skips a claim §6.1 has retired
 * (`rebuild.ts` filters on `isLive` before it decodes a payload into a pass).
 *
 * The live write path has no matching half. An evidence-regime containment claim
 * materializes into `contains_index` the moment it is asserted (ratified for v1:
 * gather does not exist yet, and gating materialization on promotion would leave
 * every asserted spine empty until P3's corroboration machinery lands), and
 * nothing ever takes the row out again. So the moment a containment claim is
 * deprecated — by §6.2's `CONTRADICTS` cell falling through τ, by a dispute
 * resolved against it, by any of the P3 verdicts — the live index and a rebuilt
 * one hold different spines. One database, two answers to "what contains what",
 * and which one a caller gets depends on whether anybody has happened to run a
 * rebuild since.
 *
 * The obligation this suite pins is the other half of the immediate
 * materialization: **a containment claim that leaves the live set takes its
 * `contains_index` row with it, in the same breath.** Not at the next rebuild,
 * and not by filtering the read — §3.1's index is a table, and a read that
 * quietly re-derived its answer from the ledger would make `rebuild-index` a
 * no-op rather than a check.
 *
 * What it must *not* take with it is the referent. A child that loses its parent
 * has lost an edge, not its existence; its own existence claim is untouched, and
 * §6.1 keeps the retired containment claim readable for exactly as long as it
 * keeps everything else.
 *
 * @spec §3.1, §3.3, §6.1, §6.2, §11
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort, IngestReceipt } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import { retireClaim } from '../../ingest/spine-writer';
import { openGraphStore, type GraphStore } from '../../store/index';
import { decodeSpineClaim } from '../spine';

import {
  agentOrigin,
  attestationMessage,
  claimMessage,
  containmentMessage,
  emitterOrigin,
  fakeAdjudicator,
  fakeEmbeddings,
  retractionMessage,
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
 * A containment claim leaving the live set.
 *
 * There is no producer-facing door for this, and that was checked rather than
 * assumed: the four `IngestMessage` types are claim, attestation, containment and
 * retraction, and a retraction withdraws a *noun source's attestation* — it
 * cannot reach a containment claim at all. §6.2's adjudication matrix is still
 * `it.todo` in `src/lifecycle/__tests__/status-matrix.test.ts`, so the verdict
 * that will deprecate a boundary has not been built.
 *
 * What does exist is the write path's one retirement helper. Every retirement in
 * `src/ingest` already goes through it — an attestation superseding the evidence
 * claim a referent grew from, a retraction withdrawing an attestation — and a
 * dispute resolved against a boundary will leave by the same door, because it is
 * the only door. Driving the test through it names the seam for the fix rather
 * than inventing a port method to describe it.
 *
 * One call site on purpose: if F9 settles on a different seam, this is the only
 * line in the suite that moves.
 *
 * @spec §6.1, §6.2
 */
const deprecate = (claimId: string): void => {
  retireClaim(store, claimId);
};

/** The referent id a surface form names. */
const idOf = (surfaceForm: string): string => {
  const id = store.resolveMention(surfaceForm);
  if (id === undefined) throw new Error(`nothing in the index is named "${surfaceForm}"`);
  return id;
};

/** The ledger row a message wrote, or a failure loud enough to read. @spec §3.5 */
const claimIdOf = (receipt: IngestReceipt): string => {
  if (receipt.claimId === undefined) throw new Error('the message wrote no ledger row');
  return receipt.claimId;
};

/** A parent's `CONTAINS` targets, read through the structural channel. @spec §3.3 */
const containsEdgesOf = (referentId: string): string[] =>
  store
    .getStructuralEdges(referentId)
    .filter((edge) => edge.kind === 'CONTAINS')
    .map((edge) => edge.to);

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
 * Three usage-born referents, none of them placed and none of them nested.
 *
 * Usage-born rather than attested so that every `CONTAINS` edge read back below
 * was materialized by a containment claim and by nothing else, and so that
 * deprecating one of those claims is the only thing that could have removed one.
 *
 * @spec §3.1
 */
const growUnplacedTrio = async (): Promise<void> => {
  await ingest.submit(
    claimMessage('AuthService validates bearer tokens before dispatch.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  await ingest.submit(
    claimMessage('SessionStore expires idle sessions on a timer.', ['SessionStore'], {
      origin: agentOrigin(2),
    }),
  );
  await ingest.submit(
    claimMessage('The practice survives its own justification.', ['practice'], {
      origin: agentOrigin(3),
    }),
  );
};

describe('a containment claim that leaves the live set', () => {
  it('takes its CONTAINS edge out of the containment index', async () => {
    await growUnplacedTrio();
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(4) }),
    );
    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([idOf('practice')]);

    deprecate(claimIdOf(receipt));

    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([]);
    expect(containsEdgesOf(idOf('AuthService'))).toStrictEqual([]);
  });

  it('leaves the live index and a rebuilt one holding the same spine', async () => {
    await growUnplacedTrio();
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(4) }),
    );
    const authService = idOf('AuthService');

    deprecate(claimIdOf(receipt));
    const live = ingest.referents.childrenOf(authService);
    const rebuilt = await rebuiltFromLedger();

    expect(live).toStrictEqual([]);
    expect(rebuilt.referents.childrenOf(authService)).toStrictEqual([]);
  });

  it('removes only its own edge, not every edge its parent has', async () => {
    await growUnplacedTrio();
    await ingest.submit(
      containmentMessage('AuthService', 'SessionStore', { origin: agentOrigin(4) }),
    );
    const withdrawn = await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(5) }),
    );

    deprecate(claimIdOf(withdrawn));

    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([idOf('SessionStore')]);
  });

  it('stays readable in the ledger — §6.1 retires a claim, it does not delete one', async () => {
    await growUnplacedTrio();
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(4) }),
    );
    const claimId = claimIdOf(receipt);
    const authService = idOf('AuthService');
    const practice = idOf('practice');

    deprecate(claimId);

    expect(store.getClaim(claimId)?.status).toBe('deprecated');
    expect(decodeSpineClaim(store.getClaim(claimId)?.text ?? '')).toStrictEqual({
      v: 1,
      claim: 'containment',
      parent: authService,
      child: practice,
      childLevel: 'module',
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The child keeps everything the edge was not.
 * ---------------------------------------------------------------------------
 *
 * The child here is attested at a level and the containment claim names the same
 * level, so the level standing behind the referent after the deprecation is a
 * level its own live existence claim asserts. That is deliberate: it keeps the
 * question this section asks — does losing a parent disturb the referent? — clear
 * of the separate question of what a *deprecated* placement means for a level
 * nothing else asserts, which the ruling does not settle.
 */

/** A parent, and a child a noun source has attested at a level. @spec §3.1 */
const growAttestedChild = async (): Promise<{ parent: string; child: string }> => {
  await ingest.submit(
    claimMessage('AuthService validates bearer tokens before dispatch.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  await ingest.submit(
    attestationMessage('practice', { level: 'symbol', origin: emitterOrigin(2) }),
  );
  return { parent: idOf('AuthService'), child: idOf('practice') };
};

describe('the child of a containment claim that left the live set', () => {
  it('is not itself disturbed — the row, its level and its name all stand', async () => {
    const { child } = await growAttestedChild();
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'symbol',
        origin: agentOrigin(3),
      }),
    );
    const before = ingest.referents.get(child);
    expect(before?.level).toBe('symbol');

    deprecate(claimIdOf(receipt));

    expect(ingest.referents.get(child)).toStrictEqual(before);
  });

  it('is still there after a rebuild, at the level its existence claim placed it', async () => {
    const { child } = await growAttestedChild();
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'symbol',
        origin: agentOrigin(3),
      }),
    );

    deprecate(claimIdOf(receipt));
    const rebuilt = await rebuiltFromLedger();

    expect(rebuilt.referents.get(child)?.level).toBe('symbol');
    expect(rebuilt.referents.get(child)?.name).toBe('practice');
  });
});

/*
 * ---------------------------------------------------------------------------
 * A boundary more than one claim asserts.
 * ---------------------------------------------------------------------------
 *
 * The edge is keyed by the pair and the ledger is not: §3.3 materializes *every*
 * live containment claim into one row, and the table's `UNIQUE (parent_id,
 * child_id)` collapses however many of them agree into that single row. So the
 * row is not one claim's property to take away. Two producers who both place
 * `practice` under `AuthService` leave one edge standing on two claims, and the
 * first of them to be retired must leave it exactly where it was.
 *
 * The two claims here differ in the level they name, which is what makes them two
 * ledger rows rather than one: the payload is the claim's text, so the same pair
 * at the same level is a single claim written once. Different levels, same
 * boundary — the disagreement is about where the child sits, not about whether it
 * is inside.
 *
 * Without this section a `deleteContainment` fired unconditionally on every
 * containment retirement passes everything above it, and the graph loses a
 * boundary a live claim still asserts — until the next `rebuild-index` puts it
 * back, which is the divergence §3.1 forbids, arrived at from the other side.
 *
 * @spec §3.1, §3.3, §6.1
 */

/** Two live containment claims over `AuthService` → `practice`, oldest first. @spec §3.3 */
const twoClaimsOverOneBoundary = async (): Promise<readonly [string, string]> => {
  await growUnplacedTrio();
  const first = await ingest.submit(
    containmentMessage('AuthService', 'practice', { childLevel: 'module', origin: agentOrigin(4) }),
  );
  const second = await ingest.submit(
    containmentMessage('AuthService', 'practice', { childLevel: 'symbol', origin: agentOrigin(5) }),
  );
  return [claimIdOf(first), claimIdOf(second)];
};

describe('a boundary two live claims assert', () => {
  it('is on two ledger rows and one edge, which is what makes the rest of this section a question', async () => {
    const [first, second] = await twoClaimsOverOneBoundary();

    expect(first).not.toBe(second);
    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([idOf('practice')]);
  });

  it('keeps its edge when the older claim is retired', async () => {
    const [first] = await twoClaimsOverOneBoundary();

    deprecate(first);

    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([idOf('practice')]);
    expect(containsEdgesOf(idOf('AuthService'))).toStrictEqual([idOf('practice')]);
  });

  it('keeps its edge when the newer claim is retired', async () => {
    const [, second] = await twoClaimsOverOneBoundary();

    deprecate(second);

    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([idOf('practice')]);
  });

  it('leaves the live index and a rebuilt one holding the same spine', async () => {
    const [first] = await twoClaimsOverOneBoundary();
    const authService = idOf('AuthService');
    const practice = idOf('practice');

    deprecate(first);
    const live = ingest.referents.childrenOf(authService);
    const rebuilt = await rebuiltFromLedger();

    expect(live).toStrictEqual([practice]);
    expect(rebuilt.referents.childrenOf(authService)).toStrictEqual([practice]);
  });

  it('loses its edge only once the last of them has gone', async () => {
    const [first, second] = await twoClaimsOverOneBoundary();

    deprecate(first);
    deprecate(second);

    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([]);
    expect(containsEdgesOf(idOf('AuthService'))).toStrictEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Every other retirement.
 * ---------------------------------------------------------------------------
 *
 * `retireClaim` is the one door out of the live set for *every* claim, and only a
 * containment claim carries a pair. An existence claim retired by a superseding
 * attestation, a naming claim retired by a retraction, an ordinary belief — each
 * of them reaches the same lines, and each must leave the containment index
 * untouched rather than reading a boundary out of a payload that has none.
 *
 * @spec §3.3, §6.1
 */

describe('a retirement of something that is not a containment claim', () => {
  it('leaves the spine alone when an attestation supersedes the claim a referent grew from', async () => {
    await growUnplacedTrio();
    await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(4) }),
    );
    const authService = idOf('AuthService');
    const practice = idOf('practice');

    await ingest.submit(attestationMessage('practice', { level: 'symbol', origin: emitterOrigin(5) }));

    expect(ingest.referents.childrenOf(authService)).toStrictEqual([practice]);
  });

  it('leaves the spine alone when a retraction withdraws that attestation again', async () => {
    await growUnplacedTrio();
    await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(4) }),
    );
    await ingest.submit(attestationMessage('practice', { level: 'symbol', origin: emitterOrigin(5) }));
    const authService = idOf('AuthService');
    const practice = idOf('practice');

    await ingest.submit(retractionMessage('practice', { origin: emitterOrigin(6) }));

    expect(ingest.referents.childrenOf(authService)).toStrictEqual([practice]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The invariant, over shapes nobody enumerated.
 * ---------------------------------------------------------------------------
 *
 * Everything above names a shape: one claim, two claims, a sibling edge, a
 * rebuild. The obligation is not about those shapes — it is that for *any* run
 * of assertions and retirements, §3.1's live containment index and one rebuilt
 * from the ledger hold the same spine. A conditional delete has more ways to be
 * subtly wrong than a suite of named cases has cases: a boundary asserted,
 * retired and asserted again, one child under two parents, the same claim retired
 * twice, retirements interleaved rather than trailing.
 *
 * Only the spine is compared. What a deprecated placement means for the child's
 * *level* is a question §3.1 does not settle, and folding it in here would make
 * this property assert an answer to it.
 *
 * @spec §3.1, §3.3, §6.1, §11
 */

/** Three usage-born referents the property places under one another. @spec §3.1 */
const NOUNS = ['AuthService', 'SessionStore', 'TokenCache'] as const;

type SpineOp =
  | {
      readonly kind: 'assert';
      readonly parent: number;
      readonly child: number;
      readonly level: 'module' | 'symbol';
    }
  | { readonly kind: 'retire'; readonly nth: number };

const spineOpArb: fc.Arbitrary<SpineOp> = fc.oneof(
  fc.record({
    kind: fc.constant('assert' as const),
    parent: fc.nat(NOUNS.length - 1),
    child: fc.nat(NOUNS.length - 1),
    level: fc.constantFrom('module' as const, 'symbol' as const),
  }),
  fc.record({ kind: fc.constant('retire' as const), nth: fc.nat(9) }),
);

/** Every parent and its children, ordered so two ports can be compared directly. @spec §3.3 */
const spineOf = (port: IngestPort): readonly (readonly string[])[] =>
  port.referents
    .all()
    .map((referent) => [referent.id, ...[...port.referents.childrenOf(referent.id)].sort()])
    .sort((left, right) => (left[0]! < right[0]! ? -1 : 1));

const runSpineOps = async (ops: readonly SpineOp[]): Promise<void> => {
  const scratch = openGraphStore({ path: ':memory:' });
  try {
    const provider = fakeEmbeddings();
    const judge = fakeAdjudicator();
    const port = openIngest({ store: scratch, embeddings: provider, adjudicator: judge });

    let episode = 0;
    for (const noun of NOUNS) {
      episode += 1;
      await port.submit(
        claimMessage(`${noun} does its own work.`, [noun], { origin: agentOrigin(episode) }),
      );
    }

    const boundaries: string[] = [];
    for (const op of ops) {
      episode += 1;
      if (op.kind === 'retire') {
        if (boundaries.length > 0) retireClaim(scratch, boundaries[op.nth % boundaries.length]!);
        continue;
      }
      if (op.parent === op.child) continue;
      const receipt = await port.submit(
        containmentMessage(NOUNS[op.parent]!, NOUNS[op.child]!, {
          childLevel: op.level,
          origin: agentOrigin(episode),
        }),
      );
      if (receipt.claimId !== undefined && !boundaries.includes(receipt.claimId))
        boundaries.push(receipt.claimId);
    }

    const live = spineOf(port);
    scratch.clearViews();
    const rebuilt = openIngest({ store: scratch, embeddings: provider, adjudicator: judge });
    await rebuilt.rebuildIndex();

    expect(spineOf(rebuilt)).toStrictEqual(live);
  } finally {
    scratch.close();
  }
};

describe('any run of assertions and retirements', () => {
  it('leaves the live containment index and a rebuilt one holding the same spine', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(spineOpArb, { maxLength: 10 }), runSpineOps),
      { numRuns: 60 },
    );
  });
});
