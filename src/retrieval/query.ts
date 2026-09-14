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
    const edges = store.getClaimEdges(served.id);
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

          const rivalEdges = store.getClaimEdges(rivalId);
          const rivalRivalIds: string[] = [];
          const seenRivalRivalIds = new Set<string>();

          for (const rEdge of rivalEdges) {
            if (rEdge.kind === 'CONTRADICTS') {
              const rTargetId = rEdge.to;
              if (seenRivalRivalIds.has(rTargetId)) continue;

              const rTargetClaim = store.getClaim(rTargetId);
              if (rTargetClaim && statusPenalty(rTargetClaim.status) !== undefined) {
                rivalRivalIds.push(rTargetId);
                seenRivalRivalIds.add(rTargetId);
              }
            }
          }

          if (rivalRivalIds.length > 0) {
            rivalServed.rivals = rivalRivalIds;
          }

          output.push(rivalServed);
          servedIds.add(rivalId);
        }
      }
    }
  }

  store.recordTaint({ episodeId, claimIds: Array.from(servedIds) });

  let structural: Array<{ from: string; edge: string; to: string }> = [];

  if (anchor) {
    const parents = store.getParents(anchor.id);
    structural = parents.map((parent) => ({ from: parent, edge: 'CONTAINS', to: anchor.id }));

    const children = store.getChildren(anchor.id);
    for (const child of children) {
      structural.push({ from: anchor.id, edge: 'CONTAINS', to: child });
    }
  }

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
