/**
 * Persistence round-trips for the §3.1 entity spine and the §3.2 claim node.
 *
 * Every read goes back through the P0 Zod schemas with `.parse`, so a
 * persistence bug shows up as a schema violation rather than as a plausible
 * wrong value. That matters most for the shapes SQLite has no native column for:
 * `aliases[]`, `facets[]`, the three provenance arrays and the four optional
 * `temporal` fields all have to survive a flatten-and-rehydrate that a naive
 * column mapping quietly mangles — dropping an empty array to NULL, collapsing a
 * one-element array to a scalar, or losing an absent optional as an explicit
 * `null` that `.datetime()` then rejects.
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
import { DuplicateClaimError, UnknownEntityError, openGraphStore, type GraphStore } from '../index';

import {
  CLAIM_ID,
  CREATED_AT,
  ENTITY_ID,
  EPISODE_ID,
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

describe('entity round-trip', () => {
  it('reloads a fully populated entity exactly as it was written', () => {
    const entity = makeEntity();
    store.putEntity(entity);

    expect(Entity.parse(store.getEntity(ENTITY_ID))).toStrictEqual(entity);
  });

  it('preserves the alias list that keeps AuthService and auth-service one subgraph', () => {
    store.putEntity(makeEntity({ aliases: ['auth-service', 'the auth thing', 'AuthSvc'] }));

    expect(Entity.parse(store.getEntity(ENTITY_ID)).aliases).toStrictEqual([
      'auth-service',
      'the auth thing',
      'AuthSvc',
    ]);
  });

  it('materializes the empty alias default rather than reloading a null', () => {
    store.putEntity(makeMinimalEntity());

    expect(Entity.parse(store.getEntity(OTHER_ENTITY_ID)).aliases).toStrictEqual([]);
  });

  it('preserves a single alias as a one-element array and not as a bare string', () => {
    store.putEntity(makeEntity({ aliases: ['auth-service'] }));

    expect(Entity.parse(store.getEntity(ENTITY_ID)).aliases).toStrictEqual(['auth-service']);
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

  it('reloads the parsed source reference including its symbol range', () => {
    store.putEntity(makeEntity());

    expect(Entity.parse(store.getEntity(ENTITY_ID)).ref).toStrictEqual({
      path: 'src/auth/index.ts',
      symbolRange: [1, 412],
    });
  });

  it('leaves ref absent for an asserted grouping, which has no file to point at', () => {
    store.putEntity(makeMinimalEntity());

    expect(Entity.parse(store.getEntity(OTHER_ENTITY_ID))).not.toHaveProperty('ref');
  });

  it('reloads a parsed ref that has a path but no symbol range, as a module-level node does', () => {
    store.putEntity(makeEntity({ ref: { path: 'src/auth/index.ts' } }));

    expect(Entity.parse(store.getEntity(ENTITY_ID)).ref).toStrictEqual({
      path: 'src/auth/index.ts',
    });
  });

  it('distinguishes a parsed origin from an asserted one, since asserted boundaries are revisable', () => {
    store.putEntity(makeEntity({ origin: 'parsed' }));
    store.putEntity(makeMinimalEntity({ origin: 'asserted' }));

    expect(Entity.parse(store.getEntity(ENTITY_ID)).origin).toBe('parsed');
    expect(Entity.parse(store.getEntity(OTHER_ENTITY_ID)).origin).toBe('asserted');
  });

  it('reloads every one of the six spine levels', () => {
    const levels = ['workspace', 'repo', 'system', 'component', 'module', 'symbol'] as const;
    const reloaded = levels.map((level, index) => {
      const id = `${'0'.repeat(25)}${index}`;
      store.putEntity(makeEntity({ id, level }));
      return Entity.parse(store.getEntity(id)).level;
    });

    expect(reloaded).toStrictEqual([...levels]);
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

    expect(Claim.parse(store.getClaim(CLAIM_ID))).toStrictEqual(claim);
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

  it('reloads all three provenance arrays in order', () => {
    const claim = makeClaim();
    store.putClaim(claim);

    expect(Claim.parse(store.getClaim(CLAIM_ID)).provenance).toStrictEqual(claim.provenance);
  });

  it('reloads empty provenance arrays as empty arrays, not as nulls', () => {
    store.putClaim(makeMinimalClaim());

    expect(Claim.parse(store.getClaim(RIVAL_CLAIM_ID)).provenance).toStrictEqual({
      episodes: [],
      commits: [],
      files: [],
    });
  });

  it('reloads a provenance triple that is populated on one axis only', () => {
    store.putClaim(
      makeClaim({ provenance: { episodes: [EPISODE_ID], commits: [], files: [] } }),
    );

    expect(Claim.parse(store.getClaim(CLAIM_ID)).provenance).toStrictEqual({
      episodes: [EPISODE_ID],
      commits: [],
      files: [],
    });
  });

  it('preserves file paths verbatim, including ones with characters a naive delimiter would split on', () => {
    const files = ['src/auth/session.ts', 'src/auth/[id],weird.ts', 'src/auth/a b.ts'];
    store.putClaim(makeClaim({ provenance: { episodes: [], commits: [], files } }));

    expect(Claim.parse(store.getClaim(CLAIM_ID)).provenance.files).toStrictEqual(files);
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

    expect(Claim.parse(store.getClaim(CLAIM_ID))).toStrictEqual(claim);
  });

  it('refuses a claim anchored at a scope entity that does not exist, since scope is the one anchor', () => {
    expect(() => {
      store.putClaim(makeClaim({ scope: OTHER_ENTITY_ID }));
    }).toThrow(UnknownEntityError);
  });
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
