/**
 * Shaping ranked claims into ServedClaim objects and fitting them to the token budget.
 *
 * This module shapes retrieved claims for serving: copying the fields the client
 * needs, computing posterior summaries from Beta evidence, and packing claims
 * into a token budget by ranked order. v1 has no canonical views, so every
 * served claim is a raw claim with canonical false and no disclosure; the
 * 4-characters-per-token estimate is a v1 choice.
 *
 * @spec §7.1 step 4, §10
 */

import type { ServedClaim } from '../schema/index.js';
import type { ClaimRecord } from '../store/port.js';
import { confidence, posteriorWidth } from './score.js';

/** Characters per token in v1 token estimation. @spec §7.1 */
const CHARS_PER_TOKEN = 4;

/**
 * Shapes a claim for serving: extracts scalar fields, computes posterior
 * summaries from Beta evidence, and returns a ServedClaim without disclosure
 * or rivals.
 *
 * @spec §7.1 step 4, §10
 */
export function servedClaimOf(claim: ClaimRecord): ServedClaim {
  return {
    id: claim.id,
    text: claim.text,
    kind: claim.kind,
    tier: claim.tier,
    status: claim.status,
    posteriorMean: confidence(claim.evidence),
    posteriorWidth: posteriorWidth(claim.evidence),
    scope: claim.scope,
    canonical: claim.canonical,
  };
}

/**
 * Estimates token count for a served claim using character-based approximation.
 * Tokens are estimated as ceiling(JSON length / 4 chars per token).
 *
 * @spec §7.1, §10
 */
export function estimateTokens(served: ServedClaim): number {
  const jsonString = JSON.stringify(served);
  return Math.ceil(jsonString.length / CHARS_PER_TOKEN);
}

/**
 * Packs ranked claims into a token budget by walking in order.
 * Serves a claim when its token estimate fits the remaining budget,
 * otherwise skips and continues to the next.
 *
 * @spec §7.1 step 4, §10
 */
export function packClaims(
  ranked: readonly { readonly claim: ClaimRecord }[],
  budgetTokens: number,
): ServedClaim[] {
  const packed: ServedClaim[] = [];
  let remainingBudget = budgetTokens;

  for (const item of ranked) {
    const served = servedClaimOf(item.claim);
    const tokens = estimateTokens(served);

    if (tokens <= remainingBudget) {
      packed.push(served);
      remainingBudget -= tokens;
    }
  }

  return packed;
}
