/**
 * The referent index, read and maintained as what it is: a view.
 *
 * Every read in this module derives its answer from the ledger or from the
 * projection the ledger can regenerate — never from a field in the port's
 * memory. That is what lets a freshly opened `openIngest` over a populated
 * database serve referents it never wrote, and what makes `rebuild-index` a
 * check on the design rather than a courtesy.
 *
 * The two enumerations here page the port's ledger scans (`listClaimIds`,
 * `listEntityIds`) to exhaustion. They used to be KNN probes with a fixed unit
 * vector, which was never an enumeration at all — it was the first page of one,
 * capped at what `sqlite-vec` would accept as `k` and silently short past that.
 * Nothing bounds them now except the table: a caller here stops on an empty
 * page, never on a full one.
 *
 * @spec §3.1, §3.5, §5.2, §11
 */

import {
  type ClaimRecord,
  type ClaimStatus,
  type Entity,
  type GraphStore,
  type Regime,
} from '../store/index.js';
import { namingClaimId } from './ids.js';
import { decodeSpineClaim, type ExistencePayload } from './spine.js';

/**
 * Pages a keyset scan until it is exhausted.
 *
 * Exhaustion is an *empty* page, never a short one: `limit` is an upper bound
 * the store is free to come in under, so a caller that stopped at the first page
 * thinner than it asked for would truncate the enumeration exactly as the KNN
 * probe used to. The page size is the store's — the scan is the layer that knows
 * what one page costs, and a number chosen again here would be a second answer
 * to a question already settled.
 *
 * Refuses a page that does not end above the bound it was given. `afterId` is
 * positional (§11): a page's last id becomes the next page's bound, and a store
 * that hands back a page ending at or below its own bound will hand back the
 * same or an overlapping page forever. That is not a case this loop degrades on
 * — with no upper bound of its own, a `for (;;)` reading such a store never
 * yields to `testTimeout`, and never stops growing `ids`. A store making that
 * mistake is broken; the refusal is what turns the failure from a wedged process
 * into a thrown error that names the id it got stuck on.
 *
 * @spec §11
 */
const drainScan = (
  what: string,
  page: (afterId?: string) => readonly string[],
): string[] => {
  const ids: string[] = [];
  let afterId: string | undefined;
  for (;;) {
    const next = page(afterId);
    if (next.length === 0) return ids;
    const last = next[next.length - 1]!;
    if (afterId !== undefined && last <= afterId)
      throw new Error(
        `${what} did not advance past ${afterId} — a page must end above the bound it was given, or a drain can never terminate`,
      );
    ids.push(...next);
    afterId = last;
  }
};

/** The statuses §6.1 leaves standing. A retired existence claim stops speaking for its referent. @spec §6.1 */
const LIVE_STATUSES: readonly ClaimStatus[] = ['provisional', 'active', 'disputed'];

/**
 * Whether a status is one §6.1 leaves standing.
 *
 * {@link isLive}'s test, lifted out so a caller holding a narrow read like
 * {@link GraphStore.getClaimSummary} — a status and nothing else — can ask it
 * without hydrating a whole {@link ClaimRecord} first.
 *
 * @spec §6.1
 */
export const isLiveStatus = (status: ClaimStatus): boolean => LIVE_STATUSES.includes(status);

/** Whether a claim still speaks for anything. @spec §6.1 */
export const isLive = (claim: ClaimRecord): boolean => isLiveStatus(claim.status);

/**
 * A referent as the rest of the system sees it: §3.1's index row, plus the
 * existence claim it is a view over.
 *
 * `status` and `regime` are read off that claim rather than stored twice — the
 * index materializes the claim's regime (§3.1), and two declarations of one
 * fact are two facts that can drift.
 *
 * @spec §3.1, §3.5, §6.1
 */
export interface Referent {
  readonly id: string;
  /** Derived: the most-corroborated surface form. @spec §3.1 */
  readonly name: string;
  /** `null` until a containment claim places it. @spec §3.1 */
  readonly level: string | null;
  /** `view` while any noun source attests it, `evidence` otherwise. @spec §3.1 */
  readonly regime: Regime;
  /** The lifecycle state of the existence claim below. @spec §6.1 */
  readonly status: ClaimStatus;
  /** The claim this row is a view over. @spec §3.1, §3.5 */
  readonly existenceClaimId: string;
}

/** One existence claim, with the payload that says what it declared. @spec §3.1 */
export interface ExistenceClaim {
  readonly claim: ClaimRecord;
  readonly payload: ExistencePayload;
}

/** Every claim id in the ledger, archived ones included, in id order. @spec §3.2, §11 */
export const scanClaimIds = (store: GraphStore): string[] =>
  drainScan('listClaimIds', (afterId) => store.listClaimIds(afterId));

/** Every referent id in the index, in id order. @spec §3.1, §11 */
export const scanReferentIds = (store: GraphStore): string[] =>
  drainScan('listEntityIds', (afterId) => store.listEntityIds(afterId));

/**
 * The existence claims attached to a referent, oldest first.
 *
 * Read through `ABOUT` rather than through `scope`, because `ABOUT` is the edge
 * the store can answer a reverse query on and `scope` is a column on a row we
 * would have to find first.
 *
 * @spec §3.3, §5.3
 */
export const existenceClaimsOf = (store: GraphStore, referentId: string): ExistenceClaim[] => {
  const found: ExistenceClaim[] = [];
  for (const claimId of store.getClaimsAbout(referentId, { includeArchived: true })) {
    const claim = store.getClaim(claimId);
    if (claim === undefined) continue;
    const payload = decodeSpineClaim(claim.text);
    if (payload?.claim !== 'existence' || payload.referent !== referentId) continue;
    found.push({ claim, payload });
  }
  return found.sort((left, right) => (left.claim.id < right.claim.id ? -1 : 1));
};

/**
 * The existence claim a referent currently stands on.
 *
 * View beats evidence, which is §3.1's rule read literally: a referent is in the
 * view regime *while any noun source attests it*, so one live attestation
 * decides the regime however many retired existence claims sit behind it. Ties
 * inside a regime go to the oldest claim, so two sources attesting one referent
 * agree on which row the index materializes — including after a rebuild, where
 * the arrival order is gone and only the ids remain.
 *
 * @spec §3.1, §6.1
 */
export const standingExistenceClaim = (
  store: GraphStore,
  referentId: string,
): ExistenceClaim | undefined => {
  const live = existenceClaimsOf(store, referentId).filter((entry) => isLive(entry.claim));
  const attested = live.filter((entry) => entry.claim.regime === 'view');
  return (attested.length > 0 ? attested : live)[0];
};

/**
 * Reads one referent, or `undefined` when the index holds no row for it.
 *
 * A referent whose existence claims have all been retired is not reported: the
 * row is a view over a claim, and there is no claim left for it to be a view of.
 *
 * @spec §3.1, §6.1
 */
export const readReferent = (store: GraphStore, referentId: string): Referent | undefined => {
  const entity = store.getEntity(referentId);
  if (entity === undefined) return undefined;
  const standing = standingExistenceClaim(store, referentId);
  if (standing === undefined) return undefined;
  return {
    id: entity.id,
    name: entity.name,
    level: entity.level,
    regime: standing.claim.regime,
    status: standing.claim.status,
    existenceClaimId: standing.claim.id,
  };
};

/** Every referent in the index, in id order. @spec §3.1 */
export const readAllReferents = (store: GraphStore): Referent[] => {
  const referents: Referent[] = [];
  for (const id of scanReferentIds(store)) {
    const referent = readReferent(store, id);
    if (referent !== undefined) referents.push(referent);
  }
  return referents;
};

/**
 * The support standing behind one naming, read off the ledger.
 *
 * Zero for a pair no naming claim was ever written for, and zero for one whose
 * claim carries no posterior. Both are absences rather than errors: the mention
 * index is keyed by referent id and never checked against anything, so a form
 * this returns nothing for is a form nothing corroborated — which is exactly the
 * weight it should be cached at.
 *
 * @spec §3.1, §4.1
 */
export const namingSupport = (
  store: GraphStore,
  referentId: string,
  surfaceForm: string,
): number => {
  const evidence = store.getEvidence(namingClaimId(referentId, surfaceForm));
  return evidence === undefined || evidence === null ? 0 : evidence.alpha;
};

/**
 * §3.1's derived name: the most-corroborated surface form, ties broken by the
 * smaller surface form.
 *
 * The tally arrives weight-descending, so the head's weight is the best support
 * any form has and the tie is whatever else equals it. Equality here is exact and
 * can be: every weight is a sum of §15 tier weights times §4.2's powers of two,
 * and two forms corroborated the same way sum the same terms in the same order.
 *
 * The forms and not the arrival order. A tally's `rowid` order is a fact about
 * which form this database saw first, and a rebuild that replays the ledger in
 * claim order does not see them in that order — so a tie broken by arrival is a
 * graph that can change its own name for a reason nothing recorded. The forms
 * are the two things already being compared, and they are the same two strings
 * in every database that saw the same naming claims — so this tiebreak answers
 * the same way in all of them, however the referent underneath came to exist. A
 * tiebreak on the naming-claim id would not: that id hashes the referent id
 * (§3.5), which is a content hash only when a noun source attested the referent
 * and a fresh ULID under §3.1's baseline usage-emergence, where it would make
 * the name a coin flipped separately in each database.
 *
 * `<` and not `localeCompare`: the comparison orders UTF-16 code units, which is
 * a property of the two strings alone. A collator's answer depends on the ICU
 * data and locale of the machine asking, which is exactly the database-specific
 * dependence this tiebreak exists to shed.
 *
 * @spec §3.1, §3.5, §4.2, §11
 */
export const deriveName = (store: GraphStore, referentId: string): string | undefined => {
  const tally = store.getMentionTally(referentId);
  const best = tally[0];
  if (best === undefined) return undefined;

  let winner = best.surfaceForm;
  for (const entry of tally) {
    if (entry.weight < best.weight) break;
    if (entry.surfaceForm < winner) winner = entry.surfaceForm;
  }
  return winner;
};

/**
 * Writes an entity row, leaving every field the caller did not name alone.
 *
 * `locator` is passed through by *presence*, never by value: the store omits the
 * key for a referent that has none, and an explicit `null` would be a different
 * row than an absent one — one `toStrictEqual` notices, and one a rebuild would
 * have to reproduce by accident.
 *
 * @spec §3.1
 */
export const writeEntity = (
  store: GraphStore,
  current: Entity | undefined,
  changes: Partial<Entity> & { readonly id: string },
): void => {
  const base: Entity =
    current ?? {
      id: changes.id,
      name: changes.name ?? changes.id,
      level: null,
      regime: 'evidence',
      glossEmbedding: [],
      facets: [],
    };
  const hasLocator = 'locator' in changes || (current !== undefined && 'locator' in current);
  const locator = 'locator' in changes ? changes.locator : current?.locator;
  store.putEntity({
    ...base,
    ...changes,
    ...(hasLocator ? { locator } : {}),
  });
};
