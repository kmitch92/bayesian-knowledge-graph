/**
 * The ingest port: one door into the graph, for every producer.
 *
 * Diagram §1: *"Core contains no parser and no language-specific code. Every
 * source of knowledge — human, agent, or emitter — writes claims through one
 * ingest port."* §5 says the same thing from the write path's side: *"one
 * synchronous pipeline every observation passes through, whatever its origin"*.
 * So `submit` has no producer discriminant and no privileged caller. A parser is
 * an external emitter that writes attestations here; an agent's `observe` writes
 * claims here; a transcript importer writes claims here. The receipt is the same
 * shape for all three, and the two things that differ — tier and channel — are
 * fields any of them could set.
 *
 * The pipeline, per §5:
 *
 * ```
 * stage 0  dedupe      hash(text) + episode → an admitted observation or a replay
 * stage 1  resolve     §5.2's ladder, once per noun, minting what it cannot place
 * stage 2  embed       the claim text, once, `document` side
 *          write       the ledger row, its ABOUT edges, and the evidence they earn
 * ```
 *
 * Stage 0 gates *evidence*, not the ledger. A replay still lands as a row —
 * §4.3's "they still land in the ledger as raws" — with its own provenance and
 * its own channel; what it does not do is move a posterior. That is the
 * difference between recording that something was said twice and believing it
 * twice.
 *
 * @spec §3.1, §4.2, §4.7, §5, §5.1, §5.2, §5.8, §5.9, §6.3
 */

import type { EmbeddingProvider } from '../store/ports/embedding-provider.js';
import type { ClaimStatus, ClaimTier, Evidence, GraphStore } from '../store/index.js';
import { contentAddressedId, createIdMinter } from '../referents/ids.js';
import {
  existenceClaimsOf,
  isLive,
  readAllReferents,
  readReferent,
  writeEntity,
  type ExistenceClaim,
  type Referent,
} from '../referents/index-view.js';
import {
  resolveSurfaceForm,
  type Adjudicator,
  type LadderContext,
  type Resolution,
} from '../referents/ladder.js';
import { encodeSpineClaim } from '../referents/spine.js';

import { priorFor } from './evidence.js';
import {
  IngestMessage as IngestMessageSchema,
  type IngestMessage,
  type Origin,
  type ParsedMessage,
} from './messages.js';
import { rebuildIndex } from './rebuild.js';
import {
  corroborateExistence,
  mintReferent,
  recordMention,
  retireClaim,
  reuseOrWriteExistenceClaim,
  writeClaim,
  writeExistenceClaim,
  writeNamingClaim,
  type MintSpec,
  type WriteContext,
} from './spine-writer.js';

export type {
  AttestationMessage,
  ClaimMessage,
  ContainmentMessage,
  IngestMessage,
  Origin,
  RetractionMessage,
} from './messages.js';

/**
 * What one `submit` did.
 *
 * Three fields, the same three for every producer and every message type. §5's
 * one pipeline would be a fiction if an emitter's receipt carried a field an
 * agent's did not — the shape *is* the symmetry.
 *
 * @spec §5, §5.9
 */
export interface IngestReceipt {
  /** The ledger row this message wrote, when it wrote one. @spec §3.5 */
  readonly claimId: string | undefined;
  /** Whether stage 0 had already seen this text in this episode. @spec §5.1 */
  readonly duplicate: boolean;
  /** How each noun resolved, in the order the message named them. @spec §5.2 */
  readonly resolutions: readonly Resolution[];
}

/**
 * The referent index, as a read surface.
 *
 * Every method derives its answer from the store, so a port opened over a
 * database it never wrote serves the same answers as the port that grew it —
 * and `rebuild-index` cannot be passed by handing back an in-memory copy of
 * what the clear was supposed to destroy.
 *
 * @spec §3.1, §11
 */
export interface ReferentIndex {
  /** Every referent, in id order. @spec §3.1 */
  all(): Referent[];
  /** One referent, or `undefined` if the index holds no row for it. @spec §3.1 */
  get(referentId: string): Referent | undefined;
  /**
   * The referents gather may serve: everything but the provisional population.
   *
   * §5.2's rule, reused from §8.8 — a minted referent is *"invisible to gather
   * until corroborated"*, which is what stops one typo becoming a node the
   * retrieval path has to reason about.
   *
   * @spec §5.2, §8.8
   */
  visible(): Referent[];
  /**
   * The referents in one lifecycle state.
   *
   * §5.2: *"no separate triage structure — the provisional-referent population
   * is queryable by status"*. A queue would be a second place the truth lived.
   *
   * @spec §5.2, §6.1
   */
  byStatus(status: ClaimStatus): Referent[];
  /** Every surface form recorded for a referent, most-corroborated first. @spec §3.1 */
  mentionsOf(referentId: string): string[];
  /** A referent's direct children. Direct, not transitive. @spec §3.1, §3.3 */
  childrenOf(referentId: string): string[];
}

/**
 * The one entry point.
 *
 * @spec §5, §11
 */
export interface IngestPort {
  /** Writes one message. @spec §5 */
  submit(message: IngestMessage): Promise<IngestReceipt>;
  /** Regenerates the three projections from the ledger. @spec §3.1, §11 */
  rebuildIndex(): Promise<void>;
  readonly referents: ReferentIndex;
}

/**
 * What the port needs, all of it injected.
 *
 * The two model-shaped dependencies are ports rather than imports on purpose:
 * `src/store/nomic-dimensions.ts` exists to keep `@huggingface/transformers` off
 * the store's import path, and a concrete provider imported here would put it
 * back — 250MB and most of a second, paid by every process that only writes.
 *
 * @spec §5.2, §5.3, §11
 */
export interface IngestOptions {
  readonly store: GraphStore;
  readonly embeddings: EmbeddingProvider;
  readonly adjudicator: Adjudicator;
  /** §15's `cos_floor`. @spec §15 */
  readonly cosineFloor?: number | undefined;
  /** §15's `τ_promote`. @spec §15 */
  readonly tauPromote?: number | undefined;
}

/** The instant, as §3.5 records instants. */
const now = (): string => new Date().toISOString();

/**
 * The text stage 0 hashes for a message that is not a claim.
 *
 * A canonical rendering of the declaration, never stored: *"The store hashes
 * what it is given"*, and what it should be given for an attestation is the
 * attestation, not the sentence the attestation will eventually be written as.
 *
 * @spec §5.1
 */
const observationText = (message: ParsedMessage): string => {
  switch (message.type) {
    case 'claim':
      return message.text;
    case 'attestation':
      return `attestation ${JSON.stringify([
        message.source,
        message.surfaceForm,
        message.level,
        message.locator ?? null,
      ])}`;
    case 'containment':
      return `containment ${JSON.stringify([
        message.parent,
        message.child,
        message.childLevel,
        message.source ?? null,
      ])}`;
    case 'retraction':
      // The whole address the message carries, and no more of one than it
      // carries: `(source, form)` is the coarse address and a locator narrows
      // it, so the discriminant `withdraws` reads — the key's presence, not its
      // value — has to decide the arity here too. `locator ?? null` would render
      // the coarse address as the narrow one addressed to `null`, colliding the
      // two different withdrawals it was meant to keep apart.
      return `retraction ${JSON.stringify(
        'locator' in message
          ? [message.source, message.surfaceForm, message.locator]
          : [message.source, message.surfaceForm],
      )}`;
  }
};

/** @spec §5, §11 */
export const openIngest = (options: IngestOptions): IngestPort => {
  const { store, embeddings, adjudicator } = options;
  const write: WriteContext = {
    store,
    embeddings,
    nextId: createIdMinter(),
    tauPromote: options.tauPromote,
  };
  const ladder: LadderContext = {
    store,
    embeddings,
    adjudicator,
    cosineFloor: options.cosineFloor,
  };

  /**
   * Runs §5.2's ladder for one noun and records the outcome.
   *
   * Every resolution — a mint, an exact hit, a gloss hit, a tiebreak the model
   * paid for — leaves a mention behind, so the next use of that form answers at
   * rung 2 and the same question is never asked of a model twice. Every one of
   * them also touches the naming claim for the pair: minting it if this is the
   * form's first use, corroborating it if it is not. Only the two rungs that
   * cannot have seen the form before used to write anything, which left the
   * mention index holding a count of uses no rebuild could reproduce — and
   * counting uses is counting insistence, which §4.2 and §4.4 exist to discount.
   *
   * The rung decides nothing here beyond whether a referent had to be minted.
   * That is deliberate: the ladder is read-only (see `ladder.ts`), so *which* rung
   * answered is news about how the form was found and never about whether the
   * finding is worth recording.
   */
  const resolveOne = async (
    surfaceForm: string,
    contextText: string,
    origin: Origin,
    tier: ClaimTier,
    tainted: boolean,
    mint: Omit<MintSpec, 'surfaceForm' | 'origin' | 'tier' | 'tainted'>,
  ): Promise<Resolution> => {
    const outcome = await resolveSurfaceForm(ladder, surfaceForm, contextText);
    if (outcome.rung === 'minted') {
      const minted = await mintReferent(write, {
        ...mint,
        surfaceForm,
        origin,
        tier,
        tainted,
      });
      return { surfaceForm, referentId: minted.referentId, rung: 'minted' };
    }
    await writeNamingClaim(write, outcome.referentId, surfaceForm, tier, origin, tainted);
    await recordMention(write, outcome.referentId, surfaceForm);
    return { surfaceForm, referentId: outcome.referentId, rung: outcome.rung };
  };

  /** §5.2 and §5.3 for a claim: resolve every noun, write the row, pay the evidence. */
  const submitClaim = async (
    message: Extract<ParsedMessage, { type: 'claim' }>,
    duplicate: boolean,
  ): Promise<IngestReceipt> => {
    const resolutions: Resolution[] = [];
    for (const surfaceForm of message.mentions)
      resolutions.push(
        await resolveOne(surfaceForm, message.text, message.origin, message.tier, duplicate, {
          level: null,
        }),
      );

    const claim = await writeClaim(write, {
      id: write.nextId(),
      text: message.text,
      kind: message.kind,
      tier: message.tier,
      status: 'provisional',
      regime: 'evidence',
      evidence: priorFor(message.tier),
      // §3.2: exactly one ABOUT target is the anchor. The first noun the claim
      // named is where the claim lives; the rest are what it references.
      scope: resolutions[0]!.referentId,
      origin: message.origin,
    });

    // Before the edges land, so this claim does not count itself as one of the
    // episode's earlier contributions.
    for (const resolution of resolutions)
      if (resolution.rung !== 'minted')
        corroborateExistence(write, resolution.referentId, message.origin, message.tier, duplicate);

    for (const referentId of new Set(resolutions.map((entry) => entry.referentId)))
      store.putClaimEdge({ from: claim.id, kind: 'ABOUT', to: referentId });

    return { claimId: claim.id, duplicate, resolutions };
  };

  /**
   * A noun source declaring a referent.
   *
   * The declaration's own id is a content hash of what it declares (§3.1), so a
   * source re-running against an unchanged world lands on the row it landed on
   * last time — in this database or in one it has never met. The ladder still
   * runs first: an attestation of a noun the graph already grew from usage is
   * the *same referent* moving regime, not a second one.
   */
  const submitAttestation = async (
    message: Extract<ParsedMessage, { type: 'attestation' }>,
    duplicate: boolean,
  ): Promise<IngestReceipt> => {
    const declaration = [message.source, message.surfaceForm, message.level, message.locator];
    const existenceClaimId = contentAddressedId('existence-claim', declaration);
    const text = observationText(message);

    const outcome = await resolveSurfaceForm(ladder, message.surfaceForm, text);
    const mint: MintSpec = {
      surfaceForm: message.surfaceForm,
      origin: message.origin,
      tier: message.tier,
      level: message.level,
      locator: message.locator,
      source: message.source,
      referentId: contentAddressedId('referent', declaration),
      existenceClaimId,
    };

    let referentId: string;
    let claimId: string;
    if (outcome.rung === 'minted') {
      const minted = await mintReferent(write, mint);
      referentId = minted.referentId;
      claimId = minted.existenceClaimId;
    } else {
      referentId = outcome.referentId;
      claimId = await reuseOrWriteExistenceClaim(write, referentId, existenceClaimId, mint);
      await writeNamingClaim(
        write,
        referentId,
        message.surfaceForm,
        message.tier,
        message.origin,
        duplicate,
      );
      await recordMention(write, referentId, message.surfaceForm);
    }

    // §3.1: `view` while any noun source attests it. The belief this referent's
    // existence used to be is retired rather than deleted — §6.1 keeps it
    // readable, and its posterior with it.
    for (const entry of existenceClaimsOf(store, referentId))
      if (entry.claim.regime === 'evidence' && isLive(entry.claim)) retireClaim(store, entry.claim.id);

    writeEntity(store, store.getEntity(referentId), {
      id: referentId,
      level: message.level,
      regime: 'view',
      locator: message.locator,
    });

    return {
      claimId,
      duplicate,
      resolutions: [{ surfaceForm: message.surfaceForm, referentId, rung: outcome.rung }],
    };
  };

  /**
   * Whether a retraction reaches one standing declaration.
   *
   * The source always has to match: a withdrawal is a source letting go of its
   * own claim, and it may not retire another source's. A locator on the message
   * narrows it further, to the one declaration made at that locator.
   *
   * The locator is compared as the store serializes it, which is how every other
   * comparison of an opaque locator in this system is made — {@link
   * contentAddressedId} hashes `JSON.stringify` of the declaration, and the
   * payload read back here came through the same encoding. Matched on the payload
   * rather than by recomputing the declaration's id: that id hashes the *attested*
   * surface form, and a withdrawal addressed to an alias the referent also answers
   * to would recompute an id no claim was ever written at, and silently retire
   * nothing. §3.1's index exists so a form can reach a referent it did not mint.
   *
   * The two encodings part on one value: `JSON.stringify` writes an `undefined`
   * array element as `null`, so a declaration made at `locator: null` and one
   * made with no locator hash to the same id, while the comparison here keeps
   * them apart (`JSON.stringify(undefined)` is not a string). Reaching that takes
   * a source spelling "no place" one way when it attests and the other way when
   * it withdraws; the hashing is left as it is.
   *
   * @spec §3.1
   */
  const withdraws = (
    message: Extract<ParsedMessage, { type: 'retraction' }>,
    attestation: ExistenceClaim,
  ): boolean => {
    if (attestation.payload.source !== message.source) return false;
    if (!('locator' in message)) return true;
    return JSON.stringify(attestation.payload.locator) === JSON.stringify(message.locator);
  };

  /**
   * The retired evidence-regime existence claim a fallen referent's successor is
   * seeded from, with the posterior it still holds — `undefined` when the ledger
   * holds no such claim, or none carrying a posterior to read.
   *
   * The most recent, when there are several: each succeeded the one before it, so
   * the newest is the only one that read all of them. Evidence-regime existence
   * claims are written under fresh monotonic ids (§3.5) — the content-addressed
   * ids belong to attested declarations, which are view claims — so id order is
   * arrival order here.
   *
   * The seed and the lineage edge come from this one answer on purpose: a
   * successor that read a posterior must say so, and one that read nothing must
   * not claim a derivation it did not make.
   *
   * @spec §3.5, §6.1, §6.2
   */
  const corpseOf = (referentId: string): { id: string; posterior: Evidence } | undefined => {
    const retired = existenceClaimsOf(store, referentId).filter(
      (entry) => entry.claim.regime === 'evidence' && !isLive(entry.claim),
    );
    const newest = retired[retired.length - 1];
    if (newest === undefined) return undefined;
    const posterior = store.getEvidence(newest.claim.id);
    return posterior === null || posterior === undefined
      ? undefined
      : { id: newest.claim.id, posterior };
  };

  /**
   * A noun source withdrawing a declaration.
   *
   * Addressed to a *form*, and §3.1 keys the mention index `(surface_form,
   * referent_id)` "precisely so a form that comes to name two referents keeps
   * both". So the withdrawal visits every candidate the form reaches and retires
   * this source's live attestations on each — a first-candidate read would land on
   * a referent the source never spoke for, find nothing of its own to retire, and
   * leave the attestation it was actually asked to withdraw standing.
   *
   * §3.1's regime rule is then answered *per referent*: the regime falls back only
   * where the *last* source let go ("while any noun source attests it"), and one
   * referent losing its last attestation says nothing about another that still has
   * one.
   *
   * Where it does fall, the referent's existence becomes an ordinary belief again
   * and needs an ordinary posterior. The claim it succeeds is a view claim and has
   * none — but a referent that grew from usage before a source attested it left an
   * evidence claim behind, retired rather than deleted (§6.1), with its posterior
   * still on it. That is §6.2's deprecated row: "mint a new claim `DERIVED_FROM`
   * the corpse, seeded from the old posterior". Reading it is reading evidence,
   * not inventing it, and the `DERIVED_FROM` edge is where the successor says
   * where it read. The corpse stays retired; being read is not being resurrected.
   * Only a referent the graph never knew as anything but an attestation has no
   * corpse, and there the §15 prior is where its existence honestly starts.
   *
   * The successor is born at exactly that seed. {@link writeExistenceClaim}'s
   * first-observation boost is a vote for the referent's existence, and the only
   * message paying for one here asserts its absence.
   *
   * A retraction of a noun the graph never held is a no-op, not a mint. Nothing
   * was asserted, so there is nothing to disbelieve.
   */
  const submitRetraction = async (
    message: Extract<ParsedMessage, { type: 'retraction' }>,
    duplicate: boolean,
  ): Promise<IngestReceipt> => {
    const resolutions: Resolution[] = [];
    let claimId: string | undefined;

    for (const mentioned of store.findReferentsByMention(message.surfaceForm)) {
      const referentId = mentioned.referentId;
      resolutions.push({
        surfaceForm: message.surfaceForm,
        referentId,
        rung: mentioned.canonicalName ? 'exact' : 'mention-index',
      });

      const attestations = existenceClaimsOf(store, referentId).filter(
        (entry) => entry.claim.regime === 'view' && isLive(entry.claim),
      );
      const withdrawn = attestations.filter((entry) => withdraws(message, entry));
      for (const entry of withdrawn) retireClaim(store, entry.claim.id);
      if (withdrawn.length === 0 || withdrawn.length < attestations.length) continue;

      const last = withdrawn[withdrawn.length - 1]!;
      const corpse = corpseOf(referentId);
      const successor = await writeExistenceClaim(write, referentId, {
        surfaceForm: last.payload.surfaceForm,
        origin: message.origin,
        tier: 'observed',
        level: last.payload.level,
        ...('locator' in last.payload ? { locator: last.payload.locator } : {}),
        seed: corpse?.posterior ?? priorFor('observed'),
      });
      if (corpse !== undefined)
        store.putClaimEdge({ from: successor.id, kind: 'DERIVED_FROM', to: corpse.id });
      writeEntity(store, store.getEntity(referentId), { id: referentId, regime: 'evidence' });
      claimId ??= successor.id;
    }

    return { claimId, duplicate, resolutions };
  };

  /**
   * An assertion that one referent contains another.
   *
   * The only path to a `CONTAINS` edge or a non-null level in the whole system.
   * A locator sharing a directory with another locator does not nest anything, a
   * claim naming two nouns does not nest them, and an anchor is not a parent —
   * §3.3's spine is *"the materialization of containment claims"* and of nothing
   * else, which is what makes a bad boundary an ordinary wrong claim.
   */
  const submitContainment = async (
    message: Extract<ParsedMessage, { type: 'containment' }>,
    duplicate: boolean,
  ): Promise<IngestReceipt> => {
    const text = observationText(message);
    const parent = await resolveOne(
      message.parent,
      text,
      message.origin,
      message.tier,
      duplicate,
      { level: null },
    );
    const child = await resolveOne(message.child, text, message.origin, message.tier, duplicate, {
      level: message.childLevel,
    });

    const asserted = message.source === undefined;
    const claim = await writeClaim(write, {
      id: write.nextId(),
      text: encodeSpineClaim({
        v: 1,
        claim: 'containment',
        parent: parent.referentId,
        child: child.referentId,
        childLevel: message.childLevel,
      }),
      kind: 'fact',
      tier: message.tier,
      status: asserted ? 'provisional' : 'active',
      regime: asserted ? 'evidence' : 'view',
      evidence: asserted ? priorFor(message.tier) : null,
      scope: parent.referentId,
      origin: message.origin,
    });

    store.putContainment({ parent: parent.referentId, child: child.referentId });
    const entity = store.getEntity(child.referentId);
    if (entity !== undefined && entity.level !== message.childLevel)
      writeEntity(store, entity, { id: child.referentId, level: message.childLevel });

    return { claimId: claim.id, duplicate, resolutions: [parent, child] };
  };

  const submit = async (message: IngestMessage): Promise<IngestReceipt> => {
    const parsed = IngestMessageSchema.parse(message);
    const admitted = store.admitObservation({
      episodeId: parsed.origin.episodeId,
      normalizedText: observationText(parsed),
    });
    const duplicate = !admitted;

    const receipt = await (parsed.type === 'claim'
      ? submitClaim(parsed, duplicate)
      : parsed.type === 'attestation'
        ? submitAttestation(parsed, duplicate)
        : parsed.type === 'containment'
          ? submitContainment(parsed, duplicate)
          : submitRetraction(parsed, duplicate));

    // §5.8: every stage logs its inputs and its decision, because §13's replay
    // is what tunes the thresholds those decisions were made against.
    store.appendStageLog({
      episodeId: parsed.origin.episodeId,
      stage: 'resolve',
      inputs: { type: parsed.type, channel: parsed.origin.channel },
      decision: {
        duplicate: receipt.duplicate,
        claimId: receipt.claimId ?? null,
        resolutions: receipt.resolutions.map((entry) => ({
          surfaceForm: entry.surfaceForm,
          referentId: entry.referentId,
          rung: entry.rung,
        })),
      },
      at: now(),
    });

    return receipt;
  };

  const referents: ReferentIndex = {
    all: () => readAllReferents(store),
    get: (referentId) => readReferent(store, referentId),
    visible: () => readAllReferents(store).filter((referent) => referent.status !== 'provisional'),
    byStatus: (status) => readAllReferents(store).filter((referent) => referent.status === status),
    mentionsOf: (referentId) => store.getMentionTally(referentId).map((tally) => tally.surfaceForm),
    childrenOf: (referentId) => store.getChildren(referentId),
  };

  return {
    submit,
    rebuildIndex: () => rebuildIndex(write),
    referents,
  };
};

export type { Referent } from '../referents/index-view.js';
