/**
 * Where the spine comes from, and where it does not.
 *
 * §3.3 lists `CONTAINS` as *"spine structure — the materialization of
 * containment claims (principle 14)"*, and §3.1 makes `level` nullable so that
 * *"a usage-born referent ('practice', 'the retry pattern') has no level until a
 * containment claim places it."*
 *
 * The negative half matters more than the positive half. A locator is opaque
 * (§3.1: *"never parsed or queried by the store"*), so two referents whose
 * locators happen to share a path prefix are not thereby parent and child; a
 * claim that mentions two nouns has not thereby nested them; and no emitter
 * gets to write a spine edge except by asserting a containment claim that any
 * other producer could have asserted too. Containment is a proposition with a
 * lifecycle, which is what makes a bad boundary *"just a wrong claim:
 * disputable, splittable, revisable"*.
 *
 * @spec §3.1, §3.3, §5.2, §8.4
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import { openGraphStore, type GraphStore } from '../../store/index';

import {
  NOUN_SOURCE,
  agentOrigin,
  attestationMessage,
  claimMessage,
  containmentMessage,
  emitterOrigin,
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

/** The referent id a surface form names. */
const idOf = (surfaceForm: string): string => {
  const id = store.resolveMention(surfaceForm);
  if (id === undefined) throw new Error(`nothing in the index is named "${surfaceForm}"`);
  return id;
};

/** Every `CONTAINS` edge in the containment index, as readable pairs. */
const containment = (): string[][] =>
  ingest.referents
    .all()
    .flatMap((parent) =>
      store
        .getStructuralEdges(parent.id)
        .filter((edge) => edge.kind === 'CONTAINS')
        .map((edge) => [parent.name, ingest.referents.get(edge.to)?.name ?? edge.to]),
    );

describe('a containment claim', () => {
  it('materializes a CONTAINS edge in the containment index', async () => {
    await ingest.submit(
      claimMessage('AuthService validates bearer tokens before dispatch.', ['AuthService']),
    );
    await ingest.submit(
      claimMessage('The practice survives its own justification.', ['practice'], {
        origin: agentOrigin(2),
      }),
    );

    await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(3) }),
    );

    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([idOf('practice')]);
    expect(store.getStructuralEdges(idOf('AuthService'))).toStrictEqual([
      { from: idOf('AuthService'), kind: 'CONTAINS', to: idOf('practice') },
    ]);
  });

  it('places the child at the level it declares, and leaves the parent alone', async () => {
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(1) }));

    await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'module',
        origin: agentOrigin(2),
      }),
    );

    expect(ingest.referents.get(idOf('practice'))?.level).toBe('module');
    expect(ingest.referents.get(idOf('AuthService'))?.level).toBe('component');
  });

  it('resolves both endpoints through the ladder, minting whichever is unknown', async () => {
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(1) }),
    );

    expect(receipt.resolutions.map((entry) => [entry.surfaceForm, entry.rung])).toStrictEqual([
      ['AuthService', 'minted'],
      ['practice', 'minted'],
    ]);
    expect(ingest.referents.all()).toHaveLength(2);
  });

  it('lands in the ledger as a claim, not as a bare edge', async () => {
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(1) }),
    );
    const claim = receipt.claimId === undefined ? undefined : store.getClaim(receipt.claimId);

    expect(claim?.kind).toBe('fact');
    expect(claim?.regime).toBe('evidence');
    expect(store.getEvidence(claim!.id)).not.toBeNull();
  });

  it('is disputable when asserted, because an asserted boundary is an ordinary belief', async () => {
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(1) }),
    );

    expect(store.getClaim(receipt.claimId!)?.status).toBe('provisional');
    expect(store.getEvidence(receipt.claimId!)?.alpha).toBeGreaterThan(0);
  });

  it('is re-derived rather than believed when a noun source stands behind it', async () => {
    const receipt = await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        source: NOUN_SOURCE,
        tier: 'verified',
        origin: emitterOrigin(1),
      }),
    );

    expect(store.getClaim(receipt.claimId!)?.regime).toBe('view');
    expect(store.getEvidence(receipt.claimId!)).toBeNull();
  });

  it('is idempotent — asserting the same containment twice leaves one edge', async () => {
    await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(1) }),
    );

    await ingest.submit(
      containmentMessage('AuthService', 'practice', { origin: agentOrigin(2) }),
    );

    expect(containment()).toStrictEqual([['AuthService', 'practice']]);
  });

  it('materializes the direct edge only — the index stores the ladder, not its closure', async () => {
    await ingest.submit(
      containmentMessage('AuthService', 'SessionStore', {
        childLevel: 'module',
        origin: agentOrigin(1),
      }),
    );

    await ingest.submit(
      containmentMessage('SessionStore', 'practice', {
        childLevel: 'symbol',
        origin: agentOrigin(2),
      }),
    );

    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([idOf('SessionStore')]);
    expect(ingest.referents.childrenOf(idOf('SessionStore'))).toStrictEqual([idOf('practice')]);
  });
});

describe('nothing else places a referent', () => {
  it('leaves every usage-born referent unplaced, however many claims name it', async () => {
    for (const n of [1, 2, 3, 4])
      await ingest.submit(
        claimMessage('The practice survives its own justification.', ['practice'], {
          origin: agentOrigin(n),
        }),
      );

    expect(ingest.referents.get(idOf('practice'))?.level).toBeNull();
    expect(containment()).toStrictEqual([]);
  });

  it('reads no hierarchy out of locators that share a directory', async () => {
    await ingest.submit(
      attestationMessage('AuthService', {
        level: null,
        locator: { path: 'src/auth/index.ts', symbolRange: [1, 412] },
        origin: emitterOrigin(1),
      }),
    );
    await ingest.submit(
      attestationMessage('SessionStore', {
        level: null,
        locator: { path: 'src/auth/session.ts', symbolRange: [1, 88] },
        origin: emitterOrigin(2),
      }),
    );

    expect(containment()).toStrictEqual([]);
    expect(ingest.referents.get(idOf('AuthService'))?.level).toBeNull();
  });

  it('does not nest two nouns merely because one claim named them together', async () => {
    await ingest.submit(
      claimMessage('AuthService reads its signing key from SessionStore.', [
        'AuthService',
        'SessionStore',
      ]),
    );

    expect(containment()).toStrictEqual([]);
    expect(ingest.referents.childrenOf(idOf('AuthService'))).toStrictEqual([]);
  });

  it('does not nest a referent under the one that happens to be its claim anchor', async () => {
    await ingest.submit(
      claimMessage('AuthService reads its signing key from SessionStore.', [
        'AuthService',
        'SessionStore',
      ]),
    );
    const claims = store.getClaimsAbout(idOf('SessionStore'));

    expect(claims.length).toBeGreaterThan(0);
    expect(ingest.referents.childrenOf(idOf('SessionStore'))).toStrictEqual([]);
  });
});
