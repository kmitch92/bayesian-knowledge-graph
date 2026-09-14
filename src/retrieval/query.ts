/**
 * Composition of a complete retrieval query: resolving the anchor, gathering
 * claims, packing to budget, handling rivals, and recording taint.
 *
 * This module composes the full retrieval pipeline from the five simpler steps
 * (resolveAnchor, gather claims by relevance and posterior mean, pack to
 * token budget, attach rival contests, record taint). v1 serves raw claims
 * only with containment bands and no traverse mode; rivals travel outside the
 * budget; taint is recorded but not yet enforced as weight 0 (that needs P3
 * matching).
 *
 * @spec §3.1, §7.1, §7.2, §7.4, §7.5, §10
 */

import type { EmbeddingProvider } from '../store/ports/embedding-provider.js';
import type { GraphStore } from '../store/index.js';
import type { QueryRequest, QueryResponse, ServedClaim } from '../schema/index.js';
import { resolveAnchor } from './anchor.js';
import { gather } from './gather.js';
import { packClaims, servedClaimOf } from './pack.js';
import { statusPenalty } from './score.js';

const UNPLACED_LEVEL = 'unplaced';

/**
 * Gathers CONTRADICTS rivals whose claims exist and have defined status penalties,
 * de-duplicated by edge discovery order.
 *
 * @spec §7.1, §7.5
 */
function servableRivals(store: GraphStore, claimId: string): string[] {
  const edges = store.getClaimEdges(claimId);
  const rivalIds: string[] = [];
  const seenRivalIds = new Set<string>();

  for (const edge of edges) {
    if (edge.kind === 'CONTRADICTS') {
      const targetId = edge.to;
      if (seenRivalIds.has(targetId)) continue;

      const targetClaim = store.getClaim(targetId);
      if (targetClaim && statusPenalty(targetClaim.status) !== undefined) {
        rivalIds.push(targetId);
        seenRivalIds.add(targetId);
      }
    }
  }

  return rivalIds;
}

export async function runQuery(
  context: { store: GraphStore; embeddings: EmbeddingProvider; episodeId: string },
  request: QueryRequest,
): Promise<QueryResponse> {
  const { store, embeddings, episodeId } = context;

  const anchor = await resolveAnchor({ store, embeddings }, { task: request.task, anchor: request.anchor });

  const candidates = await gather({ store, embeddings }, { task: request.task, modes: request.modes }, anchor);

  const packed = packClaims(candidates, request.budgetTokens);

  const output: ServedClaim[] = [];
  const servedIds = new Set<string>();
  const packedIds = new Set(packed.map((c) => c.id));

  for (const served of packed) {
    const rivalIds = servableRivals(store, served.id);

    const claimWithRivals: ServedClaim = { ...served };
    if (rivalIds.length > 0) {
      claimWithRivals.rivals = rivalIds;
    }
    output.push(claimWithRivals);
    servedIds.add(served.id);

    for (const rivalId of rivalIds) {
      if (!packedIds.has(rivalId) && !servedIds.has(rivalId)) {
        const rivalClaim = store.getClaim(rivalId);
        if (rivalClaim) {
          const rivalServed = servedClaimOf(rivalClaim);
          const rivalRivalIds = servableRivals(store, rivalId);

          if (rivalRivalIds.length > 0) {
            rivalServed.rivals = rivalRivalIds;
          }

          output.push(rivalServed);
          servedIds.add(rivalId);
        }
      }
    }
  }

  if (servedIds.size > 0) {
    store.recordTaint({ episodeId, claimIds: Array.from(servedIds) });
  }

  const structural: Array<{ from: string; edge: string; to: string }> = anchor
    ? [
        ...store.getParents(anchor.id).map((parent) => ({ from: parent, edge: 'CONTAINS', to: anchor.id })),
        ...store.getChildren(anchor.id).map((child) => ({ from: anchor.id, edge: 'CONTAINS', to: child })),
      ]
    : [];

  const response: QueryResponse = {
    claims: output,
    structural,
    taintRecorded: true,
  };

  if (anchor) {
    response.anchor = {
      id: anchor.id,
      name: anchor.name,
      level: anchor.level ?? UNPLACED_LEVEL,
    };
  }

  return response;
}
