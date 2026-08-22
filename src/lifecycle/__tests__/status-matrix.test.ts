import { describe, it } from 'vitest';

import type { ClaimStatus } from '../../schema/index';

/**
 * The §6.2 status × verdict matrix, transcribed as an executable backlog.
 *
 * Every cell of the spec's five-status by three-verdict grid appears here as one
 * or more `it.todo` cases named in the spec's own words. Nothing is implemented:
 * the adjudication logic these describe is P3 work, and this file is the list it
 * has to burn down.
 *
 * `LifecycleStatus` now re-points at the schema module's `ClaimStatus`, since the
 * RED-phase constraint that kept this suite from importing it (the schema module
 * was still unwritten) no longer holds. `Verdict` and `TierScope` stay as local
 * unions: §6.2's verdict labels and tier-scope groupings ('any tier', 'observed /
 * inferred') are matrix-only vocabulary with no corresponding schema export to
 * point at — `TierScope` is not `ClaimTier`.
 *
 * @spec §6.1, §6.2, §6.3
 */

/** The five lifecycle states, down the side of the §6.2 matrix. @spec §3.5, §6.1 */
export type LifecycleStatus = ClaimStatus;

/** The three incoming-verdict columns across the top of the §6.2 matrix. @spec §6.2 */
export type Verdict = 'DUPLICATE / SUPPORTS' | 'CONTRADICTS' | 'REFINES';

/**
 * Which tier the cell's behaviour is stated for. §6.3 makes tier a privilege
 * level cutting across every cell, so cells whose text splits on tier are
 * transcribed as separate cells rather than collapsed.
 *
 * @spec §6.3
 */
export type TierScope = 'any tier' | 'verified' | 'observed / inferred';

/** One behaviour-bearing cell of the matrix, keyed by verdict and tier scope. @spec §6.2 */
export interface MatrixCell {
  readonly verdict: Verdict;
  readonly tierScope: TierScope;
  readonly behaviours: readonly string[];
}

/** One row of the matrix: a current status and every cell reachable from it. @spec §6.2 */
export interface MatrixRow {
  readonly status: LifecycleStatus;
  readonly cells: readonly MatrixCell[];
}

/**
 * The §6.2 matrix in full. `w` throughout is the tier-weighted increment of
 * §4.2 (verified 3.0 / observed 1.0 / inferred 0.5, §15).
 *
 * @spec §6.2, §4.2, §15
 */
export const STATUS_VERDICT_MATRIX: readonly MatrixRow[] = [
  {
    status: 'provisional',
    cells: [
      {
        verdict: 'DUPLICATE / SUPPORTS',
        tierScope: 'any tier',
        behaviours: [
          'alpha += w',
          'promotes to active at tau_promote (0.80)',
        ],
      },
      {
        verdict: 'CONTRADICTS',
        tierScope: 'any tier',
        behaviours: [
          'beta += w',
          'deprecates directly when the posterior falls below tau — no dispute ceremony, nothing relied on it yet',
        ],
      },
      {
        verdict: 'REFINES',
        tierScope: 'any tier',
        behaviours: [
          'successor is seeded from the original prior',
          'original usually deprecates when the successor promotes',
        ],
      },
    ],
  },
  {
    status: 'active',
    cells: [
      {
        verdict: 'DUPLICATE / SUPPORTS',
        tierScope: 'any tier',
        behaviours: [
          'alpha += w',
          'refreshes lastCorroborated',
        ],
      },
      {
        verdict: 'CONTRADICTS',
        tierScope: 'any tier',
        behaviours: [
          'beta += w',
          'moves to disputed when the posterior falls below tau_dispute (0.65)',
          'moves to disputed on two or more distinct contradicting episodes',
        ],
      },
      {
        verdict: 'CONTRADICTS',
        tierScope: 'verified',
        behaviours: [
          'moves to disputed unconditionally — verified tier needs no posterior or episode threshold',
        ],
      },
      {
        verdict: 'REFINES',
        tierScope: 'any tier',
        behaviours: [
          'successor is minted with a REFINES edge',
          'original is flagged for the consolidator — it often narrows scope rather than dying',
        ],
      },
    ],
  },
  {
    status: 'disputed',
    cells: [
      {
        verdict: 'DUPLICATE / SUPPORTS',
        tierScope: 'verified',
        behaviours: [
          'resolves the dispute and returns the claim to active',
          'deprecates the rival via SUPERSEDED_BY',
        ],
      },
      {
        verdict: 'DUPLICATE / SUPPORTS',
        tierScope: 'observed / inferred',
        behaviours: [
          'accumulates only — cannot resolve the dispute',
        ],
      },
      {
        verdict: 'CONTRADICTS',
        tierScope: 'verified',
        behaviours: [
          'resolves against the claim and deprecates it',
          'promotes the rival',
        ],
      },
      {
        verdict: 'CONTRADICTS',
        tierScope: 'observed / inferred',
        behaviours: [
          'weaker tiers accumulate only — cannot resolve the dispute',
        ],
      },
      {
        verdict: 'REFINES',
        tierScope: 'any tier',
        behaviours: [
          'allowed and common — dispute resolution is often "both half-right"',
          'successor supersedes both the claim and its rival',
        ],
      },
    ],
  },
  {
    status: 'deprecated',
    cells: [
      {
        verdict: 'DUPLICATE / SUPPORTS',
        tierScope: 'any tier',
        behaviours: [
          'treats corroboration as a resurrection signal and never flips the claim back',
          'mints a new claim DERIVED_FROM the corpse, seeded from its old posterior',
          'leaves history linear — the corpse keeps its deprecated status',
        ],
      },
      {
        verdict: 'CONTRADICTS',
        tierScope: 'any tier',
        behaviours: [
          'counts as mild support for its successor, transitively via SUPERSEDED_BY',
        ],
      },
      {
        verdict: 'REFINES',
        tierScope: 'any tier',
        behaviours: [
          'is rare, and is treated as a new claim carrying an ancestry edge',
        ],
      },
    ],
  },
  {
    status: 'archived',
    cells: [
      {
        verdict: 'DUPLICATE / SUPPORTS',
        tierScope: 'any tier',
        behaviours: [
          'is excluded from candidate retrieval entirely — an archived claim surfacing from ANN is a bug',
        ],
      },
      {
        verdict: 'CONTRADICTS',
        tierScope: 'any tier',
        behaviours: [
          'has no cell: exclusion from candidates means no contradiction verdict can reach an archived claim',
        ],
      },
      {
        verdict: 'REFINES',
        tierScope: 'any tier',
        behaviours: [
          'has no cell: exclusion from candidates means no refinement verdict can reach an archived claim',
        ],
      },
    ],
  },
];

describe.each(STATUS_VERDICT_MATRIX)('§6.2 current status: $status', ({ cells }) => {
  describe.each(cells)('incoming $verdict ($tierScope)', ({ behaviours }) => {
    for (const behaviour of behaviours) {
      it.todo(behaviour);
    }
  });
});
