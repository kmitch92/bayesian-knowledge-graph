/**
 * The kg-mcp data model, transcribed from the v0.6.0 reference spec.
 *
 * The Zod blocks below are copied from `kg-mcp-reference-spec.md` §3.5 (the
 * referent index, claims, identity claims), §3.6 (document nodes) and §10 (the
 * MCP tool surface). The spec is the source of truth: these schemas describe
 * *shape* only. The logic that chooses a prior from a tier, mints ids, or seeds
 * evidence lives outside the schema layer and is not implemented here.
 *
 * Every exported symbol carries a `@spec §x.y` tag naming the section it
 * implements; that tag is the hook for a future code-vs-spec drift lint.
 *
 * The transcription is no longer verbatim, and the places it departs are worth
 * naming, because §3.5 and the §4/§6 diagrams do not agree with each other:
 *
 * 1. **Levels are open (A16).** `EntityLevel` is `z.string()`, not the closed
 *    six-rung enum of v0.2. A level is pack-declared ordered data, and the
 *    ladder it has to respect is the active pack's, not this layer's. §3.5
 *    already carries this change; the v0.2 enum here did not.
 *
 * 2. **The regime rides on the ledger row, not only on the referent index.**
 *    §3.5 places `regime` on `Entity` alone, but the referent index is a
 *    materialized view that `rebuild-index` must be able to clear and
 *    regenerate from the ledger (§11: a projection cannot constrain its
 *    source), so a regime held only there would be destroyed by clearing it.
 *    `Entity.regime` below is the value the index *materializes*; the claim it
 *    materializes from carries the original. That ledger row is a superset of
 *    §3.5's `Claim` and is declared by the store, not here — see
 *    `src/store/__tests__/regime.test.ts`, which reads it through the store
 *    precisely because a non-strict `Claim.parse` would strip the field.
 *
 * 3. **Evidence is absent in the view regime.** Diagram §6 says *"no α/β, no
 *    posterior"* for view-regime nodes and *"Nothing is ever both"*, which
 *    §3.5's required, strictly-positive `Evidence` cannot express. The
 *    exclusivity — regime `view` implies no evidence, regime `evidence`
 *    implies both parameters positive — is enforced on the same ledger row as
 *    (2), and for the same reason. `Claim` below keeps §3.5's shape.
 *
 * @spec §3.5, §3.6, §10, §11
 */

import { z } from 'zod';

/**
 * A spine level, as an open vocabulary rather than a closed one (A16).
 *
 * Levels are pack-declared ordered data: the shipped code pack declares
 * workspace → repo → system → component → module → symbol, and a prose pack or
 * an ops pack is free to declare `chapter` or `practice` instead. The ordering
 * a level has to respect lives with the pack that declared it, so the only
 * shape-level rule left here is that a level is a string.
 *
 * @spec §3.1, §3.5
 */
export const EntityLevel = z.string();

/** A spine level. @spec §3.1, §3.5 */
export type EntityLevel = z.infer<typeof EntityLevel>;

/** The six epistemic kinds a claim may take. @spec §3.3, §3.5 */
export const ClaimKind = z.enum(['fact', 'convention', 'rationale', 'risk', 'intent', 'coupling']);

/** An epistemic kind. @spec §3.3, §3.5 */
export type ClaimKind = z.infer<typeof ClaimKind>;

/** The three-rung evidence privilege ladder. @spec §3.2, §3.5 */
export const ClaimTier = z.enum(['verified', 'observed', 'inferred']);

/** An evidence tier. @spec §3.2, §3.5 */
export type ClaimTier = z.infer<typeof ClaimTier>;

/** The five lifecycle states a claim moves through. @spec §3.5, §6.1 */
export const ClaimStatus = z.enum([
  'provisional',
  'active',
  'disputed',
  'deprecated',
  'archived',
]);

/** A lifecycle state. @spec §3.5, §6.1 */
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Beta-Bernoulli parameter pair. @spec §3.5, §4.1 */
export const Evidence = z.object({
  alpha: z.number().positive(),
  beta: z.number().positive(),
});

/** A Beta-Bernoulli posterior's parameters. @spec §3.5, §4.1 */
export type Evidence = z.infer<typeof Evidence>;

/**
 * The episodes/changeEvents/artifacts triple feeding churn decay and
 * independence discounting, plus the A15 pathway signature.
 *
 * `commits` and `files` became `changeEvents` and `artifacts` (A16) because
 * neither axis is git-shaped any more: a change event may be an editor save or
 * a deploy, and an artifact may be a config blob or a schema. `channel` and
 * `agent` are optional because a claim need not know how it arrived, but a
 * pathway counter is keyed by them when it does.
 *
 * @spec §3.5, §4.4, §4.5
 */
export const Provenance = z.object({
  episodes: z.array(z.string()),
  changeEvents: z.array(z.string()), // was commits (A16)
  artifacts: z.array(z.string()), // was files (A16)
  channel: z.string().optional(), // A15 pathway signature
  agent: z.string().optional(), // A15 pathway signature
});

/** A provenance record. @spec §3.5, §4.4, §4.5 */
export type Provenance = z.infer<typeof Provenance>;

/**
 * A materialized referent-index row: a view over existence claims, rebuildable
 * from the ledger.
 *
 * Three v0.2 fields left the shape in v0.6.0. `aliases` was a column of surface
 * forms and is now the mention index, a table of rows. `origin`'s
 * parsed/asserted split is now `regime`, which names the truth-maintenance
 * machinery rather than the provenance. `ref` was a code-shaped
 * `{ path, symbolRange }` and is now `locator`: opaque — no field of it is
 * declared, refined, queried or indexed, which is what makes it pack-agnostic,
 * since another pack's locator is another shape entirely. The store still
 * serializes it whole in both directions, and guards the read, because
 * deserialization is where a corrupt row surfaces. `name` is derived — the
 * most-corroborated surface form — and `level` is nullable, since a referent
 * born from a mention is unplaced until a containment claim places it.
 *
 * @spec §3.1, §3.5
 */
export const Entity = z.object({
  id: z.string().ulid(),
  name: z.string().min(1), // derived: most-corroborated surface form
  level: EntityLevel.nullable(),
  regime: z.enum(['view', 'evidence']),
  locator: z.unknown().nullable(), // opaque; no field declared, refined, queried or indexed; code recipe: { path, symbolRange }
  glossEmbedding: z.array(z.number()),
  facets: z.array(z.array(z.number())).max(4).default([]),
});

/** A referent-index row. @spec §3.1, §3.5 */
export type Entity = z.infer<typeof Entity>;

/**
 * A claim node: one self-contained declarative proposition with its own
 * posterior.
 *
 * §3.5's shape exactly. The `regime` a claim is maintained under, and the
 * nullable evidence that pairs with it, are on the store's ledger row rather
 * than here — see (2) and (3) in the module docblock. A consumer that needs to
 * tell a view claim from an evidence one must read the store, not parse this.
 *
 * @spec §3.2, §3.5
 */
export const Claim = z.object({
  id: z.string().ulid(),
  text: z.string().min(1), // self-contained declarative, deixis-free
  embedding: z.array(z.number()),
  kind: ClaimKind,
  tier: ClaimTier,
  status: ClaimStatus,
  evidence: Evidence,
  scope: z.string().ulid(), // spine anchor entity
  temporal: z.object({
    createdAt: z.string().datetime(),
    lastCorroborated: z.string().datetime().optional(),
    invalidatedAt: z.string().datetime().optional(),
    lastChurnEvent: z.string().datetime().optional(),
  }),
  provenance: Provenance,
  canonical: z.boolean().default(false),
});

/** A claim node. @spec §3.2, §3.5 */
export type Claim = z.infer<typeof Claim>;

/** A first-class claim asserting that its members state the same proposition. @spec §3.4, §3.5, §8.2 */
export const IdentityClaim = z.object({
  id: z.string().ulid(),
  members: z.array(z.string().ulid()).min(2),
  evidence: Evidence,
  status: ClaimStatus,
  priorBasis: z.object({
    paraphraseDistance: z.number(), // max pairwise cosine distance
    provenanceOverlap: z.number(), // Jaccard over artifacts ∪ changeEvents (A16)
  }),
});

/** An identity claim. @spec §3.4, §3.5, §8.2 */
export type IdentityClaim = z.infer<typeof IdentityClaim>;

/** A document node: discursive knowledge holding no evidence of its own. @spec §3.6, §5.10 */
export const DocumentNode = z.object({
  id: z.string().ulid(),
  docKind: z.enum(['adr', 'runbook', 'overview', 'postmortem', 'other']),
  origin: z.enum(['authored', 'materialized']),
  contentRef: z.string(),
  chunks: z.array(z.object({ hash: z.string(), embedding: z.array(z.number()) })),
  scope: z.string().ulid(),
});

/** A document node. @spec §3.6, §5.10 */
export type DocumentNode = z.infer<typeof DocumentNode>;

/** The retrieval tool's request. @spec §10 */
export const QueryRequest = z.object({
  task: z.string().min(1),
  hint: z.enum(['debugging', 'planning', 'implementing']).optional(),
  budgetTokens: z.number().int().positive().default(2000),
  anchor: z.string().optional(), // entity id/name; resolved when absent (Mode B)
  modes: z.array(z.enum(['spine', 'ann', 'traverse'])).default(['spine', 'ann']),
});

/** A retrieval request. @spec §10 */
export type QueryRequest = z.infer<typeof QueryRequest>;

/** A claim as retrieval renders it: posterior summary plus disclosure. @spec §3.4, §10 */
export const ServedClaim = z.object({
  id: z.string().ulid(),
  text: z.string(),
  kind: ClaimKind,
  tier: ClaimTier,
  status: ClaimStatus,
  posteriorMean: z.number().min(0).max(1),
  posteriorWidth: z.number().min(0).max(1), // e.g. 95% credible-interval width
  scope: z.string().ulid(),
  canonical: z.boolean(),
  disclosure: z
    .object({
      rawCount: z.number().int(),
      refinementCount: z.number().int(),
      disputed: z.boolean(),
    })
    .optional(),
  rivals: z.array(z.string().ulid()).optional(), // contested pairs travel together
});

/** A served claim. @spec §3.4, §10 */
export type ServedClaim = z.infer<typeof ServedClaim>;

/** The retrieval envelope, including the mandatory taint record. @spec §7.1, §10 */
export const QueryResponse = z.object({
  anchor: z.object({ id: z.string().ulid(), name: z.string(), level: EntityLevel }).optional(), // absent when no anchor resolves (Mode B)
  claims: z.array(ServedClaim),
  structural: z.array(z.object({ from: z.string(), edge: z.string(), to: z.string() })),
  taintRecorded: z.literal(true),
});

/** A retrieval response. @spec §7.1, §10 */
export type QueryResponse = z.infer<typeof QueryResponse>;

/** The elective write. @spec §5.2, §10 */
export const ObserveRequest = z.object({
  claim: z.string().min(1),
  tier: ClaimTier,
  about: z.array(z.string()).optional(), // entity names/ids; resolver handles the rest
  provenance: Provenance.partial(),
});

/** An observe request. @spec §5.2, §10 */
export type ObserveRequest = z.infer<typeof ObserveRequest>;

/** The rivalry write. @spec §6.3, §10 */
export const ContradictRequest = z.object({
  target: z.string().ulid(),
  claim: z.string().min(1),
  tier: ClaimTier,
  provenance: Provenance.partial(),
});

/** A contradict request. @spec §6.3, §10 */
export type ContradictRequest = z.infer<typeof ContradictRequest>;

/** Reading through a canonical view to its members. @spec §3.4, §6.1, §10 */
export const DrillDownRequest = z.object({
  canonical: z.string().ulid(),
  includeArchived: z.boolean().default(false),
});

/** A drill-down request. @spec §3.4, §6.1, §10 */
export type DrillDownRequest = z.infer<typeof DrillDownRequest>;

/*
 * Edge vocabulary — back-annotation A24.
 *
 * §3.3 fixes the closed set of edge types in a table, but the §3.5 Zod block
 * omits a schema for it, so the verbatim transcription above had nothing to
 * carry. The enums below are derived from the §3.3 table alone and are grouped
 * by the node the edge *leaves*: a claim edge is any edge whose source is a
 * claim, which is why `ABOUT` (claim → entity, per §3.3) sits with the five
 * claim → claim kinds, and why `CONTAINS` (entity → entity) does not appear —
 * parsed structural edges carry no confidence machinery (§2, principle 2) and
 * use an open parser vocabulary rather than this closed set.
 */

/** The six §3.3 claim edges v1 writes and reads. @spec §3.3, §5.5, §7.4 */
export const LiveClaimEdgeKind = z.enum([
  'ABOUT',
  'SUPPORTS',
  'CONTRADICTS',
  'REFINES',
  'DERIVED_FROM',
  'SUPERSEDED_BY',
]);

/** A live claim edge kind. @spec §3.3, §5.5, §7.4 */
export type LiveClaimEdgeKind = z.infer<typeof LiveClaimEdgeKind>;

/**
 * The four edge kinds reserved for deferred features: `MERGES` for the
 * consolidator's identity and grouping claims (§8.2, §8.8), `STATED_IN` for
 * document members (§3.6), `INSTANCE_OF` and `SPECIALIZES` for the conceptual
 * vertical (§3.7). Compiled so the vocabulary need not change when those land;
 * no v1 behaviour attaches to them.
 *
 * @spec §3.3, §3.6, §3.7, §8.2
 */
export const ReservedEdgeKind = z.enum(['MERGES', 'STATED_IN', 'INSTANCE_OF', 'SPECIALIZES']);

/** A reserved edge kind. @spec §3.3, §3.6, §3.7, §8.2 */
export type ReservedEdgeKind = z.infer<typeof ReservedEdgeKind>;

/** The closed vocabulary a claim edge may name: the live six plus the reserved four. @spec §3.3 */
export const ClaimEdgeKind = z.enum([...LiveClaimEdgeKind.options, ...ReservedEdgeKind.options]);

/** A claim edge kind. @spec §3.3 */
export type ClaimEdgeKind = z.infer<typeof ClaimEdgeKind>;

/** The live six as a value, for callers that must enumerate rather than parse. @spec §3.3 */
export const LIVE_CLAIM_EDGE_KINDS = LiveClaimEdgeKind.options;

/** The reserved four as a value, for the write path's refusal check. @spec §3.3, §5.5 */
export const RESERVED_EDGE_KINDS = ReservedEdgeKind.options;

/*
 * Job queue and extraction-rejection vocabulary — back-annotation E1b.
 *
 * §9's job queue and §5.10's extraction-rejection log are store-owned in the
 * same sense {@link ReservedEdgeKind} above is: `JobState` belongs to no
 * entity and `ExtractionRejectionReason` belongs to no claim, but each is
 * still a closed set three sites — a TypeScript type, a runtime refusal check,
 * a table CHECK — have to agree on. Both lived as bare TypeScript unions in
 * `src/store/port.ts` until here, which let a fourth arm compile in wherever
 * only the union was consulted, silently, exactly as an untyped fourth
 * `ReservedEdgeKind` would.
 */

/**
 * Where a job is in its one pass through the queue.
 *
 * Four, because a job is waiting for a drain, held by one, finished, or parked
 * after a failure the caller gave no retry instant for. Closed at the table too:
 * `claimJob` selects `WHERE state = 'pending'`, so a fifth spelling would not be
 * a job in a wrong state, it would be a job that is never seen again.
 *
 * @spec §9
 */
export const JobState = z.enum(['pending', 'running', 'done', 'failed']);

/** A job's lifecycle state. @spec §9 */
export type JobState = z.infer<typeof JobState>;

/**
 * Why the extraction gate refused a proposed member.
 *
 * A vocabulary and not a sentence, for the reason `documents.origin` is one:
 * §13's drift audits and §15's verifier tuning both ask a counting question —
 * how often did this model fail *this way* — and counting over prose written by
 * whichever caller logged the row is counting over nothing.
 *
 * Two arms are this build's verbatim gate, split because they are different
 * diagnoses: a model that never quotes is broken in a way no threshold fixes,
 * while a model that quotes loosely is exactly what a floor is for.
 * `entailmentBelowFloor` is the deferred semantic gate, admitted before anything
 * writes it so that landing it is not a migration — plan §7's rule, the one
 * `RESERVED_EDGE_KINDS` already follows.
 *
 * `mentionsAbsent` is E8b's arm, and it is a verdict about a *different field* —
 * which is exactly why none of the other three could carry it. E7d's first live
 * run had the model answer 37% of its unique claims with an empty `mentions`
 * list, and `ClaimMessage.mentions` is `.min(1)` because §5.2 *"forces every
 * claim to name its referents explicitly"*: the one ingest door refuses the
 * message, so the proposal is a refused proposal and §5.10 sends refused
 * proposals here. The two quote arms are verdicts about the span and the span in
 * this case is verbatim, so either one would file a sound citation as a bad one;
 * `entailmentBelowFloor` is defined by a score against a floor, and score-less
 * rows written there would corrupt the first real data the deferred gate ever
 * produces. The name mirrors `quoteAbsent`'s `<field>Absent` shape because it is
 * the same diagnosis one field over. Unlike `quoteAbsent` it is *anchored*: that
 * arm leaves `chunk_ordinal` NULL because a claim offered with no quote at all
 * locates nothing, while this one quoted the paragraph correctly, so the auditor
 * asking which paragraph a model keeps failing on has an answer here.
 *
 * @spec §5.2, §5.10, §12, §13, §15
 */
export const ExtractionRejectionReason = z.enum([
  'quoteAbsent',
  'quoteNotVerbatim',
  'mentionsAbsent',
  'entailmentBelowFloor',
]);

/** Why the extraction gate refused a proposed member. @spec §5.2, §5.10, §12, §13, §15 */
export type ExtractionRejectionReason = z.infer<typeof ExtractionRejectionReason>;

/** The four arms as a value, for the write path's refusal check. @spec §5.10, §13 */
export const EXTRACTION_REJECTION_REASONS = ExtractionRejectionReason.options;
