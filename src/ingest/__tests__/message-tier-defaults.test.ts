/**
 * What rung the one ingest door hands a producer who names none.
 *
 * §6.3 makes tier a **privilege ladder**: *"verified — creates disputes,
 * resolves disputes, kills provisionals unilaterally. observed — moves
 * posteriors at full weight; needs the 2-episode rule for status changes.
 * inferred — accumulates at half weight … never changes a status by itself."*
 * A default is what the door awards a message that asserted nothing about how it
 * knows, so a default is privilege granted to silence, and the only question
 * worth asking of one is what the *message type itself* guarantees.
 *
 * ── Why silence is reasoning, for a claim and for a boundary ─────────────────
 *
 * A {@link ClaimMessage} guarantees nothing: a proposition, its nouns, and an
 * episode. §15's tier table reads `observed` as *"agent directly read the
 * relevant code/output"*, and nothing in a claim message says anybody read
 * anything. Awarding it full §15 weight, the neutral β₀=1 prior and eligibility
 * for §6.3's 2-episode status changes hands measurement's privileges to a
 * producer who claimed none of it — and §4's whole apparatus is the ability to
 * tell measurement from reasoning apart again afterwards, which is the one thing
 * no later pass can reconstruct.
 *
 * A {@link ContainmentMessage} guarantees no more. Its `source` is *optional*,
 * and §1 is explicit about what a spine with no noun source behind it is worth:
 * *"a zero-adapter domain runs an all-asserted spine — referents minted via the
 * resolution ladder and grouping claims, no structural floor, **nothing reaching
 * verified tier** — correctly humbler testimony."* A boundary asserted by nobody
 * in particular is a belief, and a defaulted one is a belief whose holder did not
 * even say they had looked. The sourced case loses nothing by the same floor:
 * `submitContainment` puts a sourced boundary in the *view* regime with
 * `evidence: null`, so its tier moves no posterior at all — it weighs only the
 * naming claims the ladder writes on the way, and a noun source that wants those
 * weighed as measurement is already filling in `source` and can fill in `tier`.
 *
 * ── Why silence is *verified* for an attestation, and why that is not the same
 *    argument ──────────────────────────────────────────────────────────────────
 *
 * {@link AttestationMessage.source} is **required**. The message type is not a
 * producer who happens to be a noun source; it is the act §3.1 calls attesting,
 * and §15's own tier table spends the top rung on exactly that act — `verified`
 * is *"test executed, **noun-source attested**, CI observed"*. So the default
 * here rests on a structural guarantee of the type rather than on a producer's
 * silence, which is the whole distinction this file is about. §4.3's A1
 * exemption names the same three things — *"a test, **parse**, or CI
 * observation"* — as the evidence that stays untainted.
 *
 * What the rung buys is narrow and correctly placed. The existence claim it
 * writes is in the view regime carrying no posterior (§3.1, diagram §6:
 * *"Nothing is ever both"*), so `verified` moves nothing there; it moves the
 * *naming* claim, which is an ordinary evidence-regime belief about what the
 * thing is called — and a source reporting a name has read it rather than
 * guessed it. Pinned here green so the day the two rulings below are applied,
 * the third default is not carried along by reflex.
 *
 * ── Read through the door, not off the file ─────────────────────────────────
 *
 * Every assertion here parses a message or submits one. Nothing restates a
 * literal out of `messages.ts`: the rungs are named, but the weight and the
 * prior each rung buys are read from §15's own `TIER_WEIGHT` and `priorFor`, so
 * a replay that retunes those numbers (§5.8) retunes this file with them.
 *
 * @spec §3.1, §3.2, §4.2, §4.3, §5.2, §6.3, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanClaimIds } from '../../referents/index-view';
import { decodeSpineClaim } from '../../referents/spine';
import { openGraphStore, type GraphStore } from '../../store/index';
import { TIER_WEIGHT, observationWeight, priorFor } from '../evidence';
import { openIngest, type IngestPort } from '../index';
import { AttestationMessage, ClaimMessage, ContainmentMessage } from '../messages';

import {
  LOCATOR,
  NOUN_SOURCE,
  agentOrigin,
  emitterOrigin,
  fakeAdjudicator,
  fakeEmbeddings,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from '../../referents/__tests__/fixtures';

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
 * The bottom rung, read off §15's weights rather than written down.
 *
 * The ladder is a ranking of weights before it is a list of words, so "the rung
 * a producer's silence earns" is *the one §15 weighs least* — and a replay that
 * retunes the weights (§5.8) moves this with them instead of leaving a word
 * behind that no longer names the bottom.
 *
 * @spec §4.2, §6.3, §15
 */
const LOWEST_RUNG = (Object.keys(TIER_WEIGHT) as ReadonlyArray<keyof typeof TIER_WEIGHT>).reduce(
  (lowest, rung) => (TIER_WEIGHT[rung] < TIER_WEIGHT[lowest] ? rung : lowest),
);

/** What the default rung is worth as one uncapped, untainted observation. @spec §4.2, §15 */
const SILENCE_IS_WORTH = observationWeight(LOWEST_RUNG, 0, false);

/** The rungs above the one silence earns. @spec §6.3, §15 */
const HIGHER_RUNGS = (Object.keys(TIER_WEIGHT) as ReadonlyArray<keyof typeof TIER_WEIGHT>).filter(
  (rung) => rung !== LOWEST_RUNG,
);

/**
 * Every claim in the ledger as `<what it is>: <the rung it landed at>`.
 *
 * Deduped and sorted, because the question is which rungs the write path spent
 * and not how many rows each one bought — and read through
 * {@link decodeSpineClaim} so a spine claim answers as the thing it is rather
 * than as an id this test would have to know in advance.
 *
 * @spec §3.5, §6.3
 */
const rungsInLedger = (graph: GraphStore): readonly string[] =>
  [
    ...new Set(
      scanClaimIds(graph).map((claimId) => {
        const claim = graph.getClaim(claimId);
        if (claim === undefined) throw new Error(`the ledger lost claim ${claimId}`);
        return `${decodeSpineClaim(claim.text)?.claim ?? 'member'}: ${claim.tier}`;
      }),
    ),
  ].sort();

/** One claim row, as the three fields a tier decides. @spec §3.2, §6.2 */
const rowOf = (graph: GraphStore, claimId: string | undefined): unknown => {
  const claim = claimId === undefined ? undefined : graph.getClaim(claimId);
  if (claim === undefined) throw new Error('the ingest port wrote no claim');
  return { tier: claim.tier, evidence: claim.evidence, status: claim.status };
};

/** The support one spine claim of the given shape carries. @spec §3.1, §4.1 */
const supportFor = (graph: GraphStore, shape: string): unknown => {
  const found = scanClaimIds(graph).flatMap((claimId) => {
    const claim = graph.getClaim(claimId);
    if (claim === undefined || decodeSpineClaim(claim.text)?.claim !== shape) return [];
    return [{ tier: claim.tier, regime: claim.regime, evidence: claim.evidence }];
  });
  if (found.length !== 1)
    throw new Error(`the ledger holds ${String(found.length)} ${shape} claims, not one`);
  return found[0];
};

const CLAIM_WITHOUT_TIER = {
  type: 'claim',
  text: 'TokenRotator refreshes the signing key every twelve hours.',
  kind: 'fact',
  mentions: ['TokenRotator'],
  origin: agentOrigin(1),
} satisfies ClaimMessage;

const CONTAINMENT_WITHOUT_TIER = {
  type: 'containment',
  parent: 'TokenRotator',
  child: 'rotateSigningKey',
  childLevel: 'symbol',
  origin: agentOrigin(1),
} satisfies ContainmentMessage;

const ATTESTATION_WITHOUT_TIER = {
  type: 'attestation',
  source: NOUN_SOURCE,
  surfaceForm: 'TokenRotator',
  level: 'component',
  locator: LOCATOR,
  origin: emitterOrigin(1),
} satisfies AttestationMessage;

describe('the rung every default in this file is read from', () => {
  /**
   * §15 records which rung is the bottom **twice**, and nothing held the two
   * records together.
   *
   * `TIER_WEIGHT` says it by *ordering* — the bottom is whichever rung weighs
   * least — while `priorFor` says it by *naming one*, `tier === 'inferred'`. Every
   * assertion below reads the rung through {@link LOWEST_RUNG} and its prior
   * through `priorFor(LOWEST_RUNG)`, which is what makes them survive a §5.8
   * replay that retunes the weights. It is also what would let such a replay
   * decouple the two: reorder `TIER_WEIGHT` until some other rung weighs least and
   * every test in this file follows it there, cheerfully asserting that silence
   * now earns the lightest weight *and* the neutral prior, because `priorFor` was
   * left behind pointing at a rung that is no longer the bottom.
   *
   * The ruling these defaults exist for is both halves at once, and §3.2 is
   * explicit that they belong together: *"model reasoning with no observation
   * behind it starts out doubted, not neutral"*. So the bottom rung is the most
   * doubted rung, and that is asserted here rather than assumed by the four
   * describes below.
   *
   * @spec §3.2, §4.2, §5.8, §6.3, §15
   */
  it('is the one §3.2 starts out doubting, and not merely the one §15 weighs least', () => {
    expect({
      hasRungsAboveIt: HIGHER_RUNGS.length > 0,
      startingLessDoubtedThanSilence: HIGHER_RUNGS.filter(
        (rung) => priorFor(rung).beta >= priorFor(LOWEST_RUNG).beta,
      ),
    }).toStrictEqual({ hasRungsAboveIt: true, startingLessDoubtedThanSilence: [] });
  });
});

describe('a claim message that names no tier', () => {
  /**
   * The prompt the extractor ships says *"inferred is the default"* and the door
   * it writes through says `observed`. Only one of them can be the rule, and the
   * door is the one every other producer inherits.
   *
   * The three fields move together on purpose: the rung is the visible half, but
   * what §6.3 actually grants is the **weight** and the **prior**, and a ruling
   * that moved the word while leaving `observed`'s arithmetic behind would have
   * changed nothing that matters.
   *
   * @spec §3.2, §4.2, §6.3, §15
   */
  it('is filed at the rung §6.3 lets change no status by itself', () => {
    const parsed = ClaimMessage.parse(CLAIM_WITHOUT_TIER);

    expect({
      tier: parsed.tier,
      weight: observationWeight(parsed.tier, 0, false),
      prior: priorFor(parsed.tier),
    }).toStrictEqual({
      tier: LOWEST_RUNG,
      weight: SILENCE_IS_WORTH,
      prior: priorFor(LOWEST_RUNG),
    });
  });

  /**
   * The row, not the parse — because §4 reads tiers off the ledger and never off
   * the message that wrote it.
   *
   * @spec §3.2, §4.1, §6.2
   */
  it('lands in the ledger holding the skeptical prior and nothing more', async () => {
    const receipt = await ingest.submit(CLAIM_WITHOUT_TIER);

    expect(rowOf(store, receipt.claimId)).toStrictEqual({
      tier: LOWEST_RUNG,
      evidence: priorFor(LOWEST_RUNG),
      status: 'provisional',
    });
  });

  /**
   * The defect's blast radius, which is larger than the claim that carried it.
   *
   * §5.2's ladder mints a referent for every unknown noun, and `mintReferent`
   * passes the *message's* tier into the existence claim and the naming claim it
   * writes alongside it. E8c's live run is the demonstration: 240 auto-minted
   * spine claims, 69 of them at `observed`, every one inheriting the rung from
   * the member claim that triggered the mint. So an inflated default is never one
   * inflated row.
   *
   * @spec §3.1, §5.2, §6.3
   */
  it('mints its spine at that rung too, since the spine inherits what the claim carried', async () => {
    await ingest.submit(CLAIM_WITHOUT_TIER);

    expect(rungsInLedger(store)).toStrictEqual([
      `existence: ${LOWEST_RUNG}`,
      `member: ${LOWEST_RUNG}`,
      `naming: ${LOWEST_RUNG}`,
    ]);
  });
});

describe('a containment message that names no tier', () => {
  /**
   * §3.3's spine is *"the materialization of containment claims"* and of nothing
   * else, which is what makes a bad boundary an ordinary wrong claim — and an
   * ordinary claim whose producer said nothing about how it knows is reasoning.
   *
   * @spec §3.1, §3.3, §6.3
   */
  it('is filed as reasoning, because only a source makes a boundary measured', () => {
    const parsed = ContainmentMessage.parse(CONTAINMENT_WITHOUT_TIER);

    expect({
      tier: parsed.tier,
      weight: observationWeight(parsed.tier, 0, false),
      sourced: parsed.source,
    }).toStrictEqual({ tier: LOWEST_RUNG, weight: SILENCE_IS_WORTH, sourced: undefined });
  });

  /**
   * Both ends of the boundary and the boundary itself, in one read: the ladder
   * resolves `parent` and `child` at the message's tier before the containment
   * claim is written at it.
   *
   * @spec §3.1, §3.3, §5.2
   */
  it('lands the boundary and both its ends at that rung', async () => {
    await ingest.submit(CONTAINMENT_WITHOUT_TIER);

    expect(rungsInLedger(store)).toStrictEqual([
      `containment: ${LOWEST_RUNG}`,
      `existence: ${LOWEST_RUNG}`,
      `naming: ${LOWEST_RUNG}`,
    ]);
  });
});

describe('an attestation message that names no tier', () => {
  /**
   * The default that is already right, pinned so it survives the two above being
   * fixed.
   *
   * §15's tier table spends `verified` on three acts and one of them is
   * *"noun-source attested"*. `AttestationMessage.source` is required, so this
   * default is not privilege granted to silence — the message cannot be written
   * at all without the act the rung is for.
   *
   * @spec §3.1, §4.3, §6.3, §15
   */
  it('keeps the top rung, which is the act the message type requires', () => {
    const parsed = AttestationMessage.parse(ATTESTATION_WITHOUT_TIER);

    expect({
      tier: parsed.tier,
      weight: observationWeight(parsed.tier, 0, false),
      attestedBy: parsed.source,
    }).toStrictEqual({
      tier: 'verified',
      weight: TIER_WEIGHT.verified,
      attestedBy: NOUN_SOURCE,
    });
  });

  /**
   * Where that rung is spent, which is not where it looks.
   *
   * The existence claim goes to §3.1's view regime carrying no posterior at all,
   * so `verified` moves nothing there. It moves the naming claim — an ordinary
   * evidence-regime belief about what the referent is *called* — and that is the
   * one a source has genuinely read rather than reasoned to.
   *
   * @spec §3.1, §4.2, §6.2, §15
   */
  it('spends it on the name it read, not on the existence it re-derives', async () => {
    await ingest.submit(ATTESTATION_WITHOUT_TIER);

    expect({
      existence: supportFor(store, 'existence'),
      naming: supportFor(store, 'naming'),
    }).toStrictEqual({
      existence: { tier: 'verified', regime: 'view', evidence: null },
      naming: {
        tier: 'verified',
        regime: 'evidence',
        evidence: {
          alpha: priorFor('verified').alpha + observationWeight('verified', 0, false),
          beta: priorFor('verified').beta,
        },
      },
    });
  });
});
