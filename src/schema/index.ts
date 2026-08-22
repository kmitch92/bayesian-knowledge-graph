/**
 * The kg-mcp data model, transcribed verbatim from the reference spec.
 *
 * The Zod blocks below are copied from `kg-mcp-reference-spec.md` §3.5 (entity
 * spine, claims, identity claims), §3.6 (document nodes) and §10 (the MCP tool
 * surface). The spec is the source of truth: these schemas describe *shape*
 * only. The logic that chooses a prior from a tier, mints ids, or seeds
 * evidence lives outside the schema layer and is not implemented here.
 *
 * Every exported symbol carries a `@spec §x.y` tag naming the section it
 * implements; that tag is the hook for a future code-vs-spec drift lint.
 *
 * @spec §3.5, §3.6, §10
 */

import { z } from 'zod';

/** The six fixed spine levels, coarse to fine. @spec §3.1, §3.5 */
export const EntityLevel = z.enum([
  'workspace',
  'repo',
  'system',
  'component',
  'module',
  'symbol',
]);

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

/** The episodes/commits/files triple feeding churn decay and independence discounting. @spec §3.5, §4.4, §4.5 */
export const Provenance = z.object({
  episodes: z.array(z.string()),
  commits: z.array(z.string()),
  files: z.array(z.string()),
});

/** A provenance triple. @spec §3.5, §4.4, §4.5 */
export type Provenance = z.infer<typeof Provenance>;

/** A spine node: the structural anchor claims hang from. @spec §3.1, §3.5 */
export const Entity = z.object({
  id: z.string().ulid(),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  level: EntityLevel,
  origin: z.enum(['parsed', 'asserted']),
  ref: z
    .object({
      path: z.string(),
      symbolRange: z.tuple([z.number().int(), z.number().int()]).optional(),
    })
    .optional(),
  glossEmbedding: z.array(z.number()),
  facets: z.array(z.array(z.number())).max(4).default([]),
});

/** A spine node. @spec §3.1, §3.5 */
export type Entity = z.infer<typeof Entity>;

/** A claim node: one self-contained declarative proposition with its own posterior. @spec §3.2, §3.5 */
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
    provenanceOverlap: z.number(), // Jaccard over files ∪ commits
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
  anchor: z.object({ id: z.string().ulid(), name: z.string(), level: EntityLevel }),
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
