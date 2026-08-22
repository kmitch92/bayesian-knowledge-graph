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
  OTHER_SESSION_ID,
  RIVAL_CLAIM_ID,
  SESSION_ID,
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

describe('recording the claims a session was served', () => {
  it('reports a served claim as tainted for that session', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });

    expect(store.isTainted({ sessionId: SESSION_ID, claimId: CLAIM_ID })).toBe(true);
  });

  it('reports a claim the session never saw as untainted', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });

    expect(store.isTainted({ sessionId: SESSION_ID, claimId: RIVAL_CLAIM_ID })).toBe(false);
  });

  it('records every claim in one served response', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(new Set([CLAIM_ID, RIVAL_CLAIM_ID]));
  });

  it('accumulates across responses, because a session is served many times over its life', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [RIVAL_CLAIM_ID] });
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [THIRD_CLAIM_ID] });

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(
      new Set([CLAIM_ID, RIVAL_CLAIM_ID, THIRD_CLAIM_ID]),
    );
  });

  it('is a set, so serving the same claim twice in a session records it once', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(new Set([CLAIM_ID, RIVAL_CLAIM_ID]));
  });

  it('tolerates a repeated id inside one call, which is what a rivals-together response produces', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, CLAIM_ID] });

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(new Set([CLAIM_ID]));
  });

  it('records nothing for an empty response without failing', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [] });

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(new Set());
  });

  it('reports an empty set for a session that has never been served', () => {
    expect(store.getTaintSet(OTHER_SESSION_ID)).toStrictEqual(new Set());
  });

  it('reports untainted for every claim in a session that has never been served', () => {
    expect(store.isTainted({ sessionId: OTHER_SESSION_ID, claimId: CLAIM_ID })).toBe(false);
  });
});

describe('taint is per session and does not leak', () => {
  it('leaves a second session untainted by what the first was served', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });

    expect(store.isTainted({ sessionId: OTHER_SESSION_ID, claimId: CLAIM_ID })).toBe(false);
  });

  it('keeps the taint sets of two sessions disjoint when they were served different claims', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });
    store.recordTaint({ sessionId: OTHER_SESSION_ID, claimIds: [RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(new Set([CLAIM_ID]));
    expect(store.getTaintSet(OTHER_SESSION_ID)).toStrictEqual(new Set([RIVAL_CLAIM_ID]));
  });

  it('lets both sessions be tainted by the same claim independently', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });
    store.recordTaint({ sessionId: OTHER_SESSION_ID, claimIds: [CLAIM_ID] });

    expect(store.isTainted({ sessionId: SESSION_ID, claimId: CLAIM_ID })).toBe(true);
    expect(store.isTainted({ sessionId: OTHER_SESSION_ID, claimId: CLAIM_ID })).toBe(true);
  });

  it('does not let one session record taint on behalf of another', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(OTHER_SESSION_ID)).toStrictEqual(new Set());
  });
});

describe('the taint boundary', () => {
  it('hands back a snapshot, so mutating the returned set cannot corrupt the ledger', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });

    const returned = store.getTaintSet(SESSION_ID) as Set<string>;
    returned.add(RIVAL_CLAIM_ID);

    expect(store.isTainted({ sessionId: SESSION_ID, claimId: RIVAL_CLAIM_ID })).toBe(false);
  });

  it('refuses to taint a session with a claim id that does not exist', () => {
    expect(() => {
      store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID.replace(/.$/, 'Z')] });
    }).toThrow();
  });

  it('still reports taint for a claim that was archived after being served', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });

    expect(store.isTainted({ sessionId: SESSION_ID, claimId: CLAIM_ID })).toBe(true);
  });
});
