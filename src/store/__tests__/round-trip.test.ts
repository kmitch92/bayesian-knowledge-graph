/**
 * Persistence round-trips for the §3.1 referent index and the §3.2 claim node.
 *
 * Field-level reads still go back through the P0 Zod schemas with `.parse`, so a
 * persistence bug shows up as a schema violation rather than as a plausible
 * wrong value. That matters most for the shapes SQLite has no native column for:
 * `facets[]`, the opaque `locator`, the three provenance axes and the four
 * optional `temporal` fields all have to survive a flatten-and-rehydrate that a
 * naive column mapping quietly mangles — dropping an empty array to NULL,
 * collapsing a one-element array to a scalar, or losing an absent optional as an
 * explicit `null` that `.datetime()` then rejects.
 *
 * Whole-record reads are asserted against the store's own return value instead.
 * The ledger row is a superset of §3.5's Zod block — it carries the `regime`
 * that decides whether a posterior exists at all — and a non-strict `.parse`
 * would silently strip that field before the comparison ran.
 *
 * `putClaim` is minting, not upserting. §5.7 keeps every mutation of a live
 * claim on an atomic single-statement path, and principle 4 keeps the ledger
 * append-only, so overwriting a whole claim row is not an operation this store
 * offers. Entities are the opposite: the parser re-derives the structural floor
 * on every parse (§3.3, principle 2), so `putEntity` is an upsert by design.
 *
 * @spec §3.1, §3.2, §3.3, §3.5, §5.7
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Claim, Entity } from '../../schema/index';
import { DuplicateClaimError, openGraphStore, type GraphStore } from '../index';

import {
  AGENT,
  CHANNEL,
  CLAIM_ID,
  CREATED_AT,
  ENTITY_ID,
  EPISODE_ID,
  LOCATOR,
  OTHER_ENTITY_ID,
  RIVAL_CLAIM_ID,
  makeClaim,
  makeEntity,
  makeMinimalClaim,
  makeMinimalEntity,
  unitVectorArray,
} from './fixtures';

let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

/*
 * Three alias round-trips were removed here in v0.6.0, not rewritten:
 *
 *   it('preserves the alias list that keeps AuthService and auth-service one subgraph', ...)
 *   it('materializes the empty alias default rather than reloading a null', ...)
 *   it('preserves a single alias as a one-element array and not as a bare string', ...)
 *
 * Surface forms are no longer a JSON column on the referent. They are rows in
 * the mention index, many to one, so what used to be "does this array survive a
 * flatten" is now "do these surface forms all resolve to this referent" — a
 * different behaviour, asserted in `regime.test.ts` where the rest of the
 * ledger/view separation lives.
 */
describe('referent round-trip', () => {
  it('reloads a fully populated referent exactly as it was written', () => {
    const entity = makeEntity();
    store.putEntity(entity);

    expect(store.getEntity(ENTITY_ID)).toStrictEqual(entity);
  });

  it('reloads all four facet centroids in order, at full width', () => {
    const facets = [1, 2, 3, 4].map((seed) => unitVectorArray(seed + 100));
    store.putEntity(makeEntity({ facets }));

    expect(Entity.parse(store.getEntity(ENTITY_ID)).facets).toStrictEqual(facets);
  });

  it('materializes the empty facet default for an entity no claim has attached to yet', () => {
    store.putEntity(makeMinimalEntity());

    expect(Entity.parse(store.getEntity(OTHER_ENTITY_ID)).facets).toStrictEqual([]);
  });

  it('reloads the code recipe locator with its nesting intact', () => {
    store.putEntity(makeEntity());

    expect(Entity.parse(store.getEntity(ENTITY_ID)).locator).toStrictEqual(LOCATOR);
  });

  it('reloads a null locator for a referent that points at nothing', () => {
    store.putEntity(makeMinimalEntity());

    expect(Entity.parse(store.getEntity(OTHER_ENTITY_ID)).locator).toBeNull();
  });

  it('distinguishes an attested referent from an unattested one, since the two are maintained differently', () => {
    store.putEntity(makeEntity({ regime: 'view' }));
    store.putEntity(makeMinimalEntity({ regime: 'evidence' }));

    expect(store.getEntity(ENTITY_ID)?.regime).toBe('view');
    expect(store.getEntity(OTHER_ENTITY_ID)?.regime).toBe('evidence');
  });

  it('reloads every level the shipped code pack declares', () => {
    const levels = ['workspace', 'repo', 'system', 'component', 'module', 'symbol'] as const;
    const reloaded = levels.map((level, index) => {
      const id = `${'0'.repeat(25)}${index}`;
      store.putEntity(makeEntity({ id, level }));
      return Entity.parse(store.getEntity(id)).level;
    });

    expect(reloaded).toStrictEqual([...levels]);
  });

  it('reloads a level no pack in this codebase declares, since the ladder is pack data', () => {
    store.putEntity(makeEntity({ level: 'namespace' }));

    expect(Entity.parse(store.getEntity(ENTITY_ID)).level).toBe('namespace');
  });

  it('reloads a null level for a referent no containment claim has placed yet', () => {
    store.putEntity(makeMinimalEntity());

    expect(Entity.parse(store.getEntity(OTHER_ENTITY_ID)).level).toBeNull();
  });

  it('upserts, because the parser re-derives the structural floor on every parse', () => {
    store.putEntity(makeEntity({ name: 'AuthService' }));
    store.putEntity(makeEntity({ name: 'AuthenticationService' }));

    expect(Entity.parse(store.getEntity(ENTITY_ID)).name).toBe('AuthenticationService');
  });

  it('returns undefined for an entity that was never written', () => {
    expect(store.getEntity(ENTITY_ID)).toBeUndefined();
  });
});

describe('claim round-trip', () => {
  beforeEach(() => {
    store.putEntity(makeEntity());
  });

  it('reloads a fully populated claim exactly as it was written', () => {
    const claim = makeClaim();
    store.putClaim(claim);

    expect(store.getClaim(CLAIM_ID)).toStrictEqual(claim);
  });

  it('reloads a freshly minted claim, materializing the canonical default as false', () => {
    store.putClaim(makeMinimalClaim());

    expect(Claim.parse(store.getClaim(RIVAL_CLAIM_ID)).canonical).toBe(false);
  });

  it('reloads a canonical view flag as true', () => {
    store.putClaim(makeClaim({ canonical: true }));

    expect(Claim.parse(store.getClaim(CLAIM_ID)).canonical).toBe(true);
  });

  it('reloads all four temporal fields when every one is set', () => {
    const claim = makeClaim();
    store.putClaim(claim);

    expect(Claim.parse(store.getClaim(CLAIM_ID)).temporal).toStrictEqual(claim.temporal);
  });

  it('leaves the three optional temporal fields absent on a claim nothing has happened to yet', () => {
    store.putClaim(makeMinimalClaim());

    expect(Claim.parse(store.getClaim(RIVAL_CLAIM_ID)).temporal).toStrictEqual({
      createdAt: CREATED_AT,
    });
  });

  it('reloads lastCorroborated on its own without inventing the other two', () => {
    store.putClaim(
      makeClaim({
        temporal: { createdAt: CREATED_AT, lastCorroborated: '2026-08-22T11:47:52.000Z' },
      }),
    );

    expect(Claim.parse(store.getClaim(CLAIM_ID)).temporal).toStrictEqual({
      createdAt: CREATED_AT,
      lastCorroborated: '2026-08-22T11:47:52.000Z',
    });
  });

  it('reloads invalidatedAt on its own, as a deprecated claim carries it', () => {
    store.putClaim(
      makeClaim({
        status: 'deprecated',
        temporal: { createdAt: CREATED_AT, invalidatedAt: '2026-08-22T16:02:19.000Z' },
      }),
    );

    expect(Claim.parse(store.getClaim(CLAIM_ID)).temporal).toStrictEqual({
      createdAt: CREATED_AT,
      invalidatedAt: '2026-08-22T16:02:19.000Z',
    });
  });

  it('reloads lastChurnEvent on its own, as a decayed but uncorroborated claim carries it', () => {
    store.putClaim(
      makeClaim({
        temporal: { createdAt: CREATED_AT, lastChurnEvent: '2026-08-22T15:30:00.000Z' },
      }),
    );

    expect(Claim.parse(store.getClaim(CLAIM_ID)).temporal).toStrictEqual({
      createdAt: CREATED_AT,
      lastChurnEvent: '2026-08-22T15:30:00.000Z',
    });
  });

  it('reloads all three provenance axes in order, alongside the pathway signature', () => {
    const claim = makeClaim();
    store.putClaim(claim);

    expect(Claim.parse(store.getClaim(CLAIM_ID)).provenance).toStrictEqual(claim.provenance);
  });

  it('reloads the channel and agent a pathway counter is keyed by', () => {
    store.putClaim(makeClaim());

    const provenance = Claim.parse(store.getClaim(CLAIM_ID)).provenance;
    expect(provenance.channel).toBe(CHANNEL);
    expect(provenance.agent).toBe(AGENT);
  });

  it('leaves the pathway signature absent for a claim that arrived by no known pathway', () => {
    store.putClaim(makeMinimalClaim());

    const provenance = Claim.parse(store.getClaim(RIVAL_CLAIM_ID)).provenance;
    expect(provenance).not.toHaveProperty('channel');
    expect(provenance).not.toHaveProperty('agent');
  });

  it('reloads empty provenance axes as empty arrays, not as nulls', () => {
    store.putClaim(makeMinimalClaim());

    expect(Claim.parse(store.getClaim(RIVAL_CLAIM_ID)).provenance).toStrictEqual({
      episodes: [],
      changeEvents: [],
      artifacts: [],
    });
  });

  it('reloads a provenance that is populated on one axis only', () => {
    store.putClaim(
      makeClaim({ provenance: { episodes: [EPISODE_ID], changeEvents: [], artifacts: [] } }),
    );

    expect(Claim.parse(store.getClaim(CLAIM_ID)).provenance).toStrictEqual({
      episodes: [EPISODE_ID],
      changeEvents: [],
      artifacts: [],
    });
  });

  it('preserves artifact references verbatim, including ones a naive delimiter would split on', () => {
    const artifacts = ['src/auth/session.ts', 'src/auth/[id],weird.ts', 'src/auth/a b.ts'];
    store.putClaim(makeClaim({ provenance: { episodes: [], changeEvents: [], artifacts } }));

    expect(Claim.parse(store.getClaim(CLAIM_ID)).provenance.artifacts).toStrictEqual(artifacts);
  });

  it('reloads every one of the six epistemic kinds', () => {
    const kinds = ['fact', 'convention', 'rationale', 'risk', 'intent', 'coupling'] as const;
    const reloaded = kinds.map((kind, index) => {
      const id = `${'0'.repeat(24)}K${index}`;
      store.putClaim(makeClaim({ id, kind }));
      return Claim.parse(store.getClaim(id)).kind;
    });

    expect(reloaded).toStrictEqual([...kinds]);
  });

  it('reloads every one of the three evidence tiers', () => {
    const tiers = ['verified', 'observed', 'inferred'] as const;
    const reloaded = tiers.map((tier, index) => {
      const id = `${'0'.repeat(24)}T${index}`;
      store.putClaim(makeClaim({ id, tier }));
      return Claim.parse(store.getClaim(id)).tier;
    });

    expect(reloaded).toStrictEqual([...tiers]);
  });

  it('reloads every one of the five lifecycle states', () => {
    const statuses = ['provisional', 'active', 'disputed', 'deprecated', 'archived'] as const;
    const reloaded = statuses.map((status, index) => {
      const id = `${'0'.repeat(24)}S${index}`;
      store.putClaim(makeClaim({ id, status }));
      return Claim.parse(store.getClaim(id)).status;
    });

    expect(reloaded).toStrictEqual([...statuses]);
  });

  it('reloads a fractional posterior without rounding it to integers', () => {
    store.putClaim(makeClaim({ evidence: { alpha: 4.75, beta: 1.25 } }));

    expect(Claim.parse(store.getClaim(CLAIM_ID)).evidence).toStrictEqual({
      alpha: 4.75,
      beta: 1.25,
    });
  });

  it('preserves the exact claim text, which is the normalized self-contained sentence', () => {
    const text = 'The "refresh" path in `AuthService` is idempotent — verified at 9f2c1ab.';
    store.putClaim(makeClaim({ text }));

    expect(Claim.parse(store.getClaim(CLAIM_ID)).text).toBe(text);
  });

  it('returns undefined for a claim that was never written', () => {
    expect(store.getClaim(CLAIM_ID)).toBeUndefined();
  });
});

describe('the claim write boundary', () => {
  beforeEach(() => {
    store.putEntity(makeEntity());
  });

  it('refuses a second claim with an id already in the ledger, because minting is not upserting', () => {
    store.putClaim(makeClaim());

    expect(() => {
      store.putClaim(makeClaim({ text: 'A different proposition under the same id.' }));
    }).toThrow(DuplicateClaimError);
  });

  it('leaves the original claim intact after a rejected re-mint', () => {
    const claim = makeClaim();
    store.putClaim(claim);

    expect(() => {
      store.putClaim(makeClaim({ text: 'A different proposition under the same id.' }));
    }).toThrow(DuplicateClaimError);

    expect(store.getClaim(CLAIM_ID)).toStrictEqual(claim);
  });

  /*
   * Removed here in v0.6.0, not rewritten:
   *
   *   it('refuses a claim anchored at a scope entity that does not exist, ...', ...)
   *
   * `claims.scope` lost its foreign key to the referent index. The index is a
   * view over existence claims, rebuildable from the ledger, and a ledger row
   * that a view can refuse is a ledger the view constrains. Scope is now a
   * referent id and nothing more. The behaviour that replaced this refusal — a
   * claim scoped to a referent no index row holds is written anyway — is
   * asserted in `regime.test.ts`.
   */
});

describe('claim status transitions', () => {
  beforeEach(() => {
    store.putEntity(makeEntity());
    store.putClaim(makeClaim({ status: 'provisional' }));
  });

  it('moves a claim to a new lifecycle state without disturbing anything else', () => {
    const before = Claim.parse(store.getClaim(CLAIM_ID));

    store.setClaimStatus({ claimId: CLAIM_ID, status: 'active' });

    expect(Claim.parse(store.getClaim(CLAIM_ID))).toStrictEqual({ ...before, status: 'active' });
  });

  it('stamps the invalidation instant when one is supplied with the transition', () => {
    store.setClaimStatus({
      claimId: CLAIM_ID,
      status: 'deprecated',
      invalidatedAt: '2026-08-22T16:02:19.000Z',
    });

    expect(Claim.parse(store.getClaim(CLAIM_ID)).temporal.invalidatedAt).toBe(
      '2026-08-22T16:02:19.000Z',
    );
  });

  it('leaves the posterior alone, because a status change is not evidence', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'disputed' });

    expect(Claim.parse(store.getClaim(CLAIM_ID)).evidence).toStrictEqual(makeClaim().evidence);
  });
});
