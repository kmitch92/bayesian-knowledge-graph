/**
 * The v0.6.0 regime rule, and the ledger/view separation it rests on.
 *
 * Diagram §6: *"Same node type; two truth-maintenance regimes. Nothing is ever
 * both."* A referent a noun source attests is maintained by re-parsing that
 * source — it is invalidated by the change feed, served with an as-of marker,
 * and carries no posterior at all, so re-running the parser cannot inflate
 * anything. A referent nothing attests is maintained by evidence: α and β, taint,
 * caps, saturation. A claim is in one regime or the other. Never both — a view
 * claim with a posterior is a parser vote counted as corroboration. Never
 * neither — an evidence claim with no posterior is a belief with no belief in it.
 *
 * The other half of the file is the same rule seen from the storage side.
 * Diagram §4: *"Claims are the only primitive. Everything on the right is a
 * materialized view, rebuildable from the ledger. No foreign keys point from the
 * ledger onto views."* That is a testable claim, not a slogan: if the referent
 * index, the mention index and the containment index can all be dropped without
 * the ledger noticing, the ledger genuinely does not depend on them.
 *
 * Reads here go through the store's own return value rather than through
 * `Claim.parse`. The ledger row carries a `regime` and a nullable `evidence`;
 * §3.5's Zod block carries neither, and a non-strict parse would quietly strip
 * exactly the field under test.
 *
 * Real SQLite throughout, `:memory:`, no mocks: the rules being tested are
 * column nullability and dropped foreign keys, which only a real engine has.
 *
 * @spec §3.1, §3.2, §3.5, §4.1, §5.2
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Evidence } from '../../schema/index';
import { RegimeViolationError, openGraphStore, type GraphStore } from '../index';

import {
  CLAIM_ID,
  ENTITY_ID,
  OTHER_ENTITY_ID,
  RIVAL_CLAIM_ID,
  THIRD_CLAIM_ID,
  makeClaim,
  makeEntity,
  makeMinimalEntity,
  makeViewClaim,
  testUlid,
} from './fixtures';

let store: GraphStore;

/**
 * What one untainted, uncapped naming is worth at §15's observed tier.
 *
 * Every mention this file records is recorded at it. Nothing here reads the
 * tally — these cases are about which referent a form resolves to, and about the
 * mention index surviving or not surviving a `clearViews` — so the weight is
 * present because `putMention` caches a naming claim's support rather than
 * counting uses, and a naming with no support behind it is not a naming this file
 * means to record.
 *
 * @spec §3.1, §4.2, §15
 */
const ONE_OBSERVATION = 1;

/**
 * The refusal a write produced, or `undefined` if it did not refuse.
 *
 * Returned rather than matched with `toThrow(RegimeViolationError)`, because a
 * store that refuses for some entirely unrelated reason — a shape violation, a
 * null constraint — satisfies `toThrow` just as well and never shows that the
 * regime rule is the thing being enforced.
 *
 * @spec §3.2
 */
const refusalFrom = (write: () => void): unknown => {
  try {
    write();
    return undefined;
  } catch (error) {
    return error;
  }
};

/**
 * Posteriors that are the right shape and still not a distribution.
 *
 * Kept apart from the null cases below: an absent parameter and a parameter of
 * zero reach `putClaim` down the same branch, so a suite that only offers nulls
 * proves the branch exists without ever proving where it draws the line. §4.1's
 * Beta parameters are strictly positive — α = 0 is a claim with no probability
 * mass anywhere it could be true.
 *
 * @spec §3.2, §4.1
 */
const NON_POSITIVE_POSTERIORS: readonly [string, Evidence][] = [
  ['α is zero', { alpha: 0, beta: 2 }],
  ['β is zero', { alpha: 4, beta: 0 }],
  ['α is negative', { alpha: -1, beta: 2 }],
  ['β is negative', { alpha: 4, beta: -1 }],
];

/** Posteriors carrying a number that is not a real number. @spec §4.1 */
const UNREAL_POSTERIORS: readonly [string, Evidence][] = [
  ['α is infinite', { alpha: Number.POSITIVE_INFINITY, beta: 2 }],
  ['α is NaN', { alpha: Number.NaN, beta: 2 }],
  ['β is NaN', { alpha: 4, beta: Number.NaN }],
];

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('the view regime — a referent a noun source attests', () => {
  it('round-trips a claim that carries no posterior at all', () => {
    const claim = makeViewClaim();
    store.putClaim(claim);

    expect(store.getClaim(THIRD_CLAIM_ID)).toStrictEqual(claim);
  });

  it('reports a null posterior rather than seeding a prior nobody asked for', () => {
    store.putClaim(makeViewClaim());

    expect(store.getClaim(THIRD_CLAIM_ID)?.evidence).toBeNull();
  });

  it('tells a claim that has no posterior apart from a claim that does not exist', () => {
    store.putClaim(makeViewClaim());

    expect(store.getEvidence(THIRD_CLAIM_ID)).toBeNull();
    expect(store.getEvidence(CLAIM_ID)).toBeUndefined();
  });

  it('refuses a view claim that arrives carrying a posterior, since nothing is ever both', () => {
    const refusal = refusalFrom(() => {
      store.putClaim(makeViewClaim({ evidence: { alpha: 3, beta: 1 } }));
    });

    expect(refusal).toBeInstanceOf(RegimeViolationError);
  });

  it('writes nothing at all when it refuses a view claim carrying a posterior', () => {
    const refusal = refusalFrom(() => {
      store.putClaim(makeViewClaim({ evidence: { alpha: 3, beta: 1 } }));
    });

    expect(refusal).toBeInstanceOf(RegimeViolationError);
    expect(store.getClaim(THIRD_CLAIM_ID)).toBeUndefined();
  });
});

describe('the evidence regime — a referent nothing attests', () => {
  it('round-trips the posterior a claim was minted with', () => {
    const claim = makeClaim({ evidence: { alpha: 4.5, beta: 2 } });
    store.putClaim(claim);

    expect(store.getClaim(CLAIM_ID)?.evidence).toStrictEqual({ alpha: 4.5, beta: 2 });
  });

  it('refuses an evidence claim with no posterior, since nothing is ever neither', () => {
    const refusal = refusalFrom(() => {
      store.putClaim(makeClaim({ evidence: null }));
    });

    expect(refusal).toBeInstanceOf(RegimeViolationError);
  });

  it.each([
    ['alpha', { alpha: null, beta: 2 }],
    ['beta', { alpha: 4, beta: null }],
  ])(
    'refuses an evidence claim whose %s is null, since half a Beta is not a distribution',
    (_parameter, partial) => {
      const refusal = refusalFrom(() => {
        store.putClaim(makeClaim({ evidence: partial as unknown as Evidence }));
      });

      expect(refusal).toBeInstanceOf(RegimeViolationError);
    },
  );

  it.each(NON_POSITIVE_POSTERIORS)(
    'refuses an evidence claim whose %s, since a Beta parameter is strictly positive',
    (_description, posterior) => {
      const refusal = refusalFrom(() => {
        store.putClaim(makeClaim({ evidence: posterior }));
      });

      expect(refusal).toBeInstanceOf(RegimeViolationError);
    },
  );

  it.each(UNREAL_POSTERIORS)(
    'refuses an evidence claim whose %s, since no such Beta exists to update',
    (_description, posterior) => {
      const refusal = refusalFrom(() => {
        store.putClaim(makeClaim({ evidence: posterior }));
      });

      expect(refusal).toBeInstanceOf(RegimeViolationError);
    },
  );

  it('writes nothing at all when it refuses an evidence claim with no posterior', () => {
    const refusal = refusalFrom(() => {
      store.putClaim(makeClaim({ evidence: null }));
    });

    expect(refusal).toBeInstanceOf(RegimeViolationError);
    expect(store.getClaim(CLAIM_ID)).toBeUndefined();
  });

  it('writes nothing at all when it refuses a posterior whose α is zero', () => {
    const refusal = refusalFrom(() => {
      store.putClaim(makeClaim({ evidence: { alpha: 0, beta: 1 } }));
    });

    expect(refusal).toBeInstanceOf(RegimeViolationError);
    expect(store.getClaim(CLAIM_ID)).toBeUndefined();
  });

  it('admits the smallest posterior that is still a distribution', () => {
    const barely: Evidence = { alpha: Number.MIN_VALUE, beta: Number.MIN_VALUE };
    store.putClaim(makeClaim({ evidence: barely }));

    expect(store.getEvidence(CLAIM_ID)).toStrictEqual(barely);
  });

  it('keeps the two regimes side by side in one ledger, since they are one node type', () => {
    const attested = makeViewClaim();
    const observed = makeClaim();
    store.putClaim(attested);
    store.putClaim(observed);

    expect([store.getClaim(THIRD_CLAIM_ID), store.getClaim(CLAIM_ID)]).toStrictEqual([
      attested,
      observed,
    ]);
  });
});

describe('scope names a referent, and names it without a foreign key', () => {
  it('writes a claim whose scope no referent-index row holds', () => {
    const claim = makeClaim({ scope: OTHER_ENTITY_ID });
    store.putClaim(claim);

    expect(store.getClaim(CLAIM_ID)).toStrictEqual(claim);
  });

  it('preserves a scope id that was never minted as a referent anywhere', () => {
    const unminted = testUlid('REFERENT-NOBODY-INDEXED');
    store.putClaim(makeClaim({ scope: unminted }));

    expect(store.getClaim(CLAIM_ID)?.scope).toBe(unminted);
  });
});

describe('the mention index — many surface forms, one referent', () => {
  const surfaceForms = ['AuthService', 'auth-service', 'the auth thing', 'AuthSvc'];

  beforeEach(() => {
    store.putEntity(makeEntity());
  });

  it('resolves every surface form of one referent back to the same id', () => {
    surfaceForms.forEach((surfaceForm) => {
      store.putMention({ surfaceForm, referentId: ENTITY_ID, weight: ONE_OBSERVATION });
    });

    expect(surfaceForms.map((surfaceForm) => store.resolveMention(surfaceForm))).toStrictEqual(
      surfaceForms.map(() => ENTITY_ID),
    );
  });

  it('keeps two referents apart when each is named several ways', () => {
    store.putEntity(makeMinimalEntity());
    store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_OBSERVATION });
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_OBSERVATION });
    store.putMention({
      surfaceForm: 'CognitoClient',
      referentId: OTHER_ENTITY_ID,
      weight: ONE_OBSERVATION,
    });
    store.putMention({
      surfaceForm: 'the cognito wrapper',
      referentId: OTHER_ENTITY_ID,
      weight: ONE_OBSERVATION,
    });

    expect(['AuthService', 'auth-service'].map((form) => store.resolveMention(form))).toStrictEqual([
      ENTITY_ID,
      ENTITY_ID,
    ]);
    expect(
      ['CognitoClient', 'the cognito wrapper'].map((form) => store.resolveMention(form)),
    ).toStrictEqual([OTHER_ENTITY_ID, OTHER_ENTITY_ID]);
  });

  it('records one surface form once however many times an episode names it', () => {
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_OBSERVATION });
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_OBSERVATION });

    expect(store.resolveMention('auth-service')).toBe(ENTITY_ID);
  });

  it('returns undefined for a surface form nothing has been named by', () => {
    expect(store.resolveMention('AuthenticationService')).toBeUndefined();
  });
});

describe('views cannot constrain the ledger', () => {
  const claims = [
    makeClaim(),
    makeClaim({ id: RIVAL_CLAIM_ID, text: 'AuthService.refresh retries twice.' }),
    makeViewClaim(),
  ];

  beforeEach(() => {
    store.putEntity(makeEntity());
    store.putEntity(makeMinimalEntity());
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_OBSERVATION });
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CONTAINS', to: OTHER_ENTITY_ID }]);
    claims.forEach((claim) => {
      store.putClaim(claim);
    });
  });

  it('keeps every claim after the referent, mention and containment indexes are dropped', () => {
    store.clearViews();

    expect(claims.map((claim) => store.getClaim(claim.id))).toStrictEqual(claims);
  });

  it('keeps a view-regime claim through the drop, posterior still absent', () => {
    store.clearViews();

    expect(store.getClaim(THIRD_CLAIM_ID)?.evidence).toBeNull();
  });

  it('keeps an evidence-regime posterior readable through the drop', () => {
    store.clearViews();

    expect(store.getEvidence(CLAIM_ID)).toStrictEqual(makeClaim().evidence);
  });

  it('actually drops the referent index, the mention index and the containment index', () => {
    store.clearViews();

    expect(store.getEntity(ENTITY_ID)).toBeUndefined();
    expect(store.resolveMention('auth-service')).toBeUndefined();
    expect(store.getStructuralEdges(ENTITY_ID)).toStrictEqual([]);
  });

  it('lets the dropped indexes be rebuilt over a ledger that never moved', () => {
    store.clearViews();
    store.putEntity(makeEntity());
    store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_OBSERVATION });

    expect(store.resolveMention('auth-service')).toBe(ENTITY_ID);
    expect(claims.map((claim) => store.getClaim(claim.id))).toStrictEqual(claims);
  });
});

describe('the locator the store never parses', () => {
  it('returns a nested locator byte for byte, having read no field of it', () => {
    const locator = {
      path: 'src/auth/index.ts',
      symbolRange: [1, 412],
      vcs: { rev: '9f2c1ab', dirty: false, tag: null },
      spans: [
        [1, 88],
        [104, 412],
      ],
    };
    store.putEntity(makeEntity({ locator }));

    expect(store.getEntity(ENTITY_ID)?.locator).toStrictEqual(locator);
  });

  it('returns a locator in a shape no recipe in this codebase declares', () => {
    const locator = { kind: 'orbit', frames: [[1, 2]], depth: 3, label: null };
    store.putEntity(makeEntity({ locator }));

    expect(store.getEntity(ENTITY_ID)?.locator).toStrictEqual(locator);
  });

  it('returns a locator that is not an object at all', () => {
    store.putEntity(makeEntity({ locator: 'urn:pack:prose#chapter-4' }));

    expect(store.getEntity(ENTITY_ID)?.locator).toBe('urn:pack:prose#chapter-4');
  });

  it('preserves a locator string with characters a naive serializer would escape', () => {
    const locator = 'src/auth/[id]"weird".ts — ✓\n\tline 2';
    store.putEntity(makeEntity({ locator }));

    expect(store.getEntity(ENTITY_ID)?.locator).toBe(locator);
  });

  it('returns a null locator for a referent that points at nothing', () => {
    store.putEntity(makeEntity({ locator: null }));

    expect(store.getEntity(ENTITY_ID)?.locator).toBeNull();
  });
});
