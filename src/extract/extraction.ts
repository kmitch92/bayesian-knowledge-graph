/**
 * §5.10's expensive half, finally paid: *"Extraction is lazy: member claims are
 * extracted per chunk when the chunk is served or cited, when incoming evidence
 * targets it, or opportunistically on the calendar clock."*
 *
 * E2 parked one job per chunk and wrote nothing else. This file takes those jobs
 * back off §9's queue, runs an {@link Extractor} over the chunk each one names,
 * puts every proposal through the verbatim gate, and hands the survivors to the
 * *same* `openIngest.submit()` an agent's `observe` uses. There is no second
 * write path here and there must not be: §1's *"every source of knowledge —
 * human, agent, or emitter — writes claims through one ingest port"* is not a
 * claim about producers, it is a claim about doors.
 *
 * ── The gate, and why "verbatim" is read literally ──────────────────────────
 *
 * A proposal is admitted only if **the chunk contains its quote byte for byte
 * and the quote is not blank**. No trimming, no case folding, no whitespace
 * collapsing, no typographic-quote folding. Three things force the strict
 * reading:
 *
 * 1. A chunk's text is *derived*, not stored — E2's `chunksOf` re-runs the
 *    chunker over `content_ref` — so a chunk is by construction an exact
 *    substring of the document. Exact containment in the chunk therefore implies
 *    exact containment in the document. A folded match implies nothing about the
 *    document, which is the only thing the citation was ever a citation *of*.
 * 2. §5.10's testimony decay reads the same relation later — *"members whose
 *    quotes vanish flag `retracted_in_source`"* — so a member admitted under a
 *    fold vanishes under an exact search. One normalization decision, leaking
 *    into a second subsystem that has no reason to know about it, failing
 *    silently in both.
 * 3. `ExtractionRejection.quote` is stored *"neither trimmed nor folded"*
 *    because *"a quote that fails the verbatim check only on whitespace is a
 *    different diagnosis from one the paragraph never contained"*. That sentence
 *    describes nothing unless a whitespace-only difference is a failure.
 *
 * The cost is real and accepted: a model whose renderer curls quotation marks
 * loses every member of every paragraph containing one. That failure is
 * *legible* — the rejection log holds the quote unfolded and §13 counts it in
 * one query — where a fold would admit spans the document does not contain and
 * erase the evidence that it had.
 *
 * The blank check is not decoration. `chunk.text.includes(quote)` is `true` for
 * `''` and for `' '` in every chunk of every document, so a bare containment
 * test admits a model that cited *nothing at all* — §12's phantom with the
 * citation removed rather than faked. That is `quoteAbsent`, a model *"broken in
 * a way no threshold fixes"*, and it is why {@link ExtractionRejection}'s chunk
 * anchor is nullable: there is no span to attribute it by. Anything else the
 * chunk does not hold is `quoteNotVerbatim`, anchored to the chunk under
 * extraction, which is *"exactly what a floor is for"*.
 *
 * Semantic entailment — does the span actually *support* the claim — is a second
 * model call against a floor §13 has no replay data to tune, so
 * `entailmentBelowFloor` stays in the vocabulary unwritten and the seam stays
 * open.
 *
 * ── What is not written, and what carries the tie instead ───────────────────
 *
 * **No `STATED_IN` edge.** §3.3 names the edge and §3.6 wants a member tied to
 * the span it came from, but `putClaimEdge` refuses every `RESERVED_EDGE_KIND`
 * on its first line, and the edge's `to` addresses a claim or an entity — a
 * document is neither. Lifting either is a store cycle, not this one. The
 * **episode** carries the tie meanwhile: §5.10 makes a document one episode and
 * E2 derives it from the document id, so `provenance.episodes` names the source
 * document recoverably for every member. When `STATED_IN` lands it replaces an
 * inference; it does not have to invent a fact.
 *
 * ── Two rulings this file makes ─────────────────────────────────────────────
 *
 * **A materialized document is refused here too.** E2 parks nothing for one, but
 * `enqueueJob` is public, so this is the second lock — §5.10 is unconditional
 * and §12 files testimony laundering as an attack. The model is never called,
 * and the job settles `failed` rather than `done`: retrying cannot change the
 * answer, since `origin` is a property of the document and not of the attempt,
 * so somebody parking work nobody may do leaves a readable trace instead of a
 * silent success.
 *
 * **A thrown extractor is transient.** §9 puts the retry policy in the caller's
 * hands precisely because neither automatic reading is right, and the drain is
 * that caller. So the throw does not propagate: the job goes back to `pending`
 * with the attempt counted and a `retryAt` strictly in the future — the *future*
 * part being what stops a drain loop immediately re-taking the job that just
 * killed it — and the graph is left exactly as it was found, because nothing is
 * written until the model has answered.
 *
 * **But transient has a ceiling.** {@link MAX_ATTEMPTS} attempts, and then the
 * job is parked with a `last_error` that names the cap and the way back — the
 * ruling above is unchanged, this only stops it running forever. An extractor
 * that is *down* rather than flaky otherwise costs a full re-chunk of the whole
 * document per job per minute, indefinitely, for a model call that was never
 * going to answer. The cap is affordable because `store.requeueJob` lands beside
 * it: parking is terminal — `claimJob` selects `pending` and nothing else — so a
 * ceiling with no recovery path would convert somebody else's brief outage into
 * permanent silent work loss, which is strictly worse than the storm it replaces.
 *
 * @spec §1, §3.2, §3.6, §4.2, §4.7, §5.2, §5.8, §5.10, §9, §11, §12, §13, §15
 */

import { z } from 'zod';

import { openIngest, type Origin } from '../ingest/index.js';
import type { ClaimKind, ClaimTier, ExtractionRejectionReason } from '../store/index.js';

import { EXTRACT_JOB_KIND, openTextIngest, type TextIngestOptions } from './text-ingest.js';

/**
 * One assertion a model proposes, with the span it says it read it in.
 *
 * The quote is required and is the whole of the model's obligation: §5.10 makes
 * *"every member carries its verbatim source span"* the price of admission, and
 * a proposal without one is not a weaker proposal but an unfalsifiable one.
 *
 * @spec §3.2, §5.2, §5.10
 */
export interface ExtractedClaim {
  /** The proposition, as the member will be written. @spec §3.2 */
  readonly text: string;
  /** The span the model says supports it, byte for byte as it offered it. @spec §5.10 */
  readonly quote: string;
  /** §3.2's claim kind. @spec §3.2 */
  readonly kind: ClaimKind;
  /** §6.3's privilege ladder. A document read is a reading, not a test. @spec §6.3, §15 */
  readonly tier: ClaimTier;
  /**
   * The nouns the member names, re-resolved from scratch.
   *
   * §3.6 demotes the document's anchor to *"a prior, not an inheritance"*, so a
   * member's entities are the ones its own text named and never the ones the
   * submitter anchored the document at.
   *
   * @spec §3.6, §5.2
   */
  readonly mentions: readonly string[];
}

/**
 * One chunk, handed to the model.
 *
 * The span is verbatim by construction — it is E2's derivation of the document's
 * own bytes — which is what makes the gate's byte-for-byte test meaningful
 * rather than a comparison against something already normalized.
 *
 * @spec §3.6, §5.10
 */
export interface ExtractionRequest {
  /** The paragraph under extraction, exactly as the author wrote it. @spec §3.6, §5.10 */
  readonly chunkText: string;
  /**
   * Whatever the drain can tell the model about where this paragraph sits.
   *
   * Deliberately underdetermined: §5.10 does not say what an extractor should be
   * told beyond the span, and guessing here would pin a prompt contract this
   * cycle has no evidence for.
   *
   * @spec §5.10
   */
  readonly context?: string | undefined;
}

/**
 * The third faked-in-tests model port, beside §5.2's adjudicator and §5.3's
 * embedding provider.
 *
 * `modelId` sits on the port rather than on a caller, mirroring
 * `EmbeddingProvider.modelId`: §13 groups an audit of the rejection log *by
 * model*, and a grouping key supplied by whoever happened to call the drain is a
 * key that can disagree with the model that actually ran.
 *
 * @spec §5.10, §11, §13
 */
export interface Extractor {
  /** The model under audit — §13's grouping key. @spec §13, §15 */
  readonly modelId: string;
  /** Proposes members for one chunk. @spec §5.10 */
  extract(request: ExtractionRequest): Promise<readonly ExtractedClaim[]>;
}

/**
 * What the drain needs: everything E2 needed, plus the model that does the
 * mining.
 *
 * Extended rather than restated, for the reason {@link TextIngestOptions} is an
 * alias of `IngestOptions`: one store, one embedding provider, one adjudicator,
 * §15's two constants. A member's nouns climb the same §5.2 ladder a document's
 * anchor does.
 *
 * @spec §5.2, §5.3, §5.10, §11
 */
export type ExtractionOptions = TextIngestOptions & {
  /** The model §5.10 defers the forty adjudications to. @spec §5.10, §11 */
  readonly extractor: Extractor;
};

/**
 * What one `drainOnce` did.
 *
 * A receipt, and read as one: *"the drain says a claim landed"* is evidence
 * about the receipt, so the tests that matter read the store. What it is for is
 * the caller's own accounting — which job, which document, how much got in and
 * how much did not.
 *
 * @spec §5.10, §9
 */
export interface DrainOutcome {
  /** The queue row that was taken. §9 makes the row the job. @spec §9 */
  readonly jobId: number;
  /** The document the chunk belonged to. @spec §3.6 */
  readonly documentId: string;
  /** The ledger ids of the members the gate admitted, in proposal order. @spec §3.5 */
  readonly admitted: readonly string[];
  /** How many proposals the gate refused to the log. @spec §5.10, §13 */
  readonly rejected: number;
}

/**
 * The extraction drain.
 *
 * @spec §5.10, §9, §11
 */
export interface ExtractionPort {
  /**
   * Takes the next due extraction job and works it, or answers with nothing.
   *
   * Mirrors `store.claimJob` exactly, because it is asking the queue the same
   * question: an empty queue gets the same answer. That shape makes *"a drain of
   * an empty queue"* expressible without a sentinel, without an exception and
   * without a spin.
   *
   * @spec §5.10, §9
   */
  drainOnce(): Promise<DrainOutcome | undefined>;
}

/**
 * §4.7's pathway half for a member the graph mined out of a document.
 *
 * Not the submitter's channel. The pathway signature records how a contribution
 * *arrived*, and this one arrived from a model reading a paragraph, not from
 * whoever posted the file.
 *
 * @spec §4.7, §5.10
 */
const DOC_EXTRACTION_CHANNEL = 'doc-extraction';

/**
 * How long a job that died on a transient failure waits before it is claimable
 * again.
 *
 * A placeholder for §15's ⚙ backoff, and the only property that matters here is
 * that it is strictly positive: a `retryAt` in the past would be re-claimed on
 * the next pass of the same drain loop, forever, which is precisely the spin §9
 * put the instant in the caller's hands to avoid.
 *
 * @spec §9, §15
 */
const RETRY_AFTER_MS = 60_000;

/**
 * §15's ⚙ retry budget: how many attempts one extract job gets before the drain
 * stops handing it back and parks it for an operator.
 *
 * The other half of the policy §9 leaves to the caller — *"the store supplies
 * the mechanism and the caller supplies the policy"* — because a backoff with no
 * ceiling is only half of one. What an uncapped drain costs is not the model
 * call, which fails fast: it is that `chunksOf` re-derives the document's whole
 * chunking before `extract` is ever reached, so a forty-chunk document whose
 * extractor is down pays forty full re-chunks a minute, indefinitely.
 *
 * Five, and not a larger number, because `store.requeueJob` lands in the same
 * cycle: an operator gets an unbounded number of fresh runs for the price of one
 * deliberate call, so this budget only has to cover the failures *nobody is
 * watching*. Five attempts at {@link RETRY_AFTER_MS} bounds the re-chunk storm
 * at five minutes, and migration 0's own illustration of a budget on this column
 * — the reason `attempts` carries a `typeof(attempts) = 'integer'` guard at all
 * — is written `attempts < 5`.
 *
 * @spec §9, §15
 */
const MAX_ATTEMPTS = 5;

/**
 * What E2 parked, as the drain reads it back.
 *
 * Parsed rather than cast: §9 keeps a payload *"opaque JSON the store persists
 * and hands back"*, and `enqueueJob` is public, so what comes off this queue is
 * external input by the same standard a submitted message is.
 *
 * @spec §5.10, §9
 */
const ExtractJobPayload = z.object({
  documentId: z.string().min(1),
  ordinal: z.number().int().min(0),
  hash: z.string().min(1),
  episodeId: z.string().min(1),
});

/** The instant, as §3.5 records instants. */
const now = (): string => new Date().toISOString();

/** What killed an attempt, as an operator would want to read it. @spec §9, §12 */
const reasonFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The verbatim gate: the reason a proposal was refused, or `undefined` when the
 * chunk really does contain what the model cited.
 *
 * Both arms of the test are load-bearing, and the blank one is the one a naive
 * implementation drops — see this module's head.
 *
 * @spec §5.10, §12, §13
 */
const refusalFor = (chunkText: string, quote: string): ExtractionRejectionReason | undefined => {
  if (quote.trim().length === 0) return 'quoteAbsent';
  return chunkText.includes(quote) ? undefined : 'quoteNotVerbatim';
};

/** @spec §5.10, §9, §11 */
export const openExtraction = (options: ExtractionOptions): ExtractionPort => {
  const { store, extractor } = options;
  // The serving side, reused rather than re-derived: `chunksOf` re-runs the
  // chunker over `content_ref` *and* checks the result against the stored rows,
  // so a document whose `content_ref` holds a pointer raises
  // `ContentRefDivergedError` instead of handing the model a pointer string to
  // mine. Deriving the span here again would be the same bytes computed twice
  // with only one of the two copies checked.
  const text = openTextIngest(options);
  // §1's one door. Every member below goes through it, exactly as an agent's
  // observation does.
  const ingest = openIngest(options);

  /** Parks a job for good: readable, countable, and never claimed again. @spec §9, §12 */
  const park = (jobId: number, why: string): void => {
    store.failJob({ id: jobId, error: why });
  };

  /**
   * Hands a job back to the queue with the attempt counted — until the attempt
   * that spends {@link MAX_ATTEMPTS}, which parks it instead.
   *
   * `attemptsBefore` is `job.attempts` as `claimJob` handed it over, which is the
   * count *before* this failure is recorded: `failJob` does the `attempts + 1`
   * inside SQLite. So the comparison is against the count this attempt is about
   * to produce, and the budget is spent on the attempt that reaches the cap
   * rather than on the one after it.
   *
   * The parked job's `last_error` has to carry three things, because it is the
   * only thing an operator will read: what killed the job, that a *cap* stopped
   * it rather than the failure itself, and the call that puts it back. A cap
   * whose recovery path is undiscoverable is a cap nobody will trust — and
   * `park` is terminal by construction, since `claimJob` selects `pending` and
   * nothing else, so this branch would otherwise turn somebody else's five-minute
   * API outage into silent permanent work loss. `store.requeueJob` is what makes
   * the cap affordable, and naming it here is what makes it findable.
   *
   * @spec §9, §12, §15
   */
  const handBack = (jobId: number, attemptsBefore: number, why: string): void => {
    if (attemptsBefore + 1 >= MAX_ATTEMPTS) {
      park(
        jobId,
        `${why} — capped at ${String(MAX_ATTEMPTS)} attempts; call store.requeueJob(${String(jobId)}) to retry`,
      );
      return;
    }
    store.failJob({
      id: jobId,
      error: why,
      retryAt: new Date(Date.now() + RETRY_AFTER_MS).toISOString(),
    });
  };

  /**
   * Runs one chunk: the second materialized lock, the model call, the gate, and
   * the one ingest door.
   *
   * @spec §4.7, §5.2, §5.10, §12
   */
  const workChunk = async (
    jobId: number,
    payload: z.infer<typeof ExtractJobPayload>,
  ): Promise<DrainOutcome> => {
    const { documentId, ordinal, episodeId } = payload;
    const nothing = { jobId, documentId, admitted: [], rejected: 0 } as const;

    // A job names a document by id and nothing stronger — §9's `enqueueJob`
    // takes an opaque payload with no foreign key — so a row that never
    // existed and a row a later revision's `deleteDocument` cascade took away
    // read identically here: no document. Retrying cannot manufacture one, so
    // this parks rather than backs off.
    const document = store.getDocument(documentId);
    if (document === undefined) {
      park(jobId, `no document ${documentId} to extract from`);
      return nothing;
    }
    // §5.10, unconditional: *"Authored documents only. Materialized documents
    // have members by construction; re-extracting would launder canonicals back
    // in as fresh testimony."* Before the model call, so the refusal costs
    // nothing and leaves nothing.
    if (document.origin === 'materialized') {
      park(
        jobId,
        `document ${documentId} is materialized: §5.10 mines authored documents only, and re-extracting one would launder canonicals back in as fresh testimony`,
      );
      return nothing;
    }

    // The document survived but a shrinking revision may not have: `text
    // -ingest.ts` deletes and rewrites a document whose re-chunking has fewer
    // paragraphs than before, so a job parked for an ordinal the author has
    // since deleted names a chunk that no longer exists and never will again
    // under this hash. Same terminal answer as a missing document, for the
    // same reason.
    const chunk = text.chunksOf(documentId).find((view) => view.ordinal === ordinal);
    if (chunk === undefined) {
      park(jobId, `document ${documentId} no longer has a chunk at ordinal ${String(ordinal)}`);
      return nothing;
    }

    const proposals = await extractor.extract({ chunkText: chunk.text });

    // §5.10 makes a document one episode, so every member of every chunk is
    // attributed to the one E2 derived from the document id — twelve assertions
    // in one ADR are one source, not twelve observations.
    const origin: Origin = { episodeId, channel: DOC_EXTRACTION_CHANNEL };
    const admitted: string[] = [];
    let rejected = 0;

    // Proposal by proposal, never batch by batch: a model that gets one span
    // right and two wrong has said one true thing, and refusing the batch would
    // throw it away while admitting the batch would launder the other two.
    for (const proposal of proposals) {
      const refusal = refusalFor(chunk.text, proposal.quote);
      if (refusal !== undefined) {
        rejected += 1;
        const unanchored = refusal === 'quoteAbsent';
        store.recordExtractionRejection({
          documentId,
          chunkOrdinal: unanchored ? null : ordinal,
          chunkHash: unanchored ? null : chunk.hash,
          claimText: proposal.text,
          quote: unanchored ? null : proposal.quote,
          reason: refusal,
          modelId: extractor.modelId,
          // Left empty for the deferred entailment gate, whose score, floor and
          // parameters are what this column exists to hold without a migration.
          detail: null,
          at: now(),
        });
        continue;
      }

      const receipt = await ingest.submit({
        type: 'claim',
        text: proposal.text,
        kind: proposal.kind,
        tier: proposal.tier,
        mentions: [...proposal.mentions],
        origin,
      });
      if (receipt.claimId !== undefined) admitted.push(receipt.claimId);
    }

    store.completeJob(jobId);
    return { jobId, documentId, admitted, rejected };
  };

  const drainOnce = async (): Promise<DrainOutcome | undefined> => {
    for (;;) {
      const job = store.claimJob(EXTRACT_JOB_KIND);
      if (job === undefined) return undefined;

      const payload = ExtractJobPayload.safeParse(job.payload);
      if (!payload.success) {
        // Not work this drain did, and not work it can ever do: a payload it
        // cannot read names no chunk. Parked, and the queue asked again, so
        // "nothing came back" keeps meaning "nothing left to mine".
        park(job.id, `extract job ${String(job.id)} carries no readable payload`);
        continue;
      }

      try {
        return await workChunk(job.id, payload.data);
      } catch (error) {
        // Transient by default. The failure this arm exists for is the model
        // call, which happens before anything is written, so a job handed back
        // here leaves the graph exactly as it found it.
        handBack(job.id, job.attempts, reasonFor(error));
        return { jobId: job.id, documentId: payload.data.documentId, admitted: [], rejected: 0 };
      }
    }
  };

  return { drainOnce };
};
