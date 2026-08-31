/**
 * `rebuild-index`: the three projections, regenerated from the claims ledger and
 * from nothing else.
 *
 * Diagram §4: *"Claims are the only primitive. Everything on the right is a
 * materialized view, rebuildable from the ledger. No foreign keys point from the
 * ledger onto views."* This module is where that stops being a slogan. It runs
 * against a store whose referent index, mention index and containment index have
 * just been dropped, holds no state of its own, and asks the ledger three
 * questions: which referents exist, what are they called, and what contains
 * what.
 *
 * Replay order is `(createdAt, id)`, not arrival order — arrival order is not a
 * thing the ledger records. Fresh ids are monotonic so id order *is* creation
 * order within a process, and `createdAt` orders the content-addressed ids a
 * noun source mints, which carry no clock in them at all.
 *
 * No model is consulted beyond re-embedding the glosses, and in particular the
 * coreference adjudicator is never called: a tiebreak that has already been paid
 * for is recorded as a naming claim, and re-deciding it would let a rebuild
 * change what the graph believes.
 *
 * @spec §3.1, §3.3, §5.2, §11
 */

import type { ClaimRecord, GraphStore } from '../store/index.js';
import {
  deriveName,
  isLive,
  scanClaimIds,
  scanReferentIds,
  writeEntity,
} from '../referents/index-view.js';
import {
  decodeSpineClaim,
  type ContainmentPayload,
  type ExistencePayload,
  type NamingPayload,
} from '../referents/spine.js';

import type { WriteContext } from './spine-writer.js';

/** One spine claim, paired with the row it was decoded from. */
interface Decoded<Payload> {
  readonly claim: ClaimRecord;
  readonly payload: Payload;
}

/** The ledger, oldest first, with `createdAt` deciding and the id breaking ties. @spec §11 */
const ledgerInOrder = (store: GraphStore): ClaimRecord[] => {
  const claims: ClaimRecord[] = [];
  for (const id of scanClaimIds(store)) {
    const claim = store.getClaim(id);
    if (claim !== undefined) claims.push(claim);
  }
  return claims.sort((left, right) => {
    if (left.temporal.createdAt !== right.temporal.createdAt)
      return left.temporal.createdAt < right.temporal.createdAt ? -1 : 1;
    return left.id < right.id ? -1 : 1;
  });
};

/**
 * Regenerates the referent index, the mention index and the containment index.
 *
 * Four passes, and the order is forced: a mention needs its referent to have a
 * name to be a name *for*, a containment edge needs both ends in the index
 * (§3.1's own constraint on `putContainment`), and the derived name cannot be
 * known until every naming has landed.
 *
 * @spec §3.1, §3.3, §11
 */
export const rebuildIndex = async (context: WriteContext): Promise<void> => {
  const { store } = context;
  const existence: Decoded<ExistencePayload>[] = [];
  const naming: Decoded<NamingPayload>[] = [];
  const containment: Decoded<ContainmentPayload>[] = [];

  for (const claim of ledgerInOrder(store)) {
    const payload = decodeSpineClaim(claim.text);
    // A retired spine claim is history, not structure: §6.1 keeps it readable,
    // and materializing it would resurrect a referent a retraction dropped.
    if (payload === undefined || !isLive(claim)) continue;
    if (payload.claim === 'existence') existence.push({ claim, payload });
    else if (payload.claim === 'naming') naming.push({ claim, payload });
    else containment.push({ claim, payload });
  }

  // Pass 1 — the referents, and the form each was minted under.
  for (const { claim, payload } of existence) {
    const gloss = await context.embeddings.embed(payload.surfaceForm, 'document');
    writeEntity(store, store.getEntity(payload.referent), {
      id: payload.referent,
      name: payload.surfaceForm,
      level: payload.level,
      regime: claim.regime,
      glossEmbedding: Array.from(gloss),
      facets: [],
      ...('locator' in payload ? { locator: payload.locator } : {}),
    });
    store.putMention({ surfaceForm: payload.surfaceForm, referentId: payload.referent });
  }

  // Pass 2 — every other form the graph learned, including the ones a tiebreak
  // decided. The model is not asked again.
  for (const { payload } of naming)
    store.putMention({ surfaceForm: payload.surfaceForm, referentId: payload.referent });

  // Pass 3 — the spine, and the levels it placed. Both ends must be in the index
  // by now; a containment claim naming a referent nothing attests any more is
  // skipped rather than resurrecting it.
  for (const { payload } of containment) {
    const child = store.getEntity(payload.child);
    if (store.getEntity(payload.parent) === undefined || child === undefined) continue;
    store.putContainment({ parent: payload.parent, child: payload.child });
    if (child.level !== payload.childLevel)
      writeEntity(store, child, { id: child.id, level: payload.childLevel });
  }

  // Pass 4 — §3.1's derived name, now that the whole mention cluster is back.
  for (const referentId of scanReferentIds(store)) {
    const entity = store.getEntity(referentId);
    if (entity === undefined) continue;
    const derived = deriveName(store, referentId);
    if (derived === undefined || derived === entity.name) continue;
    const gloss = await context.embeddings.embed(derived, 'document');
    writeEntity(store, entity, {
      id: referentId,
      name: derived,
      glossEmbedding: Array.from(gloss),
    });
  }
};
