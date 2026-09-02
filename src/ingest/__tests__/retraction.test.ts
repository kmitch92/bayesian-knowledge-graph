/**
 * What a withdrawn attestation reaches, and what the referent it drops is left
 * standing on.
 *
 * Two rules meet on this path, and the port currently gets both wrong.
 *
 * ---
 *
 * **A retraction is about a form, and a form can name more than one thing.**
 * §3.1 keys the mention index `(surface_form, referent_id)` *"precisely so a form
 * that comes to name two referents keeps both, and answering one away is the
 * ambiguity §5.2 exists to adjudicate"*. `submitRetraction` reads that index and
 * keeps the first row, which is the same first-candidate defect F4 took out of
 * the ladder. When the source attested the *second* referent, the withdrawal
 * lands on a referent that source never spoke for, finds nothing of its own to
 * retire, and no-ops — and the attestation the emitter actually withdrew is still
 * there, still holding the referent in the view regime. A source that let go is
 * still, in the graph, holding on.
 *
 * So the withdrawal iterates every candidate the form reaches, retires that
 * source's live view-regime claims on each, and lets §3.1's regime rule answer
 * *per referent*: one referent losing its last attestation says nothing about
 * another that still has one.
 *
 * A `locator` on the message narrows it. With one, the emitter is naming the
 * declaration it is withdrawing and exactly that claim retires — the precise
 * half of the emitter contract, and the only way to drop one of two attestations
 * a source made under one form. Without one, `(source, form)` matches everywhere
 * the form reaches, which is the coarse meaning and the right default.
 *
 * ---
 *
 * **The successor is seeded from the corpse, and the withdrawal does not vote
 * for it.** `submitRetraction`'s docblock argues that a fallen referent has
 * nothing to seed a posterior from, because *"the claim it succeeds is a view
 * claim and view claims have no posterior by construction"*. That is true of the
 * view predecessor and blind to what stands behind it. A referent born from usage
 * accumulates a real evidence-regime posterior; the attestation that later
 * arrived retired that claim rather than deleting it (§6.1), and the posterior is
 * still on it. Starting the successor at the §15 prior throws away a number the
 * ledger is still holding — reading it is reading evidence, not inventing it, and
 * §6.2's deprecated row is exactly this: *"mint a new claim `DERIVED_FROM` the
 * corpse, seeded from its old posterior"*.
 *
 * And the successor is born at exactly that seed. The mint boost
 * {@link writeExistenceClaim} adds to a first observation is a vote for the
 * referent's existence, and the message paying for it here is a message asserting
 * the referent's *absence*. Counting it means a source that withdrew a claim
 * corroborated it on the way out.
 *
 * ---
 *
 * The store is real, at `:memory:`, as everywhere in this suite. Only the
 * embedding provider (§5.3) and the coreference adjudicator (§5.2) are stood in
 * for, over the declared semantic space in `../../referents/__tests__/fixtures`.
 *
 * @spec §3.1, §4.1, §4.2, §5.2, §6.1, §6.2, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  existenceClaimsOf,
  isLive,
  type ExistenceClaim,
} from '../../referents/index';
import { openGraphStore, type Evidence, type GraphStore } from '../../store/index';
import { observationWeight, priorFor } from '../evidence';
import { openIngest, type IngestPort, type RetractionMessage } from '../index';

import {
  COSINE_FLOOR,
  LOCATOR,
  NOUN_SOURCE,
  OTHER_NOUN_SOURCE,
  agentOrigin,
  attestationMessage,
  claimMessage,
  declaredCosine,
  emitterOrigin,
  fakeAdjudicator,
  fakeEmbeddings,
  retractionMessage,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from '../../referents/__tests__/fixtures';

/**
 * Two forms the declared space puts in separate planes, so each attestation
 * mints its own referent and neither resolves to the other.
 */
const AUTH = 'AuthService';
const SESSION = 'SessionStore';

/**
 * The form both referents come to answer to, and the one every retraction below
 * is addressed to. In a third plane, so nothing about these arrangements depends
 * on the gloss channel — the retraction path reads the mention index, and the
 * geometry is here only to keep the *fixtures* from collapsing into one referent.
 */
const SHARED = 'Chapter Three';

/** The tier the fixtures write at, where §15's weight is a round 1.0. @spec §4.2, §15 */
const OBSERVED = 'observed';

/**
 * What one uncapped, untainted observation is worth — the boost
 * {@link writeExistenceClaim} adds to a claim's prior when it mints one.
 *
 * Read off §4.2 rather than written as a number, so the test that says the
 * withdrawal contributes none of it is comparing against the weight the write
 * path would really have added.
 *
 * @spec §4.2, §15
 */
const FIRST_OBSERVATION = observationWeight(OBSERVED, 0, false);

/**
 * What one alias binding is recorded at: less than the support behind the form a
 * referent is already called, so sharing a form never moves a derived name. The
 * ladder never reads this number; `deriveName` does.
 *
 * @spec §3.1, §4.2
 */
const ONE_NAMING = 1;

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

/** A noun source declaring a referent, at a locator of the caller's choosing. @spec §3.1 */
const attest = async (
  surfaceForm: string,
  source: string,
  n: number,
  locator: unknown = LOCATOR,
): Promise<void> => {
  await ingest.submit(attestationMessage(surfaceForm, { source, origin: emitterOrigin(n), locator }));
};

/** That source withdrawing everything it attested under a form. @spec §3.1, §4.5 */
const retract = async (surfaceForm: string, source: string, n: number): Promise<void> => {
  await ingest.submit(retractionMessage(surfaceForm, { source, origin: emitterOrigin(n) }));
};

/**
 * The same withdrawal, narrowed to one declaration.
 *
 * `locator` is not on `RetractionMessage` yet, and the type error this raises is
 * the RED signal — left standing rather than cast away, because a cast would let
 * the test compile against a contract the port does not offer and would go on
 * compiling if the field never arrived.
 *
 * @spec §3.1, §4.5
 */
const preciseRetraction = (
  surfaceForm: string,
  locator: unknown,
  n: number,
): RetractionMessage => ({
  type: 'retraction',
  source: NOUN_SOURCE,
  surfaceForm,
  locator,
  origin: emitterOrigin(n),
});

/** Ordinary usage: a claim naming a noun, once, in its own episode. @spec §4.4, §5.2 */
const nameInEpisode = async (surfaceForm: string, n: number): Promise<void> => {
  await ingest.submit(
    claimMessage(`${surfaceForm} came up again while working.`, [surfaceForm], {
      origin: agentOrigin(n),
    }),
  );
};

/**
 * Records one more thing a referent gets called, without disturbing what it is
 * called.
 *
 * Written into the mention index directly, exactly as `mention-ambiguity.test.ts`
 * does and for the same reason: every rung of §5.2's ladder records what it
 * resolved, so a second referent can never acquire a form the first one already
 * holds by going in through the port — the ladder hands the form back to the
 * first referent and the mention lands there. The state arrives instead from
 * §8.4's split, from a rebuild that re-derives two names onto one string, or from
 * a graph federated in, and `putMention` is the store's own public write all
 * three would land on.
 *
 * @spec §3.1, §5.2, §8.4
 */
const alsoCalled = (referentId: string, surfaceForm: string): void => {
  store.putMention({ surfaceForm, referentId, weight: ONE_NAMING });
};

/** The referent a form names, read out of the index. @spec §3.1 */
const referentOf = (surfaceForm: string): string => {
  const referentId = store.resolveMention(surfaceForm);
  if (referentId === undefined) throw new Error(`nothing in the index is named "${surfaceForm}"`);
  return referentId;
};

/** The claim a referent's existence currently stands on. @spec §3.1, §6.1 */
const standingClaimId = (referentId: string): string => {
  const referent = ingest.referents.get(referentId);
  if (referent === undefined) throw new Error(`the index holds no referent ${referentId}`);
  return referent.existenceClaimId;
};

/** Which machinery maintains a referent right now. @spec §3.1 */
const regimeOf = (referentId: string): string => {
  const referent = ingest.referents.get(referentId);
  if (referent === undefined) throw new Error(`the index holds no referent ${referentId}`);
  return referent.regime;
};

/** Where a referent's existence sits in §6.1's lifecycle. @spec §6.1 */
const statusOf = (referentId: string): string => {
  const referent = ingest.referents.get(referentId);
  if (referent === undefined) throw new Error(`the index holds no referent ${referentId}`);
  return referent.status;
};

/** The posterior behind a referent's existence, `null` where §3.1 says it has none. @spec §4.1 */
const posteriorOf = (referentId: string): Evidence | null => {
  const evidence = store.getEvidence(standingClaimId(referentId));
  if (evidence === undefined) throw new Error(`no claim stands behind referent ${referentId}`);
  return evidence;
};

/** The same read, for a fixture that has already established there is one. @spec §4.1 */
const requiredPosteriorOf = (referentId: string): Evidence => {
  const evidence = posteriorOf(referentId);
  if (evidence === null) throw new Error(`referent ${referentId} carries no posterior`);
  return evidence;
};

/** Every existence claim still speaking for a referent. @spec §6.1 */
const liveExistenceClaimIds = (referentId: string): string[] =>
  existenceClaimsOf(store, referentId)
    .filter((entry) => isLive(entry.claim))
    .map((entry) => entry.claim.id);

/** The attestations still standing behind a referent. @spec §3.1, §6.1 */
const liveAttestations = (referentId: string): ExistenceClaim[] =>
  existenceClaimsOf(store, referentId).filter(
    (entry) => entry.claim.regime === 'view' && isLive(entry.claim),
  );

/** The noun sources still attesting a referent, sorted so the assertion reads the same twice. @spec §3.1 */
const attestingSources = (referentId: string): string[] =>
  liveAttestations(referentId)
    .map((entry) => entry.payload.source)
    .filter((source): source is string => source !== undefined)
    .sort();

/** The declarations still standing, by the locator each one named. @spec §3.1 */
const liveLocators = (referentId: string): unknown[] =>
  liveAttestations(referentId).map((entry) => entry.payload.locator);

/**
 * The replay verdict §5.8 recorded for each message in an episode, read the way
 * §13 would read it back: the store keeps `decision` opaque, so a consumer of the
 * log has to look for the field rather than be handed it.
 *
 * @spec §5.8, §13
 */
const loggedReplayVerdicts = (episodeId: string): unknown[] =>
  store.readStageLog(episodeId).map(({ decision }) =>
    decision instanceof Object && 'duplicate' in decision ? decision.duplicate : undefined,
  );

/** What a claim says it was derived from — §6.2's lineage edge. @spec §3.3, §6.2 */
const lineageOf = (claimId: string): string[] =>
  store
    .getClaimEdges(claimId)
    .filter((edge) => edge.kind === 'DERIVED_FROM' && edge.from === claimId)
    .map((edge) => edge.to);

describe('the arrangements these withdrawals are read against', () => {
  it('keeps the two attested forms and the form they share out of reach of one another', () => {
    expect(declaredCosine(AUTH, SESSION)).toBeLessThan(COSINE_FLOOR);
    expect(declaredCosine(SHARED, AUTH)).toBeLessThan(COSINE_FLOOR);
    expect(declaredCosine(SHARED, SESSION)).toBeLessThan(COSINE_FLOOR);
  });

  it('returns the shared form\'s two referents in the order they acquired it', async () => {
    await attest(AUTH, NOUN_SOURCE, 1);
    await attest(SESSION, NOUN_SOURCE, 2);
    const first = referentOf(AUTH);
    const second = referentOf(SESSION);

    alsoCalled(first, SHARED);
    alsoCalled(second, SHARED);

    expect(store.findReferentsByMention(SHARED).map((entry) => entry.referentId)).toStrictEqual([
      first,
      second,
    ]);
  });

  it('gives a mint boost worth having, so a successor that took one would say so', () => {
    expect(FIRST_OBSERVATION).toBeGreaterThan(0);
  });
});

describe('a withdrawal addressed to a form that names two referents', () => {
  /**
   * `AuthService` is the inventory's; `SessionStore` is the emitter's. Both have
   * come to answer to `Chapter Three`, in that order — so the referent the
   * emitter's withdrawal is *about* is precisely the one a first-candidate read
   * never reaches.
   */
  const oneEach = async (): Promise<{ inventorys: string; emitters: string }> => {
    await attest(AUTH, OTHER_NOUN_SOURCE, 1);
    await attest(SESSION, NOUN_SOURCE, 2);
    const inventorys = referentOf(AUTH);
    const emitters = referentOf(SESSION);
    alsoCalled(inventorys, SHARED);
    alsoCalled(emitters, SHARED);
    return { inventorys, emitters };
  };

  it('retires the attestation on the candidate that source attested, and only that one', async () => {
    const { inventorys, emitters } = await oneEach();

    await retract(SHARED, NOUN_SOURCE, 3);

    expect(attestingSources(emitters)).toStrictEqual([]);
    expect(attestingSources(inventorys)).toStrictEqual([OTHER_NOUN_SOURCE]);
  });

  it('moves the regime of the referent that lost its last source, and of no other', async () => {
    const { inventorys, emitters } = await oneEach();

    await retract(SHARED, NOUN_SOURCE, 3);

    expect(regimeOf(emitters)).toBe('evidence');
    expect(regimeOf(inventorys)).toBe('view');
  });

  it('matches (source, form) everywhere the form reaches when no locator narrows it', async () => {
    await attest(AUTH, NOUN_SOURCE, 1);
    await attest(SESSION, NOUN_SOURCE, 2);
    const first = referentOf(AUTH);
    const second = referentOf(SESSION);
    alsoCalled(first, SHARED);
    alsoCalled(second, SHARED);

    await retract(SHARED, NOUN_SOURCE, 3);

    expect(attestingSources(first)).toStrictEqual([]);
    expect(attestingSources(second)).toStrictEqual([]);
    expect([regimeOf(first), regimeOf(second)]).toStrictEqual(['evidence', 'evidence']);
  });

  /**
   * §3.1 holds a referent in the view regime *while any noun source attests it*,
   * and that is a fact about one referent's own attestations. A second referent
   * that lost its last source at the same instant is a separate question with a
   * separate answer.
   */
  it('falls the regime per referent, leaving one a second source still attests where it was', async () => {
    await attest(AUTH, NOUN_SOURCE, 1);
    await attest(AUTH, OTHER_NOUN_SOURCE, 2);
    await attest(SESSION, NOUN_SOURCE, 3);
    const shared = referentOf(AUTH);
    const sole = referentOf(SESSION);
    alsoCalled(shared, SHARED);
    alsoCalled(sole, SHARED);

    await retract(SHARED, NOUN_SOURCE, 4);

    expect(regimeOf(shared)).toBe('view');
    expect(regimeOf(sole)).toBe('evidence');
  });

  /**
   * The partial withdrawal, on a candidate the first-candidate read cannot see.
   * The claim the emitter withdrew has to go; §3.1 keeps the referent in the view
   * regime anyway, because the inventory is still standing behind it.
   */
  it('withdraws one of two sources without moving the referent they both attest', async () => {
    await attest(AUTH, NOUN_SOURCE, 1);
    await attest(SESSION, NOUN_SOURCE, 2);
    await attest(SESSION, OTHER_NOUN_SOURCE, 3);
    const first = referentOf(AUTH);
    const twiceAttested = referentOf(SESSION);
    alsoCalled(first, SHARED);
    alsoCalled(twiceAttested, SHARED);

    await retract(SHARED, NOUN_SOURCE, 4);

    expect(attestingSources(twiceAttested)).toStrictEqual([OTHER_NOUN_SOURCE]);
    expect(regimeOf(twiceAttested)).toBe('view');
  });

  /**
   * Diagram §6: *"Nothing is ever both"*. A referent a source is still attesting
   * has not fallen, so no successor belief may be written beside the attestation
   * that survived — and the derived regime would not say so, because it reads the
   * standing claim and a live attestation outranks any belief sitting under it.
   *
   * @spec §3.1, §6.1
   */
  it('writes no successor belief beside the attestation that survived', async () => {
    await attest(AUTH, NOUN_SOURCE, 1);
    await attest(SESSION, NOUN_SOURCE, 2);
    await attest(SESSION, OTHER_NOUN_SOURCE, 3);
    const first = referentOf(AUTH);
    const twiceAttested = referentOf(SESSION);
    alsoCalled(first, SHARED);
    alsoCalled(twiceAttested, SHARED);

    await retract(SHARED, NOUN_SOURCE, 4);

    expect(liveExistenceClaimIds(twiceAttested)).toStrictEqual([standingClaimId(twiceAttested)]);
  });
});

describe('a withdrawal that names the declaration it retires', () => {
  /** A second locator, nested like {@link LOCATOR} and sharing none of its fields. */
  const ALSO_AT = {
    path: 'src/auth/legacy-gateway.ts',
    symbolRange: [17, 96],
    vcs: { rev: '4b7e0d3', dirty: true, tag: 'v0.9' },
  } as const;

  /** One referent, one source, two declarations of it at two locators. @spec §3.1 */
  const attestedAtBothLocators = async (): Promise<string> => {
    await attest(AUTH, NOUN_SOURCE, 1, LOCATOR);
    await attest(AUTH, NOUN_SOURCE, 2, ALSO_AT);
    return referentOf(AUTH);
  };

  it('leaves the source with two declarations to withdraw separately', async () => {
    const referentId = await attestedAtBothLocators();

    expect(liveLocators(referentId)).toHaveLength(2);
    expect(ingest.referents.all()).toHaveLength(1);
  });

  it('retires exactly the declaration at that locator and leaves the other standing', async () => {
    const referentId = await attestedAtBothLocators();

    await ingest.submit(preciseRetraction(AUTH, LOCATOR, 3));

    expect(liveLocators(referentId)).toStrictEqual([ALSO_AT]);
  });

  it('does not fall the regime, because the source is still attesting the other one', async () => {
    const referentId = await attestedAtBothLocators();

    await ingest.submit(preciseRetraction(AUTH, LOCATOR, 3));

    expect(regimeOf(referentId)).toBe('view');
    expect(posteriorOf(referentId)).toBeNull();
  });

  /** The same rule read off the ledger rather than the index. @spec §3.1, §6.1 */
  it('leaves the referent standing on the surviving declaration and nothing else', async () => {
    const referentId = await attestedAtBothLocators();

    await ingest.submit(preciseRetraction(AUTH, LOCATOR, 3));

    expect(liveExistenceClaimIds(referentId)).toStrictEqual([standingClaimId(referentId)]);
  });
});

describe('a withdrawal of a form the graph never held', () => {
  it('is a no-op rather than a mint, since nothing was asserted to disbelieve', async () => {
    await attest(AUTH, NOUN_SOURCE, 1);

    const receipt = await ingest.submit(
      retractionMessage('the thing nobody ever mentioned', {
        source: NOUN_SOURCE,
        origin: emitterOrigin(2),
      }),
    );

    expect(receipt.claimId).toBeUndefined();
    expect(receipt.resolutions).toStrictEqual([]);
    expect(ingest.referents.all().map((referent) => referent.name)).toStrictEqual([AUTH]);
  });
});

describe('the successor a fallen referent is left standing on', () => {
  /**
   * A referent grown from two episodes of ordinary usage, then attested — so the
   * evidence-regime claim the attestation retired is still in the ledger with its
   * posterior on it, which is the corpse §6.2 says a successor is seeded from.
   */
  interface AttestedAfterUsage {
    readonly referentId: string;
    /** The retired evidence claim, and the posterior it still holds. @spec §6.1 */
    readonly corpseId: string;
    readonly corpse: Evidence;
  }

  const usageBornThenAttested = async (): Promise<AttestedAfterUsage> => {
    for (const n of [1, 2]) await nameInEpisode(AUTH, n);
    const referentId = referentOf(AUTH);
    const corpseId = standingClaimId(referentId);
    const corpse = requiredPosteriorOf(referentId);

    await attest(AUTH, NOUN_SOURCE, 3);

    return { referentId, corpseId, corpse };
  };

  it('leaves a corpse with a real posterior for the withdrawal to find', async () => {
    const { corpseId, corpse } = await usageBornThenAttested();

    expect(store.getClaim(corpseId)?.status).toBe('deprecated');
    expect(corpse.alpha).toBeGreaterThan(priorFor(OBSERVED).alpha);
  });

  it('is seeded from that posterior, not from the §15 prior', async () => {
    const { referentId, corpse } = await usageBornThenAttested();

    await retract(AUTH, NOUN_SOURCE, 4);

    expect(posteriorOf(referentId)).toStrictEqual(corpse);
  });

  it('says where it read that posterior, with §6.2\'s lineage edge to the corpse', async () => {
    const { referentId, corpseId } = await usageBornThenAttested();

    await retract(AUTH, NOUN_SOURCE, 4);

    expect(lineageOf(standingClaimId(referentId))).toStrictEqual([corpseId]);
  });

  /**
   * The seed and nothing on top of it. A mint's first-observation boost is a vote
   * for the referent's existence, and the only message paying for one here is a
   * message asserting its absence.
   */
  it('is born at exactly its seed, because a withdrawal is not a vote', async () => {
    const { referentId, corpse } = await usageBornThenAttested();

    await retract(AUTH, NOUN_SOURCE, 4);

    const successor = requiredPosteriorOf(referentId);
    expect(successor.alpha).toBe(corpse.alpha);
    expect(successor.alpha).not.toBe(corpse.alpha + FIRST_OBSERVATION);
  });

  it('reads the corpse without resurrecting it into the live set', async () => {
    const { referentId, corpseId } = await usageBornThenAttested();

    await retract(AUTH, NOUN_SOURCE, 4);

    expect(lineageOf(standingClaimId(referentId))).toStrictEqual([corpseId]);
    expect(store.getClaim(corpseId)?.status).toBe('deprecated');
    expect(liveExistenceClaimIds(referentId)).toStrictEqual([standingClaimId(referentId)]);
  });

  /**
   * A referent that has fallen, been attested again, and fallen again, so the
   * ledger holds two corpses: the belief the first attestation retired, and the
   * successor the first withdrawal wrote — corroborated once more before the
   * second attestation retired it in turn.
   *
   * @spec §3.5, §6.1, §6.2
   */
  interface FallenTwice {
    readonly referentId: string;
    readonly firstCorpseId: string;
    /** The belief the first attestation retired. @spec §6.1 */
    readonly firstCorpse: Evidence;
    readonly secondCorpseId: string;
    /** The successor the first withdrawal wrote, as the second attestation retired it. @spec §6.2 */
    readonly secondCorpse: Evidence;
  }

  const fallenTwice = async (): Promise<FallenTwice> => {
    const {
      referentId,
      corpseId: firstCorpseId,
      corpse: firstCorpse,
    } = await usageBornThenAttested();
    await retract(AUTH, NOUN_SOURCE, 4);
    await nameInEpisode(AUTH, 5);
    const secondCorpseId = standingClaimId(referentId);
    const secondCorpse = requiredPosteriorOf(referentId);
    await attest(AUTH, NOUN_SOURCE, 6);

    return { referentId, firstCorpseId, firstCorpse, secondCorpseId, secondCorpse };
  };

  /**
   * Only the newest corpse read all the ones before it — each succeeded the last
   * and was seeded from it. Reaching past it for an older row would throw away
   * every observation made between the two falls.
   */
  it('reads the newest corpse, not the first belief the referent ever held', async () => {
    const { referentId, firstCorpse, secondCorpseId, secondCorpse } = await fallenTwice();

    await retract(AUTH, NOUN_SOURCE, 7);

    expect(secondCorpse.alpha).toBeGreaterThan(firstCorpse.alpha);
    expect(posteriorOf(referentId)).toStrictEqual(secondCorpse);
    expect(lineageOf(standingClaimId(referentId))).toStrictEqual([secondCorpseId]);
  });

  /** Reading a posterior is not restoring the row it was read from. @spec §6.1, §6.2 */
  it('leaves every corpse deprecated and one live claim standing behind the referent', async () => {
    const { referentId, firstCorpseId, secondCorpseId } = await fallenTwice();

    await retract(AUTH, NOUN_SOURCE, 7);

    expect(store.getClaim(firstCorpseId)?.status).toBe('deprecated');
    expect(store.getClaim(secondCorpseId)?.status).toBe('deprecated');
    expect(liveExistenceClaimIds(referentId)).toStrictEqual([standingClaimId(referentId)]);
  });

  /**
   * The other half of the rule. A referent the graph only ever knew as an
   * attestation has no earlier belief behind it, so there is nothing to read and
   * §15's prior is where its existence honestly starts — provisional, because
   * nothing has corroborated it since it stopped being re-derived.
   */
  it('starts at the bare §15 prior when the referent was never anything but attested', async () => {
    await attest(AUTH, NOUN_SOURCE, 1);
    const referentId = referentOf(AUTH);

    await retract(AUTH, NOUN_SOURCE, 2);

    expect(posteriorOf(referentId)).toStrictEqual(priorFor(OBSERVED));
    expect(statusOf(referentId)).toBe('provisional');
    expect(lineageOf(standingClaimId(referentId))).toStrictEqual([]);
  });
});

/**
 * §3.1 calls the locator opaque — *"never parsed, never queried, never turned
 * into a hierarchy"* — so the only thing a withdrawal can do with one is compare
 * it. These pin what that comparison treats as the same place, whatever shape a
 * source chose to describe a place in.
 *
 * @spec §3.1
 */
describe('the shapes a withdrawal may name a declaration by', () => {
  const SHAPES: readonly (readonly [string, unknown])[] = [
    ['a bare string', 'src/auth/index.ts'],
    ['a number', 412],
    ['null', null],
    ['a nested object', LOCATOR],
  ];

  for (const [description, locator] of SHAPES)
    it(`reaches the declaration a source made at ${description}`, async () => {
      await attest(AUTH, NOUN_SOURCE, 1, locator);
      const referentId = referentOf(AUTH);

      await ingest.submit(preciseRetraction(AUTH, locator, 2));

      expect(liveLocators(referentId)).toStrictEqual([]);
      expect(regimeOf(referentId)).toBe('evidence');
    });

  it('leaves a declaration standing when the shape named is not the shape declared', async () => {
    await attest(AUTH, NOUN_SOURCE, 1, 'src/auth/index.ts');
    const referentId = referentOf(AUTH);

    await ingest.submit(preciseRetraction(AUTH, LOCATOR, 2));

    expect(liveLocators(referentId)).toStrictEqual(['src/auth/index.ts']);
    expect(regimeOf(referentId)).toBe('view');
  });
});

/**
 * Two objects with the same fields in a different order.
 *
 * They are two declarations everywhere else in this system already: §3.1's
 * content-addressed id hashes `JSON.stringify` of `[source, form, level,
 * locator]`, and `JSON.stringify` is insertion-ordered, so one source attesting
 * one form at both spellings lands on two ids and leaves two declarations
 * standing. A withdrawal that reached across the two spellings would be reaching
 * across the store's own idea of which declaration it is holding.
 *
 * So the emitter contract is a stable serialization, not a stable set of fields,
 * and it was that before a withdrawal could name a locator at all.
 *
 * @spec §3.1, §3.5
 */
describe('a locator whose keys are named back in another order', () => {
  const FORWARD = { path: 'src/auth/index.ts', line: 1 };
  const REVERSED = { line: 1, path: 'src/auth/index.ts' };

  it('is already a second declaration when a source attests both spellings', async () => {
    await attest(AUTH, NOUN_SOURCE, 1, FORWARD);
    await attest(AUTH, NOUN_SOURCE, 2, REVERSED);
    const referentId = referentOf(AUTH);

    expect(ingest.referents.all()).toHaveLength(1);
    expect(liveLocators(referentId).map((locator) => JSON.stringify(locator))).toStrictEqual([
      JSON.stringify(FORWARD),
      JSON.stringify(REVERSED),
    ]);
  });

  it('keeps the order the source declared, so the source can name it back', async () => {
    await attest(AUTH, NOUN_SOURCE, 1, FORWARD);

    expect(liveLocators(referentOf(AUTH)).map((locator) => JSON.stringify(locator))).toStrictEqual([
      JSON.stringify(FORWARD),
    ]);
  });

  it('does not reach the declaration made under the other spelling', async () => {
    await attest(AUTH, NOUN_SOURCE, 1, FORWARD);
    const referentId = referentOf(AUTH);

    await ingest.submit(preciseRetraction(AUTH, REVERSED, 2));

    expect(liveLocators(referentId)).toStrictEqual([FORWARD]);
    expect(regimeOf(referentId)).toBe('view');
  });
});

/**
 * The presence of the key is the discriminant, so a source that says nothing
 * about locators and a source that says "the one made at no locator" are asking
 * for different things and get different answers.
 *
 * @spec §3.1
 */
describe('a withdrawal that omits the locator and one that names an absent one', () => {
  /** A declaration a source made without naming a place. @spec §3.1 */
  const attestWithoutLocator = async (surfaceForm: string, n: number): Promise<void> => {
    await ingest.submit(
      attestationMessage(surfaceForm, {
        source: NOUN_SOURCE,
        origin: emitterOrigin(n),
        locator: undefined,
      }),
    );
  };

  it('reads an omitted key as the coarse address and reaches a placed declaration', async () => {
    await attest(AUTH, NOUN_SOURCE, 1, LOCATOR);
    const referentId = referentOf(AUTH);

    await retract(AUTH, NOUN_SOURCE, 2);

    expect(liveLocators(referentId)).toStrictEqual([]);
    expect(regimeOf(referentId)).toBe('evidence');
  });

  it('reads a named undefined as the narrow address and leaves a placed declaration', async () => {
    await attest(AUTH, NOUN_SOURCE, 1, LOCATOR);
    const referentId = referentOf(AUTH);

    await ingest.submit(preciseRetraction(AUTH, undefined, 2));

    expect(liveLocators(referentId)).toStrictEqual([LOCATOR]);
    expect(regimeOf(referentId)).toBe('view');
  });

  it('reaches the placeless declaration that named undefined does address', async () => {
    await attestWithoutLocator(AUTH, 1);
    const referentId = referentOf(AUTH);

    await ingest.submit(preciseRetraction(AUTH, undefined, 2));

    expect(liveAttestations(referentId)).toStrictEqual([]);
    expect(regimeOf(referentId)).toBe('evidence');
  });

  it('leaves the placeless declaration standing when a place is named instead', async () => {
    await attestWithoutLocator(AUTH, 1);
    const referentId = referentOf(AUTH);

    await ingest.submit(preciseRetraction(AUTH, LOCATOR, 2));

    expect(liveAttestations(referentId)).toHaveLength(1);
    expect(regimeOf(referentId)).toBe('view');
  });
});

/**
 * Two withdrawals a source makes in one episode, differing only by the
 * declaration each one names.
 *
 * §5.1 hashes a message to a canonical rendering of itself so that stage 0 can
 * tell a replay from a second observation. A retraction's address is `(source,
 * surfaceForm)` and, when it carries one, a locator — so the rendering has to
 * carry the locator too, and has to say the same thing about it that
 * {@link withdraws} does: the key's *presence* is the discriminant, not its
 * value. Two withdrawals that differ only in the declaration they name are two
 * observations, and a coarse withdrawal is not the narrow one addressed to
 * `null`.
 *
 * @spec §5.1
 */
describe('two withdrawals a source makes in one episode', () => {
  const ALSO_AT = {
    path: 'src/auth/legacy-gateway.ts',
    symbolRange: [17, 96],
    vcs: { rev: '4b7e0d3', dirty: true, tag: 'v0.9' },
  } as const;

  const bothDeclared = async (): Promise<string> => {
    await attest(AUTH, NOUN_SOURCE, 1, LOCATOR);
    await attest(AUTH, NOUN_SOURCE, 2, ALSO_AT);
    return referentOf(AUTH);
  };

  it('retires both declarations, because stage 0 gates evidence and not the ledger', async () => {
    const referentId = await bothDeclared();

    await ingest.submit(preciseRetraction(AUTH, LOCATOR, 3));
    await ingest.submit(preciseRetraction(AUTH, ALSO_AT, 3));

    expect(liveLocators(referentId)).toStrictEqual([]);
    expect(regimeOf(referentId)).toBe('evidence');
  });

  it('does not report the second as a replay of the first', async () => {
    await bothDeclared();

    const first = await ingest.submit(preciseRetraction(AUTH, LOCATOR, 3));
    const second = await ingest.submit(preciseRetraction(AUTH, ALSO_AT, 3));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
  });

  it('does not log the second as a replay for §13 to read back', async () => {
    await bothDeclared();

    await ingest.submit(preciseRetraction(AUTH, LOCATOR, 3));
    await ingest.submit(preciseRetraction(AUTH, ALSO_AT, 3));

    expect(loggedReplayVerdicts(emitterOrigin(3).episodeId)).toStrictEqual([false, false]);
  });

  it('still reports a true replay of the same withdrawal as one', async () => {
    await bothDeclared();

    await ingest.submit(preciseRetraction(AUTH, LOCATOR, 3));
    const replay = await ingest.submit(preciseRetraction(AUTH, LOCATOR, 3));

    expect(replay.duplicate).toBe(true);
  });

  /**
   * The narrower collision underneath the first one. "Everything this source
   * declared under this form" and "the one declaration it made at no place" are
   * two different withdrawals, and a rendering that filled the missing locator in
   * with `null` would spell them the same way — so the coarse address has to be
   * shorter than the narrow one, not a narrow one aimed at `null`.
   *
   * @spec §3.1, §5.1
   */
  const placedAndPlaceless = async (): Promise<string> => {
    await attest(AUTH, NOUN_SOURCE, 1, LOCATOR);
    await attest(AUTH, NOUN_SOURCE, 2, null);
    return referentOf(AUTH);
  };

  it('does not read the coarse withdrawal as a replay of one addressed to no place', async () => {
    const referentId = await placedAndPlaceless();

    const placeless = await ingest.submit(preciseRetraction(AUTH, null, 3));
    const everything = await ingest.submit(
      retractionMessage(AUTH, { source: NOUN_SOURCE, origin: emitterOrigin(3) }),
    );

    expect([placeless.duplicate, everything.duplicate]).toStrictEqual([false, false]);
    expect(liveLocators(referentId)).toStrictEqual([]);
    expect(regimeOf(referentId)).toBe('evidence');
  });

  it('does not log the coarse withdrawal as a replay of one addressed to no place', async () => {
    await placedAndPlaceless();

    await ingest.submit(preciseRetraction(AUTH, null, 3));
    await ingest.submit(retractionMessage(AUTH, { source: NOUN_SOURCE, origin: emitterOrigin(3) }));

    expect(loggedReplayVerdicts(emitterOrigin(3).episodeId)).toStrictEqual([false, false]);
  });
});
