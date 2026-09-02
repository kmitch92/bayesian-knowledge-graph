/**
 * §5.2's ladder in front of a surface form that names more than one thing.
 *
 * `resolution-ladder.test.ts` walks the four rungs on the assumption that each
 * read below them answers with at most one referent. This file is about the read
 * that does not. §3.1's mention index is keyed `(surface_form, referent_id)`
 * *"precisely so a form that comes to name two referents keeps both, and
 * answering one away is the ambiguity §5.2 exists to adjudicate"* — so a plural
 * answer is a state the store is built to hold, and the ladder owes it the
 * tiebreak rung rather than the first row.
 *
 * **The rule this file pins is plurality *at the same strength*, not plurality.**
 * A form can be one referent's derived name while being a mere alias of another,
 * and that is neither rare nor ambiguous: §3.1's `name` is the most-corroborated
 * surface form, so a canonical match outranks any number of alias matches and
 * rung 1 answers as it always did. Escalating there would buy a model call to
 * break a tie that is not tied, on every resolution of every form two referents
 * have ever shared. Ambiguity is two canonical matches, or two aliases and no
 * canonical match — and only then.
 *
 * ---
 *
 * **Why the arrangements write the index directly.** Every rung records what it
 * resolved, which is exactly what makes this state unreachable from the ingest
 * port: a second referent can never acquire a form the first one already holds,
 * because the ladder hands that form back to the first one and the mention lands
 * there. The state arrives instead from §8.4's split, from a rebuild that
 * re-derives two names onto the same string, or from a graph merged in from
 * elsewhere. {@link alsoCalled} and {@link nowCalled} stand in for those, using
 * nothing but the store's own public writes — the same two calls
 * `referent-queries.test.ts` uses to prove the store keeps both bindings.
 *
 * The store is real, at `:memory:`, as everywhere in this suite. The embedding
 * provider and the adjudicator are faked, and nothing else is.
 *
 * @spec §3.1, §5.2, §8.4, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort, IngestReceipt } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import type {
  Resolution,
  TiebreakCandidate,
  TiebreakRequest,
  TiebreakVerdict,
} from '../index';
import { openGraphStore, type GraphStore } from '../../store/index';

import {
  COSINE_FLOOR,
  agentOrigin,
  claimMessage,
  declaredCosine,
  fakeAdjudicator,
  fakeEmbeddings,
  readsAsAGlossMatch,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from './fixtures';

/**
 * The form two referents come to share, and the question every escalation below
 * is asked about. Declared in {@link SEMANTIC_CLUSTERS}, so a referent whose
 * derived name is this one has a gloss that answers to it at cosine 1.
 */
const SHARED = 'Chapter Three';

/**
 * Forms nothing in the declared semantic space places, and therefore forms that
 * are orthogonal to each other and to {@link SHARED}. Every referent minted
 * under one of these is invisible to rung 3, which is what lets a test say that
 * an escalation came from the mention index and from nowhere else.
 */
const THE_BOOKS_CHAPTER = "the book's third chapter";
const THE_COURSES_CHAPTER = "the course's third chapter";
const THE_ERRATA = 'the errata sheet';
const THE_HANDOUT = 'the seminar handout';
const THE_THROTTLE_DIAL = 'the throttle dial';

/**
 * A form the declared space places right beside {@link SHARED} — near enough
 * that a referent named this one is a floor-clearing gloss hit for a query the
 * mention index has already answered two ways.
 */
const THE_THIRD_CHAPTER = 'the third chapter';

/** What one alias binding is worth. The ladder never reads it; `deriveName` does. @spec §4.2 */
const ONE_NAMING = 1;

/**
 * More support than any fixture here gives the form it displaced, so a referent
 * these helpers rename has an `entities.name` and a mention tally that agree
 * about which form is derived. The ladder reads only the former; a fixture where
 * the two disagreed would be describing a corrupt index rather than a shared name.
 *
 * @spec §3.1, §4.2
 */
const SETTLED = 9;

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
 * Mints a referent under a form nothing else is near, insisted on twice.
 *
 * Twice for {@link deriveName}'s sake: a form corroborated once is tied with any
 * other form corroborated once, and §3.1's derived name would then turn on which
 * of the two strings sorts smaller rather than on which one the fixture meant.
 *
 * @spec §3.1, §4.2
 */
const referentCalled = async (surfaceForm: string, firstEpisode: number): Promise<string> => {
  const minted = await name(surfaceForm, firstEpisode);
  await name(surfaceForm, firstEpisode + 1);
  return minted.referentId;
};

/**
 * Records one more thing a referent gets called, without disturbing what it is
 * called: an alias binding, invisible to rung 1 and answered by rung 2.
 *
 * @spec §3.1, §5.2
 */
const alsoCalled = (referentId: string, surfaceForm: string): void => {
  store.putMention({ surfaceForm, referentId, weight: ONE_NAMING });
};

/**
 * Moves a referent's derived name onto a form, gloss and all.
 *
 * The gloss travels with the name because §3.1 makes it an embedding *of* the
 * name — `recordMention` re-embeds for the same reason, and a fixture that moved
 * one without the other would be testing the ladder against an index no write
 * path could produce.
 *
 * @spec §3.1, §5.2
 */
const nowCalled = async (referentId: string, surfaceForm: string): Promise<void> => {
  const entity = store.getEntity(referentId);
  if (entity === undefined) throw new Error(`the index holds no referent ${referentId}`);
  const gloss = await embeddings.embed(surfaceForm, 'document');
  store.putEntity({ ...entity, name: surfaceForm, glossEmbedding: Array.from(gloss) });
  store.putMention({ surfaceForm, referentId, weight: SETTLED });
};

/**
 * Picks a named referent out of the slate, or declines when it is not there.
 *
 * By id rather than by name, which is `picks`' way, because the case this file
 * is about is two candidates carrying the *same* name — a picker that chose on
 * the name would be as unable to answer as the embedding was.
 *
 * @spec §5.2
 */
const picksReferent =
  (referentId: string) =>
  (request: TiebreakRequest): TiebreakVerdict => {
    const chosen = request.candidates.find((candidate) => candidate.referentId === referentId);
    return chosen === undefined
      ? { outcome: 'unresolved' }
      : { outcome: 'resolved', referentId: chosen.referentId };
  };

/** The referents the model was offered, in the order it was offered them. @spec §5.2 */
const slate = (): string[] => {
  const request = adjudicator.requests[0];
  if (request === undefined) throw new Error('the ladder escalated nothing to the adjudicator');
  return request.candidates.map((candidate) => candidate.referentId);
};

/** What the model was told about one referent on the slate. @spec §5.2 */
const offered = (referentId: string): TiebreakCandidate => {
  const request = adjudicator.requests[0];
  if (request === undefined) throw new Error('the ladder escalated nothing to the adjudicator');
  const candidate = request.candidates.find((entry) => entry.referentId === referentId);
  if (candidate === undefined) throw new Error(`the model was not offered ${referentId}`);
  return candidate;
};

describe('the geometry these arrangements assume', () => {
  it('keeps every privately-named referent out of reach of the shared form', () => {
    for (const form of [THE_BOOKS_CHAPTER, THE_COURSES_CHAPTER, THE_ERRATA, THE_HANDOUT])
      expect(declaredCosine(form, SHARED)).toBeLessThan(COSINE_FLOOR);
  });

  it('keeps the privately-named referents out of reach of one another', () => {
    expect(declaredCosine(THE_BOOKS_CHAPTER, THE_COURSES_CHAPTER)).toBeLessThan(COSINE_FLOOR);
    expect(declaredCosine(THE_ERRATA, THE_HANDOUT)).toBeLessThan(COSINE_FLOOR);
    expect(declaredCosine(THE_THROTTLE_DIAL, 'the retry knob')).toBeLessThan(COSINE_FLOOR);
  });

  it('keeps "the ledger" below the floor for LedgerEntry, so rung 3 must decline it', () => {
    expect(declaredCosine('the ledger', 'LedgerEntry')).toBeLessThan(COSINE_FLOOR);
  });

  it('puts one referent, and only one, within reach of the shared form', () => {
    expect(declaredCosine(THE_THIRD_CHAPTER, SHARED)).toBeGreaterThan(COSINE_FLOOR);
    expect(declaredCosine(THE_THIRD_CHAPTER, THE_ERRATA)).toBeLessThan(COSINE_FLOOR);
    expect(declaredCosine(THE_THIRD_CHAPTER, THE_HANDOUT)).toBeLessThan(COSINE_FLOOR);
  });
});

describe('two referents that answer to the same name', () => {
  /**
   * A chapter of a book and a chapter of a course, each minted under a form of
   * its own and each having since settled on being called `Chapter Three`.
   */
  const bothCalledChapterThree = async (): Promise<{ book: string; course: string }> => {
    const book = await referentCalled(THE_BOOKS_CHAPTER, 1);
    const course = await referentCalled(THE_COURSES_CHAPTER, 3);
    await nowCalled(book, SHARED);
    await nowCalled(course, SHARED);
    return { book, course };
  };

  it('escalates rather than answering with whichever the index returned first', async () => {
    await bothCalledChapterThree();

    await name(SHARED, 5);

    expect(adjudicator.requests).toHaveLength(1);
  });

  it('offers the model both of them', async () => {
    const { book, course } = await bothCalledChapterThree();

    await name(SHARED, 5);

    expect(slate().sort()).toStrictEqual([book, course].sort());
  });

  it('resolves to the one the model chose, at the tiebreak rung', async () => {
    const { course } = await bothCalledChapterThree();
    adjudicator.answerWith(picksReferent(course));

    const chosen = await name(SHARED, 5);

    expect(chosen.rung).toBe('tiebreak');
    expect(chosen.referentId).toBe(course);
  });

  it('mints when the model declines to choose between them', async () => {
    await bothCalledChapterThree();

    const undecided = await name(SHARED, 5);

    expect(undecided.rung).toBe('minted');
    expect(ingest.referents.all()).toHaveLength(3);
  });
});

describe('two referents that answer to the same nickname', () => {
  /**
   * Neither referent is *called* `Chapter Three`; both have been called it. No
   * canonical match outranks the other, and the gloss channel reaches neither,
   * so the mention index is the only thing that can escalate this.
   */
  const bothNicknamedChapterThree = async (): Promise<{ errata: string; handout: string }> => {
    const errata = await referentCalled(THE_ERRATA, 1);
    const handout = await referentCalled(THE_HANDOUT, 3);
    alsoCalled(errata, SHARED);
    alsoCalled(handout, SHARED);
    return { errata, handout };
  };

  it('escalates two aliases that no name outranks', async () => {
    const { handout } = await bothNicknamedChapterThree();
    adjudicator.answerWith(picksReferent(handout));

    const chosen = await name(SHARED, 5);

    expect(chosen.rung).toBe('tiebreak');
    expect(chosen.referentId).toBe(handout);
  });
});

describe('a tie the gloss channel can only widen', () => {
  /**
   * Two referents nicknamed `Chapter Three` and a third the gloss space places
   * beside that form — the *only* referent geometry can see from it.
   *
   * This is the arrangement where "rung 3 answers when it finds exactly one hit"
   * and "rung 3 answers only when the rungs above declined" come apart, because
   * both antecedents hold at once. §5.2's answer is that the gloss channel never
   * saw the form the tie is over — it was asked about `Chapter Three` and it
   * knows about `the third chapter` — so its lone hit is a third opinion, not a
   * casting vote. A ladder that let it answer would resolve a form two referents
   * are called to a referent nothing has ever called it.
   */
  const twoNicknamesAndOneNeighbour = async (): Promise<{
    errata: string;
    handout: string;
    neighbour: string;
  }> => {
    const errata = await referentCalled(THE_ERRATA, 1);
    const handout = await referentCalled(THE_HANDOUT, 3);
    const neighbour = await referentCalled(THE_THIRD_CHAPTER, 5);
    alsoCalled(errata, SHARED);
    alsoCalled(handout, SHARED);
    return { errata, handout, neighbour };
  };

  it('does not let a lone gloss hit settle what two aliases left tied', async () => {
    const { handout } = await twoNicknamesAndOneNeighbour();
    adjudicator.answerWith(picksReferent(handout));

    const chosen = await name(SHARED, 7);

    expect(chosen.rung).toBe('tiebreak');
    expect(chosen.referentId).toBe(handout);
  });

  it('widens the slate with the gloss neighbour instead of resolving to it', async () => {
    const { errata, handout, neighbour } = await twoNicknamesAndOneNeighbour();

    await name(SHARED, 7);

    expect(slate().sort()).toStrictEqual([errata, handout, neighbour].sort());
  });
});

describe('a name that is also somebody else\'s nickname', () => {
  /**
   * The case the blunt rule would have paid a model call for. `Chapter Three` is
   * one referent's derived name and two other referents' alias; §3.1 already
   * ranks those, and rung 1 is what that ranking is called.
   */
  const oneNameAndTwoNicknames = async (): Promise<string> => {
    const chapter = await referentCalled(SHARED, 1);
    alsoCalled(await referentCalled(THE_ERRATA, 3), SHARED);
    alsoCalled(await referentCalled(THE_HANDOUT, 5), SHARED);
    return chapter;
  };

  it('resolves to the referent the form names, at the exact rung', async () => {
    const chapter = await oneNameAndTwoNicknames();

    const hit = await name(SHARED, 7);

    expect(hit.rung).toBe('exact');
    expect(hit.referentId).toBe(chapter);
  });

  it('buys no tiebreak to settle what a canonical name already settles', async () => {
    await oneNameAndTwoNicknames();

    await name(SHARED, 7);

    expect(adjudicator.requests).toHaveLength(0);
  });
});

describe('the single-candidate rungs the rule leaves alone', () => {
  it('answers a lone canonical match at the exact rung, without a model call', async () => {
    const chapter = await referentCalled(SHARED, 1);

    const hit = await name(SHARED, 3);

    expect(hit.rung).toBe('exact');
    expect(hit.referentId).toBe(chapter);
    expect(adjudicator.requests).toHaveLength(0);
  });

  it('answers a lone alias at the mention-index rung, without a model call', async () => {
    const errata = await referentCalled(THE_ERRATA, 1);
    alsoCalled(errata, SHARED);

    const hit = await name(SHARED, 3);

    expect(hit.rung).toBe('mention-index');
    expect(hit.referentId).toBe(errata);
    expect(adjudicator.requests).toHaveLength(0);
  });
});

describe('the slate an escalation is built from', () => {
  /**
   * `the retry knob` is an alias of `RetryBudget` and of a referent the gloss
   * space cannot see; it is also within {@link COSINE_FLOOR} of `RetryPolicy`
   * and `RetryBudget`. So one referent is reachable through both channels, one
   * through the mention index alone, and one through the gloss alone.
   */
  const reachableBothWays = async (): Promise<{
    policy: string;
    budget: string;
    dial: string;
  }> => {
    const policy = await referentCalled('RetryPolicy', 1);
    const budget = await referentCalled('RetryBudget', 3);
    const dial = await referentCalled(THE_THROTTLE_DIAL, 5);
    alsoCalled(budget, 'the retry knob');
    alsoCalled(dial, 'the retry knob');
    return { policy, budget, dial };
  };

  it('is the mention candidates and the gloss candidates together', async () => {
    const { policy, budget, dial } = await reachableBothWays();

    await name('the retry knob', 7);

    expect(slate().sort()).toStrictEqual([policy, budget, dial].sort());
  });

  it('holds a referent both channels reached exactly once', async () => {
    const { budget } = await reachableBothWays();

    await name('the retry knob', 7);

    expect(slate().filter((referentId) => referentId === budget)).toHaveLength(1);
  });

  it('leads with the candidates the mention index found', async () => {
    const { policy, budget, dial } = await reachableBothWays();

    await name('the retry knob', 7);

    expect(slate().slice(0, 2).sort()).toStrictEqual([budget, dial].sort());
    expect(slate().at(-1)).toBe(policy);
  });

  /**
   * The candidate the mention index alone reached is the one the gloss channel
   * has no number for, and the slate must not invent one that reads like a
   * measurement. A model shown a floor-clearing cosine beside a referent nothing
   * measured is being told the geometry agrees when the geometry never looked —
   * the one misreading §5.2's floor exists to prevent.
   *
   * What the ladder reports *instead* is not pinned here on purpose: `0` and a
   * null both say "unplaced" honestly, and {@link readsAsAGlossMatch} is written
   * so that either passes. What is pinned is that it never reads as a match.
   *
   * @spec §5.2, §15
   */
  it('does not offer a mention-only candidate as though the gloss had placed it', async () => {
    const { dial } = await reachableBothWays();

    await name('the retry knob', 7);

    expect(readsAsAGlossMatch(offered(dial))).toBe(false);
  });

  it('reports the gloss measurement for a candidate the mention index led with', async () => {
    const { budget } = await reachableBothWays();

    await name('the retry knob', 7);

    expect(readsAsAGlossMatch(offered(budget))).toBe(true);
  });

  it('leaves out a gloss neighbour that sits below the floor', async () => {
    const ledger = await referentCalled('LedgerEntry', 1);
    const errata = await referentCalled(THE_ERRATA, 3);
    const handout = await referentCalled(THE_HANDOUT, 5);
    alsoCalled(errata, 'the ledger');
    alsoCalled(handout, 'the ledger');

    await name('the ledger', 7);

    expect(slate().sort()).toStrictEqual([errata, handout].sort());
    expect(slate()).not.toContain(ledger);
  });
});
