/**
 * Resolving the entity a query is anchored at.
 *
 * The orchestrator's design for §7.1 step 1: choosing an entity from either an
 * explicit anchor or the task text itself. The resolution ladder runs five rungs:
 *
 * 1. **rung `id`**: anchor given and it is an entity id in the store.
 * 2. **rung `mention`**: anchor given and it names a referent in the mention index.
 * 3. **rung `mention`**: task text contains a surface form (1–3 word runs) that names
 *    a referent. No embedding call on this path; the mention index is the gate.
 * 4. **rung `gloss`**: task embedded as a query, searched against referent gloss
 *    embeddings; hits at cosine ≥ `COSINE_FLOOR` are candidates.
 * 5. **undefined**: nothing resolved.
 *
 * The name runs (step 3) are tried before any embedding (step 4) to minimize model
 * calls when a name matches. "Most specific" is read as deepest on the containment
 * spine, breaking ties by gloss cosine similarity when both methods resolve.
 *
 * @spec §5.2, §7.1, §7.2
 */

import type { EmbeddingProvider } from '../store/ports/embedding-provider.js';
import type { GraphStore } from '../store/index.js';
import { COSINE_FLOOR, CANDIDATE_CAP } from '../referents/ladder.js';

/**
 * An entity resolved as the anchor of a query.
 *
 * @spec §7.1
 */
export interface ResolvedAnchor {
  /** The entity's id in the store. */
  readonly id: string;
  /** The entity's name from the store (most-corroborated surface form). */
  readonly name: string;
  /** The entity's level if recorded, or null if unplaced. */
  readonly level: string | null;
  /** Which rung of the resolution ladder answered. */
  readonly rung: 'id' | 'mention' | 'gloss';
}

/**
 * Calculates the depth of an entity via its parent chain.
 *
 * Depth is the number of steps in the longest upward chain via `store.getParents`,
 * with cycle detection and a maximum of 32 steps.
 */
function depthOf(store: GraphStore, id: string): number {
  const visited = new Set<string>();
  let depth = 0;
  let current = id;
  const maxDepth = 32;

  while (depth < maxDepth) {
    visited.add(current);
    const parents = store.getParents(current);
    const unvisitedParent = parents.find((p) => !visited.has(p));

    if (unvisitedParent === undefined) {
      break;
    }

    current = unvisitedParent;
    depth += 1;
  }

  return depth;
}

/**
 * Resolves an entity from either an explicit anchor or the task text.
 *
 * Tries the resolution ladder in order, returning the first match:
 * 1. Anchor as entity id
 * 2. Anchor as mention surface form
 * 3. Task text surface forms (1–3 word runs)
 * 4. Task text embedding against gloss index
 * 5. Undefined
 */
export async function resolveAnchor(
  context: { store: GraphStore; embeddings: EmbeddingProvider },
  request: { task: string; anchor?: string | undefined },
): Promise<ResolvedAnchor | undefined> {
  const { store, embeddings } = context;
  const { task, anchor } = request;

  // Step 1: Anchor given and it is an entity id
  if (anchor && anchor.length > 0) {
    const entity = store.getEntity(anchor);
    if (entity) {
      return {
        id: entity.id,
        name: entity.name,
        level: entity.level ?? null,
        rung: 'id',
      };
    }

    // Step 2: Anchor given, not an id, but mention index knows it
    const mentionCandidates = store.findReferentsByMention(anchor);
    if (mentionCandidates.length > 0) {
      const deepestCandidate = mentionCandidates.reduce((best, candidate) => {
        const bestDepth = depthOf(store, best.referentId);
        const candidateDepth = depthOf(store, candidate.referentId);
        return candidateDepth > bestDepth ? candidate : best;
      });

      const entity = store.getEntity(deepestCandidate.referentId);
      if (entity) {
        return {
          id: entity.id,
          name: entity.name,
          level: entity.level ?? null,
          rung: 'mention',
        };
      }
    }
  }

  // Step 3: From task, extract words and try surface forms (1–3 word runs)
  const words = task
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, '').trim())
    .filter((word) => word.length > 0);

  let bestMentionResult: { candidate: { referentId: string }; run: number; position: number } | undefined;

  for (let runLength = Math.min(3, words.length); runLength >= 1; runLength--) {
    for (let position = 0; position <= words.length - runLength; position++) {
      const surfaceForm = words.slice(position, position + runLength).join(' ');
      const candidates = store.findReferentsByMention(surfaceForm);

      for (const candidate of candidates) {
        const entity = store.getEntity(candidate.referentId);
        if (!entity) continue;

        // Only update if this is a longer run, or same length but deeper, or same depth but earlier position
        if (
          !bestMentionResult ||
          runLength > bestMentionResult.run ||
          (runLength === bestMentionResult.run &&
            depthOf(store, candidate.referentId) > depthOf(store, bestMentionResult.candidate.referentId)) ||
          (runLength === bestMentionResult.run &&
            depthOf(store, candidate.referentId) === depthOf(store, bestMentionResult.candidate.referentId) &&
            position < bestMentionResult.position)
        ) {
          bestMentionResult = { candidate, run: runLength, position };
        }
      }
    }
  }

  if (bestMentionResult) {
    const entity = store.getEntity(bestMentionResult.candidate.referentId);
    if (entity) {
      return {
        id: entity.id,
        name: entity.name,
        level: entity.level ?? null,
        rung: 'mention',
      };
    }
  }

  // Step 4: Embed the task and search gloss index
  const taskEmbedding = await embeddings.embed(task, 'query');
  const glossHits = store.searchReferentGlosses({
    embedding: taskEmbedding,
    limit: CANDIDATE_CAP,
  });

  let bestGlossResult: { referentId: string; cosine: number } | undefined;

  for (const hit of glossHits) {
    if (hit.cosine < COSINE_FLOOR) continue;

    const entity = store.getEntity(hit.referentId);
    if (!entity) continue;

    if (
      !bestGlossResult ||
      depthOf(store, hit.referentId) > depthOf(store, bestGlossResult.referentId) ||
      (depthOf(store, hit.referentId) === depthOf(store, bestGlossResult.referentId) &&
        hit.cosine > bestGlossResult.cosine)
    ) {
      bestGlossResult = { referentId: hit.referentId, cosine: hit.cosine };
    }
  }

  if (bestGlossResult) {
    const entity = store.getEntity(bestGlossResult.referentId);
    if (entity) {
      return {
        id: entity.id,
        name: entity.name,
        level: entity.level ?? null,
        rung: 'gloss',
      };
    }
  }

  // Step 5: Nothing resolved
  return undefined;
}
