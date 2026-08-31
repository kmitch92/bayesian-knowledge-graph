import { describe, expect, it } from 'vitest';

import {
  Claim,
  ClaimKind,
  ClaimStatus,
  ClaimTier,
  ContradictRequest,
  DocumentNode,
  DrillDownRequest,
  Entity,
  EntityLevel,
  Evidence,
  IdentityClaim,
  ObserveRequest,
  Provenance,
  QueryRequest,
  QueryResponse,
  ServedClaim,
} from '../index';

import {
  accumulatedEvidence,
  claimFixture,
  contradictRequestFixture,
  documentNodeFixture,
  drillDownRequestFixture,
  entityFixture,
  identityClaimFixture,
  inferredTierClaimFixture,
  locatorFixture,
  CLAIM_ULID,
  minimalClaimFixture,
  minimalDrillDownRequestFixture,
  minimalEntityFixture,
  minimalObserveRequestFixture,
  minimalQueryRequestFixture,
  observedTierClaimFixture,
  observeRequestFixture,
  overFacetedEntityFixture,
  PRIOR_ALPHA,
  PRIOR_BETA,
  PRIOR_BETA_INFERRED,
  priorEvidence,
  provenanceFixture,
  queryRequestFixture,
  queryResponseFixture,
  rawServedClaimFixture,
  servedClaimFixture,
  skepticalPriorEvidence,
  verifiedTierClaimFixture,
} from './fixtures';

describe('Evidence — the Beta-Bernoulli parameter pair', () => {
  it('round-trips an accumulated posterior unchanged', () => {
    expect(Evidence.parse(accumulatedEvidence)).toStrictEqual(accumulatedEvidence);
  });

  it('round-trips an untouched prior unchanged', () => {
    expect(Evidence.parse(priorEvidence)).toStrictEqual(priorEvidence);
  });

  it('rejects alpha of zero because a Beta with a zero parameter is not a distribution', () => {
    expect(Evidence.safeParse({ alpha: 0, beta: 1 }).success).toBe(false);
  });

  it('rejects beta of zero because a Beta with a zero parameter is not a distribution', () => {
    expect(Evidence.safeParse({ alpha: 1, beta: 0 }).success).toBe(false);
  });

  it('rejects negative alpha', () => {
    expect(Evidence.safeParse({ alpha: -1, beta: 1 }).success).toBe(false);
  });

  it('rejects negative beta', () => {
    expect(Evidence.safeParse({ alpha: 1, beta: -1 }).success).toBe(false);
  });

  it('accepts fractional parameters, since tier weights move alpha and beta by halves', () => {
    expect(Evidence.parse({ alpha: 1.5, beta: 2.25 })).toStrictEqual({ alpha: 1.5, beta: 2.25 });
  });
});

/**
 * The field paths `Provenance` refused a payload on, or none if it accepted it.
 *
 * Named paths rather than a bare `success: false`, because a payload can be
 * refused for a reason that has nothing to do with the field under test — which
 * is how a rejection test goes on passing after the rule it names is gone.
 */
const provenanceRefusals = (value: unknown): string[] => {
  const result = Provenance.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

/** The field paths `Entity` refused a payload on, or none if it accepted it. */
const entityRefusals = (value: unknown): string[] => {
  const result = Entity.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('Provenance — the episodes, changeEvents and artifacts axes', () => {
  it('round-trips every axis and the pathway signature unchanged', () => {
    expect(Provenance.parse(provenanceFixture)).toStrictEqual(provenanceFixture);
  });

  it('accepts empty axes, since a claim may predate any change event that touches it', () => {
    const empty = { episodes: [], changeEvents: [], artifacts: [] };
    expect(Provenance.parse(empty)).toStrictEqual(empty);
  });

  it('requires all three axes to be present on a stored claim', () => {
    expect(Provenance.safeParse({ episodes: ['ep-1'] }).success).toBe(false);
  });

  it('requires the changeEvents axis, which replaced the git-shaped commits arm', () => {
    const { changeEvents: _dropped, ...withoutChangeEvents } = provenanceFixture;
    expect(provenanceRefusals(withoutChangeEvents)).toStrictEqual(['changeEvents']);
  });

  it('requires the artifacts axis, which replaced the git-shaped files arm', () => {
    const { artifacts: _dropped, ...withoutArtifacts } = provenanceFixture;
    expect(provenanceRefusals(withoutArtifacts)).toStrictEqual(['artifacts']);
  });

  it('leaves the pathway signature optional, since a claim need not know how it arrived', () => {
    const { channel: _channel, agent: _agent, ...axesOnly } = provenanceFixture;
    expect(Provenance.parse(axesOnly)).toStrictEqual(axesOnly);
  });

  it('carries the channel and agent a pathway counter is keyed by when they are known', () => {
    const parsed = Provenance.parse(provenanceFixture);
    expect(parsed.channel).toBe('mcp');
    expect(parsed.agent).toBe('claude-code');
  });
});

describe('Entity — the referent index row', () => {
  it('round-trips a fully specified attested referent unchanged', () => {
    expect(Entity.parse(entityFixture)).toStrictEqual(entityFixture);
  });

  it('materialises an empty facets list when none are supplied', () => {
    expect(Entity.parse(minimalEntityFixture).facets).toStrictEqual([]);
  });

  it('accepts a null level, since a referent is unplaced until a containment claim places it', () => {
    expect(Entity.parse({ ...minimalEntityFixture, level: null }).level).toBeNull();
  });

  it('accepts a level the shipped code pack does not declare, since levels are pack data', () => {
    expect(Entity.parse({ ...minimalEntityFixture, level: 'namespace' }).level).toBe('namespace');
  });

  it.each(['view', 'evidence'])('accepts %s as a truth-maintenance regime', (regime) => {
    expect(Entity.parse({ ...minimalEntityFixture, regime }).regime).toBe(regime);
  });

  it('rejects a regime outside view and evidence, because nothing is ever both or neither', () => {
    expect(entityRefusals({ ...minimalEntityFixture, regime: 'parsed' })).toStrictEqual(['regime']);
  });

  it('requires a regime, since which machinery maintains a referent is never left open', () => {
    const { regime: _dropped, ...withoutRegime } = minimalEntityFixture;
    expect(entityRefusals(withoutRegime)).toStrictEqual(['regime']);
  });

  /*
   * `origin` and `aliases` left the shape in v0.6.0. `origin` was the
   * parsed/asserted split that `regime` now carries, and `aliases` was a column
   * of surface forms that the mention index now holds as rows. The object is
   * non-strict, so the assertion available here is that a payload still
   * carrying either one parses to an object that has neither — a stale writer
   * cannot smuggle the old fields through.
   */
  it('drops an origin a v0.2 writer still sends, since regime replaced it', () => {
    const stale = { ...minimalEntityFixture, origin: 'parsed' };
    expect(Entity.parse(stale)).not.toHaveProperty('origin');
  });

  it('drops an aliases list a v0.2 writer still sends, since the mention index holds them', () => {
    const stale = { ...minimalEntityFixture, aliases: ['auth-service', 'the auth thing'] };
    expect(Entity.parse(stale)).not.toHaveProperty('aliases');
  });

  it('drops a ref a v0.2 writer still sends, since locator replaced it', () => {
    const stale = { ...minimalEntityFixture, ref: { path: 'src/auth/index.ts' } };
    expect(Entity.parse(stale)).not.toHaveProperty('ref');
  });

  it('returns a nested locator exactly as it was handed over, having parsed nothing in it', () => {
    const parsed = Entity.parse({ ...minimalEntityFixture, locator: locatorFixture });
    expect(parsed.locator).toStrictEqual(locatorFixture);
  });

  it('accepts a locator shape no recipe in this codebase declares', () => {
    const alien = { kind: 'orbit', frames: [[1, 2]], tag: null, depth: 3 };
    expect(Entity.parse({ ...minimalEntityFixture, locator: alien }).locator).toStrictEqual(alien);
  });

  it('accepts a null locator, since a referent born from a mention points at nothing', () => {
    expect(Entity.parse({ ...minimalEntityFixture, locator: null }).locator).toBeNull();
  });

  it('accepts up to four facet centroids', () => {
    const atCeiling = { ...minimalEntityFixture, facets: [[0.1], [0.2], [0.3], [0.4]] };
    expect(Entity.parse(atCeiling).facets).toHaveLength(4);
  });

  it('rejects more than four facet centroids', () => {
    expect(Entity.safeParse(overFacetedEntityFixture).success).toBe(false);
  });

  it('rejects an empty entity name', () => {
    expect(Entity.safeParse({ ...minimalEntityFixture, name: '' }).success).toBe(false);
  });

  it('rejects an id that is not a ULID', () => {
    expect(Entity.safeParse({ ...minimalEntityFixture, id: 'auth-service' }).success).toBe(false);
  });
});

/*
 * Two tests were removed here in v0.6.0 (A16) rather than rewritten:
 *
 *   it('rejects a level outside the six-level spine', ...)      // 'namespace'
 *   it('rejects a level on an otherwise valid entity', ...)     // 'namespace'
 *
 * Both asserted that the schema closes the set of levels. It no longer does.
 * Levels are pack-declared ordered data: the shipped code pack declares
 * workspace → repo → system → component → module → symbol, and a prose pack or
 * an ops pack is free to declare `namespace` or `practice`. A level is now
 * checked against the *active pack's* ladder by the code recipe that declared
 * it, which is where the ordering it has to respect lives. There is no
 * shape-level rejection left for this layer to make, so asserting one here
 * would be asserting a rule the system deliberately moved.
 */
describe('EntityLevel — an open, pack-declared vocabulary', () => {
  it.each(['workspace', 'repo', 'system', 'component', 'module', 'symbol'])(
    'accepts %s, which the shipped code pack declares',
    (level) => {
      expect(EntityLevel.parse(level)).toBe(level);
    },
  );

  it.each(['namespace', 'practice', 'crate', 'chapter'])(
    'accepts %s, which another pack is free to declare',
    (level) => {
      expect(EntityLevel.parse(level)).toBe(level);
    },
  );

  it('rejects a level that is not a string at all', () => {
    expect(EntityLevel.safeParse(3).success).toBe(false);
  });
});

describe('Claim nodes', () => {
  it('round-trips a fully specified claim unchanged', () => {
    expect(Claim.parse(claimFixture)).toStrictEqual(claimFixture);
  });

  it('defaults canonical to false, so a fresh claim is a raw ledger entry not a view', () => {
    expect(Claim.parse(minimalClaimFixture).canonical).toBe(false);
  });

  it('keeps the optional temporal marks absent on a claim nothing has touched yet', () => {
    const temporal = Claim.parse(minimalClaimFixture).temporal;
    expect(temporal).not.toHaveProperty('lastCorroborated');
    expect(temporal).not.toHaveProperty('invalidatedAt');
    expect(temporal).not.toHaveProperty('lastChurnEvent');
  });

  it('rejects empty claim text, since a claim is a self-contained declarative sentence', () => {
    expect(Claim.safeParse({ ...minimalClaimFixture, text: '' }).success).toBe(false);
  });

  it('rejects a scope that is not a ULID, since scope is a single spine anchor id', () => {
    expect(Claim.safeParse({ ...minimalClaimFixture, scope: 'AuthService' }).success).toBe(false);
  });

  it('rejects a createdAt that is not an ISO-8601 datetime', () => {
    const badTemporal = { ...minimalClaimFixture, temporal: { createdAt: '2026-08-22' } };
    expect(Claim.safeParse(badTemporal).success).toBe(false);
  });

  it('rejects evidence with a non-positive parameter on an otherwise valid claim', () => {
    const zeroed = { ...minimalClaimFixture, evidence: { alpha: 1, beta: 0 } };
    expect(Claim.safeParse(zeroed).success).toBe(false);
  });
});

describe('ClaimKind — the six epistemic kinds', () => {
  it.each(['fact', 'convention', 'rationale', 'risk', 'intent', 'coupling'])(
    'accepts %s as a claim kind',
    (kind) => {
      expect(ClaimKind.parse(kind)).toBe(kind);
    },
  );

  it('rejects a kind outside the closed set', () => {
    expect(ClaimKind.safeParse('assumption').success).toBe(false);
  });

  it('rejects an unknown kind on an otherwise valid claim', () => {
    expect(Claim.safeParse({ ...minimalClaimFixture, kind: 'assumption' }).success).toBe(false);
  });
});

describe('ClaimTier — the three evidence tiers', () => {
  it.each(['verified', 'observed', 'inferred'])('accepts %s as a claim tier', (tier) => {
    expect(ClaimTier.parse(tier)).toBe(tier);
  });

  it('rejects a tier outside the privilege ladder', () => {
    expect(ClaimTier.safeParse('asserted').success).toBe(false);
  });

  it('rejects an unknown tier on an otherwise valid claim', () => {
    expect(Claim.safeParse({ ...minimalClaimFixture, tier: 'asserted' }).success).toBe(false);
  });
});

describe('ClaimStatus — the five lifecycle states', () => {
  it.each(['provisional', 'active', 'disputed', 'deprecated', 'archived'])(
    'accepts %s as a lifecycle state',
    (status) => {
      expect(ClaimStatus.parse(status)).toBe(status);
    },
  );

  it('rejects a status outside the lifecycle', () => {
    expect(ClaimStatus.safeParse('resolved').success).toBe(false);
  });

  it('rejects an unknown status on an otherwise valid claim', () => {
    expect(Claim.safeParse({ ...minimalClaimFixture, status: 'resolved' }).success).toBe(false);
  });
});

describe('Prior seeding as documented data', () => {
  it('gives an inferred-tier claim the skeptical prior beta of two', () => {
    const parsed = Claim.parse(inferredTierClaimFixture);
    expect(parsed.tier).toBe('inferred');
    expect(parsed.evidence).toStrictEqual({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA_INFERRED });
  });

  it('gives an observed-tier claim the ordinary prior beta of one', () => {
    const parsed = Claim.parse(observedTierClaimFixture);
    expect(parsed.tier).toBe('observed');
    expect(parsed.evidence).toStrictEqual({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA });
  });

  it('gives a verified-tier claim the ordinary prior beta of one', () => {
    const parsed = Claim.parse(verifiedTierClaimFixture);
    expect(parsed.tier).toBe('verified');
    expect(parsed.evidence).toStrictEqual({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA });
  });

  it('seeds both priors with an alpha of one regardless of tier', () => {
    expect(priorEvidence.alpha).toBe(PRIOR_ALPHA);
    expect(skepticalPriorEvidence.alpha).toBe(PRIOR_ALPHA);
  });
});

describe('Identity claims', () => {
  it('round-trips a two-member merge hypothesis unchanged', () => {
    expect(IdentityClaim.parse(identityClaimFixture)).toStrictEqual(identityClaimFixture);
  });

  it('rejects a single-member cluster, since identity is a claim about two or more', () => {
    const lonely = { ...identityClaimFixture, members: [CLAIM_ULID] };
    expect(IdentityClaim.safeParse(lonely).success).toBe(false);
  });

  it('rejects an empty member list', () => {
    expect(IdentityClaim.safeParse({ ...identityClaimFixture, members: [] }).success).toBe(false);
  });

  it('rejects members that are not ULIDs', () => {
    const named = { ...identityClaimFixture, members: ['claim-a', 'claim-b'] };
    expect(IdentityClaim.safeParse(named).success).toBe(false);
  });

  it('carries its own evidence, so a merge judgment is evidence and not a verdict', () => {
    expect(IdentityClaim.parse(identityClaimFixture).evidence).toStrictEqual(
      skepticalPriorEvidence,
    );
  });

  it('requires a prior basis of paraphrase distance and provenance overlap', () => {
    const { priorBasis: _dropped, ...withoutBasis } = identityClaimFixture;
    expect(IdentityClaim.safeParse(withoutBasis).success).toBe(false);
  });
});

describe('Document nodes', () => {
  it('round-trips an authored ADR unchanged', () => {
    expect(DocumentNode.parse(documentNodeFixture)).toStrictEqual(documentNodeFixture);
  });

  it('carries no evidence field, since evidence lands on member claims not on prose', () => {
    expect(DocumentNode.parse(documentNodeFixture)).not.toHaveProperty('evidence');
  });

  it.each(['adr', 'runbook', 'overview', 'postmortem', 'other'])(
    'accepts %s as a document kind',
    (docKind) => {
      expect(DocumentNode.parse({ ...documentNodeFixture, docKind }).docKind).toBe(docKind);
    },
  );

  it('rejects a document kind outside the closed set', () => {
    expect(DocumentNode.safeParse({ ...documentNodeFixture, docKind: 'guide' }).success).toBe(
      false,
    );
  });

  it('rejects an origin outside authored and materialized', () => {
    expect(DocumentNode.safeParse({ ...documentNodeFixture, origin: 'parsed' }).success).toBe(
      false,
    );
  });

  it('anchors chunks by hash rather than by raw offsets', () => {
    const offsetAnchored = {
      ...documentNodeFixture,
      chunks: [{ start: 0, end: 240, embedding: [0.1] }],
    };
    expect(DocumentNode.safeParse(offsetAnchored).success).toBe(false);
  });
});

describe('QueryRequest — the retrieval tool', () => {
  it('round-trips a fully specified request unchanged', () => {
    expect(QueryRequest.parse(queryRequestFixture)).toStrictEqual(queryRequestFixture);
  });

  it('defaults the token budget to two thousand', () => {
    expect(QueryRequest.parse(minimalQueryRequestFixture).budgetTokens).toBe(2000);
  });

  it('defaults the retrieval modes to spine and ann', () => {
    expect(QueryRequest.parse(minimalQueryRequestFixture).modes).toStrictEqual(['spine', 'ann']);
  });

  it('leaves the anchor absent so the resolver takes over', () => {
    expect(QueryRequest.parse(minimalQueryRequestFixture)).not.toHaveProperty('anchor');
  });

  it('rejects an empty task, since the task string is what drives retrieval', () => {
    expect(QueryRequest.safeParse({ task: '' }).success).toBe(false);
  });

  it.each(['debugging', 'planning', 'implementing'])('accepts %s as a hint', (hint) => {
    expect(QueryRequest.parse({ ...minimalQueryRequestFixture, hint }).hint).toBe(hint);
  });

  it('rejects a hint outside the three biasing modes', () => {
    const bad = { ...minimalQueryRequestFixture, hint: 'reviewing' };
    expect(QueryRequest.safeParse(bad).success).toBe(false);
  });

  it('rejects a retrieval mode outside spine, ann and traverse', () => {
    const bad = { ...minimalQueryRequestFixture, modes: ['spine', 'grep'] };
    expect(QueryRequest.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-positive token budget', () => {
    expect(QueryRequest.safeParse({ task: 'x', budgetTokens: 0 }).success).toBe(false);
  });

  it('rejects a fractional token budget', () => {
    expect(QueryRequest.safeParse({ task: 'x', budgetTokens: 250.5 }).success).toBe(false);
  });
});

describe('ServedClaim — what retrieval hands back', () => {
  it('round-trips a canonical view with disclosure and rivals unchanged', () => {
    expect(ServedClaim.parse(servedClaimFixture)).toStrictEqual(servedClaimFixture);
  });

  it('round-trips a raw ledger entry without disclosure or rivals unchanged', () => {
    expect(ServedClaim.parse(rawServedClaimFixture)).toStrictEqual(rawServedClaimFixture);
  });

  it('accepts a posterior mean at each end of the unit interval', () => {
    expect(ServedClaim.parse({ ...rawServedClaimFixture, posteriorMean: 0 }).posteriorMean).toBe(0);
    expect(ServedClaim.parse({ ...rawServedClaimFixture, posteriorMean: 1 }).posteriorMean).toBe(1);
  });

  it('rejects a posterior mean above one', () => {
    expect(ServedClaim.safeParse({ ...rawServedClaimFixture, posteriorMean: 1.5 }).success).toBe(
      false,
    );
  });

  it('rejects a negative posterior mean', () => {
    expect(ServedClaim.safeParse({ ...rawServedClaimFixture, posteriorMean: -0.1 }).success).toBe(
      false,
    );
  });

  it('rejects a posterior width above one', () => {
    expect(ServedClaim.safeParse({ ...rawServedClaimFixture, posteriorWidth: 1.2 }).success).toBe(
      false,
    );
  });

  it('rejects a negative posterior width', () => {
    expect(ServedClaim.safeParse({ ...rawServedClaimFixture, posteriorWidth: -0.01 }).success).toBe(
      false,
    );
  });

  it('rejects fractional disclosure counts, since raws and refinements are counted not measured', () => {
    const fractional = {
      ...servedClaimFixture,
      disclosure: { rawCount: 4.5, refinementCount: 1, disputed: true },
    };
    expect(ServedClaim.safeParse(fractional).success).toBe(false);
  });

  it('rejects rivals that are not ULIDs, since contested pairs travel together by id', () => {
    const named = { ...servedClaimFixture, rivals: ['the other one'] };
    expect(ServedClaim.safeParse(named).success).toBe(false);
  });
});

describe('QueryResponse — the retrieval envelope', () => {
  it('round-trips a full response unchanged', () => {
    expect(QueryResponse.parse(queryResponseFixture)).toStrictEqual(queryResponseFixture);
  });

  it('reports the resolved anchor with its spine level', () => {
    expect(QueryResponse.parse(queryResponseFixture).anchor.level).toBe('component');
  });

  it('rejects a response that does not record taint', () => {
    const untainted = { ...queryResponseFixture, taintRecorded: false };
    expect(QueryResponse.safeParse(untainted).success).toBe(false);
  });

  it('rejects a response that omits the taint record entirely', () => {
    const { taintRecorded: _dropped, ...withoutTaint } = queryResponseFixture;
    expect(QueryResponse.safeParse(withoutTaint).success).toBe(false);
  });

  it('accepts an empty claim list, since a cold anchor still returns structure', () => {
    const empty = { ...queryResponseFixture, claims: [] };
    expect(QueryResponse.parse(empty).claims).toStrictEqual([]);
  });

  it('serves an anchor at a level another pack declared, since levels are open data', () => {
    const packLevel = {
      ...queryResponseFixture,
      anchor: { ...queryResponseFixture.anchor, level: 'namespace' },
    };
    expect(QueryResponse.parse(packLevel).anchor.level).toBe('namespace');
  });
});

describe('ObserveRequest — the elective write', () => {
  it('round-trips a write with entity names and partial provenance unchanged', () => {
    expect(ObserveRequest.parse(observeRequestFixture)).toStrictEqual(observeRequestFixture);
  });

  it('round-trips the narrowest legal write unchanged', () => {
    expect(ObserveRequest.parse(minimalObserveRequestFixture)).toStrictEqual(
      minimalObserveRequestFixture,
    );
  });

  it('accepts provenance with any axis omitted, since the caller rarely knows all three', () => {
    const provenance = ObserveRequest.parse(observeRequestFixture).provenance;
    expect(provenance).not.toHaveProperty('changeEvents');
    expect(provenance.artifacts).toStrictEqual(['src/auth/refresh.ts']);
    expect(provenance.episodes).toStrictEqual(['ep-2026-08-22-1147']);
  });

  it('rejects empty claim text', () => {
    expect(ObserveRequest.safeParse({ ...observeRequestFixture, claim: '' }).success).toBe(false);
  });

  it('rejects a tier outside the privilege ladder', () => {
    const bad = { ...observeRequestFixture, tier: 'asserted' };
    expect(ObserveRequest.safeParse(bad).success).toBe(false);
  });

  it('requires provenance to be present even when every arm is empty', () => {
    const { provenance: _dropped, ...withoutProvenance } = observeRequestFixture;
    expect(ObserveRequest.safeParse(withoutProvenance).success).toBe(false);
  });

  it('accepts entity names in about, leaving resolution to the resolver', () => {
    expect(ObserveRequest.parse(observeRequestFixture).about).toStrictEqual([
      'AuthService',
      'CognitoClient',
    ]);
  });
});

describe('ContradictRequest — the rivalry write', () => {
  it('round-trips a verified-tier contradiction unchanged', () => {
    expect(ContradictRequest.parse(contradictRequestFixture)).toStrictEqual(
      contradictRequestFixture,
    );
  });

  it('rejects a target that is not a claim ULID', () => {
    const bad = { ...contradictRequestFixture, target: 'the retry claim' };
    expect(ContradictRequest.safeParse(bad).success).toBe(false);
  });

  it('rejects empty rival claim text', () => {
    expect(ContradictRequest.safeParse({ ...contradictRequestFixture, claim: '' }).success).toBe(
      false,
    );
  });

  it('rejects a tier outside the privilege ladder', () => {
    const bad = { ...contradictRequestFixture, tier: 'asserted' };
    expect(ContradictRequest.safeParse(bad).success).toBe(false);
  });
});

describe('DrillDownRequest — reading through a canonical to its members', () => {
  it('round-trips an audit read unchanged', () => {
    expect(DrillDownRequest.parse(drillDownRequestFixture)).toStrictEqual(drillDownRequestFixture);
  });

  it('defaults includeArchived to false, so archived claims stay out of ordinary reads', () => {
    expect(DrillDownRequest.parse(minimalDrillDownRequestFixture).includeArchived).toBe(false);
  });

  it('rejects a canonical target that is not a ULID', () => {
    expect(DrillDownRequest.safeParse({ canonical: 'AuthService' }).success).toBe(false);
  });
});
