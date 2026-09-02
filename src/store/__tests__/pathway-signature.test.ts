/**
 * The A15 pathway signature on a claim with no provenance axes.
 *
 * The gap. `channel` and `agent` are stored per provenance *row*
 * (`provenance.channel`, `provenance.agent`), and `putClaim` writes one row per
 * value across the three axes. A claim carrying a signature but no axis values
 * therefore writes zero rows, and the signature has nowhere to land. `getClaim`
 * reads it back off the first row carrying each half, finds no rows, and returns
 * `{ episodes: [], changeEvents: [], artifacts: [] }`. The signature is gone,
 * and nothing anywhere said so.
 *
 * Why it matters. §4.7 pathway saturation groups corroborations by channel and
 * agent to notice that ten "independent" confirmations all came in over one
 * pathway. A claim whose signature was dropped is a claim saturation can never
 * fire on: it looks like it arrived by no known pathway, which is exactly the
 * shape that is exempt from the check. The failure mode is silent under-counting
 * of inflation — the thing §4.7 exists to catch.
 *
 * ── What this file pins, and what it deliberately does not ──────────────────
 *
 * The storage *shape* is contested and is not decided here. Spec §3.5 attaches
 * the signature once per claim; diagram §4 keys it per provenance row, which is
 * what migration 0 built. That disagreement is unresolved and above this file's
 * pay grade — a test that asserted a column, a sentinel row or a claims-table
 * field would be pinning one side of an open argument as if it were settled.
 *
 * What is *not* contested is that a write must not silently discard data. That
 * is the invariant pinned here, and it is pinned twice, at two strengths:
 *
 *   1. `does not silently discard` asserts only the disjunction — round-trip or
 *      refuse. It is shape-agnostic and survives either resolution of the spec
 *      dispute, so it is the assertion that should outlive this cycle.
 *
 *   2. The refusal cases assert the specific reading ruled on below. They are
 *      the stricter of the two, and are what would need revisiting if the shape
 *      question is ever settled in favour of storing the signature per claim.
 *
 * ── Why refusal, and not round-trip ─────────────────────────────────────────
 *
 * The ordinary write refusal would supposedly break does not exist. Every claim
 * reaching `putClaim` through the ingest port carries a non-empty episode axis:
 * `writeClaim` builds provenance as `episodes: [draft.origin.episodeId]`
 * (`src/ingest/spine-writer.ts`), and `Origin.episodeId` is `z.string().min(1)`
 * — required, never optional (`src/ingest/messages.ts`). `writeClaim` is the
 * only production caller of `putClaim`. So "the first claim of a fresh episode,
 * minted before anything has been attributed to it" is not an unattributed
 * claim at all: it names its episode, which is the entire point of an episode.
 * A signed claim with three empty axes can only arrive from a direct `putClaim`
 * that went around ingest — a caller's bug, not a normal write.
 *
 * That also settles the data-loss objection. Refusing can only convert a valid
 * claim into a rejected one if valid claims reach this path, and none do. What
 * it rejects is a record that was already malformed by the time it arrived.
 *
 * The schema objection is the real one, and it is answered rather than ignored.
 * `Provenance` in `src/schema/` does declare this record legal: `channel` and
 * `agent` are `.optional()` beside three plain array axes, and nothing couples
 * them. But `putClaim` already refuses regime/evidence pairings that `Claim`
 * admits, with `RegimeViolationError`, and `src/store/errors.ts` opens by saying
 * why — these are *boundary* errors, each naming a promise the persistence layer
 * makes that no shape expresses. A schema too coarse to couple two fields is not
 * a licence to accept every combination of them.
 *
 * The deeper reason is one layer up. §4.4 cannot discount an observation that
 * names no episode, so such an observation would corroborate without limit —
 * which is precisely why `Origin` requires one. A signature with nowhere to live
 * is the same defect restated: a pathway §4.7 can never group on, and therefore
 * one it can never saturate. Refusing at the write is the answer the layer above
 * already gives to the same question.
 *
 * And the refusal is total. It belongs before the first statement runs, so a
 * refused write leaves no claim row, no vector copy and no provenance row — the
 * store is byte-for-byte what it was. That is asserted here rather than assumed,
 * including the residue a bare `getClaim` cannot see: rows that outlive a
 * refusal are invisible until the same id is minted for real, at which point
 * they silently join the new claim.
 *
 * Residue has exactly two surfaces, and each is asserted where it shows. A
 * surviving claim row makes the id unmintable, so the refused-then-minted case
 * reads it off the second write refusing at all. A surviving *provenance* row is
 * the one that joins silently — it is the only table `getClaim` reads by join —
 * so that case compares the provenance it reads back, not the whole record. The
 * remaining fields all come off the single claim row the second write inserted,
 * and comparing them would pin the record's shape, which is a question this file
 * has no business answering.
 *
 * Real SQLite, `:memory:`, no mocks — the behaviour under test is what a row
 * loop does when it iterates zero times, which only a real write path has.
 *
 * @spec §3.5, §4.4, §4.7
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OrphanedSignatureError, openGraphStore, type ClaimRecord, type GraphStore } from '../index';

import {
  AGENT,
  CHANNEL,
  CLAIM_ID,
  EPISODE_ID,
  RIVAL_CLAIM_ID,
  makeClaim,
  makeMinimalClaim,
} from './fixtures';

let store: GraphStore;

/** A change event on the axis §4.5 churn decay reads. @spec §3.5, §4.5 */
const CHANGE_EVENT = '9f2c1ab4e7d05b3c8a6f41d29e0b7c5a3d81f6e2';

/** An artifact on the axis §4.4 independence discounting reads. @spec §3.5, §4.4 */
const ARTIFACT = 'src/auth/session.ts';

/** The provenance half of a claim fixture, as an override. @spec §3.5 */
type ProvenancePart = Partial<ClaimRecord['provenance']>;

/**
 * A claim with all three axes empty, carrying whatever signature is handed in.
 *
 * @spec §3.5
 */
const unattributed = (signature: ProvenancePart): ClaimRecord =>
  makeMinimalClaim({
    provenance: { episodes: [], changeEvents: [], artifacts: [], ...signature },
  });

/**
 * The malformed record itself: both halves of the signature, nothing for either
 * half to ride on.
 *
 * @spec §3.5, §4.7
 */
const signedButUnattributed = (): ClaimRecord => unattributed({ channel: CHANNEL, agent: AGENT });

/**
 * A fully signed claim that also names something — what ingest actually writes.
 *
 * @spec §3.5, §4.7
 */
const signedAndAttributed = (axis: ProvenancePart): ClaimRecord =>
  makeMinimalClaim({
    provenance: {
      episodes: [],
      changeEvents: [],
      artifacts: [],
      channel: CHANNEL,
      agent: AGENT,
      ...axis,
    },
  });

/**
 * Signatures that must be refused when no axis carries them.
 *
 * Each half alone as well as both together, because the condition is
 * `channel ?? agent`: an agent with no channel is still a pathway §4.7 groups
 * by, and a rule that only fired when both were present would drop exactly the
 * signatures an agent-less emitter and a channel-less agent produce.
 *
 * @spec §3.5, §4.7
 */
const ORPHANED_SIGNATURES: readonly [string, ProvenancePart][] = [
  ['a channel and an agent', { channel: CHANNEL, agent: AGENT }],
  ['a channel alone', { channel: CHANNEL }],
  ['an agent alone', { agent: AGENT }],
];

/**
 * Axis values a signature can ride on. Any one of the three is enough — the
 * refusal is about having nowhere to land, not about which axis lands it.
 *
 * @spec §3.5, §4.4, §4.5, §4.7
 */
const ATTRIBUTIONS: readonly [string, ProvenancePart][] = [
  ['an episode', { episodes: [EPISODE_ID] }],
  ['a change event', { changeEvents: [CHANGE_EVENT] }],
  ['an artifact', { artifacts: [ARTIFACT] }],
];

/**
 * The refusal a write produced, or `undefined` if it did not refuse.
 *
 * Returned rather than matched with `toThrow`, for the same reason the regime
 * suite does it: a store that refuses for an unrelated reason satisfies
 * `toThrow` just as well and never shows which rule did the refusing.
 */
const refusalFrom = (write: () => void): unknown => {
  try {
    write();
    return undefined;
  } catch (error) {
    return error;
  }
};

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('the pathway signature on a claim with no provenance axes', () => {
  it('does not silently discard the signature — it either round-trips or refuses', () => {
    const claim = signedButUnattributed();
    const refusal = refusalFrom(() => {
      store.putClaim(claim);
    });

    const stored = refusal === undefined ? store.getClaim(RIVAL_CLAIM_ID)?.provenance : undefined;
    const roundTripped = stored?.channel === CHANNEL && stored?.agent === AGENT;

    expect({ refused: refusal !== undefined, roundTripped }).not.toStrictEqual({
      refused: false,
      roundTripped: false,
    });
  });

  it.each(ORPHANED_SIGNATURES)(
    'refuses %s that no axis value can carry, rather than dropping it',
    (_description, signature) => {
      const refusal = refusalFrom(() => {
        store.putClaim(unattributed(signature));
      });

      expect(refusal).toBeInstanceOf(OrphanedSignatureError);
    },
  );

  it('names the refused claim on the error, so a caller knows which write it lost', () => {
    const refusal = refusalFrom(() => {
      store.putClaim(signedButUnattributed());
    });

    expect(refusal).toMatchObject({ claimId: RIVAL_CLAIM_ID, name: 'OrphanedSignatureError' });
  });
});

describe('a refused signature leaves the store exactly as it found it', () => {
  beforeEach(() => {
    store.putClaim(makeClaim());
  });

  it('writes no claim row and no vector copy', () => {
    const refusal = refusalFrom(() => {
      store.putClaim(signedButUnattributed());
    });

    expect(refusal).toBeInstanceOf(OrphanedSignatureError);
    expect(store.getClaim(RIVAL_CLAIM_ID)).toBeUndefined();
    expect(store.getRerankVector(RIVAL_CLAIM_ID)).toBeUndefined();
    expect(store.getAnnVector(RIVAL_CLAIM_ID)).toBeUndefined();
  });

  it('leaves the ledger enumerating exactly the claims it enumerated before', () => {
    const before = store.listClaimIds();
    refusalFrom(() => {
      store.putClaim(signedButUnattributed());
    });

    expect(store.listClaimIds()).toStrictEqual(before);
    expect(before).toStrictEqual([CLAIM_ID]);
  });

  it('leaves the claim beside it untouched, posterior and provenance both', () => {
    const neighbour = makeClaim();
    refusalFrom(() => {
      store.putClaim(signedButUnattributed());
    });

    expect(store.getClaim(CLAIM_ID)).toStrictEqual(neighbour);
  });

  it('leaves the refused id mintable, with no residue joining the claim that lands', () => {
    refusalFrom(() => {
      store.putClaim(signedButUnattributed());
    });

    const landed = signedAndAttributed({ episodes: [EPISODE_ID] });
    const second = refusalFrom(() => {
      store.putClaim(landed);
    });

    expect(second).toBeUndefined();
    expect(store.getClaim(RIVAL_CLAIM_ID)?.provenance).toStrictEqual(landed.provenance);
  });
});

describe('what the refusal does not reach', () => {
  it.each(ATTRIBUTIONS)(
    'round-trips a signature carried by %s, which is what ingest always writes',
    (_description, axis) => {
      const claim = signedAndAttributed(axis);
      store.putClaim(claim);

      expect(store.getClaim(RIVAL_CLAIM_ID)?.provenance).toStrictEqual(claim.provenance);
    },
  );

  it('admits a claim with no signature and no axis values, which discards nothing', () => {
    const claim = makeMinimalClaim();
    store.putClaim(claim);

    expect(store.getClaim(RIVAL_CLAIM_ID)?.provenance).toStrictEqual(claim.provenance);
  });

  it('admits an unsigned claim that names an episode, since there is no signature to strand', () => {
    const claim = unattributed({ episodes: [EPISODE_ID] });
    store.putClaim(claim);

    expect(store.getClaim(RIVAL_CLAIM_ID)?.provenance).toStrictEqual(claim.provenance);
  });
});
