/**
 * The referent index, read and maintained as what it is: a view.
 *
 * Every read in this module derives its answer from the ledger or from the
 * projection the ledger can regenerate — never from a field in the port's
 * memory. That is what lets a freshly opened `openIngest` over a populated
 * database serve referents it never wrote, and what makes `rebuild-index` a
 * check on the design rather than a courtesy.
 *
 * Two enumerations here go through ANN queries (`searchReferentGlosses`,
 * `searchClaims`) because the `GraphStore` port has no scan: there is no
 * `listEntities` and no `listClaims`. The KNN cap is what bounds them — see
 * {@link SCAN_LIMIT}.
 *
 * @spec §3.1, §3.5, §5.2, §11
 */

import {
  STORED_VECTOR_DIMENSIONS,
  type ClaimRecord,
  type ClaimStatus,
  type Entity,
  type GraphStore,
  type Regime,
} from '../store/index.js';
import { decodeSpineClaim, type ExistencePayload } from './spine.js';

/**
 * How many rows one enumeration can see.
 *
 * `sqlite-vec` refuses a KNN `k` above 4096, and a KNN query is the only
 * enumeration the store port offers. A graph past this size needs a ledger scan
 * on the port, not a bigger constant here.
 *
 * @spec §11
 */
export const SCAN_LIMIT = 4096;

/**
 * The probe every enumeration uses.
 *
 * Any unit vector enumerates, since a KNN with `k` above the row count returns
 * every row; a fixed one keeps enumeration free of model calls, which matters
 * because `rebuild-index` must not spend the embedding budget on a scan.
 *
 * @spec §11
 */
const scanProbe = (): Float32Array => {
  const probe = new Float32Array(STORED_VECTOR_DIMENSIONS);
  probe[0] = 1;
  return probe;
};

/** The statuses §6.1 leaves standing. A retired existence claim stops speaking for its referent. @spec §6.1 */
const LIVE_STATUSES: readonly ClaimStatus[] = ['provisional', 'active', 'disputed'];

/** Whether a claim still speaks for anything. @spec §6.1 */
export const isLive = (claim: ClaimRecord): boolean => LIVE_STATUSES.includes(claim.status);

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

/** Every claim id in the ledger, oldest first. @spec §11 */
export const scanClaimIds = (store: GraphStore): string[] =>
  store
    .searchClaims({ embedding: scanProbe(), limit: SCAN_LIMIT, includeArchived: true })
    .map((hit) => hit.claimId)
    .sort();

/** Every referent id in the index, in id order. @spec §3.1, §11 */
export const scanReferentIds = (store: GraphStore): string[] =>
  store
    .searchReferentGlosses({ embedding: scanProbe(), limit: SCAN_LIMIT })
    .map((hit) => hit.referentId)
    .sort();

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
 * §3.1's derived name: the most-corroborated surface form, ties oldest first.
 *
 * @spec §3.1
 */
export const deriveName = (store: GraphStore, referentId: string): string | undefined =>
  store.getMentionTally(referentId)[0]?.surfaceForm;

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
