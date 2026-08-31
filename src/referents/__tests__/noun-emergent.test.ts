/**
 * P2's exit criterion: the referent layer grown purely from claim usage.
 *
 * There is no emitter in this file, no pre-seeded entity, no `putEntity` call,
 * and — in the whole of `src/` — no parser. Claims go in through the public
 * ingest port naming their nouns as plain strings, and a referent index comes
 * out. §3.1: *"A domain with no noun source runs pure usage-emergence — the
 * all-asserted mode and the noun-emergent mode are the same mode."* This is the
 * baseline, not a degraded fallback, which is why it gets the primary test.
 *
 * Diagram §7: *"No entity is ever created directly. Naming is what creates
 * them, in the same transaction as the claim."*
 *
 * Nothing here is code-shaped. The nouns are `AuthService`, `practice` and
 * `Chapter Three`; a philosophy notebook and a TypeScript repo enter by the
 * same door and the core cannot tell which it is holding.
 *
 * Real SQLite `:memory:` throughout. Only the embedding provider and the
 * coreference tiebreak are faked — both are model calls, and a test that waits
 * on a model tests the model.
 *
 * @spec §3.1, §3.2, §3.3, §4.2, §4.4, §5.1, §5.2, §6.2, §8.9, §15
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort, IngestReceipt } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import type { Referent, Resolution } from '../index';
import { openGraphStore, type GraphStore } from '../../store/index';

import {
  TAU_PROMOTE,
  agentOrigin,
  claimMessage,
  containmentMessage,
  episode,
  fakeAdjudicator,
  fakeEmbeddings,
  queriedTexts,
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

/** How one noun in one message resolved. Throws rather than returning `undefined`, so a miss names itself. */
const resolutionOf = (receipt: IngestReceipt, surfaceForm: string): Resolution => {
  const found = receipt.resolutions.find((entry) => entry.surfaceForm === surfaceForm);
  if (found === undefined)
    throw new Error(`the ingest port returned no resolution for "${surfaceForm}"`);
  return found;
};

/** The referent one noun resolved to, read back out of the index. */
const referentOf = (receipt: IngestReceipt, surfaceForm: string): Referent => {
  const id = resolutionOf(receipt, surfaceForm).referentId;
  const referent = ingest.referents.get(id);
  if (referent === undefined) throw new Error(`the referent index holds no row for ${id}`);
  return referent;
};

/** The ledger row a message wrote. */
const claimIdOf = (receipt: IngestReceipt): string => {
  if (receipt.claimId === undefined) throw new Error('the ingest port wrote no claim');
  return receipt.claimId;
};

/** The Beta mean of a referent's existence claim — what τ_promote is compared against. @spec §4.1, §6.2 */
const posteriorMean = (referent: Referent): number => {
  const evidence = store.getEvidence(referent.existenceClaimId);
  if (evidence === undefined) throw new Error('no such existence claim');
  if (evidence === null) throw new Error('the existence claim is in the view regime');
  return evidence.alpha / (evidence.alpha + evidence.beta);
};

/** Names the same noun once per episode, with a text distinct enough to clear the §5.1 dedupe. */
const nameAcrossEpisodes = async (
  surfaceForm: string,
  episodes: readonly number[],
): Promise<IngestReceipt[]> => {
  const receipts: IngestReceipt[] = [];
  for (const n of episodes)
    receipts.push(
      await ingest.submit(
        claimMessage(`${surfaceForm} came up again while working.`, [surfaceForm], {
          origin: agentOrigin(n),
        }),
      ),
    );
  return receipts;
};

describe('a graph with no noun source at all', () => {
  it('holds no referents until a claim names one', () => {
    expect(ingest.referents.all()).toStrictEqual([]);
  });

  it('mints a referent for a noun nothing has ever declared', async () => {
    const receipt = await ingest.submit(
      claimMessage('AuthService validates bearer tokens before dispatch.', ['AuthService']),
    );

    expect(resolutionOf(receipt, 'AuthService').rung).toBe('minted');
    expect(referentOf(receipt, 'AuthService').name).toBe('AuthService');
  });

  it('grows its whole population from the nouns claims happen to use', async () => {
    await ingest.submit(
      claimMessage('AuthService validates bearer tokens before dispatch.', ['AuthService'], {
        origin: agentOrigin(1),
      }),
    );
    await ingest.submit(
      claimMessage('Chapter Three rejects the private-language argument.', ['Chapter Three'], {
        origin: agentOrigin(2),
      }),
    );
    await ingest.submit(
      claimMessage('The practice survives its own justification.', ['practice'], {
        origin: agentOrigin(3),
      }),
    );

    expect(ingest.referents.all().map((referent) => referent.name).sort()).toStrictEqual([
      'AuthService',
      'Chapter Three',
      'practice',
    ]);
  });

  it('anchors the claim on the referent its own naming created', async () => {
    const receipt = await ingest.submit(
      claimMessage('AuthService validates bearer tokens before dispatch.', ['AuthService']),
    );
    const claim = store.getClaim(claimIdOf(receipt));

    expect(claim?.scope).toBe(referentOf(receipt, 'AuthService').id);
  });

  it('points an ABOUT edge at every noun the claim named, not only the anchor', async () => {
    const receipt = await ingest.submit(
      claimMessage('AuthService reads its signing key from SessionStore.', [
        'AuthService',
        'SessionStore',
      ]),
    );
    const about = store
      .getClaimEdges(claimIdOf(receipt))
      .filter((edge) => edge.kind === 'ABOUT')
      .map((edge) => edge.to)
      .sort();

    expect(about).toStrictEqual(
      [
        referentOf(receipt, 'AuthService').id,
        referentOf(receipt, 'SessionStore').id,
      ].sort(),
    );
  });

  it('mints nothing when the claim it would have been minted with is refused', async () => {
    await expect(ingest.submit(claimMessage('', ['AuthService']))).rejects.toThrow();

    expect(ingest.referents.all()).toStrictEqual([]);
    expect(store.resolveMention('AuthService')).toBeUndefined();
  });
});

describe('an unresolved mention', () => {
  it('mints a provisional existence claim rather than refusing to mint', async () => {
    const receipt = await ingest.submit(
      claimMessage('The practice survives its own justification.', ['practice']),
    );
    const referent = referentOf(receipt, 'practice');

    expect(store.getClaim(referent.existenceClaimId)?.status).toBe('provisional');
    expect(referent.status).toBe('provisional');
  });

  it('self-anchors that existence claim on the referent it minted', async () => {
    const receipt = await ingest.submit(
      claimMessage('The practice survives its own justification.', ['practice']),
    );
    const referent = referentOf(receipt, 'practice');

    expect(store.getClaim(referent.existenceClaimId)?.scope).toBe(referent.id);
  });

  it('is invisible to gather until something corroborates it', async () => {
    await ingest.submit(claimMessage('The practice survives its own justification.', ['practice']));

    expect(ingest.referents.visible()).toStrictEqual([]);
  });

  it('stays queryable by status, so the provisional population needs no triage structure', async () => {
    const receipt = await ingest.submit(
      claimMessage('The practice survives its own justification.', ['practice']),
    );

    expect(ingest.referents.byStatus('provisional').map((referent) => referent.id)).toStrictEqual([
      referentOf(receipt, 'practice').id,
    ]);
  });
});

describe('recurrence promotes a provisional referent', () => {
  it('leaves it provisional while only one episode has named it', async () => {
    const [first] = await nameAcrossEpisodes('practice', [1]);

    expect(referentOf(first!, 'practice').status).toBe('provisional');
  });

  it('leaves it provisional while too few independent episodes have named it', async () => {
    const receipts = await nameAcrossEpisodes('practice', [1, 2]);
    const referent = referentOf(receipts[0]!, 'practice');

    expect(posteriorMean(ingest.referents.get(referent.id)!)).toBeLessThan(TAU_PROMOTE);
    expect(ingest.referents.get(referent.id)?.status).toBe('provisional');
  });

  it('promotes it through ordinary evidence once independent episodes accumulate', async () => {
    const receipts = await nameAcrossEpisodes('practice', [1, 2, 3, 4]);
    const referent = ingest.referents.get(referentOf(receipts[0]!, 'practice').id);

    expect(posteriorMean(referent!)).toBeGreaterThanOrEqual(TAU_PROMOTE);
    expect(referent?.status).toBe('active');
  });

  it('makes it visible to gather once it promotes', async () => {
    const receipts = await nameAcrossEpisodes('practice', [1, 2, 3, 4]);
    const referent = referentOf(receipts[0]!, 'practice');

    expect(ingest.referents.visible().map((entry) => entry.id)).toStrictEqual([referent.id]);
  });

  it('never promotes on repetition inside a single episode, however long it goes on', async () => {
    let receipt: IngestReceipt | undefined;
    for (let i = 0; i < 12; i += 1)
      receipt = await ingest.submit(
        claimMessage(`The practice governs case ${i}.`, ['practice'], { origin: agentOrigin(1) }),
      );
    const referent = ingest.referents.get(referentOf(receipt!, 'practice').id);

    expect(posteriorMean(referent!)).toBeLessThan(TAU_PROMOTE);
    expect(referent?.status).toBe('provisional');
    expect(ingest.referents.visible()).toStrictEqual([]);
  });

  it('counts twelve namings in one episode as weaker evidence than four across four', async () => {
    for (let i = 0; i < 12; i += 1)
      await ingest.submit(
        claimMessage(`The practice governs case ${i}.`, ['practice'], { origin: agentOrigin(1) }),
      );
    const crowded = posteriorMean(
      ingest.referents.all().find((referent) => referent.name === 'practice')!,
    );

    const second = openGraphStore({ path: ':memory:' });
    try {
      const spread = openIngest({ store: second, embeddings, adjudicator });
      for (const n of [1, 2, 3, 4])
        await spread.submit(
          claimMessage('The practice survives its own justification.', ['practice'], {
            origin: agentOrigin(n),
          }),
        );
      const referent = spread.referents.all().find((entry) => entry.name === 'practice')!;
      const evidence = second.getEvidence(referent.existenceClaimId)!;

      expect(evidence.alpha / (evidence.alpha + evidence.beta)).toBeGreaterThan(crowded);
    } finally {
      second.close();
    }
  });

  it('treats a retried tool call as the replay it is, not as fresh corroboration', async () => {
    const message = claimMessage('The practice survives its own justification.', ['practice'], {
      origin: agentOrigin(1),
    });
    const first = await ingest.submit(message);
    const referentId = referentOf(first, 'practice').id;
    const before = posteriorMean(ingest.referents.get(referentId)!);

    const replay = await ingest.submit(message);

    expect(replay.duplicate).toBe(true);
    expect(posteriorMean(ingest.referents.get(referentId)!)).toBe(before);
    expect(ingest.referents.all()).toHaveLength(1);
  });
});

describe('one referent, several surface forms', () => {
  /** §3.1's own example, grown without an identity claim ever being authored by hand. */
  const nameAuthServiceThreeWays = async (): Promise<readonly IngestReceipt[]> => {
    const receipts: IngestReceipt[] = [];
    for (const n of [1, 2, 3])
      receipts.push(
        await ingest.submit(
          claimMessage(`AuthService was read in episode ${n}.`, ['AuthService'], {
            origin: agentOrigin(n),
          }),
        ),
      );
    receipts.push(
      await ingest.submit(
        claimMessage('The auth-service rotation window is fifteen minutes.', ['auth-service'], {
          origin: agentOrigin(4),
        }),
      ),
    );
    receipts.push(
      await ingest.submit(
        claimMessage('The auth thing drops idle sockets after a minute.', ['the auth thing'], {
          origin: agentOrigin(5),
        }),
      ),
    );
    return receipts;
  };

  it('collapses AuthService, auth-service and "the auth thing" onto one referent', async () => {
    const receipts = await nameAuthServiceThreeWays();
    const ids = new Set([
      resolutionOf(receipts[0]!, 'AuthService').referentId,
      resolutionOf(receipts[3]!, 'auth-service').referentId,
      resolutionOf(receipts[4]!, 'the auth thing').referentId,
    ]);

    expect([...ids]).toHaveLength(1);
    expect(ingest.referents.all()).toHaveLength(1);
  });

  it('records every form in the mention index', async () => {
    const receipts = await nameAuthServiceThreeWays();
    const referent = referentOf(receipts[0]!, 'AuthService');

    expect(ingest.referents.mentionsOf(referent.id).sort()).toStrictEqual([
      'AuthService',
      'auth-service',
      'the auth thing',
    ]);
  });

  it('keeps the name a view over the mention cluster rather than the newest form', async () => {
    const receipts = await nameAuthServiceThreeWays();

    expect(referentOf(receipts[4]!, 'the auth thing').name).toBe('AuthService');
  });

  it('answers the next use of a recorded form from the index, without asking the model', async () => {
    await nameAuthServiceThreeWays();
    embeddings.forget();

    const again = await ingest.submit(
      claimMessage('The auth-service key ring is reloaded on SIGHUP.', ['auth-service'], {
        origin: agentOrigin(6),
      }),
    );

    expect(resolutionOf(again, 'auth-service').rung).toBe('mention-index');
    expect(queriedTexts(embeddings)).toStrictEqual([]);
    expect(adjudicator.requests).toStrictEqual([]);
  });
});

describe('a referent born from usage', () => {
  it('is unplaced — no level, because nothing has placed it', async () => {
    const receipt = await ingest.submit(
      claimMessage('The practice survives its own justification.', ['practice']),
    );

    expect(referentOf(receipt, 'practice').level).toBeNull();
  });

  it('stays unplaced however many claims name it, absent a containment claim', async () => {
    const receipts = await nameAcrossEpisodes('practice', [1, 2, 3, 4]);
    const referent = ingest.referents.get(referentOf(receipts[0]!, 'practice').id);

    expect(referent?.status).toBe('active');
    expect(referent?.level).toBeNull();
  });

  it('takes a level only from a containment claim that places it', async () => {
    await ingest.submit(
      claimMessage('AuthService validates bearer tokens before dispatch.', ['AuthService']),
    );
    const placed = await ingest.submit(
      containmentMessage('AuthService', 'practice', {
        childLevel: 'module',
        origin: agentOrigin(2),
      }),
    );

    expect(referentOf(placed, 'practice').level).toBe('module');
  });
});

describe('the noun-emergent graph serves', () => {
  it('offers gather the promoted referents and withholds the rest', async () => {
    await nameAcrossEpisodes('practice', [1, 2, 3, 4]);
    await ingest.submit(
      claimMessage('Chapter Three rejects the private-language argument.', ['Chapter Three'], {
        origin: agentOrigin(5),
      }),
    );

    expect(ingest.referents.all()).toHaveLength(2);
    expect(ingest.referents.visible().map((referent) => referent.name)).toStrictEqual(['practice']);
  });

  it('hands back the claims attached to a referent it grew', async () => {
    const receipts = await nameAcrossEpisodes('practice', [1, 2, 3]);
    const referent = referentOf(receipts[0]!, 'practice');

    expect(store.getClaimsAbout(referent.id).sort()).toStrictEqual(
      [referent.existenceClaimId, ...receipts.map(claimIdOf)].sort(),
    );
  });

  it('reloads a referent it grew, out of a database a later process opens', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kgmem-noun-emergent-')), 'graph.db');
    const first = openGraphStore({ path });
    let grown: readonly Referent[];
    try {
      const growing = openIngest({ store: first, embeddings, adjudicator });
      for (const n of [1, 2, 3, 4])
        await growing.submit(
          claimMessage('The practice survives its own justification.', ['practice'], {
            origin: agentOrigin(n),
          }),
        );
      grown = growing.referents.all();
    } finally {
      first.close();
    }

    const second = openGraphStore({ path });
    try {
      const reopened = openIngest({ store: second, embeddings, adjudicator });

      expect(reopened.referents.all()).toStrictEqual(grown);
      expect(reopened.referents.visible().map((referent) => referent.name)).toStrictEqual([
        'practice',
      ]);
    } finally {
      second.close();
    }
  });

  it('never needed an episode of its own to bootstrap — episode one is a real episode', async () => {
    const receipt = await ingest.submit(
      claimMessage('The practice survives its own justification.', ['practice'], {
        origin: agentOrigin(1),
      }),
    );
    const claim = store.getClaim(claimIdOf(receipt));

    expect(claim?.provenance.episodes).toStrictEqual([episode(1)]);
  });
});
