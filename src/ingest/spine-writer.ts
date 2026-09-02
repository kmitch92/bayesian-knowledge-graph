/**
 * The writes behind the referent index.
 *
 * Diagram §7: *"No entity is ever created directly. Naming is what creates them,
 * in the same transaction as the claim."* So there is no `createReferent` here.
 * There is minting-by-naming, attestation, retraction and placement — four
 * things that happen to nouns — and each of them writes a claim first and
 * projects it into the index second. The index never learns anything the ledger
 * does not already know, which is what makes `rebuild-index` possible at all.
 *
 * @spec §3.1, §3.2, §3.3, §4.2, §5.2, §6.1
 */

import type { EmbeddingProvider } from '../store/ports/embedding-provider.js';
import type {
  ClaimKind,
  ClaimRecord,
  ClaimStatus,
  ClaimTier,
  Evidence,
  GraphStore,
  Regime,
} from '../store/index.js';
import { namingClaimId, type IdMinter } from '../referents/ids.js';
import {
  deriveName,
  isLive,
  namingSupport,
  standingExistenceClaim,
  writeEntity,
} from '../referents/index-view.js';
import { encodeSpineClaim, type SpinePayload } from '../referents/spine.js';

import { observationWeight, posteriorMean, priorFor, TAU_PROMOTE } from './evidence.js';
import type { Origin } from './messages.js';

/** Everything a write needs: the ledger, the one model call it may make, and fresh ids. @spec §5 */
export interface WriteContext {
  readonly store: GraphStore;
  readonly embeddings: EmbeddingProvider;
  readonly nextId: IdMinter;
  /** §15's `τ_promote`, overridable because §13 replay is what tunes it. @spec §15 */
  readonly tauPromote?: number | undefined;
}

/** One ledger row, before it has an id or an embedding. @spec §3.5 */
interface ClaimDraft {
  readonly id: string;
  readonly text: string;
  readonly kind: ClaimKind;
  readonly tier: ClaimTier;
  readonly status: ClaimStatus;
  readonly regime: Regime;
  readonly evidence: Evidence | null;
  readonly scope: string;
  readonly origin: Origin;
}

/** The instant, as §3.5 records instants. */
const now = (): string => new Date().toISOString();

/**
 * Writes one claim, embedding its text on the way in.
 *
 * The embedding is of the text as stored, `document` side: §5.3 embeds the
 * incoming claim once, and the only `query` embedding in the write path is
 * §5.2's rung 3.
 *
 * @spec §3.5, §5.3
 */
export const writeClaim = async (
  context: WriteContext,
  draft: ClaimDraft,
): Promise<ClaimRecord> => {
  const embedding = await context.embeddings.embed(draft.text, 'document');
  const claim: ClaimRecord = {
    id: draft.id,
    text: draft.text,
    embedding: Array.from(embedding),
    kind: draft.kind,
    tier: draft.tier,
    status: draft.status,
    regime: draft.regime,
    evidence: draft.evidence,
    scope: draft.scope,
    temporal: { createdAt: now() },
    provenance: {
      episodes: [draft.origin.episodeId],
      changeEvents: [],
      artifacts: [],
      channel: draft.origin.channel,
      ...(draft.origin.agent === undefined ? {} : { agent: draft.origin.agent }),
    },
    canonical: false,
  };
  context.store.putClaim(claim);
  return claim;
};

/**
 * Records a surface form against a referent and re-derives the name.
 *
 * §3.1 makes `name` *"the most-corroborated surface form, a view over its
 * mention cluster — never authoritative"*, so it moves when the cluster moves,
 * and the gloss vector moves with it: the gloss is an embedding of the name, and
 * a name that changed while its vector did not would make rung 3 answer for a
 * referent that no longer goes by it.
 *
 * The weight is read off the naming claim rather than counted here. That is the
 * direction that makes the index a cache: the ledger holds the support, this
 * refreshes the row from it, and `rebuild-index` can do the same read against the
 * same claims. Called after the naming claim has been written, always — a mention
 * refreshed before its claim moved would cache the support of the naming before
 * this one.
 *
 * @spec §3.1, §4.2, §5.2
 */
export const recordMention = async (
  context: WriteContext,
  referentId: string,
  surfaceForm: string,
): Promise<void> => {
  const { store } = context;
  store.putMention({
    surfaceForm,
    referentId,
    weight: namingSupport(store, referentId, surfaceForm),
  });
  const entity = store.getEntity(referentId);
  if (entity === undefined) return;
  const derived = deriveName(store, referentId);
  if (derived === undefined || derived === entity.name) return;
  const gloss = await context.embeddings.embed(derived, 'document');
  writeEntity(store, entity, {
    id: referentId,
    name: derived,
    glossEmbedding: Array.from(gloss),
  });
};

/**
 * How many times an episode has already contributed to a referent's existence.
 *
 * Counted from the ledger rather than from a counter, because a counter is a
 * fact the projections would hold and the claims would not — and §4.2's cap
 * would then survive `clearViews` only by luck. The existence claim counts as
 * the first contribution: minting *is* the episode saying the referent exists.
 *
 * @spec §4.2, §4.4, §11
 */
export const contributionsFromEpisode = (
  store: GraphStore,
  referentId: string,
  episodeId: string,
): number => {
  let contributions = 0;
  for (const claimId of store.getClaimsAbout(referentId, { includeArchived: true })) {
    const claim = store.getClaim(claimId);
    if (claim?.provenance.episodes.includes(episodeId) === true) contributions += 1;
  }
  return contributions;
};

/**
 * Adds one naming's worth of evidence to a referent's existence claim.
 *
 * Silent in the view regime, and that silence is the point: §3.1 calls a noun
 * source *"a privileged noun source, nothing more"*, and diagram §6 says a
 * re-run of the source *"cannot inflate anything"*. A referent an emitter
 * attests has no posterior to add to, so a nightly re-parse is not a vote.
 *
 * @spec §3.1, §4.2, §6.2
 */
export const corroborateExistence = (
  context: WriteContext,
  referentId: string,
  origin: Origin,
  tier: ClaimTier,
  tainted: boolean,
): void => {
  const { store } = context;
  const standing = standingExistenceClaim(store, referentId);
  if (standing === undefined || standing.claim.regime === 'view') return;

  const weight = observationWeight(
    tier,
    contributionsFromEpisode(store, referentId, origin.episodeId),
    tainted,
  );
  if (weight > 0) store.incrementEvidence({ claimId: standing.claim.id, alpha: weight });

  const evidence = store.getEvidence(standing.claim.id);
  if (evidence === null || evidence === undefined) return;
  if (
    standing.claim.status === 'provisional' &&
    posteriorMean(evidence) >= (context.tauPromote ?? TAU_PROMOTE)
  )
    store.setClaimStatus({ claimId: standing.claim.id, status: 'active' });
};

/** Retires a claim without deleting it — §6.1's append-only ledger. @spec §6.1 */
export const retireClaim = (store: GraphStore, claimId: string): void => {
  store.setClaimStatus({ claimId, status: 'deprecated', invalidatedAt: now() });
};

/** What a mint needs to know about the referent it is about to create. @spec §3.1 */
export interface MintSpec {
  readonly surfaceForm: string;
  readonly origin: Origin;
  readonly tier: ClaimTier;
  readonly level: string | null;
  readonly locator?: unknown;
  /** The noun source attesting it, if one is. Its presence is what chooses the regime. @spec §3.1 */
  readonly source?: string | undefined;
  /** A content-addressed id, when the declaration has one. @spec §3.1 */
  readonly referentId?: string | undefined;
  readonly existenceClaimId?: string | undefined;
  /** Whether this naming may move a posterior at all (§5.1 replays may not). @spec §4.2, §5.1 */
  readonly tainted?: boolean | undefined;
}

/**
 * Writes one existence claim and anchors it on the referent it declares.
 *
 * Self-anchored, per §3.2: *"Existence claims are self-anchored (scope = the
 * referent they mint)"*. The `ABOUT` edge goes on for the same reason the scope
 * does — an existence claim is a claim *about* the referent, and §5.3's
 * structural retrieval channel would otherwise never surface the one claim that
 * says the thing exists.
 *
 * In the view regime it carries no posterior at all (diagram §6: *"Nothing is
 * ever both"*) and is born active: a re-derived fact is not a belief waiting for
 * corroboration. In the evidence regime it is born provisional and carries the
 * §15 prior plus the naming that produced it, which is §5.2's *"mints a
 * provisional existence claim — invisible to gather until corroborated"*.
 *
 * @spec §3.1, §3.2, §5.2, §6.2
 */
export const writeExistenceClaim = async (
  context: WriteContext,
  referentId: string,
  spec: MintSpec,
): Promise<ClaimRecord> => {
  const regime: Regime = spec.source === undefined ? 'evidence' : 'view';
  const payload: SpinePayload = {
    v: 1,
    claim: 'existence',
    referent: referentId,
    surfaceForm: spec.surfaceForm,
    level: spec.level,
    ...('locator' in spec ? { locator: spec.locator } : {}),
    ...(spec.source === undefined ? {} : { source: spec.source }),
  };

  const prior = priorFor(spec.tier);
  const evidence: Evidence | null =
    regime === 'view'
      ? null
      : {
          alpha: prior.alpha + observationWeight(spec.tier, 0, spec.tainted === true),
          beta: prior.beta,
        };
  const status: ClaimStatus =
    evidence === null || posteriorMean(evidence) >= (context.tauPromote ?? TAU_PROMOTE)
      ? 'active'
      : 'provisional';

  const claim = await writeClaim(context, {
    id: spec.existenceClaimId ?? context.nextId(),
    text: encodeSpineClaim(payload),
    kind: 'fact',
    tier: spec.tier,
    status,
    regime,
    evidence,
    scope: referentId,
    origin: spec.origin,
  });
  context.store.putClaimEdge({ from: claim.id, kind: 'ABOUT', to: referentId });
  return claim;
};

/**
 * Writes the existence claim for a content-addressed declaration, or reuses
 * the one already there.
 *
 * §3.1's content-addressed ids mean a source re-running against a declaration
 * it has already made lands on the same claim id, so a second attestation is
 * a re-attestation of a standing claim, never a second mint. A claim found
 * retired is that source's own earlier withdrawal — re-attesting reinstates
 * it, per §6.2's rule that a re-run "cannot inflate anything" but can still
 * stand behind what it once stood behind.
 *
 * @spec §3.1, §6.1, §6.2
 */
export const reuseOrWriteExistenceClaim = async (
  context: WriteContext,
  referentId: string,
  existenceClaimId: string,
  spec: MintSpec,
): Promise<string> => {
  const already = context.store.getClaim(existenceClaimId);
  if (already === undefined) return (await writeExistenceClaim(context, referentId, spec)).id;
  if (!isLive(already)) context.store.setClaimStatus({ claimId: already.id, status: 'active' });
  return already.id;
};

/**
 * Mints a referent out of a naming, in the same breath as the claim that names
 * it.
 *
 * Diagram §7: *"No entity is ever created directly. Naming is what creates them,
 * in the same transaction as the claim."* Refusing to mint is never the
 * alternative — §5.2 answers fragmentation *"by minting into a lifecycle, not
 * refusing to mint"*, because a refused mention is knowledge discarded at the
 * only moment it was recoverable.
 *
 * @spec §3.1, §3.2, §5.2, §6.2
 */
export const mintReferent = async (
  context: WriteContext,
  spec: MintSpec,
): Promise<{ referentId: string; existenceClaimId: string }> => {
  const referentId = spec.referentId ?? context.nextId();
  const gloss = await context.embeddings.embed(spec.surfaceForm, 'document');
  writeEntity(context.store, undefined, {
    id: referentId,
    name: spec.surfaceForm,
    level: spec.level,
    regime: spec.source === undefined ? 'evidence' : 'view',
    glossEmbedding: Array.from(gloss),
    facets: [],
    ...('locator' in spec ? { locator: spec.locator } : {}),
  });

  const claim = await writeExistenceClaim(context, referentId, spec);
  // The minting form gets a naming claim like any other. It used to get none —
  // its every use answered at a rung that wrote nothing — so the form a referent
  // is usually called was the one form the ledger said nothing about, and a
  // rebuild had to guess its support from the fact that it was written first.
  await writeNamingClaim(
    context,
    referentId,
    spec.surfaceForm,
    spec.tier,
    spec.origin,
    spec.tainted === true,
  );
  await recordMention(context, referentId, spec.surfaceForm);

  return { referentId, existenceClaimId: claim.id };
};

/**
 * How many times an episode has already contributed to one naming.
 *
 * Counted off the claim's own provenance rather than through `ABOUT`, because a
 * naming claim has no `ABOUT` edge to count through — see {@link namingClaimId}.
 * The claim's own creation counts as the episode's first contribution, mirroring
 * {@link contributionsFromEpisode}'s rule for existence claims: minting is the
 * episode saying the referent goes by this name. Counting only the repeats after
 * it would let twelve namings in one session buy just over three observations,
 * and no cap that permits that is §4.2's.
 *
 * @spec §4.2, §4.4
 */
const namingsFromEpisode = (claim: ClaimRecord, episodeId: string): number =>
  claim.provenance.episodes.filter((episode) => episode === episodeId).length;

/**
 * Writes the identity claim §3.1 says the mention index materializes, or
 * corroborates the one already there.
 *
 * For **every** form, whatever rung §5.2 answered on and including the form a
 * referent was minted under. A naming is a claim, so re-using a known form is
 * ordinary corroboration of it: §4.2's episode cap, §4.4's independence discount
 * and §5.1's replay-zero apply to it exactly as they apply to anything else. The
 * count that used to stand in for this lived only in the mention index, which is
 * a projection §11 requires to be regenerable from the ledger — a number that
 * exists nowhere but the view it is derived from is not derivable, and it counted
 * insistence rather than corroboration besides.
 *
 * The claim id is a content hash of the pair, so the reuse case is a lookup. No
 * `ABOUT` edge: §5.3's structural channel retrieves *"every claim already
 * attached via `ABOUT` to the same entities"* as candidate knowledge, and a
 * naming claim is not knowledge about the referent — it is knowledge about what
 * the referent is called. It reaches the index through {@link recordMention} and
 * a rebuild through the ledger scan.
 *
 * @spec §3.1, §4.2, §4.4, §5.1, §5.2, §5.3, §8.2
 */
export const writeNamingClaim = async (
  context: WriteContext,
  referentId: string,
  surfaceForm: string,
  tier: ClaimTier,
  origin: Origin,
  tainted: boolean,
): Promise<void> => {
  const { store } = context;
  const claimId = namingClaimId(referentId, surfaceForm);
  const standing = store.getClaim(claimId);

  if (standing === undefined) {
    const prior = priorFor(tier);
    await writeClaim(context, {
      id: claimId,
      text: encodeSpineClaim({ v: 1, claim: 'naming', referent: referentId, surfaceForm }),
      kind: 'fact',
      tier,
      status: 'provisional',
      // Evidence even when the referent is attested. §3.1 makes a noun source
      // *"a privileged noun source, nothing more"* — it declares that the thing
      // exists, not what everyone else calls it, and the derived name is a view
      // over what everyone else calls it.
      regime: 'evidence',
      evidence: { alpha: prior.alpha + observationWeight(tier, 0, tainted), beta: prior.beta },
      scope: referentId,
      origin,
    });
    return;
  }

  const weight = observationWeight(tier, namingsFromEpisode(standing, origin.episodeId), tainted);
  if (weight <= 0) return;
  store.incrementEvidence({
    claimId,
    alpha: weight,
    witness: {
      episodeId: origin.episodeId,
      channel: origin.channel,
      agent: origin.agent,
    },
  });
};
