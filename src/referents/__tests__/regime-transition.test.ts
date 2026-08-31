/**
 * Which truth-maintenance machinery maintains a referent, and what happens when
 * that changes.
 *
 * §3.1: *"`regime` — derived per referent: `view` while any noun source attests
 * it (re-derived, no α/β), `evidence` otherwise."* Diagram §6: *"Same node
 * type; two truth-maintenance regimes. **Nothing is ever both.**"*
 *
 * The regime is therefore not a property a producer declares. It is a function
 * of whether anything currently attests the referent, and it moves when that
 * fact moves — in both directions. A usage-born referent an emitter later
 * attests stops carrying a posterior; an attested referent whose source drops
 * it starts carrying one again, because from that moment its existence is an
 * ordinary belief with ordinary evidence behind it.
 *
 * The strongest test in this file is the one about inflation. §3.1 calls a
 * noun source "a privileged noun source, nothing more", and diagram §6 says a
 * re-run of the source "cannot inflate anything". So a referent an emitter
 * attests must not accumulate α as claims keep naming it — otherwise a nightly
 * re-parse is a vote, repeated forever, and every posterior downstream of it is
 * a count of how often a script ran.
 *
 * The "emitter" here is `attestationMessage` in `./fixtures`: nine lines with no
 * grammar in them, entering through the same public port as everything else.
 *
 * @spec §3.1, §3.2, §3.3, §4.2, §5.2
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort } from '../../ingest/index';
import { openIngest } from '../../ingest/index';
import type { Referent } from '../index';
import { openGraphStore, type GraphStore } from '../../store/index';

import {
  LOCATOR,
  NOUN_SOURCE,
  OTHER_NOUN_SOURCE,
  agentOrigin,
  attestationMessage,
  claimMessage,
  emitterOrigin,
  fakeAdjudicator,
  fakeEmbeddings,
  retractionMessage,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from './fixtures';

let store: GraphStore;
let embeddings: FakeEmbeddings;
let adjudicator: FakeAdjudicator;
let ingest: IngestPort;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  embeddings = fakeEmbeddings();
  adjudicator = fakeAdjudicator();
  ingest = openIngest({ store, embeddings, adjudicator });
});

afterEach(() => {
  store.close();
});

/** The referent this surface form names, read out of the index by name. */
const referentNamed = (surfaceForm: string): Referent => {
  const id = store.resolveMention(surfaceForm);
  const referent = id === undefined ? undefined : ingest.referents.get(id);
  if (referent === undefined) throw new Error(`nothing in the index is named "${surfaceForm}"`);
  return referent;
};

/** Names a noun once per episode through the agent channel — ordinary usage, no attestation. */
const nameAcrossEpisodes = async (
  surfaceForm: string,
  episodes: readonly number[],
): Promise<void> => {
  for (const n of episodes)
    await ingest.submit(
      claimMessage(`${surfaceForm} came up again while working.`, [surfaceForm], {
        origin: agentOrigin(n),
      }),
    );
};

describe('a referent a noun source attests', () => {
  it('is maintained in the view regime', async () => {
    await ingest.submit(attestationMessage('AuthService'));

    expect(referentNamed('AuthService').regime).toBe('view');
  });

  it('has an existence claim with no posterior at all', async () => {
    await ingest.submit(attestationMessage('AuthService'));
    const referent = referentNamed('AuthService');

    expect(store.getClaim(referent.existenceClaimId)?.regime).toBe('view');
    expect(store.getEvidence(referent.existenceClaimId)).toBeNull();
  });

  it('carries the locator it was attested with, opaque and unread', async () => {
    await ingest.submit(attestationMessage('AuthService'));

    expect(store.getEntity(referentNamed('AuthService').id)?.locator).toStrictEqual(LOCATOR);
  });

  it('gets the same id from the same declaration in a database it never met', async () => {
    await ingest.submit(attestationMessage('AuthService'));
    const first = referentNamed('AuthService').id;

    const second = openGraphStore({ path: ':memory:' });
    try {
      const other = openIngest({ store: second, embeddings, adjudicator });
      await other.submit(attestationMessage('AuthService'));

      expect(second.resolveMention('AuthService')).toBe(first);
    } finally {
      second.close();
    }
  });

  it('is an upsert on re-attestation, not a second referent', async () => {
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(1) }));
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(2) }));

    expect(ingest.referents.all()).toHaveLength(1);
  });

  it('cannot be inflated by the claims that keep naming it', async () => {
    await ingest.submit(attestationMessage('AuthService'));
    await nameAcrossEpisodes('AuthService', [2, 3, 4, 5, 6]);
    const referent = referentNamed('AuthService');

    expect(referent.regime).toBe('view');
    expect(store.getEvidence(referent.existenceClaimId)).toBeNull();
  });
});

describe('a referent nothing attests', () => {
  it('is maintained in the evidence regime', async () => {
    await nameAcrossEpisodes('practice', [1]);

    expect(referentNamed('practice').regime).toBe('evidence');
  });

  it('has an existence claim carrying a posterior', async () => {
    await nameAcrossEpisodes('practice', [1]);
    const evidence = store.getEvidence(referentNamed('practice').existenceClaimId);

    expect(evidence?.alpha).toBeGreaterThan(0);
    expect(evidence?.beta).toBeGreaterThan(0);
  });

  it('is a wrong claim rather than a wrong fact — disputable like any other', async () => {
    await nameAcrossEpisodes('practice', [1]);
    const referent = referentNamed('practice');

    expect(store.getClaim(referent.existenceClaimId)?.regime).toBe('evidence');
    expect(store.getClaim(referent.existenceClaimId)?.scope).toBe(referent.id);
  });
});

describe('attestation arriving', () => {
  it('moves a usage-born referent into the view regime', async () => {
    await nameAcrossEpisodes('AuthService', [1, 2]);
    expect(referentNamed('AuthService').regime).toBe('evidence');

    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(3) }));

    expect(referentNamed('AuthService').regime).toBe('view');
  });

  it('keeps the referent, since it is the same thing either way', async () => {
    await nameAcrossEpisodes('AuthService', [1, 2]);
    const before = referentNamed('AuthService').id;

    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(3) }));

    expect(referentNamed('AuthService').id).toBe(before);
    expect(ingest.referents.all()).toHaveLength(1);
  });

  it('retires the evidence-regime existence claim without deleting it', async () => {
    await nameAcrossEpisodes('AuthService', [1, 2]);
    const superseded = referentNamed('AuthService').existenceClaimId;

    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(3) }));

    expect(referentNamed('AuthService').existenceClaimId).not.toBe(superseded);
    expect(store.getClaim(superseded)?.status).toBe('deprecated');
    expect(store.getEvidence(superseded)).not.toBeNull();
  });
});

describe('attestation dropping', () => {
  const attestThenRetract = async (): Promise<void> => {
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(1) }));
    await nameAcrossEpisodes('AuthService', [2, 3]);
    await ingest.submit(retractionMessage('AuthService', { origin: emitterOrigin(4) }));
  };

  it('moves the referent back into the evidence regime', async () => {
    await attestThenRetract();

    expect(referentNamed('AuthService').regime).toBe('evidence');
  });

  it('gives it an existence claim with a posterior, since nothing re-derives it now', async () => {
    await attestThenRetract();
    const evidence = store.getEvidence(referentNamed('AuthService').existenceClaimId);

    expect(evidence?.alpha).toBeGreaterThan(0);
    expect(evidence?.beta).toBeGreaterThan(0);
  });

  it('keeps the referent id stable across the transition', async () => {
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(1) }));
    const before = referentNamed('AuthService').id;

    await ingest.submit(retractionMessage('AuthService', { origin: emitterOrigin(2) }));

    expect(referentNamed('AuthService').id).toBe(before);
  });

  it('leaves the retracted view claim readable, because the ledger is append-only', async () => {
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(1) }));
    const attested = referentNamed('AuthService').existenceClaimId;

    await ingest.submit(retractionMessage('AuthService', { origin: emitterOrigin(2) }));

    expect(store.getClaim(attested)?.regime).toBe('view');
    expect(store.getEvidence(attested)).toBeNull();
    expect(store.getClaim(attested)?.status).toBe('deprecated');
  });

  it('holds the view regime while any other source still attests', async () => {
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(1) }));
    await ingest.submit(
      attestationMessage('AuthService', { source: OTHER_NOUN_SOURCE, origin: emitterOrigin(2) }),
    );

    await ingest.submit(
      retractionMessage('AuthService', { source: NOUN_SOURCE, origin: emitterOrigin(3) }),
    );

    expect(referentNamed('AuthService').regime).toBe('view');
  });

  it('falls to the evidence regime only when the last source lets go', async () => {
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(1) }));
    await ingest.submit(
      attestationMessage('AuthService', { source: OTHER_NOUN_SOURCE, origin: emitterOrigin(2) }),
    );
    await ingest.submit(
      retractionMessage('AuthService', { source: NOUN_SOURCE, origin: emitterOrigin(3) }),
    );

    await ingest.submit(
      retractionMessage('AuthService', { source: OTHER_NOUN_SOURCE, origin: emitterOrigin(4) }),
    );

    expect(referentNamed('AuthService').regime).toBe('evidence');
  });
});

describe('nothing is ever both, and nothing is ever neither', () => {
  it('holds across a mixed graph, in every regime and after every transition', async () => {
    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(1) }));
    await ingest.submit(
      attestationMessage('SessionStore', {
        origin: emitterOrigin(2),
        locator: { path: 'src/auth/session.ts', symbolRange: [1, 88] },
      }),
    );
    await nameAcrossEpisodes('practice', [3, 4]);
    await nameAcrossEpisodes('Chapter Three', [5]);
    await ingest.submit(retractionMessage('SessionStore', { origin: emitterOrigin(6) }));

    const observed = ingest.referents.all().map((referent) => ({
      name: referent.name,
      regime: referent.regime,
      claimRegime: store.getClaim(referent.existenceClaimId)?.regime,
      posterior: store.getEvidence(referent.existenceClaimId) === null ? 'absent' : 'present',
    }));

    expect([...observed].sort((left, right) => (left.name < right.name ? -1 : 1))).toStrictEqual([
      { name: 'AuthService', regime: 'view', claimRegime: 'view', posterior: 'absent' },
      { name: 'Chapter Three', regime: 'evidence', claimRegime: 'evidence', posterior: 'present' },
      { name: 'SessionStore', regime: 'evidence', claimRegime: 'evidence', posterior: 'present' },
      { name: 'practice', regime: 'evidence', claimRegime: 'evidence', posterior: 'present' },
    ]);
  });
});
