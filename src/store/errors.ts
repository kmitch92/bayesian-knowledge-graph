/**
 * Store-owned failure vocabulary.
 *
 * These are *boundary* errors, not domain errors: each one names a promise the
 * persistence layer makes that a caller has just broken. They live here rather
 * than in `src/schema/` because none of them is a shape violation — the schemas
 * accept every value below (a four-element embedding parses fine, §11 / A22),
 * and the store is the only place that knows the width it pinned, which ids it
 * has minted, and which edge kinds v1 refuses to write.
 *
 * @spec §3.3, §5.5, §11
 */

/**
 * A vector arrived at a width the store did not pin.
 *
 * `Claim.embedding` and `Entity.glossEmbedding` are bare `z.array(z.number())`
 * by design (back-annotation A22), so this boundary is the only thing standing
 * between a wrong-width vector and an ANN index that scores nonsense.
 *
 * @spec §11
 */
export class DimensionMismatchError extends Error {
  /** The width the store requires. */
  readonly expected: number;
  /** The width that actually arrived. */
  readonly received: number;

  constructor(what: string, expected: number, received: number) {
    super(
      `${what} must have exactly ${String(expected)} components, got ${String(received)}`,
    );
    this.name = 'DimensionMismatchError';
    this.expected = expected;
    this.received = received;
  }
}

/**
 * An operation named a claim the ledger has never minted.
 *
 * Also what an entity id gets when it is offered somewhere a claim id belongs:
 * entities carry no posterior at all (§3.1, principle 2), so "not a claim" and
 * "no such claim" are the same refusal.
 *
 * @spec §3.2, §5.7
 */
export class UnknownClaimError extends Error {
  /** The id that did not resolve. */
  readonly claimId: string;

  constructor(claimId: string) {
    super(`no claim ${claimId} in the ledger`);
    this.name = 'UnknownClaimError';
    this.claimId = claimId;
  }
}

/**
 * An operation named a spine entity that does not exist.
 *
 * Never minted eagerly to make the caller's life easier: eager entity creation
 * on a failed resolution is exactly how the graph fragments (§5.2, §12).
 *
 * @spec §3.1, §5.2
 */
export class UnknownEntityError extends Error {
  /** The id that did not resolve. */
  readonly entityId: string;

  constructor(entityId: string) {
    super(`no entity ${entityId} on the spine`);
    this.name = 'UnknownEntityError';
    this.entityId = entityId;
  }
}

/**
 * A second claim arrived under an id the ledger already holds.
 *
 * `putClaim` mints; it does not upsert. Every mutation of a live claim runs on
 * the atomic single-statement path (§5.7) and the ledger is append-only, so
 * overwriting a whole claim row is not an operation this store offers.
 *
 * @spec §3.2, §5.7
 */
export class DuplicateClaimError extends Error {
  /** The id already in the ledger. */
  readonly claimId: string;

  constructor(claimId: string) {
    super(`claim ${claimId} is already in the ledger — minting is not upserting`);
    this.name = 'DuplicateClaimError';
    this.claimId = claimId;
  }
}

/**
 * A write named one of the four edge kinds v1 reserves but does not use.
 *
 * `MERGES`, `STATED_IN`, `INSTANCE_OF` and `SPECIALIZES` belong to the
 * consolidator, documents and the conceptual vertical — all v1 non-goals. The
 * vocabulary admits them so migration 0 needs no change when they land; this
 * refusal is what stops v1 quietly minting them in the meantime.
 *
 * @spec §3.3, §5.5
 */
export class ReservedEdgeKindError extends Error {
  /** The reserved kind that was refused. */
  readonly kind: string;

  constructor(kind: string) {
    super(`${kind} is reserved for a deferred feature and cannot be written in v1`);
    this.name = 'ReservedEdgeKindError';
    this.kind = kind;
  }
}
