/**
 * §5.8 observability: "every stage logs its inputs and decisions".
 *
 * This is not a nice-to-have that P3 can bolt on. §5.8 also says the thresholds
 * (τ_promote, τ_dispute, γ, cosine floors, beam parameters) are "tuned offline
 * against replay logs (§13), never by live surgery", and §12's *threshold
 * brittleness* row makes full-pipeline logging the mitigation for every ⚙
 * constant in §15. A replay corpus that is missing entries, or that reorders
 * them, cannot tune anything — so the table and its append-only discipline are
 * migration-0 concerns, not P3 ones.
 *
 * Only the mechanism is pinned here. Which stages log what, and the adjudication
 * verdict's obligation to record both claim texts, are write-path decisions that
 * belong to P3; the store's job is to accept an opaque payload, keep it, and
 * hand it back in the order it arrived.
 *
 * @spec §5.8, §12, §13, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraphStore, type GraphStore } from '../index';

import { EPISODE_ID, OTHER_EPISODE_ID } from './fixtures';

/** An adjudication entry as §5.4 would produce it: both texts in, one verdict out. @spec §5.4, §5.8 */
const ADJUDICATION = {
  episodeId: EPISODE_ID,
  stage: 'adjudicate',
  inputs: {
    incoming: 'Batch inserts in AuthService are idempotent.',
    candidate: 'Batch inserts in AuthService are not idempotent.',
  },
  decision: { verdict: 'CONTRADICTS', confidence: 0.91 },
  at: '2026-08-22T09:14:03.000Z',
} as const;

let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('the stage log', () => {
  it('keeps an entry whole, inputs and decision alike', () => {
    store.appendStageLog(ADJUDICATION);

    const [entry] = store.readStageLog(EPISODE_ID);

    expect(entry).toMatchObject({
      stage: ADJUDICATION.stage,
      inputs: ADJUDICATION.inputs,
      decision: ADJUDICATION.decision,
      at: ADJUDICATION.at,
    });
  });

  it('returns entries in the order they were appended, which is what replay depends on', () => {
    for (const stage of ['dedupe', 'resolve', 'retrieve', 'adjudicate', 'apply'])
      store.appendStageLog({ ...ADJUDICATION, stage });

    expect(store.readStageLog(EPISODE_ID).map((entry) => entry.stage)).toStrictEqual([
      'dedupe',
      'resolve',
      'retrieve',
      'adjudicate',
      'apply',
    ]);
  });

  it('is a log and not a set, so two identical entries both survive', () => {
    store.appendStageLog(ADJUDICATION);
    store.appendStageLog(ADJUDICATION);

    expect(store.readStageLog(EPISODE_ID)).toHaveLength(2);
  });

  it('keeps each episode readable on its own', () => {
    store.appendStageLog(ADJUDICATION);
    store.appendStageLog({ ...ADJUDICATION, episodeId: OTHER_EPISODE_ID, stage: 'apply' });

    expect(store.readStageLog(OTHER_EPISODE_ID).map((entry) => entry.stage)).toStrictEqual([
      'apply',
    ]);
  });

  it('returns nothing for an episode that logged nothing', () => {
    expect(store.readStageLog(EPISODE_ID)).toStrictEqual([]);
  });

  it('accepts a stage that made no decision, such as a dedupe rejection with nothing downstream', () => {
    store.appendStageLog({
      episodeId: EPISODE_ID,
      stage: 'dedupe',
      inputs: { normalizedTextHash: 'sha256:1f0a9c4d' },
      decision: null,
      at: ADJUDICATION.at,
    });

    expect(store.readStageLog(EPISODE_ID)).toHaveLength(1);
  });

  it('round-trips a nested payload without flattening it', () => {
    store.appendStageLog({
      ...ADJUDICATION,
      decision: { verdict: 'SUPPORTS', weight: { tier: 3, episodeCap: 0.5, taint: 1 } },
    });

    expect(store.readStageLog(EPISODE_ID)[0]?.decision).toStrictEqual({
      verdict: 'SUPPORTS',
      weight: { tier: 3, episodeCap: 0.5, taint: 1 },
    });
  });
});
