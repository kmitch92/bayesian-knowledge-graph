/**
 * Canonical example objects for the kg-mcp data model.
 *
 * The reference spec gives field tables and Zod blocks rather than literal JSON,
 * so these fixtures are the constructed canonical examples of each shape. They are
 * deliberately written as plain object literals with no import from the schema
 * module: the schema module is the thing under test, and a fixture that borrowed
 * its types would hide a broken export behind a compile error.
 *
 * Identifiers are real Crockford base32 ULIDs (26 chars, no I/L/O/U) and
 * timestamps are real UTC ISO-8601 instants, so `.ulid()` and `.datetime()`
 * refinements are genuinely exercised rather than trivially satisfied.
 *
 * @spec §3.1, §3.2, §3.4, §3.5, §3.6, §10, §15
 */

/** Entity ULID: the `AuthService` component that anchors most claim fixtures. @spec §3.1 */
export const ENTITY_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** Entity ULID: a second spine node, used where a fixture needs a distinct scope. @spec §3.1 */
export const OTHER_ENTITY_ULID = '01J8ZQ0X9F3K7B2M4N6P8R0T2V';

/** Claim ULID: the primary claim fixture. @spec §3.2 */
export const CLAIM_ULID = '01J8ZQ1YB4T5C6D7E8F9G0H1J2';

/** Claim ULID: a second claim, used as identity-claim member and as a rival. @spec §3.2 */
export const RIVAL_CLAIM_ULID = '01J8ZQ2Z5M6N7P8Q9R0S1T2V3W';

/** Claim ULID: a third claim, used as an identity-claim member. @spec §3.4 */
export const MEMBER_CLAIM_ULID = '01J8ZQ3A6B7C8D9E0F1G2H3J4K';

/** Identity-claim ULID. @spec §3.4 */
export const IDENTITY_CLAIM_ULID = '01J8ZQ4B7C8D9E0F1G2H3J4K5M';

/** Document-node ULID. @spec §3.6 */
export const DOCUMENT_ULID = '01J8ZQ5C8D9E0F1G2H3J4K5M6N';

/** Canonical-view ULID, the drill-down target. @spec §3.4, §10 */
export const CANONICAL_ULID = '01J8ZQ6D9E0F1G2H3J4K5M6N7P';

/**
 * Claim creation instant. Zod 3's `.datetime()` defaults to `offset: false`,
 * so every timestamp fixture is Z-suffixed UTC.
 *
 * @spec §3.2
 */
export const CREATED_AT = '2026-08-22T09:14:03.000Z';

/** Most recent corroboration instant. @spec §3.2 */
export const LAST_CORROBORATED = '2026-08-22T11:47:52.000Z';

/** Invalidation instant, set when a claim is deprecated. @spec §3.2, §6.1 */
export const INVALIDATED_AT = '2026-08-22T16:02:19.000Z';

/** Instant of the last commit whose churn touched the claim's provenance files. @spec §4.5 */
export const LAST_CHURN_EVENT = '2026-08-22T15:30:00.000Z';

/** Beta-Bernoulli prior α₀. @spec §15 */
export const PRIOR_ALPHA = 1;

/** Beta-Bernoulli prior β₀ for verified- and observed-tier claims. @spec §15 */
export const PRIOR_BETA = 1;

/** Skeptical prior β₀ seeded for inferred-tier claims. @spec §3.2, §15 */
export const PRIOR_BETA_INFERRED = 2;

/** Untouched prior evidence, as minted for a non-inferred claim. @spec §4.1, §15 */
export const priorEvidence = {
  alpha: PRIOR_ALPHA,
  beta: PRIOR_BETA,
};

/** Untouched skeptical prior evidence, as minted for an inferred claim. @spec §3.2, §15 */
export const skepticalPriorEvidence = {
  alpha: PRIOR_ALPHA,
  beta: PRIOR_BETA_INFERRED,
};

/** Evidence after several corroborations and one contradiction. @spec §4.1 */
export const accumulatedEvidence = {
  alpha: 5,
  beta: 2,
};

/**
 * Full provenance: the three v0.6 axes plus the A15 pathway signature.
 *
 * `commits` and `files` became `changeEvents` and `artifacts` (A16) because
 * neither axis is git-shaped any more — a change event may be an editor save or
 * a deploy, an artifact may be a config blob or a schema.
 *
 * @spec §3.2, §3.5, §4.4, §4.5
 */
export const provenanceFixture = {
  episodes: ['ep-2026-08-22-0914', 'ep-2026-08-22-1147'],
  changeEvents: ['9f2c1ab4e7d05b3c8a6f41d29e0b7c5a3d81f6e2'],
  artifacts: ['src/auth/session.ts', 'src/auth/refresh.ts'],
  channel: 'mcp',
  agent: 'claude-code',
};

/**
 * An opaque locator, in the shipped code recipe's shape.
 *
 * The schema types this `z.unknown()`: no field here is declared, refined or
 * queried anywhere in the system. Another pack's locator is another shape
 * entirely, which is exactly why the nested arrays and the `null` below are
 * here — a schema that quietly reshaped its input would lose them.
 *
 * @spec §3.5
 */
export const locatorFixture = {
  path: 'src/auth/index.ts',
  symbolRange: [1, 412],
  vcs: { rev: '9f2c1ab', dirty: false, tag: null },
  spans: [
    [1, 88],
    [104, 412],
  ],
};

/**
 * A complete referent-index row: a `component`-level referent whose existence a
 * noun source attests, with every optional and defaulted field explicitly
 * present, so a parse round-trip must return exactly this object.
 *
 * @spec §3.1, §3.5
 */
export const entityFixture = {
  id: ENTITY_ULID,
  name: 'AuthService',
  level: 'component',
  regime: 'view',
  locator: locatorFixture,
  glossEmbedding: [0.12, -0.44, 0.87, 0.03],
  facets: [
    [0.11, -0.4, 0.9, 0.02],
    [0.31, -0.12, 0.55, -0.4],
  ],
};

/**
 * The same referent stripped to its required fields, so the `facets` default
 * must materialise on parse.
 *
 * `level` is `null` and not absent: a referent born from a mention is unplaced
 * until a containment claim places it, and "unplaced" is a level the schema
 * carries rather than a key it omits.
 *
 * @spec §3.1, §3.5
 */
export const minimalEntityFixture = {
  id: ENTITY_ULID,
  name: 'AuthService',
  level: null,
  regime: 'evidence',
  locator: null,
  glossEmbedding: [0.12, -0.44, 0.87, 0.03],
};

/**
 * An entity carrying five facet centroids, one past the §3.1 ceiling of four.
 *
 * @spec §3.1, §15
 */
export const overFacetedEntityFixture = {
  ...minimalEntityFixture,
  facets: [
    [0.11, -0.4],
    [0.31, -0.12],
    [-0.05, 0.62],
    [0.44, 0.18],
    [0.09, -0.71],
  ],
};

/**
 * A complete claim: an observed-tier convention, active, anchored at the
 * `AuthService` spine node, with every optional temporal field present.
 *
 * @spec §3.2, §3.5
 */
export const claimFixture = {
  id: CLAIM_ULID,
  text: 'Session refresh handlers in AuthService are idempotent under retry.',
  embedding: [0.42, 0.13, -0.77, 0.31],
  kind: 'convention',
  tier: 'observed',
  status: 'active',
  evidence: accumulatedEvidence,
  scope: ENTITY_ULID,
  temporal: {
    createdAt: CREATED_AT,
    lastCorroborated: LAST_CORROBORATED,
    invalidatedAt: INVALIDATED_AT,
    lastChurnEvent: LAST_CHURN_EVENT,
  },
  provenance: provenanceFixture,
  canonical: true,
};

/**
 * A freshly minted raw claim: required fields only, so the `canonical` default
 * must materialise as `false`, and only `createdAt` is set because nothing has
 * corroborated, invalidated or churned it yet.
 *
 * @spec §3.2, §3.5
 */
export const minimalClaimFixture = {
  id: CLAIM_ULID,
  text: 'Session refresh handlers in AuthService are idempotent under retry.',
  embedding: [0.42, 0.13, -0.77, 0.31],
  kind: 'convention',
  tier: 'observed',
  status: 'provisional',
  evidence: priorEvidence,
  scope: ENTITY_ULID,
  temporal: {
    createdAt: CREATED_AT,
  },
  provenance: provenanceFixture,
};

/**
 * An inferred-tier claim at mint time. Model reasoning with no direct
 * observation, so it carries the skeptical prior β₀ = 2.
 *
 * @spec §3.2, §15
 */
export const inferredTierClaimFixture = {
  ...minimalClaimFixture,
  id: RIVAL_CLAIM_ULID,
  text: 'The retry wrapper around AuthService.refresh exists to absorb Cognito throttling.',
  kind: 'rationale',
  tier: 'inferred',
  evidence: skepticalPriorEvidence,
};

/**
 * An observed-tier claim at mint time, carrying the ordinary prior β₀ = 1.
 * The tier/prior pairing here is data, not behaviour: the logic that selects a
 * prior from a tier is P3's, and is deliberately not asserted at schema level.
 *
 * @spec §3.2, §15
 */
export const observedTierClaimFixture = {
  ...minimalClaimFixture,
  tier: 'observed',
  evidence: priorEvidence,
};

/**
 * A verified-tier claim at mint time, also on the ordinary prior.
 *
 * @spec §3.2, §15
 */
export const verifiedTierClaimFixture = {
  ...minimalClaimFixture,
  id: MEMBER_CLAIM_ULID,
  tier: 'verified',
  evidence: priorEvidence,
};

/**
 * An identity claim: the consolidator's assertion that two raw claims state the
 * same proposition, with its own α/β lifecycle and the merge prior's basis.
 *
 * @spec §3.4, §3.5, §8.2
 */
export const identityClaimFixture = {
  id: IDENTITY_CLAIM_ULID,
  members: [CLAIM_ULID, MEMBER_CLAIM_ULID],
  evidence: skepticalPriorEvidence,
  status: 'provisional',
  priorBasis: {
    paraphraseDistance: 0.18,
    provenanceOverlap: 0.5,
  },
};

/**
 * An authored ADR, chunk-anchored by hash rather than raw offsets.
 * The document holds no evidence of its own — assertions live as member claims.
 *
 * @spec §3.6, §5.10
 */
export const documentNodeFixture = {
  id: DOCUMENT_ULID,
  docKind: 'adr',
  origin: 'authored',
  contentRef: 'docs/adr/0007-session-refresh-idempotency.md',
  chunks: [
    { hash: 'sha256:1f0a9c4d2b6e8f3a', embedding: [0.02, 0.44, -0.19, 0.6] },
    { hash: 'sha256:7c3e5b81d0a24f96', embedding: [-0.33, 0.07, 0.51, 0.12] },
  ],
  scope: ENTITY_ULID,
};

/**
 * A fully specified retrieval request: explicit anchor, hint, budget and modes.
 *
 * @spec §10
 */
export const queryRequestFixture = {
  task: 'Add exponential backoff to the session refresh path',
  hint: 'implementing',
  budgetTokens: 3500,
  anchor: ENTITY_ULID,
  modes: ['spine', 'ann', 'traverse'],
};

/**
 * A Mode B retrieval request: task only. The anchor is resolved because it is
 * absent, and `budgetTokens` and `modes` defaults must materialise.
 *
 * @spec §7.1, §10
 */
export const minimalQueryRequestFixture = {
  task: 'Add exponential backoff to the session refresh path',
};

/**
 * A served claim with full disclosure integers and a travelling rival, as a
 * canonical view renders it.
 *
 * @spec §3.4, §10
 */
export const servedClaimFixture = {
  id: CANONICAL_ULID,
  text: 'Session refresh handlers in AuthService are idempotent under retry.',
  kind: 'convention',
  tier: 'observed',
  status: 'disputed',
  posteriorMean: 0.71,
  posteriorWidth: 0.24,
  scope: ENTITY_ULID,
  canonical: true,
  disclosure: {
    rawCount: 4,
    refinementCount: 1,
    disputed: true,
  },
  rivals: [RIVAL_CLAIM_ULID],
};

/**
 * A served claim without disclosure or rivals: a raw ledger entry, not a view.
 *
 * @spec §10
 */
export const rawServedClaimFixture = {
  id: CLAIM_ULID,
  text: 'AuthService.refresh retries twice before surfacing an error.',
  kind: 'fact',
  tier: 'verified',
  status: 'active',
  posteriorMean: 0.93,
  posteriorWidth: 0.08,
  scope: ENTITY_ULID,
  canonical: false,
};

/**
 * A complete retrieval response, including the `taintRecorded` literal that
 * makes the taint set non-optional on the serving path.
 *
 * @spec §7.1, §10
 */
export const queryResponseFixture = {
  anchor: {
    id: ENTITY_ULID,
    name: 'AuthService',
    level: 'component',
  },
  claims: [servedClaimFixture, rawServedClaimFixture],
  structural: [
    { from: 'AuthService', edge: 'CONTAINS', to: 'AuthService.refresh' },
    { from: 'AuthService.refresh', edge: 'CALLS', to: 'CognitoClient.initiateAuth' },
  ],
  taintRecorded: true,
};

/**
 * An elective write: an observed-tier claim with entity names left for the
 * resolver and a partial provenance triple.
 *
 * @spec §5.2, §10
 */
export const observeRequestFixture = {
  claim: 'AuthService.refresh retries twice before surfacing an error.',
  tier: 'observed',
  about: ['AuthService', 'CognitoClient'],
  provenance: {
    artifacts: ['src/auth/refresh.ts'],
    episodes: ['ep-2026-08-22-1147'],
  },
};

/**
 * The narrowest legal write: claim text and tier, no `about`, empty provenance.
 *
 * @spec §10
 */
export const minimalObserveRequestFixture = {
  claim: 'AuthService.refresh retries twice before surfacing an error.',
  tier: 'inferred',
  provenance: {},
};

/**
 * A verified-tier contradiction against a live claim — the only kind of verdict
 * that can create or resolve a dispute unilaterally.
 *
 * @spec §6.3, §10
 */
export const contradictRequestFixture = {
  target: CLAIM_ULID,
  claim: 'AuthService.refresh retries three times, not twice.',
  tier: 'verified',
  provenance: {
    changeEvents: ['9f2c1ab4e7d05b3c8a6f41d29e0b7c5a3d81f6e2'],
  },
};

/**
 * A drill-down through a canonical view to its members, explicitly opting in to
 * archived claims (audit read).
 *
 * @spec §3.4, §6.1, §10
 */
export const drillDownRequestFixture = {
  canonical: CANONICAL_ULID,
  includeArchived: true,
};

/**
 * A drill-down with `includeArchived` omitted, so the default must materialise
 * as `false` — archived claims leave candidate retrieval entirely.
 *
 * @spec §6.1, §10
 */
export const minimalDrillDownRequestFixture = {
  canonical: CANONICAL_ULID,
};
