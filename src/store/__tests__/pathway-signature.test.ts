/**
 * RED — the A15 pathway signature on a claim with no provenance axes.
 *
 * ⚠️ EXPECTED TO FAIL. Written in the VERIFY phase of the v0.6 store migration
 * for the *next* red-green cycle; no fix is implemented alongside it. Every
 * other test in `src/store/__tests__/` passes today.
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
 * `Provenance` in `src/schema/` admits this record: `channel` and `agent` are
 * `.optional()`, the three axes are plain arrays, and nothing couples them. So
 * the store is currently accepting a value its own schema declares legal and
 * returning a different one.
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
 *   2. `round-trips` asserts the specific reading chosen below. It is the
 *      stricter of the two and will need revisiting if the team picks refusal.
 *
 * ── Why round-trip was chosen over refusal ──────────────────────────────────
 *
 * The brief allowed either. Round-trip is the safe reading, for three reasons.
 *
 * First, refusal loses strictly more. The signature is optional metadata on an
 * otherwise valid claim; refusing the write discards the claim *and* its
 * signature rather than just the signature. Turning a storage-shape limitation
 * into a rejected claim converts a metadata bug into a data-loss bug.
 *
 * Second, the schema is the contract. `Provenance` explicitly permits a
 * signature beside empty axes. A store that refuses a value its own schema
 * declares legal puts the two layers into direct contradiction, and the fix for
 * that would have to be a schema change — a much larger claim than this gap
 * supports.
 *
 * Third, refusal would fire on a real and ordinary input. The first claim of a
 * fresh episode, minted before any change event or artifact has been attributed
 * to it, has empty axes and a perfectly good signature. That is a normal write,
 * not a malformed one.
 *
 * The alternative — refuse with a typed error, the way `putClaim` already
 * refuses a regime/evidence mismatch — is the loud option, and has the genuine
 * merit that it cannot be ignored and forces the shape question to be settled
 * before anything is stored. It was rejected on the grounds above, but it is a
 * defensible choice, and assertion (1) is written so that taking it still leaves
 * this file meaningful.
 *
 * Real SQLite, `:memory:`, no mocks — the behaviour under test is what a row
 * loop does when it iterates zero times, which only a real write path has.
 *
 * @spec §3.5, §4.7
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraphStore, type ClaimRecord, type GraphStore } from '../index';

import { AGENT, CHANNEL, RIVAL_CLAIM_ID, makeMinimalClaim } from './fixtures';

let store: GraphStore;

/**
 * A claim that arrived over a known pathway before anything was attributed to
 * it: all three axes empty, both halves of the signature present.
 *
 * @spec §3.5
 */
const signedButUnattributed = (): ClaimRecord =>
  makeMinimalClaim({
    provenance: {
      episodes: [],
      changeEvents: [],
      artifacts: [],
      channel: CHANNEL,
      agent: AGENT,
    },
  });

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

  it('round-trips the channel and agent a §4.7 saturation check is grouped by', () => {
    const claim = signedButUnattributed();
    store.putClaim(claim);

    expect(store.getClaim(RIVAL_CLAIM_ID)?.provenance).toStrictEqual(claim.provenance);
  });
});
