/**
 * Scoring a gathered claim for serving: relevance × confidence × status_penalty × freshness.
 *
 * This module decides when claims are served and how they rank. The values chosen for
 * STATUS_PENALTY (active 1, disputed 0.75, provisional 0.5, deprecated/archived unserved),
 * ANCESTOR_DECAY (0.8), and freshness (1 in v1) are deliberate v1 choices left open by
 * §7.1 and §15, to be reviewed at the phase-1 checkpoint.
 *
 * Provisional claims are served ranked below active by user ruling 2026-09-14.
 *
 * @spec §7.1 step 3, §15
 */

import type { ClaimStatus, Evidence } from '../schema/index.js';
import { posteriorMean } from '../ingest/evidence.js';

/** Decay factor applied to ancestor relevance per containment level. @spec §7.1, §15 */
export const ANCESTOR_DECAY = 0.8;

/** Two-sided 95% confidence normal quantile. @spec §7.1 */
const NORMAL_QUANTILE_95 = 1.959964;

/**
 * Describes how a claim was retrieved: through direct containment, ancestor,
 * or embedding similarity.
 *
 * @spec §7.1
 */
export type Band =
  | { readonly kind: 'anchor' }
  | { readonly kind: 'ancestor'; readonly depth: number }
  | { readonly kind: 'ann'; readonly cosine: number };

/**
 * Relevance score based on retrieval band: 1 for direct containment,
 * exponentially decaying ancestor distance, or cosine similarity for embeddings.
 *
 * @spec §7.1
 */
export function bandRelevance(band: Band): number {
  switch (band.kind) {
    case 'anchor':
      return 1;
    case 'ancestor':
      return ANCESTOR_DECAY ** band.depth;
    case 'ann':
      return band.cosine;
  }
}

/**
 * Posterior mean confidence in a claim's truth from Bayesian evidence.
 * Returns 1 for view-regime claims (null evidence) that carry no posterior.
 *
 * @spec §4.1, §7.1
 */
export function confidence(evidence: Evidence | null): number {
  if (evidence === null) {
    return 1;
  }
  return posteriorMean(evidence);
}

/**
 * Width of the 95% credible interval around a Beta posterior.
 * Returns 0 for view-regime claims (null evidence).
 * Clamped to at most 1 (the full [0, 1] range).
 *
 * For Beta(α, β):
 * sd = sqrt(αβ / ((α+β)² (α+β+1)))
 * width = 2 × Z × sd where Z is the two-sided 95% confidence normal quantile (≈ 1.959964)
 *
 * @spec §4.1, §7.1
 */
export function posteriorWidth(evidence: Evidence | null): number {
  if (evidence === null) {
    return 0;
  }

  const { alpha, beta } = evidence;
  const sum = alpha + beta;
  const numerator = alpha * beta;
  const denominator = sum * sum * (sum + 1);
  const sd = Math.sqrt(numerator / denominator);
  const width = 2 * NORMAL_QUANTILE_95 * sd;
  return Math.min(width, 1);
}

/** Penalty factors by claim lifecycle status. @spec §6.1, §7.1, §15 */
const STATUS_PENALTIES: Readonly<Record<ClaimStatus, number | undefined>> = {
  active: 1,
  disputed: 0.75,
  provisional: 0.5,
  deprecated: undefined,
  archived: undefined,
};

/**
 * Status penalty: how much a claim's credibility is discounted by its lifecycle state.
 * Deprecated and archived claims are not served (undefined return value).
 *
 * @spec §6.1, §7.1, §15
 */
export function statusPenalty(status: ClaimStatus): number | undefined {
  return STATUS_PENALTIES[status];
}

/**
 * Composite relevance score: band relevance × confidence × status penalty.
 * Freshness is fixed at 1 in v1.
 * Returns undefined when the claim is not served (deprecated or archived).
 *
 * @spec §7.1, §15
 */
export function scoreClaim({
  band,
  evidence,
  status,
}: {
  readonly band: Band;
  readonly evidence: Evidence | null;
  readonly status: ClaimStatus;
}): number | undefined {
  const penalty = statusPenalty(status);
  if (penalty === undefined) {
    return undefined;
  }
  const relevance = bandRelevance(band);
  const conf = confidence(evidence);
  return relevance * conf * penalty;
}
