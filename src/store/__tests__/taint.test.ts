/**
 * §4.3 / §7.5 taint recording.
 *
 * §12 calls the retrieval echo loop the failure that must be "implemented day
 * one — cannot be retrofitted once confidences are polluted", and §4.3 calls it
 * "the single most important rule in the system": an episode that had claim E in
 * its retrieval context cannot corroborate E.
 *
 * The store's share of that rule is narrow and mechanical. §7.5: "the server
 * records the set of claim ids served to a session — the session's taint set.
 * Agents never manage it." Record, and report membership. That is all this phase
 * builds, and all these tests assert.
 *
 * §7.5 says "session" there; the store keys the set by *episode*, which is the
 * unit §4.2's caps and §4.4's independence accounting already count in. v1 maps
 * one host session to one episode (A17), so the quote holds as written, and
 * where the two diverge chained sessions collapse to one episode and share a
 * taint set — exactly the §4.3 semantics. These tests therefore name episodes.
 *
 * Explicitly *not* tested here, and deliberately not built: the weighting rule
 * `w = tier × episode_cap × taint` (§4.2) and the amendment A1 exemption for
 * verified-tier evidence with fresh provenance (§4.3). Both are write-path
 * decisions and belong to P3. Testing them against the store would bake a policy
 * into the storage layer that the spec keeps in the pipeline.
 *
 * @spec §4.3, §7.5, §12
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraphStore, type GraphStore } from '../index';

import {
  CLAIM_ID,
  OTHER_SERVED_EPISODE_ID,
  RIVAL_CLAIM_ID,
  SERVED_EPISODE_ID,
  THIRD_CLAIM_ID,
  makeClaim,
  makeEntity,
} from './fixtures';

let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  store.putEntity(makeEntity());
  store.putClaim(makeClaim());
  store.putClaim(makeClaim({ id: RIVAL_CLAIM_ID, text: 'AuthService.refresh retries twice.' }));
  store.putClaim(makeClaim({ id: THIRD_CLAIM_ID, text: 'AuthService.refresh logs every retry.' }));
});

afterEach(() => {
  store.close();
});

describe('recording the claims an episode was served', () => {
  it('reports a served claim as tainted for that episode', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });

    expect(store.isTainted({ episodeId: SERVED_EPISODE_ID, claimId: CLAIM_ID })).toBe(true);
  });

  it('reports a claim the episode never saw as untainted', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });

    expect(store.isTainted({ episodeId: SERVED_EPISODE_ID, claimId: RIVAL_CLAIM_ID })).toBe(false);
  });

  it('records every claim in one served response', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID, RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(SERVED_EPISODE_ID)).toStrictEqual(new Set([CLAIM_ID, RIVAL_CLAIM_ID]));
  });

  it('accumulates across responses, because an episode is served many times over its life', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [RIVAL_CLAIM_ID] });
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [THIRD_CLAIM_ID] });

    expect(store.getTaintSet(SERVED_EPISODE_ID)).toStrictEqual(
      new Set([CLAIM_ID, RIVAL_CLAIM_ID, THIRD_CLAIM_ID]),
    );
  });

  it('is a set, so serving the same claim twice in an episode records it once', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID, RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(SERVED_EPISODE_ID)).toStrictEqual(new Set([CLAIM_ID, RIVAL_CLAIM_ID]));
  });

  it('tolerates a repeated id inside one call, which is what a rivals-together response produces', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID, CLAIM_ID] });

    expect(store.getTaintSet(SERVED_EPISODE_ID)).toStrictEqual(new Set([CLAIM_ID]));
  });

  it('records nothing for an empty response without failing', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [] });

    expect(store.getTaintSet(SERVED_EPISODE_ID)).toStrictEqual(new Set());
  });

  it('reports an empty set for an episode that has never been served', () => {
    expect(store.getTaintSet(OTHER_SERVED_EPISODE_ID)).toStrictEqual(new Set());
  });

  it('reports untainted for every claim in an episode that has never been served', () => {
    expect(store.isTainted({ episodeId: OTHER_SERVED_EPISODE_ID, claimId: CLAIM_ID })).toBe(false);
  });
});

describe('taint is per episode and does not leak', () => {
  it('leaves a second episode untainted by what the first was served', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });

    expect(store.isTainted({ episodeId: OTHER_SERVED_EPISODE_ID, claimId: CLAIM_ID })).toBe(false);
  });

  it('keeps the taint sets of two episodes disjoint when they were served different claims', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });
    store.recordTaint({ episodeId: OTHER_SERVED_EPISODE_ID, claimIds: [RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(SERVED_EPISODE_ID)).toStrictEqual(new Set([CLAIM_ID]));
    expect(store.getTaintSet(OTHER_SERVED_EPISODE_ID)).toStrictEqual(new Set([RIVAL_CLAIM_ID]));
  });

  it('lets both episodes be tainted by the same claim independently', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });
    store.recordTaint({ episodeId: OTHER_SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });

    expect(store.isTainted({ episodeId: SERVED_EPISODE_ID, claimId: CLAIM_ID })).toBe(true);
    expect(store.isTainted({ episodeId: OTHER_SERVED_EPISODE_ID, claimId: CLAIM_ID })).toBe(true);
  });

  it('does not let one episode record taint on behalf of another', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID, RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(OTHER_SERVED_EPISODE_ID)).toStrictEqual(new Set());
  });
});

describe('the taint boundary', () => {
  it('hands back a snapshot, so mutating the returned set cannot corrupt the ledger', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });

    const returned = store.getTaintSet(SERVED_EPISODE_ID) as Set<string>;
    returned.add(RIVAL_CLAIM_ID);

    expect(store.isTainted({ episodeId: SERVED_EPISODE_ID, claimId: RIVAL_CLAIM_ID })).toBe(false);
  });

  it('refuses to taint an episode with a claim id that does not exist', () => {
    expect(() => {
      store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID.replace(/.$/, 'Z')] });
    }).toThrow();
  });

  it('still reports taint for a claim that was archived after being served', () => {
    store.recordTaint({ episodeId: SERVED_EPISODE_ID, claimIds: [CLAIM_ID] });
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.isTainted({ episodeId: SERVED_EPISODE_ID, claimId: CLAIM_ID })).toBe(true);
  });
});
