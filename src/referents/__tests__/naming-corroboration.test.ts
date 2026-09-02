/**
 * Naming corroboration: a naming is a claim, and its support is ordinary
 * evidence.
 *
 * §3.1 already calls the mention index *"the many-to-one mention index (surface
 * form → referent) materializing identity claims over names"*, and makes
 * `entities.name` *"the most-corroborated surface form, a view over its mention
 * cluster"*. F2 reads both sentences literally. Two things follow, and this file
 * is about both.
 *
 * **A naming leaves a claim behind, whatever rung answered.** Today a naming
 * claim is minted only when §5.2's gloss or tiebreak rungs resolve — the two
 * rungs that meet a form the mention index has never held. Every other use of a
 * form leaves nothing in the ledger at all: the count lives in the mention
 * index, a projection, and diagram §4 says every projection is *"rebuildable
 * from the ledger"*. A number that exists nowhere but the view it is supposed to
 * be derived from is not derivable, and `rebuild-index` cannot reproduce it.
 *
 * **That support is weighed like any other evidence.** §4.4: *"an agent saying
 * something three times in one session is one observation, not three"*. A
 * naming is an observation about what a referent is called, so §4.2's episode
 * cap, §4.4's independence discount and §5.1's replay-zero all apply to it
 * unchanged. Without that, twelve repetitions inside one episode outrank four
 * namings from four — the derived name becomes a transcript statistic, decided
 * by whoever typed the most, and §4.2 and §4.4 exist precisely to prevent that
 * inversion.
 *
 * The claim id is a content hash of `(referent, surface form)`, so reuse is a
 * lookup rather than a search: no `ABOUT` edge is needed to find the row again,
 * and §5.3's structural retrieval channel stays what it says it is — *"every
 * claim already attached via `ABOUT` to the same entities"* as candidate
 * knowledge *about* a referent, which is not the same thing as knowledge about
 * what a referent is called.
 *
 * The store is never faked here: real SQLite at `:memory:`, real vectors at the
 * real width. Only the two ports §5 calls model calls — the embedding provider
 * and the coreference adjudicator — are stood in for, over the declared
 * semantic space in `./fixtures`.
 *
 * @spec §3.1, §4.2, §4.4, §5.1, §5.2, §5.3, §11
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import { observationWeight, priorFor } from '../../ingest/evidence';
import { openGraphStore, type GraphStore } from '../../store/index';
import { contentAddressedId } from '../ids';
import { scanClaimIds } from '../index-view';
import { decodeSpineClaim } from '../spine';

import {
  agentOrigin,
  attestationMessage,
  claimMessage,
  emitterOrigin,
  fakeAdjudicator,
  fakeEmbeddings,
  picks,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from './fixtures';

/**
 * The id one naming always gets, in any database, in any process.
 *
 * `naming-claim` separates the namespace from the referent and the existence
 * claim that share the digest input, exactly as {@link contentAddressedId}'s
 * `domain` already does for those two — giving a naming the referent's id would
 * make a claim its own anchor by accident.
 *
 * @spec §3.1, §3.5
 */
const namingClaimId = (referentId: string, surfaceForm: string): string =>
  contentAddressedId('naming-claim', [referentId, surfaceForm]);

/** The tier every fixture here writes at, so §15's weight is a round 1.0. @spec §4.2, §15 */
const TIER = 'observed';

/** §15's prior α, the support a naming claim starts from before anyone says anything. @spec §15 */
const PRIOR_ALPHA = priorFor(TIER).alpha;

/** What one uncapped, untainted naming is worth. @spec §4.2, §15 */
const FIRST_OBSERVATION = observationWeight(TIER, 0, false);

/** The α a freshly minted naming claim carries: §15's prior plus the naming that minted it. @spec §4.2, §15 */
const MINTED_SUPPORT = PRIOR_ALPHA + FIRST_OBSERVATION;

/**
 * How many times one episode repeats a single form.
 *
 * Larger than {@link INDEPENDENT_EPISODES} by enough that a raw count and an
 * episode-capped one cannot agree: §4.2's 1, ½, ¼, … series sums to under two
 * however long the session runs, so twelve repetitions inside one episode are
 * worth less than four namings in four.
 *
 * @spec §4.2, §4.4
 */
const REPEATS_IN_ONE_EPISODE = 12;

/** How many separate episodes name the rival form. One naming each. @spec §4.4 */
const INDEPENDENT_EPISODES = [3, 4, 5, 6] as const;

/**
 * What `repeats` namings inside one episode are worth, stated as §4.2 states it
 * rather than as the number it comes to.
 *
 * The naming that *minted* the claim is the episode's first contribution, at
 * `episodeCap(0)` — the same convention {@link contributionsFromEpisode}
 * already applies to existence claims, where *"minting is the episode saying
 * the referent exists"*. So the claim's own provenance row counts, and the
 * first repeat after it is capped at ½ rather than at 1. The sibling case below
 * — support never reaching two observations' worth — is what forces that
 * reading: counting only the repeats would put twelve namings at just over
 * three, and no cap that lets one session buy three observations is §4.2's.
 *
 * The series is exact in f64: every term is a power of two, so every partial
 * sum is representable and no tolerance is needed to compare it.
 *
 * @spec §4.2, §4.4
 */
const cappedSupport = (repeats: number): number => {
  let support = PRIOR_ALPHA;
  for (let repeat = 0; repeat < repeats; repeat += 1)
    support += observationWeight(TIER, repeat, false);
  return support;
};

/** What the same number of namings is worth spread across that many episodes. @spec §4.4 */
const independentSupport = (namings: number): number => PRIOR_ALPHA + namings * FIRST_OBSERVATION;

let store: GraphStore;
let embeddings: FakeEmbeddings;
let adjudicator: FakeAdjudicator;
let ingest: IngestPort;
const opened: GraphStore[] = [];

/**
 * A second graph, grown by a port that has never met the first one.
 *
 * Content-addressed ids are a claim about *every* database, not about this one,
 * so the cases that test them need two.
 *
 * @spec §3.1, §3.5
 */
const openPort = (): { graph: GraphStore; port: IngestPort } => {
  const graph = openGraphStore({ path: ':memory:' });
  opened.push(graph);
  return { graph, port: openIngest({ store: graph, embeddings, adjudicator }) };
};

beforeEach(() => {
  embeddings = fakeEmbeddings();
  adjudicator = fakeAdjudicator();
  const first = openPort();
  store = first.graph;
  ingest = first.port;
});

afterEach(() => {
  for (const graph of opened) graph.close();
  opened.length = 0;
});

/** The referent a form names, or a failure loud enough to read. */
const referentNamed = (graph: GraphStore, surfaceForm: string): string => {
  const referentId = graph.resolveMention(surfaceForm);
  if (referentId === undefined) throw new Error(`nothing is named ${surfaceForm}`);
  return referentId;
};

/**
 * The support standing behind one naming, read off the ledger.
 *
 * The ledger and not the mention index on purpose: the index is the cache, and
 * a test that read the cache could not tell a derivable number from one that
 * only the projection knows.
 *
 * @spec §3.1, §4.1
 */
const namingSupport = (graph: GraphStore, referentId: string, surfaceForm: string): number => {
  const claimId = namingClaimId(referentId, surfaceForm);
  const evidence = graph.getEvidence(claimId);
  if (evidence === undefined)
    throw new Error(`the ledger holds no naming claim for ${surfaceForm} on ${referentId}`);
  if (evidence === null)
    throw new Error(`the naming claim for ${surfaceForm} carries no posterior to read`);
  return evidence.alpha;
};

/** Every naming in the ledger, as the pair it records. @spec §3.1, §3.5 */
const namingsInLedger = (graph: GraphStore): string[] =>
  scanClaimIds(graph).flatMap((claimId) => {
    const claim = graph.getClaim(claimId);
    if (claim === undefined) return [];
    const payload = decodeSpineClaim(claim.text);
    return payload?.claim === 'naming' ? [`${payload.referent} is named ${payload.surfaceForm}`] : [];
  });

/** How many separate claims the ledger holds for one pair. @spec §3.1 */
const namingClaimCount = (graph: GraphStore, referentId: string, surfaceForm: string): number =>
  namingsInLedger(graph).filter((entry) => entry === `${referentId} is named ${surfaceForm}`).length;

/** The three surface forms plane 0 of the declared semantic space holds. @spec §3.1 */
const AUTH_FORMS = ['AuthService', 'auth-service', 'the auth thing'] as const;

/**
 * The forms, ordered the way the ledger says they should be.
 *
 * Computed from the naming claims rather than written down, so the ranking a
 * test asserts is the one §3.1 defines — *"a view over its mention cluster"* —
 * and not a list that happens to agree with it for this fixture.
 *
 * @spec §3.1
 */
const rankedBySupport = (
  graph: GraphStore,
  referentId: string,
  forms: readonly string[],
): string[] =>
  [...forms].sort(
    (left, right) =>
      namingSupport(graph, referentId, right) - namingSupport(graph, referentId, left),
  );

/** Drops one graph's projections and regenerates them through a port that never watched it grow. @spec §11 */
const rebuiltFrom = async (graph: GraphStore): Promise<IngestPort> => {
  graph.clearViews();
  const rebuilt = openIngest({ store: graph, embeddings, adjudicator });
  await rebuilt.rebuildIndex();
  return rebuilt;
};

/** The same, for the graph every single-store case in this file grows. @spec §11 */
const rebuiltFromLedger = (): Promise<IngestPort> => rebuiltFrom(store);

/**
 * How many times a case that depends on a fresh ULID grows its graph again.
 *
 * A tiebreak read off a content hash of a random referent id is a coin: two
 * forms, two digests, and no reason for either to come out smaller. One pass
 * over such a rule therefore proves nothing — it passes half the time — so the
 * cases below run the whole fixture this many times and assert on the tally.
 * Sixteen independent coins all landing the same way is a one-in-65,536 run,
 * which is the point at which a green here means the rule and not the luck.
 * Sixteen is also cheap: one graph is five messages against `:memory:`, so the
 * whole loop costs well under a second even where a rebuild is on top of it.
 *
 * @spec §3.1, §3.5
 */
const TRIALS = 16;

/**
 * How often each outcome came up across the trials.
 *
 * Asserted whole rather than trial by trial, so a failure reports the *rate* —
 * `{ 'auth-service': 9, 'the auth thing': 7 }` says "this rule is a coin" in a
 * way that sixteen separate red assertions do not.
 */
const tallyOf = (outcomes: readonly string[]): Readonly<Record<string, number>> =>
  outcomes.reduce<Readonly<Record<string, number>>>(
    (counts, outcome) => ({ ...counts, [outcome]: (counts[outcome] ?? 0) + 1 }),
    {},
  );

/** The name one port derives for the referent `AuthService` names, or a failure loud enough to read. */
const derivedName = (built: { readonly graph: GraphStore; readonly port: IngestPort }): string => {
  const referentId = referentNamed(built.graph, 'AuthService');
  const name = built.port.referents.get(referentId)?.name;
  if (name === undefined) throw new Error(`the index derives no name for ${referentId}`);
  return name;
};

/*
 * ---------------------------------------------------------------------------
 * The fixtures.
 * ---------------------------------------------------------------------------
 */

/** A referent minted from usage, under a form nothing else in the space is near. @spec §5.2 */
const growUsageMint = async (port: IngestPort): Promise<void> => {
  await port.submit(
    claimMessage('The practice survives its own justification.', ['practice'], {
      origin: agentOrigin(1),
    }),
  );
};

/** One referent, then a second form for it that only the gloss rung could have placed. @spec §5.2 */
const growTwoForms = async (port: IngestPort): Promise<void> => {
  await port.submit(
    claimMessage('Chapter Three argues that the regress terminates.', ['Chapter Three'], {
      origin: agentOrigin(1),
    }),
  );
  await port.submit(
    claimMessage('The third chapter was cited again.', ['the third chapter'], {
      origin: agentOrigin(2),
    }),
  );
};

/**
 * One form, repeated {@link REPEATS_IN_ONE_EPISODE} times inside a single
 * episode, with distinct texts so stage 0 admits every one of them.
 *
 * Every repeat is a real observation the pipeline accepted and a real claim in
 * the ledger. What §4.2 denies it is a second observation's worth of weight.
 *
 * @spec §4.2, §4.4, §5.1
 */
const growCappedRepeats = async (port: IngestPort): Promise<void> => {
  await port.submit(
    claimMessage('AuthService owns the rotation window.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  for (let repeat = 0; repeat < REPEATS_IN_ONE_EPISODE; repeat += 1)
    await port.submit(
      claimMessage(`Note ${repeat}: auth-service came up again.`, ['auth-service'], {
        origin: agentOrigin(2),
      }),
    );
};

/** The same referent, named once in each of four separate episodes. @spec §4.4 */
const growIndependentNamings = async (port: IngestPort): Promise<void> => {
  await port.submit(
    claimMessage('AuthService owns the rotation window.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  for (const n of INDEPENDENT_EPISODES)
    await port.submit(
      claimMessage(`The auth thing surfaced in episode ${n}.`, ['the auth thing'], {
        origin: agentOrigin(n),
      }),
    );
};

/** Both at once: one form insisted on, one form corroborated. @spec §4.2, §4.4 */
const growMixedNaming = async (port: IngestPort): Promise<void> => {
  await growCappedRepeats(port);
  for (const n of INDEPENDENT_EPISODES)
    await port.submit(
      claimMessage(`The auth thing surfaced in episode ${n}.`, ['the auth thing'], {
        origin: agentOrigin(n),
      }),
    );
};

/** Three forms on one referent, corroborated once, twice and three times over. @spec §3.1 */
const growRankedForms = async (port: IngestPort): Promise<void> => {
  await port.submit(
    claimMessage('AuthService owns the rotation window.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  for (const n of [2, 3])
    await port.submit(
      claimMessage(`Note from episode ${n}: auth-service again.`, ['auth-service'], {
        origin: agentOrigin(n),
      }),
    );
  for (const n of [4, 5, 6])
    await port.submit(
      claimMessage(`The auth thing surfaced in episode ${n}.`, ['the auth thing'], {
        origin: agentOrigin(n),
      }),
    );
};

/**
 * The two forms {@link growTiedNaming} corroborates identically.
 *
 * Declared in the order the graph *names* them, which is deliberately the
 * reverse of the order their claim ids sort in — see {@link growTiedNaming}.
 *
 * @spec §3.1
 */
const TIED_FORMS = ['the auth thing', 'auth-service'] as const;

/**
 * The form a tiebreak that compares the forms themselves has to choose: the
 * smaller of {@link TIED_FORMS} as a string, and nothing about any database.
 *
 * Written out rather than sorted at the assertion, so a case can say which form
 * wins instead of saying that both stores agreed on something.
 *
 * @spec §3.1
 */
const SMALLER_FORM = 'auth-service';

/**
 * The two namings that put {@link TIED_FORMS} level, whichever way the referent
 * they hang off came into being.
 *
 * Two episodes each, so both forms carry §15's prior plus two full-weight
 * observations and the equality is exact rather than approximate. `the auth
 * thing` goes first, so {@link SMALLER_FORM} arrives *second* and a tiebreak
 * that quietly kept arrival order cannot pass by agreeing with this one.
 *
 * @spec §3.1, §4.4
 */
const corroborateTiedForms = async (port: IngestPort): Promise<void> => {
  for (const n of [2, 3])
    await port.submit(
      claimMessage(`The auth thing surfaced in episode ${n}.`, ['the auth thing'], {
        origin: agentOrigin(n),
      }),
    );
  for (const n of [4, 5])
    await port.submit(
      claimMessage(`Note from episode ${n}: auth-service again.`, ['auth-service'], {
        origin: agentOrigin(n),
      }),
    );
};

/**
 * One attested referent whose two aliases end up with identical support, and
 * whose winner a first-naming tiebreak and a smallest-id tiebreak disagree
 * about.
 *
 * The referent is attested rather than usage-born so its id is a content hash
 * (§3.1) and therefore the same in every database — which makes the two naming
 * claim ids the same in every database too, and the tiebreak's answer a fact
 * about the rule rather than about this run. `the auth thing` is named first
 * and `auth-service` holds the smaller id, so a tiebreak that quietly kept
 * first-naming order answers differently from one that reads the ids.
 *
 * The attestation is written at `observed` tier rather than the message
 * default so every naming in this file is weighed at the same §15 weight and
 * the arithmetic stays legible.
 *
 * @spec §3.1, §3.5
 */
const growTiedNaming = async (port: IngestPort): Promise<void> => {
  await port.submit(
    attestationMessage('AuthService', { tier: TIER, origin: emitterOrigin(1) }),
  );
  await corroborateTiedForms(port);
};

/**
 * The same tie, on a referent nothing attested.
 *
 * §3.1 makes this the baseline and not the exotic case — *"a domain with no noun
 * source runs pure usage-emergence"* — and it is the case the content-hash
 * argument for a naming-claim-id tiebreak does not cover. A usage-born referent
 * is minted at a fresh ULID (§3.5), so `namingClaimId(referentId, form)` hashes
 * a different input in every database, and a tiebreak that reads those ids
 * answers a different way in each of them. The forms are the same two strings
 * everywhere, so a tiebreak that reads *them* does not.
 *
 * @spec §3.1, §3.5, §5.2
 */
const growUsageBornTie = async (port: IngestPort): Promise<void> => {
  await port.submit(
    claimMessage('AuthService owns the rotation window.', ['AuthService'], {
      origin: agentOrigin(1),
    }),
  );
  await corroborateTiedForms(port);
};

/**
 * Two forms that UTF-16 code-unit order and collation order rank differently.
 *
 * Declared in the order the graph *names* them. `auth-service` is named first
 * and heads the tally; `AuthService` is named second and is the smaller of the
 * two as code units, because `A` is U+0041 and `a` is U+0061.
 *
 * A collator answers the other way round. ICU gives `-` a lower primary weight
 * than a letter, so `auth-service` sorts before `AuthService` at the primary
 * level and case is never reached — which is why the disagreement holds under
 * every locale and every `caseFirst` setting rather than being a quirk of one.
 *
 * That is what this pair is for. {@link TIED_FORMS} cannot do this job: `t`
 * follows `a` under code units and under every collator alike, so a tie between
 * `auth-service` and `the auth thing` is answered identically by both rules and
 * says nothing about which one is in force.
 *
 * @spec §3.1
 */
const COLLATION_SPLIT_FORMS = ['auth-service', 'AuthService'] as const;

/** The smaller of {@link COLLATION_SPLIT_FORMS} as UTF-16 code units. @spec §3.1 */
const CODE_UNIT_SMALLER = 'AuthService';

/**
 * {@link COLLATION_SPLIT_FORMS}, driven to an exact tie on a usage-born referent.
 *
 * Two episodes each: `auth-service` mints the referent and is corroborated once,
 * then `AuthService` is named in two more. Both forms land on §15's prior plus
 * two full-weight observations, so the equality is exact in f64 rather than
 * approximate, exactly as {@link corroborateTiedForms} arranges for the other
 * tie in this file.
 *
 * @spec §3.1, §4.4, §5.2
 */
const growCollationSplitTie = async (port: IngestPort): Promise<void> => {
  await port.submit(
    claimMessage('The auth-service window is fifteen minutes.', ['auth-service'], {
      origin: agentOrigin(1),
    }),
  );
  await port.submit(
    claimMessage('The auth-service pool is drained nightly.', ['auth-service'], {
      origin: agentOrigin(2),
    }),
  );
  await port.submit(
    claimMessage('AuthService owns the rotation window.', ['AuthService'], {
      origin: agentOrigin(3),
    }),
  );
  await port.submit(
    claimMessage('AuthService rotates its signing key nightly.', ['AuthService'], {
      origin: agentOrigin(4),
    }),
  );
};

/*
 * ---------------------------------------------------------------------------
 * The id a naming gets.
 * ---------------------------------------------------------------------------
 */

describe('the id one naming claim is written at', () => {
  it('is the content hash of the referent and the surface form', async () => {
    await growUsageMint(ingest);
    const referentId = referentNamed(store, 'practice');

    expect(store.getClaim(namingClaimId(referentId, 'practice'))).toBeDefined();
  });

  it('is the same id in a database it has never met', async () => {
    const second = openPort();
    await growTiedNaming(ingest);
    await growTiedNaming(second.port);

    const here = referentNamed(store, 'AuthService');
    const there = referentNamed(second.graph, 'AuthService');
    expect(there).toBe(here);
    expect(second.graph.getClaim(namingClaimId(there, 'auth-service'))).toBeDefined();
    expect(store.getClaim(namingClaimId(here, 'auth-service'))).toBeDefined();
  });

  it('gives two forms on one referent two separate claims', async () => {
    await growTwoForms(ingest);
    const referentId = referentNamed(store, 'Chapter Three');

    const minting = namingClaimId(referentId, 'Chapter Three');
    const alias = namingClaimId(referentId, 'the third chapter');
    expect(minting).not.toBe(alias);
    expect(store.getClaim(minting)).toBeDefined();
    expect(store.getClaim(alias)).toBeDefined();
  });

  it('carries a posterior, because corroborating a name is ordinary evidence', async () => {
    await growUsageMint(ingest);
    const referentId = referentNamed(store, 'practice');

    expect(store.getClaim(namingClaimId(referentId, 'practice'))?.regime).toBe('evidence');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The form that minted the referent.
 * ---------------------------------------------------------------------------
 */

describe('the form a referent was minted under', () => {
  it('carries a naming claim of its own, not only the forms added later', async () => {
    await growTwoForms(ingest);
    const referentId = referentNamed(store, 'Chapter Three');

    expect(store.getClaim(namingClaimId(referentId, 'Chapter Three'))).toBeDefined();
  });

  it('starts at §15 prior plus the naming that minted it', async () => {
    await growUsageMint(ingest);
    const referentId = referentNamed(store, 'practice');

    expect(namingSupport(store, referentId, 'practice')).toBe(MINTED_SUPPORT);
  });

  it('gets one for an attested referent too, whose existence claim carries no posterior at all', async () => {
    await ingest.submit(attestationMessage('AuthService', { tier: TIER, origin: emitterOrigin(1) }));
    const referentId = referentNamed(store, 'AuthService');

    expect(namingSupport(store, referentId, 'AuthService')).toBe(MINTED_SUPPORT);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Reuse corroborates rather than duplicating.
 * ---------------------------------------------------------------------------
 */

describe('using a form the graph already knows', () => {
  it('adds an observation to the naming claim already there', async () => {
    await growTwoForms(ingest);
    const referentId = referentNamed(store, 'Chapter Three');
    const before = namingSupport(store, referentId, 'the third chapter');

    await ingest.submit(
      claimMessage('The third chapter is cited once more.', ['the third chapter'], {
        origin: agentOrigin(3),
      }),
    );

    expect(namingSupport(store, referentId, 'the third chapter')).toBe(before + FIRST_OBSERVATION);
  });

  it('keeps exactly one claim for the pair however often the form is used', async () => {
    await growIndependentNamings(ingest);
    const referentId = referentNamed(store, 'AuthService');

    // The minting form is the case that matters: every one of its uses answers
    // at a rung that writes nothing today, so a ledger with no claim for it is
    // the failure this file exists for, and a ledger with four is the other one.
    expect(namingClaimCount(store, referentId, 'AuthService')).toBe(1);
    expect(namingClaimCount(store, referentId, 'the auth thing')).toBe(1);
  });

  it('leaves one claim per form and no more, across a whole mixed graph', async () => {
    await growMixedNaming(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(namingsInLedger(store).sort()).toStrictEqual(
      [
        `${referentId} is named AuthService`,
        `${referentId} is named auth-service`,
        `${referentId} is named the auth thing`,
      ].sort(),
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * §4.2's cap, applied to naming.
 * ---------------------------------------------------------------------------
 */

describe('naming the same form again inside one episode', () => {
  it('pays a halving weight for each repeat, exactly as §4.2 says', async () => {
    await growCappedRepeats(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(namingSupport(store, referentId, 'auth-service')).toBe(
      cappedSupport(REPEATS_IN_ONE_EPISODE),
    );
  });

  it('never reaches two observations however long the session runs', async () => {
    await growCappedRepeats(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(namingSupport(store, referentId, 'auth-service') - PRIOR_ALPHA).toBeLessThan(
      2 * FIRST_OBSERVATION,
    );
  });

  it('stays below what a quarter as many namings from separate episodes are worth', async () => {
    const second = openPort();
    await growCappedRepeats(ingest);
    await growIndependentNamings(second.port);

    const insisted = namingSupport(store, referentNamed(store, 'AuthService'), 'auth-service');
    const corroborated = namingSupport(
      second.graph,
      referentNamed(second.graph, 'AuthService'),
      'the auth thing',
    );
    expect(insisted).toBeLessThan(corroborated);
  });
});

describe('naming the same form once in each of several episodes', () => {
  it('pays full weight every time, because §4.4 counts episodes and not utterances', async () => {
    await growIndependentNamings(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(namingSupport(store, referentId, 'the auth thing')).toBe(
      independentSupport(INDEPENDENT_EPISODES.length),
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * §5.1's replay, and §4.3's echo loop.
 * ---------------------------------------------------------------------------
 */

describe('a naming inside an episode stage 0 has already admitted this text from', () => {
  it('moves the naming claim not at all', async () => {
    const message = claimMessage('The practice survives its own justification.', ['practice'], {
      origin: agentOrigin(1),
    });
    await ingest.submit(message);
    const referentId = referentNamed(store, 'practice');
    const before = namingSupport(store, referentId, 'practice');

    const receipt = await ingest.submit(message);

    expect(receipt.duplicate).toBe(true);
    expect(namingSupport(store, referentId, 'practice')).toBe(before);
  });

  it('still leaves exactly one naming claim behind, not a second one at weight zero', async () => {
    const message = claimMessage('The practice survives its own justification.', ['practice'], {
      origin: agentOrigin(1),
    });
    await ingest.submit(message);
    await ingest.submit(message);

    expect(namingClaimCount(store, referentNamed(store, 'practice'), 'practice')).toBe(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Every rung, not only the two that mint today.
 * ---------------------------------------------------------------------------
 */

describe('the rung §5.2 answered on', () => {
  it('corroborates the naming claim when the exact name answered', async () => {
    await ingest.submit(
      claimMessage('AuthService owns the rotation window.', ['AuthService'], {
        origin: agentOrigin(1),
      }),
    );
    const referentId = referentNamed(store, 'AuthService');
    const before = namingSupport(store, referentId, 'AuthService');

    const receipt = await ingest.submit(
      claimMessage('AuthService rotates its signing key nightly.', ['AuthService'], {
        origin: agentOrigin(2),
      }),
    );

    expect(receipt.resolutions[0]?.rung).toBe('exact');
    expect(namingSupport(store, referentId, 'AuthService')).toBe(before + FIRST_OBSERVATION);
  });

  it('corroborates the naming claim when the mention index answered', async () => {
    await ingest.submit(
      claimMessage('AuthService owns the rotation window.', ['AuthService'], {
        origin: agentOrigin(1),
      }),
    );
    await ingest.submit(
      claimMessage('AuthService rotates its signing key nightly.', ['AuthService'], {
        origin: agentOrigin(2),
      }),
    );
    await ingest.submit(
      claimMessage('The auth-service window is fifteen minutes.', ['auth-service'], {
        origin: agentOrigin(3),
      }),
    );
    const referentId = referentNamed(store, 'AuthService');
    const before = namingSupport(store, referentId, 'auth-service');

    const receipt = await ingest.submit(
      claimMessage('The auth-service pool is drained nightly.', ['auth-service'], {
        origin: agentOrigin(4),
      }),
    );

    expect(receipt.resolutions[0]?.rung).toBe('mention-index');
    expect(namingSupport(store, referentId, 'auth-service')).toBe(before + FIRST_OBSERVATION);
  });

  it('mints the naming claim the gloss rung resolved through, at the content-addressed id', async () => {
    await ingest.submit(
      claimMessage('Chapter Three argues that the regress terminates.', ['Chapter Three'], {
        origin: agentOrigin(1),
      }),
    );

    const receipt = await ingest.submit(
      claimMessage('The third chapter was cited again.', ['the third chapter'], {
        origin: agentOrigin(2),
      }),
    );

    const referentId = referentNamed(store, 'Chapter Three');
    expect(receipt.resolutions[0]?.rung).toBe('gloss-embedding');
    expect(namingSupport(store, referentId, 'the third chapter')).toBe(MINTED_SUPPORT);
  });

  it('mints the naming claim a paid-for tiebreak resolved through, at the content-addressed id', async () => {
    await ingest.submit(
      claimMessage('RetryPolicy caps attempts at three.', ['RetryPolicy'], {
        origin: agentOrigin(1),
      }),
    );
    await ingest.submit(
      claimMessage('RetryBudget is spent per session, not per call.', ['RetryBudget'], {
        origin: agentOrigin(2),
      }),
    );
    adjudicator.answerWith(picks('RetryPolicy'));

    const receipt = await ingest.submit(
      claimMessage('The retry knob is not a per-call setting.', ['the retry knob'], {
        origin: agentOrigin(3),
      }),
    );

    const referentId = referentNamed(store, 'RetryPolicy');
    expect(receipt.resolutions[0]?.rung).toBe('tiebreak');
    expect(namingSupport(store, referentId, 'the retry knob')).toBe(MINTED_SUPPORT);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The name the index derives from all of it.
 * ---------------------------------------------------------------------------
 */

describe('the derived name', () => {
  it('is the form carrying the most naming support', async () => {
    await growRankedForms(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(namingSupport(store, referentId, 'the auth thing')).toBe(independentSupport(3));
    expect(namingSupport(store, referentId, 'auth-service')).toBe(independentSupport(2));
    expect(namingSupport(store, referentId, 'AuthService')).toBe(independentSupport(1));
    expect(ingest.referents.get(referentId)?.name).toBe('the auth thing');
  });

  it('ranks every form behind it by the same support', async () => {
    await growRankedForms(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(ingest.referents.mentionsOf(referentId)).toStrictEqual(
      rankedBySupport(store, referentId, AUTH_FORMS),
    );
    expect(ingest.referents.mentionsOf(referentId)).toStrictEqual([
      'the auth thing',
      'auth-service',
      'AuthService',
    ]);
  });

  it('outranks twelve repeats inside one episode with four namings from four', async () => {
    await growMixedNaming(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(ingest.referents.get(referentId)?.name).toBe('the auth thing');
    expect(ingest.referents.mentionsOf(referentId)).toStrictEqual([
      'the auth thing',
      'auth-service',
      'AuthService',
    ]);
  });
});

describe('two forms corroborated identically', () => {
  it('are broken apart by the smaller surface form', async () => {
    await growTiedNaming(ingest);
    const referentId = referentNamed(store, 'AuthService');
    const [first, second] = TIED_FORMS;

    expect(namingSupport(store, referentId, first)).toBe(namingSupport(store, referentId, second));
    // `<` on the forms themselves, the rule `deriveName` actually applies — not
    // a naming-claim id, which no longer breaks any tie. For an attested
    // referent the two happen to agree (the referent id, and so the claim id,
    // is a content hash), which is what lets this same tie recur unchanged on a
    // separately built store below.
    const smallest = first < second ? first : second;
    expect(ingest.referents.get(referentId)?.name).toBe(smallest);
  });

  it('are not broken apart by which form was named first', async () => {
    await growTiedNaming(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(ingest.referents.get(referentId)?.name).not.toBe(TIED_FORMS[0]);
    expect(ingest.referents.get(referentId)?.name).toBe(TIED_FORMS[1]);
  });

  it('are broken apart the same way in a store built separately', async () => {
    const second = openPort();
    await growTiedNaming(ingest);
    await growTiedNaming(second.port);

    const here = ingest.referents.get(referentNamed(store, 'AuthService'))?.name;
    const there = second.port.referents.get(referentNamed(second.graph, 'AuthService'))?.name;
    expect(there).toBe(here);
    // Both land on the smaller-id form rather than merely on the same one: two
    // stores that agreed by first-naming order would agree here too.
    expect(here).toBe(TIED_FORMS[1]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The same tie, with nothing attesting the referent underneath it.
 * ---------------------------------------------------------------------------
 *
 * The block above ties two forms on an *attested* referent, whose id is a
 * content hash of `(level, locator, surface form)` and so is the same number in
 * every database. Breaking that tie on the smaller naming-claim id is therefore
 * a rule about the forms in disguise: the ids differ between databases only if
 * the referent id does, and there it does not.
 *
 * §3.1 makes the other case the ordinary one — *"a domain with no noun source
 * runs pure usage-emergence"*. A referent minted from usage carries a fresh
 * ULID, so the two naming-claim ids hashed from it are database-specific, and a
 * tiebreak that reads them is a coin flipped separately in every database. That
 * is not a corner: it is the mode the spec says has to stand on its own, and it
 * is what `kg-mcp-emergence-and-federation.md` turns on — two stores that have
 * never communicated agreeing about what things are called.
 *
 * A tiebreak on the surface forms themselves has the property the ids were
 * claimed to have. The forms are the two things already being compared, they are
 * the same strings in every database, and they do not move when a referent is
 * minted twice.
 */

describe('two forms corroborated identically on a referent nothing attested', () => {
  it('stands on a referent minted at a fresh ULID, not at a content hash', async () => {
    const second = openPort();
    await growUsageBornTie(ingest);
    await growUsageBornTie(second.port);

    const here = referentNamed(store, 'AuthService');
    const there = referentNamed(second.graph, 'AuthService');
    expect(there).not.toBe(here);
    expect(namingClaimId(there, SMALLER_FORM)).not.toBe(namingClaimId(here, SMALLER_FORM));
  });

  it('is broken apart the same way in every database that grows it', async () => {
    const disagreements: string[] = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const here = openPort();
      const there = openPort();
      await growUsageBornTie(here.port);
      await growUsageBornTie(there.port);

      const hereName = derivedName(here);
      const thereName = derivedName(there);
      if (hereName !== thereName) disagreements.push(`${hereName} here, ${thereName} there`);
    }

    expect({
      trials: TRIALS,
      disagreed: disagreements.length,
      how: [...new Set(disagreements)].sort(),
    }).toStrictEqual({ trials: TRIALS, disagreed: 0, how: [] });
  });

  it('falls to the lexicographically smaller form, and not merely to one of them', async () => {
    const winners: string[] = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const built = openPort();
      await growUsageBornTie(built.port);
      const referentId = referentNamed(built.graph, 'AuthService');

      expect(namingSupport(built.graph, referentId, TIED_FORMS[0])).toBe(
        namingSupport(built.graph, referentId, TIED_FORMS[1]),
      );
      winners.push(derivedName(built));
    }

    expect(tallyOf(winners)).toStrictEqual({ [SMALLER_FORM]: TRIALS });
  });

  it('is not broken apart by which form was named first', async () => {
    expect([...TIED_FORMS].sort()[0]).toBe(SMALLER_FORM);
    expect(TIED_FORMS[0]).not.toBe(SMALLER_FORM);

    const winners: string[] = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const built = openPort();
      await growUsageBornTie(built.port);
      winners.push(derivedName(built));
    }

    expect(tallyOf(winners)).toStrictEqual({ [SMALLER_FORM]: TRIALS });
  });

  it('survives a rebuild, which replays the ledger and sees no arrival order at all', async () => {
    const outcomes: string[] = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const built = openPort();
      await growUsageBornTie(built.port);
      const referentId = referentNamed(built.graph, 'AuthService');
      const live = derivedName(built);

      const rebuilt = await rebuiltFrom(built.graph);

      outcomes.push(`${live} live, ${rebuilt.referents.get(referentId)?.name} rebuilt`);
    }

    expect(tallyOf(outcomes)).toStrictEqual({
      [`${SMALLER_FORM} live, ${SMALLER_FORM} rebuilt`]: TRIALS,
    });
  });

  it('does not fire at all when one form carries strictly more support', async () => {
    await growRankedForms(ingest);
    const referentId = referentNamed(store, 'AuthService');

    const corroborated = namingSupport(store, referentId, 'the auth thing');
    expect(corroborated).toBeGreaterThan(namingSupport(store, referentId, SMALLER_FORM));
    expect('the auth thing' > SMALLER_FORM).toBe(true);
    expect(ingest.referents.get(referentId)?.name).toBe('the auth thing');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Which ordering the tiebreak means.
 * ---------------------------------------------------------------------------
 *
 * Every tie above is between `auth-service` and `the auth thing`, and `a`
 * precedes `t` under UTF-16 code units and under every collator alike. Those
 * cases pin *that* the tiebreak reads the forms; they do not pin *how* it reads
 * them, and a `deriveName` that compared with `localeCompare` would leave all of
 * them green.
 *
 * The difference is the whole point of the rule. A collator's answer is a
 * function of the ICU data and default locale of the machine asking — which is
 * the same database-specific dependence the naming-claim-id tiebreak was removed
 * for, arriving by another door: two stores holding the same ledger under
 * different ICU would derive different names. `<` is a function of the two
 * strings and nothing else, so it is the same answer everywhere.
 *
 * The assertions below are on the derived name and never on what a collator
 * says. What `localeCompare` returns is a fact about the runtime, and a test
 * that pinned it would be testing Node rather than this graph.
 *
 * @spec §3.1, §3.5
 */

describe('a tie between forms that collation and code-unit order rank differently', () => {
  it('is an exact tie, with the collation-smaller form named first', async () => {
    await growCollationSplitTie(ingest);
    const referentId = referentNamed(store, 'AuthService');
    const [first, second] = COLLATION_SPLIT_FORMS;

    expect(namingSupport(store, referentId, first)).toBe(namingSupport(store, referentId, second));
    expect(ingest.referents.mentionsOf(referentId)[0]).toBe(first);
    expect(second).toBe(CODE_UNIT_SMALLER);
  });

  it('falls to the form UTF-16 code units make smaller, whatever a collator would say', async () => {
    await growCollationSplitTie(ingest);
    const referentId = referentNamed(store, 'AuthService');

    expect(CODE_UNIT_SMALLER < COLLATION_SPLIT_FORMS[0]).toBe(true);
    expect(ingest.referents.get(referentId)?.name).toBe(CODE_UNIT_SMALLER);
  });

  it('is broken apart the same way in a store built separately', async () => {
    const second = openPort();
    await growCollationSplitTie(ingest);
    await growCollationSplitTie(second.port);

    const here = ingest.referents.get(referentNamed(store, 'AuthService'))?.name;
    const there = second.port.referents.get(referentNamed(second.graph, 'AuthService'))?.name;
    expect(there).toBe(here);
    expect(here).toBe(CODE_UNIT_SMALLER);
  });

  it('survives a rebuild, which replays the ledger and sees no arrival order at all', async () => {
    await growCollationSplitTie(ingest);
    const referentId = referentNamed(store, 'AuthService');

    const rebuilt = await rebuiltFromLedger();

    expect(rebuilt.referents.get(referentId)?.name).toBe(CODE_UNIT_SMALLER);
  });
});

describe('the name a rebuild derives from the same ledger', () => {
  it('agrees with the live one over a mixture of capped repeats and independent namings', async () => {
    await growMixedNaming(ingest);
    const referentId = referentNamed(store, 'AuthService');
    const live = ingest.referents.get(referentId)?.name;

    const rebuilt = await rebuiltFromLedger();

    expect(rebuilt.referents.get(referentId)?.name).toBe(live);
  });

  it('agrees on the whole ranking behind it, not only on its head', async () => {
    await growMixedNaming(ingest);
    const referentId = referentNamed(store, 'AuthService');
    const live = ingest.referents.mentionsOf(referentId);

    const rebuilt = await rebuiltFromLedger();

    expect(rebuilt.referents.mentionsOf(referentId)).toStrictEqual(live);
  });

  it('reads the same support out of the ledger, because the clear never touched it', async () => {
    await growMixedNaming(ingest);
    const referentId = referentNamed(store, 'AuthService');
    const live = ['the auth thing', 'auth-service', 'AuthService'].map((form) =>
      namingSupport(store, referentId, form),
    );

    await rebuiltFromLedger();

    expect(
      ['the auth thing', 'auth-service', 'AuthService'].map((form) =>
        namingSupport(store, referentId, form),
      ),
    ).toStrictEqual(live);
  });
});
