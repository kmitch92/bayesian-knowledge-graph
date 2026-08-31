/**
 * §4.2's observation weight, and the §15 constants behind it.
 *
 * ```
 * w = tier × episode_cap × taint
 * ```
 *
 * The store deliberately refuses to know any of this — {@link GraphStore} takes
 * a weight and adds it, and takes a prior as a parameter rather than deriving
 * one — because §5.8 tunes these numbers by offline replay, and a constant baked
 * into a storage layer is a constant no replay can reach.
 *
 * @spec §3.2, §4.2, §4.3, §4.4, §15
 */

import type { ClaimTier, Evidence } from '../store/index.js';

/** §15's tier weights: a test outranks a reading outranks a guess. @spec §4.2, §15 */
export const TIER_WEIGHT: Readonly<Record<ClaimTier, number>> = {
  verified: 3,
  observed: 1,
  inferred: 0.5,
};

/** §15's `τ_promote`: the posterior mean a provisional claim becomes active at. @spec §6.2, §15 */
export const TAU_PROMOTE = 0.8;

/**
 * §15's prior. Inferred-tier claims seed the skeptical β₀ = 2 (§3.2): model
 * reasoning with no observation behind it starts out doubted, not neutral.
 *
 * @spec §3.2, §15
 */
export const priorFor = (tier: ClaimTier): Evidence =>
  tier === 'inferred' ? { alpha: 1, beta: 2 } : { alpha: 1, beta: 1 };

/**
 * §4.2's episode cap: 1, ½, ¼, … per repeat contribution from one episode.
 *
 * *"An agent saying something three times in one session is one observation, not
 * three."* The series converges, so no amount of repetition inside a single
 * episode reaches τ_promote on its own — which is the difference between
 * corroboration and insistence.
 *
 * @spec §4.2, §4.4
 */
export const episodeCap = (priorContributions: number): number => 2 ** -priorContributions;

/**
 * The weight one observation carries.
 *
 * `tainted` covers both §4.3's echo loop and §5.1's replay: an episode that
 * already made this contribution makes it again at weight zero, so a retried
 * tool call moves no posterior at all.
 *
 * @spec §4.2, §4.3, §5.1
 */
export const observationWeight = (
  tier: ClaimTier,
  priorContributions: number,
  tainted: boolean,
): number => (tainted ? 0 : TIER_WEIGHT[tier] * episodeCap(priorContributions));

/** §4.1's posterior mean. @spec §4.1 */
export const posteriorMean = (evidence: Evidence): number =>
  evidence.alpha / (evidence.alpha + evidence.beta);
