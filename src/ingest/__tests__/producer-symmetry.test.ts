/**
 * The ingest port treats every producer identically.
 *
 * Diagram §1: *"Core contains no parser and no language-specific code. Every
 * source of knowledge — human, agent, or emitter — writes claims through one
 * ingest port."* §5 opens with the same rule from the write path's side: *"one
 * synchronous pipeline every observation passes through, whatever its origin
 * (agent tool call, hook capture, reflector output, consolidator merge
 * proposal)."*
 *
 * So the port must have no producer discriminant, and two claims from opposite
 * ends of the system must differ in exactly two ways — **tier**, which is the
 * privilege ladder of §6.3, and the **provenance channel**, which is half of the
 * A15 pathway signature. Everything else about them has to be the same row.
 *
 * The two negative results are the sharper ones. Coming from an emitter does
 * not put a claim in the view regime — attestation does that, and a channel is
 * not an attestation. And stage-0 dedupe is producer-blind: an emitter's replay
 * inside an agent's episode is still a replay, because the key is the text and
 * the episode, not who is speaking.
 *
 * @spec §3.2, §4.2, §4.7, §5, §5.1, §5.9, §6.3
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestPort } from '../index';
import { openIngest } from '../index';
import { openGraphStore, type GraphStore } from '../../store/index';

import {
  AGENT,
  AGENT_CHANNEL,
  EMITTER_CHANNEL,
  TAU_PROMOTE,
  agentOrigin,
  attestationMessage,
  claimMessage,
  emitterOrigin,
  episode,
  fakeAdjudicator,
  fakeEmbeddings,
  type FakeAdjudicator,
  type FakeEmbeddings,
} from '../../referents/__tests__/fixtures';

let store: GraphStore;
let embeddings: FakeEmbeddings;
let adjudicator: FakeAdjudicator;
let ingest: IngestPort;

const TEXT = 'AuthService validates bearer tokens before dispatch.';

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  embeddings = fakeEmbeddings();
  adjudicator = fakeAdjudicator();
  ingest = openIngest({ store, embeddings, adjudicator });
});

afterEach(() => {
  store.close();
});

/** Everything about a ledger row except its identity, its clocks and its provenance. */
const bodyOf = (claimId: string | undefined): unknown => {
  const claim = claimId === undefined ? undefined : store.getClaim(claimId);
  if (claim === undefined) throw new Error('the ingest port wrote no claim');
  return {
    text: claim.text,
    embedding: claim.embedding,
    kind: claim.kind,
    tier: claim.tier,
    status: claim.status,
    regime: claim.regime,
    evidence: claim.evidence,
    scope: claim.scope,
    canonical: claim.canonical,
  };
};

/** The same projection with the tier blanked, for asking what else differs. */
const bodyWithoutTier = (claimId: string | undefined): unknown => ({
  ...(bodyOf(claimId) as Record<string, unknown>),
  tier: 'redacted',
});

const claimOf = (claimId: string | undefined) => {
  const claim = claimId === undefined ? undefined : store.getClaim(claimId);
  if (claim === undefined) throw new Error('the ingest port wrote no claim');
  return claim;
};

describe('a claim from an emitter and a claim from an agent', () => {
  it('differ in tier and in nothing else the ledger records about the proposition', async () => {
    const fromEmitter = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'verified', origin: emitterOrigin(1) }),
    );
    const fromAgent = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'observed', origin: agentOrigin(2) }),
    );

    expect(bodyWithoutTier(fromEmitter.claimId)).toStrictEqual(bodyWithoutTier(fromAgent.claimId));
    expect(claimOf(fromEmitter.claimId).tier).toBe('verified');
    expect(claimOf(fromAgent.claimId).tier).toBe('observed');
  });

  it('are the same row entirely once their tiers agree', async () => {
    const fromEmitter = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'observed', origin: emitterOrigin(1) }),
    );
    const fromAgent = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'observed', origin: agentOrigin(2) }),
    );

    expect(bodyOf(fromEmitter.claimId)).toStrictEqual(bodyOf(fromAgent.claimId));
  });

  it('differ in provenance only along the pathway axes A15 named', async () => {
    const fromEmitter = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'observed', origin: emitterOrigin(1) }),
    );
    const fromAgent = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'observed', origin: agentOrigin(1) }),
    );

    expect(claimOf(fromEmitter.claimId).provenance.channel).toBe(EMITTER_CHANNEL);
    expect(claimOf(fromAgent.claimId).provenance.channel).toBe(AGENT_CHANNEL);
    expect(claimOf(fromEmitter.claimId).provenance.agent).toBeUndefined();
    expect(claimOf(fromAgent.claimId).provenance.agent).toBe(AGENT);
    expect(claimOf(fromEmitter.claimId).provenance.episodes).toStrictEqual(
      claimOf(fromAgent.claimId).provenance.episodes,
    );
  });

  it('hand back the same shape of receipt', async () => {
    const fromEmitter = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'verified', origin: emitterOrigin(1) }),
    );
    const fromAgent = await ingest.submit(
      claimMessage('AuthService rotates its signing key nightly.', ['AuthService'], {
        tier: 'inferred',
        origin: agentOrigin(2),
      }),
    );

    expect(Object.keys(fromEmitter).sort()).toStrictEqual(Object.keys(fromAgent).sort());
    expect(fromEmitter.resolutions.map((entry) => entry.surfaceForm)).toStrictEqual(
      fromAgent.resolutions.map((entry) => entry.surfaceForm),
    );
  });

  it('converge on one referent, because the noun is the same noun', async () => {
    const fromEmitter = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'verified', origin: emitterOrigin(1) }),
    );
    const fromAgent = await ingest.submit(
      claimMessage('AuthService rotates its signing key nightly.', ['AuthService'], {
        origin: agentOrigin(2),
      }),
    );

    expect(fromAgent.resolutions[0]?.referentId).toBe(fromEmitter.resolutions[0]?.referentId);
    expect(ingest.referents.all()).toHaveLength(1);
  });
});

describe('the channel buys no privilege', () => {
  it('leaves an emitter\'s claim in the evidence regime — a channel is not an attestation', async () => {
    const fromEmitter = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'verified', origin: emitterOrigin(1) }),
    );

    expect(claimOf(fromEmitter.claimId).regime).toBe('evidence');
    expect(ingest.referents.get(fromEmitter.resolutions[0]!.referentId)?.regime).toBe('evidence');
  });

  it('moves a referent into the view regime only when a source attests it', async () => {
    await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'verified', origin: emitterOrigin(1) }),
    );

    await ingest.submit(attestationMessage('AuthService', { origin: emitterOrigin(2) }));

    expect(ingest.referents.get(store.resolveMention('AuthService')!)?.regime).toBe('view');
  });

  it('lets tier alone decide how fast a referent earns its place', async () => {
    await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'verified', origin: emitterOrigin(1) }),
    );
    await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'verified', origin: emitterOrigin(2) }),
    );
    const attested = ingest.referents.get(store.resolveMention('AuthService')!);
    const strong = store.getEvidence(attested!.existenceClaimId)!;

    const second = openGraphStore({ path: ':memory:' });
    try {
      const weak = openIngest({ store: second, embeddings, adjudicator });
      await weak.submit(
        claimMessage(TEXT, ['AuthService'], { tier: 'observed', origin: agentOrigin(1) }),
      );
      await weak.submit(
        claimMessage(TEXT, ['AuthService'], { tier: 'observed', origin: agentOrigin(2) }),
      );
      const referent = weak.referents.all()[0]!;
      const soft = second.getEvidence(referent.existenceClaimId)!;

      expect(strong.alpha / (strong.alpha + strong.beta)).toBeGreaterThanOrEqual(TAU_PROMOTE);
      expect(soft.alpha / (soft.alpha + soft.beta)).toBeLessThan(TAU_PROMOTE);
    } finally {
      second.close();
    }
  });
});

describe('stage 0 is producer-blind', () => {
  it('reads an emitter repeating an agent\'s text inside one episode as a replay', async () => {
    const first = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { origin: agentOrigin(1) }),
    );

    const second = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { tier: 'verified', origin: emitterOrigin(1) }),
    );

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('admits the same text again once the episode changes', async () => {
    await ingest.submit(claimMessage(TEXT, ['AuthService'], { origin: agentOrigin(1) }));

    const later = await ingest.submit(
      claimMessage(TEXT, ['AuthService'], { origin: emitterOrigin(2) }),
    );

    expect(later.duplicate).toBe(false);
    expect(later.claimId).toBeDefined();
  });

  it('keys the replay on the episode the producer declared, not on a channel', async () => {
    const message = claimMessage(TEXT, ['AuthService'], { origin: agentOrigin(1) });
    await ingest.submit(message);

    const replay = await ingest.submit(message);

    expect(replay.duplicate).toBe(true);
    expect(store.readStageLog(episode(1)).length).toBeGreaterThan(0);
  });
});

describe('one entry point', () => {
  it('takes claims, attestations, containment and change-feed events through the same call', async () => {
    const receipts = [
      await ingest.submit(claimMessage(TEXT, ['AuthService'], { origin: agentOrigin(1) })),
      await ingest.submit(attestationMessage('SessionStore', { origin: emitterOrigin(2) })),
    ];

    for (const receipt of receipts) expect(Object.keys(receipt).sort()).toStrictEqual(
      ['claimId', 'duplicate', 'resolutions'].sort(),
    );
  });
});
