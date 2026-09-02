/**
 * §5.2's resolution ladder, rung by rung.
 *
 * ```
 * exact name → mention index → embedding match → LLM tiebreak
 * ```
 *
 * Two properties are under test and they are not the same property. The first
 * is that *each rung resolves* — a hit at any rung produces the right referent.
 * The second is that the ladder **stops at the first hit**, which is a cost
 * claim as much as a correctness one: §5 budgets one embedding and one small
 * model call for the whole write path, and a ladder that runs every rung
 * regardless spends both on questions the mention index already answered.
 *
 * Stopping is observable without reaching inside anything. The provider port
 * says rung 3 embeds the scope target as a `'query'` while stage 2 embeds claim
 * text as a `'document'`, so a ladder that short-circuits above rung 3 leaves
 * no `'query'` call in the log; and an untouched adjudicator has an empty
 * request list.
 *
 * The store is real. The two model calls are faked, and nothing else is.
 *
 * @spec §5.2, §5.3, §11, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort, IngestReceipt } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import type { Resolution } from '../index';
import { openGraphStore, type GraphStore } from '../../store/index';

import {
  COSINE_FLOOR,
  agentOrigin,
  claimMessage,
  declaredCosine,
  fakeAdjudicator,
  fakeEmbeddings,
  picks,
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

const resolutionOf = (receipt: IngestReceipt, surfaceForm: string): Resolution => {
  const found = receipt.resolutions.find((entry) => entry.surfaceForm === surfaceForm);
  if (found === undefined)
    throw new Error(`the ingest port returned no resolution for "${surfaceForm}"`);
  return found;
};

/** Names a noun once, in its own episode, and hands back how it resolved. */
const name = async (surfaceForm: string, n: number): Promise<Resolution> =>
  resolutionOf(
    await ingest.submit(
      claimMessage(`Episode ${n} had something to say about ${surfaceForm}.`, [surfaceForm], {
        origin: agentOrigin(n),
      }),
    ),
    surfaceForm,
  );

/**
 * Establishes `SessionStore` as a referent whose derived name is unambiguously
 * `SessionStore`, so a later hit on `session-store` is unambiguously rung 2.
 */
const establishSessionStore = async (): Promise<string> => {
  const first = await name('SessionStore', 1);
  await name('SessionStore', 2);
  await name('SessionStore', 3);
  return first.referentId;
};

describe('the geometry the ladder is being tested against', () => {
  it('puts the two retry candidates above the floor for the query and below it for each other', () => {
    expect(declaredCosine('the retry knob', 'RetryPolicy')).toBeGreaterThan(COSINE_FLOOR);
    expect(declaredCosine('the retry knob', 'RetryBudget')).toBeGreaterThan(COSINE_FLOOR);
    expect(declaredCosine('RetryPolicy', 'RetryBudget')).toBeLessThan(COSINE_FLOOR);
  });

  it('puts "the ledger" below the floor for LedgerEntry, so rung 3 must decline it', () => {
    expect(declaredCosine('the ledger', 'LedgerEntry')).toBeLessThan(COSINE_FLOOR);
  });
});

describe('rung 1 — exact name', () => {
  it('resolves a form that is the referent\'s own derived name', async () => {
    const minted = await name('SessionStore', 1);
    const again = await name('SessionStore', 2);

    expect(minted.rung).toBe('minted');
    expect(again.rung).toBe('exact');
    expect(again.referentId).toBe(minted.referentId);
  });

  it('stops there — no gloss query, no model call', async () => {
    await name('SessionStore', 1);
    embeddings.forget();

    await name('SessionStore', 2);

    expect(queriedTexts(embeddings)).toStrictEqual([]);
    expect(adjudicator.requests).toStrictEqual([]);
  });
});

describe('rung 2 — the mention index', () => {
  it('resolves a recorded surface form that is not the referent\'s name', async () => {
    const referentId = await establishSessionStore();
    await name('session-store', 4);

    const again = await name('session-store', 5);

    expect(again.rung).toBe('mention-index');
    expect(again.referentId).toBe(referentId);
  });

  it('stops there — no gloss query, no model call', async () => {
    await establishSessionStore();
    await name('session-store', 4);
    embeddings.forget();

    await name('session-store', 5);

    expect(queriedTexts(embeddings)).toStrictEqual([]);
    expect(adjudicator.requests).toStrictEqual([]);
  });

  it('resolves without minting a second referent for the same thing', async () => {
    await establishSessionStore();
    await name('session-store', 4);
    await name('session-store', 5);

    expect(ingest.referents.all()).toHaveLength(1);
  });
});

describe('rung 3 — the gloss embedding', () => {
  it('resolves a form no index has seen but the gloss space places', async () => {
    const referentId = await establishSessionStore();

    const first = await name('session-store', 4);

    expect(first.rung).toBe('gloss-embedding');
    expect(first.referentId).toBe(referentId);
  });

  it('asks for exactly one gloss query — the surface form, phrased as a query', async () => {
    await establishSessionStore();
    embeddings.forget();

    await name('session-store', 4);

    expect(queriedTexts(embeddings)).toStrictEqual(['session-store']);
  });

  it('stops there — a single candidate above the floor needs no tiebreak', async () => {
    await establishSessionStore();

    await name('session-store', 4);

    expect(adjudicator.requests).toStrictEqual([]);
  });

  it('records the form it resolved, so the same question is a rung-2 answer next time', async () => {
    const referentId = await establishSessionStore();
    await name('session-store', 4);

    expect(ingest.referents.mentionsOf(referentId).sort()).toStrictEqual([
      'SessionStore',
      'session-store',
    ]);
  });

  it('declines a nearest hit that sits below the floor', async () => {
    await name('LedgerEntry', 1);

    const stranger = await name('the ledger', 2);

    expect(stranger.rung).toBe('minted');
    expect(ingest.referents.all()).toHaveLength(2);
  });
});

describe('rung 4 — the tiebreak', () => {
  /**
   * Two referents the gloss channel cannot choose between, plus the ambiguous
   * phrasing.
   *
   * Each rival is named twice, in two episodes, for the reason
   * {@link establishSessionStore} names its referent three times: a form the
   * tiebreak later settles on arrives corroborated once, so a rival corroborated
   * once too would be tied with it, and §3.1's derived name would then turn on
   * which naming claim happened to hash smaller. Two namings make the minting
   * form unambiguously the derived name, which is what a later rung-2 hit on the
   * tiebreak's form has to be measured against.
   */
  const twoRivalReferents = async (): Promise<{ policy: string; budget: string }> => {
    const policy = await name('RetryPolicy', 1);
    const budget = await name('RetryBudget', 2);
    await name('RetryPolicy', 5);
    await name('RetryBudget', 6);
    return { policy: policy.referentId, budget: budget.referentId };
  };

  it('escalates only when more than one candidate clears the floor', async () => {
    await twoRivalReferents();
    adjudicator.answerWith(picks('RetryPolicy'));

    await name('the retry knob', 3);

    expect(adjudicator.requests).toHaveLength(1);
  });

  it('resolves to the referent the model chose', async () => {
    const { budget } = await twoRivalReferents();
    adjudicator.answerWith(picks('RetryBudget'));

    const chosen = await name('the retry knob', 3);

    expect(chosen.rung).toBe('tiebreak');
    expect(chosen.referentId).toBe(budget);
  });

  it('offers the model only the candidates that cleared the floor, with the claim as context', async () => {
    const { policy, budget } = await twoRivalReferents();
    adjudicator.answerWith(picks('RetryPolicy'));

    await name('the retry knob', 3);
    const request = adjudicator.requests[0];

    expect(request?.surfaceForm).toBe('the retry knob');
    expect(request?.context).toBe('Episode 3 had something to say about the retry knob.');
    expect(request?.candidates.map((candidate) => candidate.referentId).sort()).toStrictEqual(
      [policy, budget].sort(),
    );
    expect(
      request?.candidates.every((candidate) => candidate.cosine >= COSINE_FLOOR),
    ).toBe(true);
  });

  it('mints when the model declines to choose', async () => {
    await twoRivalReferents();

    const undecided = await name('the retry knob', 3);

    expect(undecided.rung).toBe('minted');
    expect(ingest.referents.all()).toHaveLength(3);
  });

  it('records the form it settled on, so the next use never reaches the model again', async () => {
    await twoRivalReferents();
    adjudicator.answerWith(picks('RetryPolicy'));
    await name('the retry knob', 3);

    const again = await name('the retry knob', 4);

    expect(again.rung).toBe('mention-index');
    expect(adjudicator.requests).toHaveLength(1);
  });
});

describe('the mint at the bottom of the ladder', () => {
  it('is reached without a model call when nothing clears the floor', async () => {
    await name('LedgerEntry', 1);
    embeddings.forget();

    const minted = await name('the ledger', 2);

    expect(minted.rung).toBe('minted');
    expect(queriedTexts(embeddings)).toStrictEqual(['the ledger']);
    expect(adjudicator.requests).toStrictEqual([]);
  });

  it('records the minting form as the new referent\'s first mention', async () => {
    const minted = await name('practice', 1);

    expect(ingest.referents.mentionsOf(minted.referentId)).toStrictEqual(['practice']);
    expect(store.resolveMention('practice')).toBe(minted.referentId);
  });

  it('climbs the whole ladder before minting — one query, no cheaper rung skipped', async () => {
    await establishSessionStore();
    embeddings.forget();

    await name('practice', 4);

    expect(queriedTexts(embeddings)).toStrictEqual(['practice']);
  });
});

describe('a claim naming several nouns', () => {
  it('runs the ladder once per noun and reports every outcome', async () => {
    await establishSessionStore();

    const receipt = await ingest.submit(
      claimMessage('SessionStore is where the practice is written down.', [
        'SessionStore',
        'practice',
      ]),
    );

    expect(receipt.resolutions.map((entry) => [entry.surfaceForm, entry.rung])).toStrictEqual([
      ['SessionStore', 'exact'],
      ['practice', 'minted'],
    ]);
  });
});
