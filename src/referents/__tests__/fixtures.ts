/**
 * Shared fixtures for the P2 referents + ingest-port suite.
 *
 * Two rules govern this module, both inherited from `src/store/__tests__/fixtures.ts`:
 *
 * 1. **Every reference to unwritten production code is type-only**, so esbuild
 *    erases it before the module runs. The RED signal then comes from the value
 *    imports in the `.test.ts` files rather than from a fixture module that
 *    cannot load.
 * 2. **The store is never faked.** Real SQLite, `:memory:`, real vectors at the
 *    real width. Only the two ports the spec says are model calls — the
 *    embedding provider (§5.3) and the coreference tiebreak adjudicator (§5.2) —
 *    are stood in for, because a test that waits on a language model tests the
 *    model.
 *
 * **Nothing here knows a programming language.** The "noun source" used by the
 * regime and containment tests is nine lines of hand-written emitter that pushes
 * attestations through the same public ingest port an agent's `observe` uses;
 * there is no grammar, no file walk and no syntax anywhere in this directory.
 * The semantic space is a declared lookup table (see {@link SEMANTIC_CLUSTERS}),
 * so "the auth thing" is near `AuthService` because *this file says so*, not
 * because either string is TypeScript.
 *
 * @spec §3.1, §5.1, §5.2, §5.3, §11
 */

import type { EmbeddingProvider, EmbeddingTask } from '../../store/ports/embedding-provider';
import type {
  Adjudicator,
  TiebreakCandidate,
  TiebreakRequest,
  TiebreakVerdict,
} from '../index';
import type {
  AttestationMessage,
  ClaimMessage,
  ContainmentMessage,
  Origin,
  RetractionMessage,
} from '../../ingest/index';

/**
 * Width every vector crosses the store boundary at. Asserted equal to the
 * store's own pin inside the suite rather than imported, so a drift in either
 * declaration is a failing test rather than a silent agreement.
 *
 * @spec §11
 */
export const RERANK_WIDTH = 768;

/**
 * §15's `cos_floor`. A gloss hit at or above this is a rung-3 resolution; below
 * it, the mention has not resolved.
 *
 * @spec §5.2, §5.3, §15
 */
export const COSINE_FLOOR = 0.7;

/**
 * §15's `τ_promote`. A provisional referent's existence claim promotes to
 * `active` — and the referent becomes visible to gather — at this posterior
 * mean.
 *
 * @spec §5.2, §6.2, §15
 */
export const TAU_PROMOTE = 0.8;

/*
 * ---------------------------------------------------------------------------
 * The declared semantic space.
 * ---------------------------------------------------------------------------
 *
 * Each entry places a text at an angle inside a two-dimensional plane. Texts
 * sharing a plane have cosine `cos(θ₁ − θ₂)`; texts in different planes are
 * exactly orthogonal. That makes every similarity in this suite a number the
 * test declared rather than a number a model happened to produce — the point of
 * a fake provider is that the *ladder* is under test, not the embedding.
 *
 * Planes are numbered; plane `p` occupies dimensions `2p` and `2p + 1`. Planes
 * 0–9 are declared here; everything undeclared lands in its own private plane
 * (see {@link PRIVATE_PLANE_BASE}) and is therefore orthogonal to all of these.
 */

/** Plane index and angle, in radians. */
type Placement = readonly [plane: number, angle: number];

/*
 * The claim texts §3.1's facet centroids are clustered from.
 *
 * Every other declaration in this file places a *surface form*, because every
 * other suite here is about §5.2's ladder, which embeds forms. Facets are the
 * other embedding the write path makes: §5.3 embeds the claim *text* once, on
 * the `document` side, and §3.1 clusters those vectors into at most four means
 * per referent. So these six are claim texts, and they are declared for exactly
 * the reason the forms above are — a test that says "a claim in a distinct
 * region" has to be able to say which region, and how far.
 *
 * Planes 6–9 hold four mutually orthogonal regions. Plane 6 also holds the two
 * off-angle texts: one close enough to region A to be folded into its centroid,
 * one too far to be folded into anything but still nearer A than any other
 * region. `facet-maintenance.test.ts` asserts every one of those relations
 * before it relies on one, so a text moved here fails loudly rather than
 * quietly changing what a case means.
 *
 * @spec §3.1, §5.3
 */

/** Region A: the anchor of plane 6. @spec §3.1 */
export const FACET_REGION_A = 'The valve seat was reground during the winter overhaul.';

/** Plane 6 at 0.2rad — cosine ≈ 0.980 to {@link FACET_REGION_A}. @spec §3.1 */
export const FACET_NEAR_A = 'The valve seat was reground a second time that winter.';

/**
 * Plane 6 at 1.2rad — cosine ≈ 0.362 to {@link FACET_REGION_A}, and exactly 0
 * to every other region. Below any sane assignment floor, and nearest A all the
 * same, which is what separates "too far to join" from "nothing to join".
 *
 * @spec §3.1
 */
export const FACET_BELOW_FLOOR_OF_A = 'The overhaul was signed off without a witness.';

/** Region B: plane 7, orthogonal to every other region. @spec §3.1 */
export const FACET_REGION_B = 'Nobody has measured the inlet pressure since March.';

/** Region C: plane 8, orthogonal to every other region. @spec §3.1 */
export const FACET_REGION_C = 'The maintenance budget is set annually and never revised.';

/** Region D: plane 9, orthogonal to every other region. @spec §3.1 */
export const FACET_REGION_D = 'Two of the three alarms are wired to the same relay.';

/**
 * The texts this suite declares to be semantically near one another.
 *
 * Plane 0 is §3.1's own example: `AuthService`, `auth-service` and "the auth
 * thing" are the three surface forms one referent must accumulate.
 *
 * Plane 1 holds two *distinct* referents plus a query phrasing sitting exactly
 * between them, which is how the rung-4 tiebreak is provoked. The half-radian
 * offsets are chosen so that `cos(0.5) ≈ 0.878` puts each candidate above
 * {@link COSINE_FLOOR} for the query, while `cos(1.0) ≈ 0.540` keeps the two
 * candidates below it for each other — they mint separately, and then neither
 * embedding alone can choose between them.
 *
 * Plane 2 is a usage-born noun with nothing near it — the mint path.
 *
 * Plane 4 holds a pair far enough apart (`cos(1.2) ≈ 0.362`) that the gloss
 * channel returns a hit *below* the floor: the rung-3 floor is a floor, not a
 * ranking.
 *
 * Planes 6–9 hold the claim texts §3.1's facet centroids are clustered from,
 * declared above.
 *
 * @spec §3.1, §5.2, §15
 */
export const SEMANTIC_CLUSTERS: ReadonlyMap<string, Placement> = new Map<string, Placement>([
  ['AuthService', [0, 0]],
  ['auth-service', [0, 0.2]],
  ['the auth thing', [0, 0.3]],
  ['RetryPolicy', [1, -0.5]],
  ['RetryBudget', [1, 0.5]],
  ['the retry knob', [1, 0]],
  ['practice', [2, 0]],
  ['SessionStore', [3, 0]],
  ['session-store', [3, 0.2]],
  ['LedgerEntry', [4, 0]],
  ['the ledger', [4, 1.2]],
  ['Chapter Three', [5, 0]],
  ['the third chapter', [5, 0.25]],
  [FACET_REGION_A, [6, 0]],
  [FACET_NEAR_A, [6, 0.2]],
  [FACET_BELOW_FLOOR_OF_A, [6, 1.2]],
  [FACET_REGION_B, [7, 0]],
  [FACET_REGION_C, [8, 0]],
  [FACET_REGION_D, [9, 0]],
]);

/** First plane available to undeclared text. Everything below it is declared above. */
const PRIVATE_PLANE_BASE = 10;

/**
 * How many private planes exist. Capped so that the highest dimension used
 * (`2 × (10 + 239) + 1 = 499`) stays inside the store's 512-wide ANN slice: a
 * vector whose whole mass sits beyond that slice quantizes to zero, and a zero
 * vector has no cosine to anything.
 *
 * @spec §11
 */
const PRIVATE_PLANE_COUNT = 240;

/** FNV-1a, so an undeclared text lands in the same private plane on every run. */
const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

const placementFor = (text: string): Placement =>
  SEMANTIC_CLUSTERS.get(text) ?? [PRIVATE_PLANE_BASE + (fnv1a(text) % PRIVATE_PLANE_COUNT), 0];

/**
 * The unit vector this suite declares for a text.
 *
 * L2-normalized after rounding to f32, because the {@link EmbeddingProvider}
 * contract promises unit norm and the store's cosines are plain dot products.
 *
 * @spec §11
 */
export const declaredVector = (text: string): Float32Array => {
  const [plane, angle] = placementFor(text);
  const vector = new Float32Array(RERANK_WIDTH);
  vector[plane * 2] = Math.fround(Math.cos(angle));
  vector[plane * 2 + 1] = Math.fround(Math.sin(angle));
  let norm = 0;
  for (const component of vector) norm += component * component;
  const inverse = 1 / Math.sqrt(norm);
  for (let i = 0; i < vector.length; i += 1) vector[i] = vector[i]! * inverse;
  return vector;
};

/** The cosine this suite declares between two texts. @spec §5.2 */
export const declaredCosine = (left: string, right: string): number => {
  const a = declaredVector(left);
  const b = declaredVector(right);
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!;
  return dot;
};

/*
 * ---------------------------------------------------------------------------
 * The two faked ports.
 * ---------------------------------------------------------------------------
 */

/** One call the ladder made to the embedding provider. @spec §5.2, §5.3 */
export interface EmbedCall {
  readonly text: string;
  /** Recorded as the provider resolved it, so an omitted argument reads as `document`. */
  readonly task: EmbeddingTask;
}

/**
 * A deterministic embedding provider over {@link SEMANTIC_CLUSTERS}, which
 * records every call.
 *
 * The call log is what makes "the ladder stops at the first hit" testable: the
 * §5.2 rung-3 read embeds the *surface form* as a `query` (the provider port
 * says so explicitly), while stage 2 embeds the *claim text* as a `document`.
 * A ladder that short-circuits at rung 1 or 2 therefore leaves no `query` call
 * behind, and one that does not is caught.
 *
 * @spec §5.2, §5.3, §11
 */
export interface FakeEmbeddings extends EmbeddingProvider {
  /** Every call since the last {@link FakeEmbeddings.forget}, in order. */
  readonly calls: readonly EmbedCall[];
  /** Drops the call log, so a test can assert about one ingest rather than all of them. */
  forget(): void;
}

/** @spec §5.3, §11 */
export const fakeEmbeddings = (): FakeEmbeddings => {
  const calls: EmbedCall[] = [];
  const record = (text: string, task: EmbeddingTask | undefined): Float32Array => {
    calls.push({ text, task: task ?? 'document' });
    return declaredVector(text);
  };
  return {
    modelId: 'declared-clusters@768',
    dimensions: RERANK_WIDTH,
    calls,
    forget: () => {
      calls.length = 0;
    },
    embed: (text, task) => Promise.resolve(record(text, task)),
    embedBatch: (texts, task) => Promise.resolve(texts.map((text) => record(text, task))),
  };
};

/** Every `query`-task text the provider was asked for. @spec §5.2 */
export const queriedTexts = (embeddings: FakeEmbeddings): string[] =>
  embeddings.calls.filter((call) => call.task === 'query').map((call) => call.text);

/**
 * A coreference tiebreak that answers from a script and records what it was
 * asked.
 *
 * Defaults to `unresolved`, so a test that never scripts an answer still proves
 * the mint path rather than silently resolving.
 *
 * @spec §5.2
 */
export interface FakeAdjudicator extends Adjudicator {
  /** Every tiebreak the ladder escalated, in order. */
  readonly requests: readonly TiebreakRequest[];
  /** Installs the verdict function used for subsequent escalations. */
  answerWith(answer: (request: TiebreakRequest) => TiebreakVerdict): void;
}

/** @spec §5.2 */
export const fakeAdjudicator = (): FakeAdjudicator => {
  const requests: TiebreakRequest[] = [];
  let answer: (request: TiebreakRequest) => TiebreakVerdict = () => ({ outcome: 'unresolved' });
  return {
    requests,
    answerWith: (next) => {
      answer = next;
    },
    tiebreakReferent: (request) => {
      requests.push(request);
      return Promise.resolve(answer(request));
    },
  };
};

/**
 * Whether the slate presents this candidate to the model as a gloss match: a
 * cosine the gloss channel actually measured, at or above {@link COSINE_FLOOR}.
 *
 * The read is annotated `number | null` deliberately. §5.2's slate now carries
 * candidates the gloss channel never placed at all, and "never measured" is a
 * different fact from "measured at zero" — a sentinel and a nullable field are
 * both honest ways to say it, and which one the port picks is not a claim any
 * test here is making. An assertion spelling `candidate.cosine >= COSINE_FLOOR`
 * inline would quietly make that claim, by failing to compile the moment the
 * field admitted the absence it documents. Everything about the slate is
 * asserted through this predicate instead, so what the tests pin is *what the
 * model is told* rather than how the ladder spells it.
 *
 * @spec §5.2, §15
 */
export const readsAsAGlossMatch = (candidate: TiebreakCandidate): boolean => {
  const measured: number | null = candidate.cosine;
  return measured !== null && measured >= COSINE_FLOOR;
};

/** Picks the candidate with this name, or declines. @spec §5.2 */
export const picks =
  (name: string) =>
  (request: TiebreakRequest): TiebreakVerdict => {
    const chosen = request.candidates.find((candidate) => candidate.name === name);
    return chosen === undefined
      ? { outcome: 'unresolved' }
      : { outcome: 'resolved', referentId: chosen.referentId };
  };

/*
 * ---------------------------------------------------------------------------
 * Message vocabulary.
 * ---------------------------------------------------------------------------
 */

/** §4.7's channel for an agent's own `observe` call. @spec §4.7, §5.9 */
export const AGENT_CHANNEL = 'live-observe';

/** §4.7's channel for an external noun source. @spec §4.7, §5.9 */
export const EMITTER_CHANNEL = 'emitter';

/** The agent half of the A15 pathway signature. @spec §3.5, §4.7 */
export const AGENT = 'claude-code';

/** A distinct episode. Independence lives here: §4.4 counts episodes, not utterances. @spec §4.4, §4.2 */
export const episode = (n: number): string => `ep-2026-08-31-${String(n).padStart(2, '0')}`;

/** An agent-channel origin in the given episode. @spec §3.5, §5.1 */
export const agentOrigin = (n: number): Origin => ({
  episodeId: episode(n),
  channel: AGENT_CHANNEL,
  agent: AGENT,
});

/** An emitter-channel origin in the given episode. @spec §3.5, §5.9 */
export const emitterOrigin = (n: number): Origin => ({
  episodeId: episode(n),
  channel: EMITTER_CHANNEL,
});

/**
 * An observed-tier claim naming the given nouns.
 *
 * `observed` rather than `inferred` by default so the §15 tier weight is a
 * round 1.0 and the §3.2 skeptical prior does not quietly change what promotion
 * arithmetic a test is asserting about.
 *
 * @spec §3.2, §4.2, §5.2
 */
export const claimMessage = (
  text: string,
  mentions: readonly string[],
  overrides: Partial<Omit<ClaimMessage, 'type'>> = {},
): ClaimMessage =>
  ({
    type: 'claim',
    text,
    kind: 'fact',
    tier: 'observed',
    mentions,
    origin: agentOrigin(1),
    ...overrides,
  }) as ClaimMessage;

/**
 * A containment claim placing `child` under `parent`.
 *
 * The only thing in this suite that produces a `CONTAINS` edge or a non-null
 * `level`: §3.1 and diagram §7 both say containment is asserted, never derived
 * from a directory tree or a parse.
 *
 * @spec §3.1, §3.3
 */
export const containmentMessage = (
  parent: string,
  child: string,
  overrides: Partial<Omit<ContainmentMessage, 'type'>> = {},
): ContainmentMessage =>
  ({
    type: 'containment',
    parent,
    child,
    childLevel: 'module',
    tier: 'observed',
    origin: agentOrigin(1),
    ...overrides,
  }) as ContainmentMessage;

/** The name of the hand-written noun source used by the regime tests. @spec §3.1 */
export const NOUN_SOURCE = 'fixture-emitter';

/** A second noun source, so "while *any* source attests it" (§3.1) has two to work with. @spec §3.1 */
export const OTHER_NOUN_SOURCE = 'fixture-inventory';

/**
 * An opaque locator, in the shipped code recipe's nested shape.
 *
 * Nested deliberately: the store persists this blob without reading a field of
 * it, and a flat fixture would let a layer that quietly destructured `path` out
 * of it pass anyway.
 *
 * @spec §3.5
 */
export const LOCATOR = {
  path: 'src/auth/index.ts',
  symbolRange: [1, 412],
  vcs: { rev: '9f2c1ab', dirty: false, tag: null },
} as const;

/**
 * A noun source declaring that a referent exists.
 *
 * This is the whole of the "emitter" in this suite: nine lines that push a
 * message through the *same public port* an agent's `observe` uses. There is no
 * grammar behind it and no file walk — the point of §3.1's "ground truth is a
 * privileged noun source, nothing more" is that privilege is a tier and a
 * regime, not a private entrance.
 *
 * @spec §3.1, §3.3
 */
export const attestationMessage = (
  surfaceForm: string,
  overrides: Partial<Omit<AttestationMessage, 'type'>> = {},
): AttestationMessage =>
  ({
    type: 'attestation',
    source: NOUN_SOURCE,
    surfaceForm,
    level: 'component',
    locator: LOCATOR,
    origin: emitterOrigin(1),
    ...overrides,
  }) as AttestationMessage;

/**
 * The change-feed event that withdraws one source's attestation — the referent
 * left the emitter's view of the world.
 *
 * @spec §3.1, §3.3, §4.5
 */
export const retractionMessage = (
  surfaceForm: string,
  overrides: Partial<Omit<RetractionMessage, 'type'>> = {},
): RetractionMessage =>
  ({
    type: 'retraction',
    source: NOUN_SOURCE,
    surfaceForm,
    origin: emitterOrigin(1),
    ...overrides,
  }) as RetractionMessage;
