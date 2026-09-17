/**
 * §7.1 steps 2–3 and §7.2: gathering candidate claims reachable through spine
 * and ANN, ranking them by band relevance, posterior confidence, and status penalty.
 *
 * v1 bands: anchor + containment ancestors (no structural floor or children yet).
 * Spine reaches the anchor and its ancestors on the containment spine; ANN
 * reaches all claim embeddings above the cosine floor. Deprecated and archived
 * claims are dropped outright. Spine claims (existence, naming, containment)
 * written with the kgmem-spine footer are excluded as they are ledger machinery
 * rather than user-asked knowledge.
 *
 * @spec §7.1, §7.2, §7.8
 */

import type { EmbeddingProvider } from '../store/ports/embedding-provider.js';
import type { GraphStore } from '../store/index.js';
import type { Band } from './score.js';
import { scoreClaim } from './score.js';
import { COSINE_FLOOR, CANDIDATE_CAP } from '../referents/ladder.js';
import type { ClaimRecord } from '../store/port.js';
import { decodeSpineClaim } from '../referents/spine.js';

/**
 * Bound on the containment walk, also a cycle guard backstop.
 *
 * @spec §7.1, §7.2
 */
export const MAX_ANCESTOR_DEPTH = 32;

/**
 * A candidate claim ranked for serving in a query response.
 *
 * @spec §7.1, §7.2
 */
export interface Candidate {
  readonly claim: ClaimRecord;
  readonly band: Band;
  readonly score: number;
}

/**
 * Gathers and ranks candidate claims for a query through spine and ANN paths.
 *
 * The spine path (when anchor is defined and modes includes 'spine') reaches
 * the anchor and its ancestors on the containment spine, up to depth 32.
 * The ANN path (when modes includes 'ann') searches claim embeddings via
 * semantic similarity, and runs only when the spine did not.
 *
 * Claims are scored by band relevance, posterior confidence, and lifecycle
 * status. Deprecated and archived claims are dropped. Spine claims are filtered
 * to exclude the ledger machinery that rebuilds the indexes from the ledger.
 * Results are deduplicated by claim id (keeping the higher score) and sorted by
 * score descending, then claim id ascending.
 *
 * @spec §7.1, §7.2, §7.8
 */
export async function gather(
  context: { store: GraphStore; embeddings: EmbeddingProvider },
  request: { task: string; modes: readonly ('spine' | 'ann' | 'traverse')[] },
  anchor: { readonly id: string } | undefined,
): Promise<Candidate[]> {
  const { store, embeddings } = context;
  const { task, modes } = request;

  const candidates = new Map<string, Candidate>();

  if (anchor && modes.includes('spine')) {
    const anchorClaimIds = store.getClaimsAbout(anchor.id);
    for (const claimId of anchorClaimIds) {
      addCandidate(candidates, store, claimId, { kind: 'anchor' });
    }

    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: anchor.id, depth: 0 }];
    visited.add(anchor.id);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= MAX_ANCESTOR_DEPTH) break;

      const parents = store.getParents(current.id);
      for (const parentId of parents) {
        if (visited.has(parentId)) continue;
        visited.add(parentId);

        const ancestorDepth = current.depth + 1;
        const ancestorClaimIds = store.getClaimsAbout(parentId);
        for (const claimId of ancestorClaimIds) {
          addCandidate(candidates, store, claimId, {
            kind: 'ancestor',
            depth: ancestorDepth,
          });
        }

        queue.push({ id: parentId, depth: ancestorDepth });
      }
    }
  } else if (modes.includes('ann')) {
    const taskEmbedding = await embeddings.embed(task, 'query');
    const hits = store.searchClaims({ embedding: taskEmbedding, limit: CANDIDATE_CAP });

    for (const hit of hits) {
      if (hit.cosine < COSINE_FLOOR) continue;
      addCandidate(candidates, store, hit.claimId, { kind: 'ann', cosine: hit.cosine });
    }
  }

  const results = Array.from(candidates.values());
  results.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0;
  });

  return results;
}

/**
 * Helper to add or update a candidate claim in the map.
 *
 * Reads the claim from the store, scores it, and updates the map only if the
 * new score is higher than any existing score for this claim (deduplication).
 *
 * Skips claims not found in the store, with undefined scores (deprecated/archived),
 * or with spine claim payloads. Spine claims exist so the referent, mention, and
 * containment indexes can be rebuilt from the ledger (§11); they are ledger
 * machinery rather than knowledge an agent asked about. On a real graph they
 * outnumber content claims and would consume the answer's token budget.
 *
 * @spec §7.1, §7.2, §11
 */
function addCandidate(
  candidates: Map<string, Candidate>,
  store: GraphStore,
  claimId: string,
  band: Band,
): void {
  const claim = store.getClaim(claimId);
  if (!claim) return;

  if (decodeSpineClaim(claim.text) !== undefined) return;

  const score = scoreClaim({ band, evidence: claim.evidence, status: claim.status });
  if (score === undefined) return;

  const existing = candidates.get(claimId);
  if (!existing || score > existing.score) {
    candidates.set(claimId, { claim, band, score });
  }
}
