/**
 * §5.10's expensive half, finally paid: *"Extraction is lazy: member claims are
 * extracted per chunk when the chunk is served and cited, when incoming evidence
 * targets it, or opportunistically on the calendar clock."*
 *
 * E2 parked one job per chunk and wrote nothing else. This file is the drain
 * that takes those jobs, runs the extractor over the chunk each one names, puts
 * every proposal through the verbatim gate (`verbatim-gate.test.ts`), and hands
 * the survivors to the *same* `openIngest.submit()` an agent's `observe` uses.
 * There is no second write path here and there must not be: §1's *"every source
 * of knowledge — human, agent, or emitter — writes claims through one ingest
 * port"* is not a claim about producers, it is a claim about doors.
 *
 * ── What the drain surface is, and why it is this small ─────────────────────
 *
 * `drainOnce()` answers with an outcome or with nothing, mirroring
 * `store.claimJob(kind)` exactly, because it is asking the queue the same
 * question and an empty queue is the same answer. That shape is what makes
 * §9's *"a drain of an empty queue"* expressible without a sentinel, an
 * exception or a spin, and it is why almost every assertion below reads the
 * *store* rather than the return value: a receipt that says a claim landed is
 * evidence about the receipt.
 *
 * ── Four rulings this file makes ────────────────────────────────────────────
 *
 * **The channel is `doc-extraction`.** §4.7's enum has an arm for this and an
 * arm for `transcript-mining` beside it. The submitter's own channel is *not*
 * inherited: the pathway signature records how this contribution arrived, and it
 * arrived from a model reading a paragraph, not from whoever posted the file.
 *
 * **No `STATED_IN` edge.** §3.3 gives the edge to claim → document and §3.6 says
 * members are *"linked by `STATED_IN` with span anchors"* — but the store
 * refuses the kind outright (`ReservedEdgeKindError`, asserted below as a
 * control), and lifting that refusal is a store cycle, not this one. Nor would
 * the edge type-check against a document: `putClaimEdge` addresses claims and
 * entities, and a document is neither. What carries the tie in the meantime is
 * the *episode*: §5.10 makes a document one episode, E2 derives that episode
 * from the document id, so `provenance.episodes` names the document a member was
 * mined from, recoverably, for every member. When `STATED_IN` lands it replaces
 * that inference with an edge; it does not have to invent the fact.
 *
 * **A materialized document is refused at the drain, not only at enqueue.**
 * E2's `extraction-gate.test.ts` rules that `submitText` parks nothing for one,
 * and says the second lock belongs here because `enqueueJob` is public. The job
 * is settled as `failed` rather than `done`: retrying can never change the
 * answer, since `origin` is a property of the document and not of the attempt,
 * and §12 files testimony laundering as an attack — so somebody parking work
 * that may not run should leave a readable trace rather than a silent success.
 *
 * **A thrown extractor is transient by default, but not forever.** §9 puts the
 * retry policy in the caller's hands precisely because neither automatic reading
 * is right, and a drain is the caller. So the job goes back to `pending` with its
 * attempt counted and a `retryAt` strictly in the future — the future part being
 * what stops the drain loop from immediately re-taking the job that just killed
 * it — until its attempts reach the §15 ⚙ budget, at which point it parks with a
 * `last_error` naming both the cap and the call that puts it back. The budget is
 * only affordable because `store.requeueJob` lands in the same cycle: a cap over
 * a terminal `failed` state, with no way out of it, would trade a retry storm for
 * permanent work loss.
 *
 * Real SQLite, `:memory:`, no mocks of the store.
 *
 * @spec §3.2, §3.3, §3.5, §3.6, §4.2, §4.4, §4.7, §5, §5.1, §5.2, §5.8, §5.10, §9, §12, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTRACT_JOB_KIND,
  openExtraction,
  type ExtractedClaim,
  type ExtractionPort,
} from '../index';

import {
  ReservedEdgeKindError,
  StoreBusyError,
  type ClaimRecord,
  type GraphStore,
} from '../../store/index';
import {
  COSINE_FLOOR,
  TAU_PROMOTE,
  agentOrigin,
  claimMessage,
} from '../../referents/__tests__/fixtures';

import {
  ABSENT_DOCUMENT_ID,
  ADMITTED_CLAIM,
  BLANK_QUOTE,
  CHUNK_ZERO_MARKER,
  EXTRACTOR_MODEL_ID,
  GATE_DOCUMENT_ID,
  LEDGER_DOCUMENT_ID,
  MEMBERS_PER_CHUNK,
  OVERHAUL_LEDGER,
  PHANTOM_CLAIM,
  PHANTOM_QUOTE,
  SECOND_ADMITTED_CLAIM,
  SECOND_HAND,
  SECOND_QUOTE,
  UNNAMED_CLAIM,
  UNNAMED_QUOTE,
  UNREADABLE_PAYLOADS,
  VALVE_SEAT,
  VERBATIM_QUOTE,
  admittedBy,
  claimTexts,
  controlHarness,
  drainExtraction,
  existenceAlpha,
  extractionHarnessFor,
  forChunkMarked,
  gateDocument,
  memberIds,
  memberTexts,
  membersPerChunk,
  proposal,
  referentFor,
  verbatimSliceOf,
  type ExtractionHarness,
} from './extraction-fixtures';

import {
  MATERIALIZED_DOCUMENT_ID,
  SHORT_PARAGRAPHS,
  SUBMITTING_ORIGIN,
  UNKNOWN_ANCHOR,
  notebook,
  refusalFrom,
  textSource,
} from './fixtures';

let harness: ExtractionHarness;

beforeEach(() => {
  harness = extractionHarnessFor(openExtraction);
});

afterEach(() => {
  harness?.close();
});

/** The gate corpus, ingested with no anchor, so the ledger starts empty of claims. */
const submitGateDocument = async () =>
  harness.text.submitText(textSource({ id: GATE_DOCUMENT_ID, text: gateDocument() }));

/** One member proposed from chunk zero, scripted before the document arrives. */
const scriptOneMember = (overrides: Parameters<typeof proposal>[0] = {}): void => {
  harness.extractor.answerWith(forChunkMarked(CHUNK_ZERO_MARKER, [proposal(overrides)]));
};

/** Mines a notebook of `paragraphs` paragraphs, three members per chunk, one noun throughout. */
const mineLedgerDocument = async (
  target: ExtractionHarness,
  paragraphs: number,
): Promise<string[]> => {
  target.extractor.answerWith(membersPerChunk(MEMBERS_PER_CHUNK));
  await target.text.submitText(
    textSource({ id: LEDGER_DOCUMENT_ID, text: notebook(paragraphs) }),
  );
  return admittedBy(await drainExtraction(target.extraction));
};

describe('a drain with nothing to drain', () => {
  it('answers with nothing, calls no model, and writes nothing', async () => {
    const outcome = await harness.extraction.drainOnce();

    expect({
      outcome,
      modelCalls: harness.extractor.requests.length,
      claims: claimTexts(harness.store),
    }).toStrictEqual({ outcome: undefined, modelCalls: 0, claims: [] });
  });

  it('leaves another clock’s jobs alone, because §9 hangs several off one table', async () => {
    const foreign = harness.store.enqueueJob({ kind: 'consolidate', payload: { note: 'not mine' } });

    const outcome = await harness.extraction.drainOnce();

    expect({
      outcome,
      foreignState: harness.store.getJob(foreign)?.state,
      modelCalls: harness.extractor.requests.length,
    }).toStrictEqual({ outcome: undefined, foreignState: 'pending', modelCalls: 0 });
  });

  it('answers with nothing again once the document’s jobs are all spent', async () => {
    await submitGateDocument();
    await drainExtraction(harness.extraction);

    expect(await harness.extraction.drainOnce()).toBeUndefined();
  });
});

describe('what the drain hands the extractor', () => {
  it('gives it each chunk’s span byte for byte, so the gate checks against the real text', async () => {
    await submitGateDocument();
    const chunks = harness.text.chunksOf(GATE_DOCUMENT_ID);

    await drainExtraction(harness.extraction);

    expect([...harness.extractor.requests].map((request) => request.chunkText).sort()).toStrictEqual(
      chunks.map((chunk) => chunk.text).sort(),
    );
  });

  it('visits every chunk exactly once and marks each job done', async () => {
    const receipt = await submitGateDocument();

    await drainExtraction(harness.extraction);

    expect({
      visits: harness.extractor.requests.length,
      states: receipt.enqueued.map((id) => harness.store.getJob(id)?.state),
    }).toStrictEqual({ visits: 2, states: ['done', 'done'] });
  });
});

describe('a member the gate admitted', () => {
  it('lands carrying the kind, tier and nouns the extractor proposed', async () => {
    await submitGateDocument();
    scriptOneMember({
      kind: 'rationale',
      tier: 'inferred',
      mentions: [VALVE_SEAT, SECOND_HAND],
    });

    const admitted = admittedBy(await drainExtraction(harness.extraction));
    const claim = harness.store.getClaim(admitted[0] ?? '');

    expect({
      count: admitted.length,
      text: claim?.text,
      kind: claim?.kind,
      tier: claim?.tier,
      about: harness.store
        .getClaimEdges(admitted[0] ?? '')
        .filter((edge) => edge.kind === 'ABOUT')
        .map((edge) => edge.to)
        .sort(),
    }).toStrictEqual({
      count: 1,
      text: ADMITTED_CLAIM,
      kind: 'rationale',
      tier: 'inferred',
      about: [referentFor(harness.store, VALVE_SEAT), referentFor(harness.store, SECOND_HAND)].sort(),
    });
  });

  it('re-resolves its own nouns — §5.10’s anchor is a prior, not an inheritance', async () => {
    const receipt = await harness.text.submitText(
      textSource({ id: GATE_DOCUMENT_ID, text: gateDocument(), anchor: UNKNOWN_ANCHOR }),
    );
    scriptOneMember({ mentions: [VALVE_SEAT] });

    const admitted = admittedBy(await drainExtraction(harness.extraction));
    const anchor = receipt.anchor?.referentId ?? '';
    const about = harness.store
      .getClaimEdges(admitted[0] ?? '')
      .filter((edge) => edge.kind === 'ABOUT')
      .map((edge) => edge.to);

    expect({
      about,
      anchorWasResolved: anchor.length > 0,
      anchorIsAmongThem: about.includes(anchor),
    }).toStrictEqual({
      about: [referentFor(harness.store, VALVE_SEAT)],
      anchorWasResolved: true,
      anchorIsAmongThem: false,
    });
  });

  it('goes through the one ingest door, which is what §5.8’s resolve stage records', async () => {
    const receipt = await submitGateDocument();
    scriptOneMember();

    await drainExtraction(harness.extraction);

    expect(
      harness.store
        .readStageLog(receipt.episodeId)
        .filter((entry) => entry.stage === 'resolve')
        .map((entry) => (entry.inputs as { channel?: unknown }).channel),
    ).toStrictEqual(['doc-extraction']);
  });

  it('signs §4.7’s pathway as doc-extraction, not as the channel the text was posted on', async () => {
    await submitGateDocument();
    scriptOneMember();

    const admitted = admittedBy(await drainExtraction(harness.extraction));

    expect({
      channel: harness.store.getClaim(admitted[0] ?? '')?.provenance.channel,
      submitted: SUBMITTING_ORIGIN.channel,
    }).toStrictEqual({ channel: 'doc-extraction', submitted: 'document-ingest' });
  });
});

describe('the tie between a member and the document it was mined from', () => {
  it('is the episode, and the episode alone — no STATED_IN edge is written', async () => {
    const receipt = await submitGateDocument();
    scriptOneMember({ mentions: [VALVE_SEAT] });

    const admitted = admittedBy(await drainExtraction(harness.extraction));

    expect({
      edges: harness.store.getClaimEdges(admitted[0] ?? '').map((edge) => edge.kind),
      episodes: harness.store.getClaim(admitted[0] ?? '')?.provenance.episodes,
    }).toStrictEqual({ edges: ['ABOUT'], episodes: [receipt.episodeId] });
  });

  it('could not be an edge yet: the store still refuses the reserved kind', async () => {
    await submitGateDocument();
    scriptOneMember();
    const admitted = admittedBy(await drainExtraction(harness.extraction));

    expect(() => {
      harness.store.putClaimEdge({
        from: admitted[0] ?? '',
        kind: 'STATED_IN',
        to: GATE_DOCUMENT_ID,
      });
    }).toThrow(ReservedEdgeKindError);
  });
});

describe('a document is one episode (§5.10)', () => {
  it('attributes every member to the document’s episode, never one per chunk', async () => {
    const receipt = await harness.text.submitText(
      textSource({ id: LEDGER_DOCUMENT_ID, text: notebook(4) }),
    );
    harness.extractor.answerWith(membersPerChunk(MEMBERS_PER_CHUNK));

    const admitted = admittedBy(await drainExtraction(harness.extraction));
    const episodes = admitted.map((id) =>
      (harness.store.getClaim(id)?.provenance.episodes ?? []).join(','),
    );

    expect({ members: admitted.length, episodes: [...new Set(episodes)] }).toStrictEqual({
      members: 4 * MEMBERS_PER_CHUNK,
      episodes: [receipt.episodeId],
    });
  });

  it('does not let twelve assertions from one document corroborate like twelve sources', async () => {
    const admitted = await mineLedgerDocument(harness, 4);
    const texts = admitted.map((id) => harness.store.getClaim(id)?.text ?? '');
    const control = controlHarness();
    try {
      for (const [at, text] of texts.entries())
        await control.ingest.submit(
          claimMessage(text, [OVERHAUL_LEDGER], { origin: agentOrigin(at + 1) }),
        );
      const fromOneDocument = existenceAlpha(harness.store, harness.ingest, OVERHAUL_LEDGER);
      const fromTwelveEpisodes = existenceAlpha(control.store, control.ingest, OVERHAUL_LEDGER);

      // §4.2's cap halves each repeat contribution from one episode, so a whole
      // document's testimony sums to less than one further observation's worth,
      // while twelve episodes pay one apiece.
      expect({
        members: texts.length,
        cappedBelowIndependent: fromOneDocument < fromTwelveEpisodes,
        gap: fromTwelveEpisodes - fromOneDocument > 8,
      }).toStrictEqual({ members: 12, cappedBelowIndependent: true, gap: true });
    } finally {
      control.close();
    }
  });

  it('buys almost nothing by doubling how much the document says', async () => {
    const twice = extractionHarnessFor(openExtraction);
    try {
      await mineLedgerDocument(harness, 4);
      await mineLedgerDocument(twice, 8);
      const twelve = existenceAlpha(harness.store, harness.ingest, OVERHAUL_LEDGER);
      const twentyFour = existenceAlpha(twice.store, twice.ingest, OVERHAUL_LEDGER);

      expect(twentyFour - twelve).toBeLessThan(0.01);
    } finally {
      twice.close();
    }
  });
});

describe('draining one chunk twice', () => {
  it('moves no posterior, no mention weight and no facet the second time', async () => {
    const receipt = await submitGateDocument();
    scriptOneMember({ mentions: [VALVE_SEAT] });
    await drainExtraction(harness.extraction);

    const referentId = referentFor(harness.store, VALVE_SEAT) ?? '';
    const before = {
      alpha: existenceAlpha(harness.store, harness.ingest, VALVE_SEAT),
      mentions: harness.store.getMentionTally(referentId),
      facets: harness.store.getFacetCounts(referentId),
    };
    // §9's queue "does not deduplicate: a second identical submission is a
    // second job", so this is the honest way to ask the question — the same
    // chunk, parked again, exactly as a re-park or a double sweep would.
    const chunk = harness.text.chunksOf(GATE_DOCUMENT_ID)[0]!;
    harness.store.enqueueJob({
      kind: EXTRACT_JOB_KIND,
      payload: {
        documentId: GATE_DOCUMENT_ID,
        ordinal: chunk.ordinal,
        hash: chunk.hash,
        episodeId: receipt.episodeId,
      },
    });

    await drainExtraction(harness.extraction);

    expect({
      alpha: existenceAlpha(harness.store, harness.ingest, VALVE_SEAT),
      mentions: harness.store.getMentionTally(referentId),
      facets: harness.store.getFacetCounts(referentId),
    }).toStrictEqual(before);
  });

  it('logs no rejection for the replay, because a duplicate is not a phantom', async () => {
    const receipt = await submitGateDocument();
    scriptOneMember();
    await drainExtraction(harness.extraction);
    const chunk = harness.text.chunksOf(GATE_DOCUMENT_ID)[0]!;
    harness.store.enqueueJob({
      kind: EXTRACT_JOB_KIND,
      payload: {
        documentId: GATE_DOCUMENT_ID,
        ordinal: chunk.ordinal,
        hash: chunk.hash,
        episodeId: receipt.episodeId,
      },
    });

    await drainExtraction(harness.extraction);

    expect(harness.store.readExtractionRejections(GATE_DOCUMENT_ID)).toStrictEqual([]);
  });
});

describe('an extractor that dies mid-chunk', () => {
  const failure = new Error('the extractor timed out reaching the model');

  it('does not propagate, and hands the job back to the queue with the attempt counted', async () => {
    const receipt = await submitGateDocument();
    harness.extractor.failWith(failure);

    const refusal = await refusalFrom(() => harness.extraction.drainOnce());
    const attempted = receipt.enqueued
      .map((id) => harness.store.getJob(id))
      .filter((job) => job !== undefined && job.attempts > 0);

    expect({
      refusal,
      attempted: attempted.length,
      attempts: attempted[0]?.attempts,
      state: attempted[0]?.state,
      saysWhy: attempted[0]?.lastError?.includes('the extractor timed out') === true,
      retryIsInTheFuture:
        attempted[0]?.scheduledAt !== null &&
        attempted[0] !== undefined &&
        Date.parse(attempted[0].scheduledAt ?? '') > Date.now(),
    }).toStrictEqual({
      refusal: undefined,
      attempted: 1,
      attempts: 1,
      state: 'pending',
      saysWhy: true,
      retryIsInTheFuture: true,
    });
  });

  it('leaves the graph exactly as it found it — no claim, no referent, no rejection', async () => {
    await submitGateDocument();
    harness.extractor.failWith(failure);

    await drainExtraction(harness.extraction);

    expect({
      claims: claimTexts(harness.store),
      referents: harness.ingest.referents.all(),
      rejections: harness.store.readExtractionRejections(GATE_DOCUMENT_ID),
    }).toStrictEqual({ claims: [], referents: [], rejections: [] });
  });
});

/**
 * The ceiling on *"a thrown extractor is transient"*.
 *
 * The ruling above stands and this section does not weaken it: a throw is still
 * transient, and a job still goes back to the queue with its attempt counted and
 * a `retryAt` in the future. What is added is the other half of the policy §9
 * hands the caller — *"the store supplies the mechanism and the caller supplies
 * the policy"* — because a backoff with no ceiling is only half of one.
 *
 * The cost of the missing half is not the model call, which fails fast. It is
 * that `chunksOf` re-derives the document's *whole* chunking before `extract` is
 * ever reached, so a forty-chunk document whose extractor is down pays forty
 * full re-chunks a minute, indefinitely, while `attempts` climbs with nothing
 * reading it. That is the column migration 0 wrote the `typeof(attempts) =
 * 'integer'` guard for, in its own words *"a retry budget written as `attempts <
 * 5`"*, and until now nothing in this codebase has ever compared it to anything.
 *
 * ── Why the cap is only affordable now ──────────────────────────────────────
 *
 * `park` is terminal: `claimJob` selects `state = 'pending'` and nothing else.
 * A cap arriving on its own would therefore convert a five-minute outage at
 * somebody else's API into permanent, silent work loss — strictly worse than the
 * retry storm it replaces. E7a lands `store.requeueJob` in the same cycle for
 * exactly that reason, and the parked job's `last_error` is required to *say so*:
 * an operator reading a parked job must be told both that a cap stopped it and
 * which call puts it back. A cap whose recovery path is undiscoverable is a cap
 * nobody will trust.
 *
 * ── Two things these tests are careful about ────────────────────────────────
 *
 * **The off-by-one is real.** `job.attempts` as the drain reads it off
 * `claimJob` is the count *before* the current failure is recorded — `failJob`
 * does the `attempts + 1` — so a cap written as `job.attempts > MAX_ATTEMPTS`
 * spends one attempt too many and one written against the wrong side of the
 * boundary spends one too few. Both boundaries are pinned from below and from
 * above, and the whole cycle is counted end to end besides.
 *
 * **Only one job is ever claimable.** Every case here enqueues its job by hand
 * against a document whose own jobs are already `done`, so no assertion depends
 * on which of several rows `claimJob` picks. This suite has no business pinning
 * queue order, and a case that needed `ORDER BY scheduled_at, id` to break a tie
 * would be pinning it by accident.
 *
 * @spec §9, §12, §15
 */
describe('an extractor that is down rather than flaky', () => {
  const failure = new Error('the extractor timed out reaching the model');

  /**
   * §15's ⚙ retry budget: how many attempts one extract job gets before the
   * drain stops handing it back.
   *
   * Restated here rather than imported, the way `COSINE_FLOOR`, `TAU_PROMOTE`
   * and `FACET_ASSIGN_FLOOR` already are — a test that imported the constant
   * would be asserting where it lives, which is not a claim this file makes,
   * and it would also pass automatically whatever value the module happened to
   * hold, which is the one thing a boundary test must not do.
   *
   * Five, and not a larger number, because the recovery path is no longer
   * hypothetical: `requeueJob` gives an operator an unbounded number of fresh
   * runs at the cost of one deliberate call, so the budget only has to cover
   * failures nobody is watching. Five attempts at `RETRY_AFTER_MS` bounds the
   * re-chunk storm at five minutes, and migration 0's own illustration of a
   * retry budget on this column is `attempts < 5`.
   *
   * @spec §9, §15
   */
  const MAX_ATTEMPTS = 5;

  /** An instant already past, so a job failed back to `pending` is due at once. @spec §9 */
  const DUE_LONG_AGO = '2020-01-01T00:00:00.000Z';

  /**
   * One extract job for chunk zero of a document that has already been mined,
   * and nothing else in the queue for the drain to choose between.
   *
   * Hand-enqueued exactly as `draining one chunk twice` does it — §9 *"does not
   * deduplicate: a second identical submission is a second job"* — because the
   * document's own two jobs have to be spent first for this to be the only
   * claimable row.
   *
   * @spec §9
   */
  const soleJobForChunkZero = async (): Promise<number> => {
    const receipt = await submitGateDocument();
    await drainExtraction(harness.extraction);
    harness.extractor.forget();
    const chunk = harness.text.chunksOf(GATE_DOCUMENT_ID)[0]!;
    return harness.store.enqueueJob({
      kind: EXTRACT_JOB_KIND,
      payload: {
        documentId: GATE_DOCUMENT_ID,
        ordinal: chunk.ordinal,
        hash: chunk.hash,
        episodeId: receipt.episodeId,
      },
    });
  };

  /**
   * Counts `count` dead attempts onto a job and leaves it due, exactly as the
   * drain's own hand-back does minus the wait.
   *
   * Through the public `failJob`, which is the only thing that moves `attempts`
   * at all, so the arranged job is indistinguishable from one a drain arrived at
   * the slow way.
   *
   * @spec §9
   */
  const spendAttempts = (jobId: number, count: number): void => {
    for (let spent = 0; spent < count; spent += 1)
      harness.store.failJob({
        id: jobId,
        error: 'an earlier attempt died the same way',
        retryAt: DUE_LONG_AGO,
      });
  };

  it('hands the job back while it is still one attempt short of the cap', async () => {
    const jobId = await soleJobForChunkZero();
    spendAttempts(jobId, MAX_ATTEMPTS - 2);
    harness.extractor.failWith(failure);

    await harness.extraction.drainOnce();
    const job = harness.store.getJob(jobId);

    expect({
      state: job?.state,
      attempts: job?.attempts,
      dueInTheFuture: Date.parse(job?.scheduledAt ?? '') > Date.now(),
      claimableRightNow: harness.store.claimJob(EXTRACT_JOB_KIND) !== undefined,
    }).toStrictEqual({
      state: 'pending',
      attempts: MAX_ATTEMPTS - 1,
      dueInTheFuture: true,
      claimableRightNow: false,
    });
  });

  it('parks the job on the attempt that reaches the cap, not on the one after it', async () => {
    const jobId = await soleJobForChunkZero();
    spendAttempts(jobId, MAX_ATTEMPTS - 1);
    harness.extractor.failWith(failure);

    await harness.extraction.drainOnce();
    const job = harness.store.getJob(jobId);

    expect({
      state: job?.state,
      attempts: job?.attempts,
      claimableAgain: harness.store.claimJob(EXTRACT_JOB_KIND) !== undefined,
    }).toStrictEqual({ state: 'failed', attempts: MAX_ATTEMPTS, claimableAgain: false });
  });

  it('tells an operator what stopped it, what killed it, and how to get it back', async () => {
    const jobId = await soleJobForChunkZero();
    spendAttempts(jobId, MAX_ATTEMPTS - 1);
    harness.extractor.failWith(failure);

    await harness.extraction.drainOnce();
    const why = harness.store.getJob(jobId)?.lastError ?? '';

    expect({
      namesTheCap: why.includes(String(MAX_ATTEMPTS)),
      namesTheWayBack: why.includes('requeueJob'),
      keepsTheDiagnosis: why.includes('the extractor timed out reaching the model'),
    }).toStrictEqual({ namesTheCap: true, namesTheWayBack: true, keepsTheDiagnosis: true });
  });

  it('leaves the graph exactly as it found it when it gives up, as it does when it retries', async () => {
    const jobId = await soleJobForChunkZero();
    spendAttempts(jobId, MAX_ATTEMPTS - 1);
    harness.extractor.failWith(failure);

    await harness.extraction.drainOnce();

    expect({
      state: harness.store.getJob(jobId)?.state,
      claims: claimTexts(harness.store),
      referents: harness.ingest.referents.all(),
      rejections: harness.store.readExtractionRejections(GATE_DOCUMENT_ID),
    }).toStrictEqual({ state: 'failed', claims: [], referents: [], rejections: [] });
  });

  it('spends the budget exactly once, however many attempts an operator hands it', async () => {
    const jobId = await soleJobForChunkZero();
    harness.extractor.failWith(failure);

    // `requeueJob` rather than a wait: every hand-back writes a `retryAt` a
    // minute out, and this is the call E7a adds for exactly this — clear the
    // not-before, keep the count. A budget a requeue silently refilled would be
    // no budget at all, so the count this loop reaches is the assertion.
    let attemptsDriven = 0;
    for (let pass = 0; pass < MAX_ATTEMPTS + 2; pass += 1) {
      if (harness.store.getJob(jobId)?.state === 'failed') break;
      harness.store.requeueJob(jobId);
      await harness.extraction.drainOnce();
      attemptsDriven += 1;
    }
    const job = harness.store.getJob(jobId);

    expect({
      attemptsDriven,
      attempts: job?.attempts,
      state: job?.state,
      modelCalls: harness.extractor.requests.length,
    }).toStrictEqual({
      attemptsDriven: MAX_ATTEMPTS,
      attempts: MAX_ATTEMPTS,
      state: 'failed',
      modelCalls: MAX_ATTEMPTS,
    });
  });

  it('works a requeued job to completion once the extractor answers again', async () => {
    const jobId = await soleJobForChunkZero();
    spendAttempts(jobId, MAX_ATTEMPTS - 1);
    harness.extractor.failWith(failure);
    await harness.extraction.drainOnce();

    harness.store.requeueJob(jobId);
    harness.extractor.answerWith(() => []);
    const outcome = await harness.extraction.drainOnce();
    const job = harness.store.getJob(jobId);

    expect({
      worked: outcome?.jobId,
      state: job?.state,
      attempts: job?.attempts,
    }).toStrictEqual({ worked: jobId, state: 'done', attempts: MAX_ATTEMPTS });
  });

  /*
   * The consequence of preserving `attempts` across a requeue, stated where it
   * can be read rather than left to be discovered: a job whose budget is already
   * spent gets exactly one attempt per requeue, and parks again the moment that
   * one dies. That is the intended shape and not a rough edge — the requeue is a
   * human deciding the outage is over, so if it is not over the drain should
   * stop again immediately rather than restart the storm the cap exists to end.
   * A requeue that reset the counter would hand a poison job an unbounded budget
   * for the price of one call.
   */
  it('parks a requeued job again on its very next failure, because the budget stays spent', async () => {
    const jobId = await soleJobForChunkZero();
    spendAttempts(jobId, MAX_ATTEMPTS - 1);
    harness.extractor.failWith(failure);
    await harness.extraction.drainOnce();

    harness.store.requeueJob(jobId);
    await harness.extraction.drainOnce();
    const job = harness.store.getJob(jobId);

    expect({
      state: job?.state,
      attempts: job?.attempts,
      claimableAgain: harness.store.claimJob(EXTRACT_JOB_KIND) !== undefined,
    }).toStrictEqual({ state: 'failed', attempts: MAX_ATTEMPTS + 1, claimableAgain: false });
  });
});

describe('a materialized document somebody parked anyway', () => {
  /** Parks an extract job by hand, as any caller of the public `enqueueJob` could. @spec §9 */
  const parkMaterializedChunk = async (): Promise<number> => {
    const receipt = await harness.text.submitText(
      textSource({
        id: MATERIALIZED_DOCUMENT_ID,
        origin: 'materialized',
        text: notebook(SHORT_PARAGRAPHS),
      }),
    );
    const chunk = harness.text.chunksOf(MATERIALIZED_DOCUMENT_ID)[0]!;
    harness.extractor.answerWith(() => [
      proposal({ quote: verbatimSliceOf(chunk.text), mentions: [OVERHAUL_LEDGER] }),
    ]);
    return harness.store.enqueueJob({
      kind: EXTRACT_JOB_KIND,
      payload: {
        documentId: MATERIALIZED_DOCUMENT_ID,
        ordinal: chunk.ordinal,
        hash: chunk.hash,
        episodeId: receipt.episodeId,
      },
    });
  };

  it('never reaches the model, and launders no canonical back in as testimony', async () => {
    await parkMaterializedChunk();

    await drainExtraction(harness.extraction);

    expect({
      modelCalls: harness.extractor.requests.length,
      claims: claimTexts(harness.store),
      referents: harness.ingest.referents.all(),
      rejections: harness.store.readExtractionRejections(MATERIALIZED_DOCUMENT_ID),
    }).toStrictEqual({ modelCalls: 0, claims: [], referents: [], rejections: [] });
  });

  it('settles the job as failed rather than done, so the attempt stays readable', async () => {
    const jobId = await parkMaterializedChunk();

    await drainExtraction(harness.extraction);
    const job = harness.store.getJob(jobId);

    expect({ state: job?.state, saysWhy: (job?.lastError ?? '').length > 0 }).toStrictEqual({
      state: 'failed',
      saysWhy: true,
    });
  });

  it('does not hand it back to the queue, because retrying cannot change the answer', async () => {
    await parkMaterializedChunk();

    await drainExtraction(harness.extraction);

    expect(harness.store.claimJob(EXTRACT_JOB_KIND)).toBeUndefined();
  });

  it('leaves an authored document beside it mined as normal', async () => {
    await parkMaterializedChunk();
    const receipt = await submitGateDocument();
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [proposal({ quote: VERBATIM_QUOTE })]),
    );

    const admitted = admittedBy(await drainExtraction(harness.extraction));

    expect({
      members: memberTexts(harness.store),
      episodes: harness.store.getClaim(admitted[0] ?? '')?.provenance.episodes,
    }).toStrictEqual({ members: [ADMITTED_CLAIM], episodes: [receipt.episodeId] });
  });
});

/**
 * The arm with no test timeout behind it.
 *
 * `drainOnce` loops rather than returning when a job cannot be worked, so that
 * `undefined` keeps meaning *"nothing left to mine"* rather than *"the first
 * thing I found was junk"*. That loop is only safe while every unworkable job is
 * **parked** — `failJob` with no `retryAt`, which settles it `failed` and takes
 * it out of `claimJob`'s `state = 'pending'` filter for good. Hand one back
 * instead, or park it somewhere the loop does not reach, and the next pass
 * claims the same row again with no `await` between the two, so the drain spins
 * inside one synchronous turn: the event loop never runs, `testTimeout` never
 * fires, and the worker has to be killed from outside. This suite's sibling in
 * `src/referents` has already paid for that once, in `drainScan`.
 *
 * So these assertions are about termination first and the store second. Every
 * one of them would hang rather than fail.
 *
 * @spec §9, §12
 */
describe('a job the drain cannot work', () => {
  /** Parks a job by hand with whatever payload, as any caller of public `enqueueJob` may. @spec §9 */
  const enqueueRaw = (payload: unknown): number =>
    harness.store.enqueueJob({ kind: EXTRACT_JOB_KIND, payload });

  /** What settles a job for good: `failed`, with a reason, and no longer claimable. @spec §9 */
  const settlementOf = (jobId: number) => ({
    state: harness.store.getJob(jobId)?.state,
    saysWhy: (harness.store.getJob(jobId)?.lastError ?? '').length > 0,
    claimableAgain: harness.store.claimJob(EXTRACT_JOB_KIND) !== undefined,
  });

  it.each(UNREADABLE_PAYLOADS.map((payload, at) => [at, payload] as const))(
    'parks unreadable payload %i and answers nothing, rather than taking it again',
    async (_at, payload) => {
      const jobId = enqueueRaw(payload);

      const outcome = await harness.extraction.drainOnce();

      expect({
        outcome,
        modelCalls: harness.extractor.requests.length,
        ...settlementOf(jobId),
      }).toStrictEqual({
        outcome: undefined,
        modelCalls: 0,
        state: 'failed',
        saysWhy: true,
        claimableAgain: false,
      });
    },
  );

  it('parks a whole queue of them in one drain, and empties', async () => {
    const jobs = UNREADABLE_PAYLOADS.map((payload) => enqueueRaw(payload));

    const outcomes = await drainExtraction(harness.extraction);

    expect({
      outcomes,
      states: jobs.map((id) => harness.store.getJob(id)?.state),
      modelCalls: harness.extractor.requests.length,
    }).toStrictEqual({
      outcomes: [],
      states: jobs.map(() => 'failed'),
      modelCalls: 0,
    });
  });

  it('keeps mining past one, so “nothing came back” never means “I gave up early”', async () => {
    // Enqueued before the document, so it is the lower id and `claimJob`'s
    // `ORDER BY scheduled_at, id` hands it over first. A drain that answered
    // `undefined` on an unreadable payload would strand every real job behind it.
    const junk = enqueueRaw(UNREADABLE_PAYLOADS[0]);
    await submitGateDocument();
    harness.extractor.answerWith(
      forChunkMarked(CHUNK_ZERO_MARKER, [proposal({ quote: VERBATIM_QUOTE })]),
    );

    const first = await harness.extraction.drainOnce();

    expect({
      answeredWithWork: first !== undefined,
      admitted: (first?.admitted ?? []).length,
      members: memberTexts(harness.store),
      junkState: harness.store.getJob(junk)?.state,
    }).toStrictEqual({
      answeredWithWork: true,
      admitted: 1,
      members: [ADMITTED_CLAIM],
      junkState: 'failed',
    });
  });

  it('parks a readable payload naming a document nothing ever wrote', async () => {
    const jobId = enqueueRaw({
      documentId: ABSENT_DOCUMENT_ID,
      ordinal: 0,
      hash: 'a hash no chunk row holds',
      episodeId: `document:${ABSENT_DOCUMENT_ID}`,
    });

    const outcome = await harness.extraction.drainOnce();

    expect({
      documentId: outcome?.documentId,
      admitted: outcome?.admitted,
      rejected: outcome?.rejected,
      modelCalls: harness.extractor.requests.length,
      ...settlementOf(jobId),
    }).toStrictEqual({
      documentId: ABSENT_DOCUMENT_ID,
      admitted: [],
      rejected: 0,
      modelCalls: 0,
      state: 'failed',
      saysWhy: true,
      claimableAgain: false,
    });
  });

  it('parks a payload naming an ordinal the document has no chunk at', async () => {
    const receipt = await submitGateDocument();
    await drainExtraction(harness.extraction);
    harness.extractor.forget();
    const jobId = enqueueRaw({
      documentId: GATE_DOCUMENT_ID,
      ordinal: receipt.chunks.length + 7,
      hash: receipt.chunks[0]?.hash ?? '',
      episodeId: receipt.episodeId,
    });

    await drainExtraction(harness.extraction);

    expect({ modelCalls: harness.extractor.requests.length, ...settlementOf(jobId) }).toStrictEqual({
      modelCalls: 0,
      state: 'failed',
      saysWhy: true,
      claimableAgain: false,
    });
  });

  it('writes nothing to the graph or the rejection log for any of them', async () => {
    for (const payload of UNREADABLE_PAYLOADS) enqueueRaw(payload);
    enqueueRaw({
      documentId: ABSENT_DOCUMENT_ID,
      ordinal: 0,
      hash: 'a hash no chunk row holds',
      episodeId: `document:${ABSENT_DOCUMENT_ID}`,
    });

    await drainExtraction(harness.extraction);

    expect({
      claims: claimTexts(harness.store),
      referents: harness.ingest.referents.all(),
      rejections: harness.store.readExtractionRejections(ABSENT_DOCUMENT_ID),
    }).toStrictEqual({ claims: [], referents: [], rejections: [] });
  });
});

/**
 * The three defects E7d's first live run put in one loop, and the receipt that
 * lied about all three.
 *
 * 23 chunks, 37 paid calls, one model. `ClaimMessage.mentions` is `.min(1)`
 * because §5.2 *"forces every claim to name its referents explicitly"*, and the
 * prompt the adapter shipped told the model the opposite — *"if a claim
 * genuinely names no specific entity, give an empty list"*. 37% of the unique
 * claims came back naming nobody, so `ingest.submit` threw on **17 of 37
 * calls**: 14 paid calls wasted outright and four chunks left at `attempts=3`
 * and `attempts=4`, one failure short of parking for good.
 *
 * The prompt is the adapter's to fix and is pinned there. What is pinned here is
 * what the *drain* does when a proposal arrives that the door will not take,
 * because `workChunk` gates and submits in one loop and a throw out of that loop
 * costs three separate things:
 *
 * **1. The refusal goes unrecorded.** A proposal the door refuses is a refused
 * proposal, and §5.10 sends those to the rejection log — *"failures go to the
 * extraction-rejection log — never the graph"*. A throw sends it nowhere. The
 * live database holds **zero** `extraction_rejections` rows, and it is not a
 * clean run: call 10 carried a genuinely non-verbatim quote at proposal #5 that
 * the gate never reached, because proposal #0 threw first. §13's audit is the
 * instrument that answers *"how often did this model fail this way"*, and a
 * refusal invisible to it is the defect — the run's one real rejection had to be
 * recovered by hand out of the raw transcript.
 *
 * **2. The siblings pay for it.** Everything after the offending proposal is
 * neither gated nor submitted. This is deliberately the *opposite* ruling from
 * the adapter's *"a batch with one spoiled claim throws whole"*, and both are
 * right where they stand: a batch the adapter cannot parse is a model whose
 * whole answer is untrustworthy, while here the adapter has already handed over
 * well-formed claims and one of them being unacceptable says nothing whatever
 * about the rest. The gate already reads it that way — *"a model that gets one
 * span right and two wrong has said one true thing"* — and the door has to read
 * it the same way or the gate's ruling only holds until a proposal throws.
 *
 * **3. The claims already written stay written, and the retry writes them
 * again.** The throw is caught as transient and the job goes back to `pending`
 * with the whole chunk still to do, so the members admitted before it are
 * committed and then re-admitted on the next attempt. The live ledger holds
 * **8 duplicate member rows over 6 distinct texts, one of them written three
 * times**, each copy carrying a full §4.1 prior of its own. Stage 0 did fire —
 * §5.1 keys on `(episode, text)`, a document is one episode, so the replays were
 * flagged and moved no existence-claim posterior and no facet centroid. It was
 * never going to stop the rows: §4.3 has a replay *"still land in the ledger as
 * [a raw]"*, deliberately. So the duplication is the drain's to prevent and not
 * stage 0's, which is why the assertion below reads both the ledger and the
 * posterior — a fix that deduplicated rows while letting α move twice would pass
 * a row count and fail the thing row counts are a proxy for.
 *
 * **And the receipt said none of it.** `DrainOutcome.admitted` is built in the
 * loop and thrown away with it: the catch arm answers `admitted: []` for a chunk
 * that has already written members. E7d's drain reported *"64 members
 * admitted"* over a store holding 100. A receipt is *"the caller's own
 * accounting"* and this one cannot be used for accounting at all, so `admitted`
 * is checked against the ledger here rather than against itself.
 *
 * @spec §1, §3.5, §4.1, §4.3, §5.1, §5.2, §5.10, §9, §12, §13
 */
describe('a proposal the one ingest door will not take', () => {
  /** The first of two siblings the gate and the door both admit. */
  const ADMITTED_FIRST = proposal({
    text: ADMITTED_CLAIM,
    quote: VERBATIM_QUOTE,
    mentions: [VALVE_SEAT],
  });

  /** The second, citing a different span so one verdict cannot stand in for two. */
  const ADMITTED_LAST = proposal({
    text: SECOND_ADMITTED_CLAIM,
    quote: SECOND_QUOTE,
    mentions: [VALVE_SEAT],
  });

  /** The one the door refuses: verbatim, well typed, and naming nobody. */
  const NAMES_NOTHING = proposal({
    text: UNNAMED_CLAIM,
    quote: UNNAMED_QUOTE,
    mentions: [],
  });

  /** The live run's shape: one refusal with admitted work on both sides of it. */
  const BATCH_AROUND_IT: readonly ExtractedClaim[] = [ADMITTED_FIRST, NAMES_NOTHING, ADMITTED_LAST];

  /** Scripts one batch for chunk zero, and nothing for chunk one. */
  const scriptBatch = (claims: readonly ExtractedClaim[]): void => {
    harness.extractor.answerWith(forChunkMarked(CHUNK_ZERO_MARKER, claims));
  };

  /** The chunk under extraction, as the drain reads it back. */
  const chunkZero = () => harness.text.chunksOf(GATE_DOCUMENT_ID)[0]!;

  /** What §13 would audit for this document. @spec §5.10, §13 */
  const rejections = () => harness.store.readExtractionRejections(GATE_DOCUMENT_ID);

  /** Just the diagnoses, widened to plain strings so a new arm needs no cast. */
  const reasonsLogged = (): string[] => rejections().map((entry) => entry.reason);

  /**
   * One logged refusal, as an auditor reads it.
   *
   * Declared rather than spread, so `reason` widens to `string`: the arm this
   * section needs is not in {@link ExtractionRejectionReason} yet, and a test
   * that cannot compile until the schema changes is a compile error rather than
   * a red test.
   */
  interface LoggedRefusal {
    readonly chunkOrdinal: number | null;
    readonly chunkHash: string | null;
    readonly claimText: string;
    readonly quote: string | null;
    readonly reason: string;
    readonly modelId: string | null;
  }

  const refusalsLogged = (): LoggedRefusal[] =>
    rejections().map((entry) => ({
      chunkOrdinal: entry.chunkOrdinal,
      chunkHash: entry.chunkHash,
      claimText: entry.claimText,
      quote: entry.quote,
      reason: entry.reason,
      modelId: entry.modelId,
    }));

  /**
   * Un-parks every job an operator could un-park, and nothing else.
   *
   * `requeueJob` refuses `done` and `running` by class, so the guard is what
   * makes this the same call a human clearing a stuck queue would make — and
   * what makes the re-drain below a no-op exactly when the drain left nothing
   * stuck.
   *
   * @spec §9
   */
  const unparkWhatIsStuck = (jobIds: readonly number[]): void => {
    for (const id of jobIds) {
      const state = harness.store.getJob(id)?.state;
      if (state === 'pending' || state === 'failed') harness.store.requeueJob(id);
    }
  };

  /**
   * The α the two admitted siblings buy when nothing in the batch goes wrong.
   *
   * The control for *"and the posteriors"*: duplicate testimony is only harmful
   * because it is testimony, so the question is not whether the ledger grew but
   * whether the graph believes the noun any harder than the same two claims,
   * arriving once, entitle it to.
   *
   * @spec §4.2, §4.4
   */
  const alphaFromACleanBatch = async (): Promise<number> => {
    const clean = extractionHarnessFor(openExtraction);
    try {
      clean.extractor.answerWith(
        forChunkMarked(CHUNK_ZERO_MARKER, [ADMITTED_FIRST, ADMITTED_LAST]),
      );
      await clean.text.submitText(textSource({ id: GATE_DOCUMENT_ID, text: gateDocument() }));
      await drainExtraction(clean.extraction);
      return existenceAlpha(clean.store, clean.ingest, VALVE_SEAT);
    } finally {
      clean.close();
    }
  };

  /**
   * The corpus relation every assertion below rests on, checked first.
   *
   * All three spans are verbatim in chunk zero, so nothing here can be mistaken
   * for the verbatim gate doing its ordinary job: the only thing wrong with
   * {@link NAMES_NOTHING} is that it names nobody.
   *
   * @spec §5.10
   */
  it('cites three spans chunk zero really holds, so the gate is not what refuses any of them', async () => {
    await submitGateDocument();
    const { text } = chunkZero();

    expect([VERBATIM_QUOTE, SECOND_QUOTE, UNNAMED_QUOTE].map((quote) => text.includes(quote))).toStrictEqual(
      [true, true, true],
    );
  });

  /*
   * A blank surface form beside the empty list, because `ClaimMessage.mentions`
   * is `z.array(z.string().min(1)).min(1)` and refuses both. The door's question
   * is "would you take this message", not "is this array empty", and a drain
   * that asks the shorter question passes the first case and throws on the
   * second — in the loop, mid-chunk, exactly as before.
   */
  it.each([
    ['names no referent at all', []],
    ['names one blank form and nothing else', ['']],
  ] as ReadonlyArray<readonly [string, readonly string[]]>)(
    'is recorded rather than thrown when it %s',
    async (_why, mentions) => {
      const receipt = await submitGateDocument();
      scriptBatch([proposal({ text: UNNAMED_CLAIM, quote: UNNAMED_QUOTE, mentions })]);

      await drainExtraction(harness.extraction);

      expect({
        reasons: reasonsLogged(),
        members: memberTexts(harness.store),
        referents: harness.ingest.referents.all().length,
        states: receipt.enqueued.map((id) => harness.store.getJob(id)?.state),
      }).toStrictEqual({
        reasons: ['mentionsAbsent'],
        members: [],
        referents: 0,
        states: ['done', 'done'],
      });
    },
  );

  /*
   * Anchored, unlike `quoteAbsent`. `ExtractionRejection.chunkOrdinal` is
   * nullable for one stated reason — "a `quoteAbsent` rejection has no span to
   * anchor" — and this refusal has one: the model quoted the paragraph
   * correctly and simply named nobody, so an auditor asking which paragraph the
   * model keeps failing on has an answer and must be given it.
   */
  it('anchors that refusal to the chunk that cited it, span and all', async () => {
    await submitGateDocument();
    scriptBatch([NAMES_NOTHING]);

    await drainExtraction(harness.extraction);

    expect(refusalsLogged()).toStrictEqual([
      {
        chunkOrdinal: 0,
        chunkHash: chunkZero().hash,
        claimText: UNNAMED_CLAIM,
        quote: UNNAMED_QUOTE,
        reason: 'mentionsAbsent',
        modelId: EXTRACTOR_MODEL_ID,
      },
    ]);
  });

  it('costs its siblings nothing — each is gated and submitted on its own account', async () => {
    await submitGateDocument();
    scriptBatch(BATCH_AROUND_IT);

    const outcomes = await drainExtraction(harness.extraction);

    expect({
      members: [...memberTexts(harness.store)].sort(),
      admitted: admittedBy(outcomes).length,
      reasons: reasonsLogged(),
    }).toStrictEqual({
      members: [ADMITTED_CLAIM, SECOND_ADMITTED_CLAIM].sort(),
      admitted: 2,
      reasons: ['mentionsAbsent'],
    });
  });

  /*
   * Call 10, reconstructed: the refusal the door raises is at proposal #0 and
   * the non-verbatim quote is behind it. Sorted rather than read in proposal
   * order — `readExtractionRejections` orders by `id` in SQL and the store suite
   * is where that ordering is pinned; what this file is entitled to say is that
   * both rows exist, where today neither does.
   */
  it('reaches the refusals behind it, which is why E7d’s rejection log was empty', async () => {
    await submitGateDocument();
    scriptBatch([NAMES_NOTHING, proposal({ text: PHANTOM_CLAIM, quote: PHANTOM_QUOTE })]);

    await drainExtraction(harness.extraction);

    expect({
      reasons: [...reasonsLogged()].sort(),
      members: memberTexts(harness.store),
    }).toStrictEqual({
      reasons: ['mentionsAbsent', 'quoteNotVerbatim'],
      members: [],
    });
  });

  it('names in its receipt exactly what landed, and counts exactly what did not', async () => {
    await submitGateDocument();
    scriptBatch(BATCH_AROUND_IT);

    const outcomes = await drainExtraction(harness.extraction);
    const landed = memberIds(harness.store);

    expect({
      receiptNames: [...admittedBy(outcomes)].sort(),
      landedCount: landed.length,
      receiptCounted: outcomes.reduce((total, outcome) => total + outcome.rejected, 0),
      logHolds: rejections().length,
    }).toStrictEqual({
      receiptNames: [...landed].sort(),
      landedCount: 2,
      receiptCounted: 1,
      logHolds: 1,
    });
  });

  it('settles the chunk done, leaving no retry to write its members a second time', async () => {
    const receipt = await submitGateDocument();
    scriptBatch(BATCH_AROUND_IT);

    await drainExtraction(harness.extraction);

    expect({
      states: receipt.enqueued.map((id) => harness.store.getJob(id)?.state),
      attempts: receipt.enqueued.map((id) => harness.store.getJob(id)?.attempts),
      claimableAgain: harness.store.claimJob(EXTRACT_JOB_KIND) !== undefined,
    }).toStrictEqual({ states: ['done', 'done'], attempts: [0, 0], claimableAgain: false });
  });

  /*
   * Three passes with an operator un-parking between them, which is the sequence
   * that produced the live duplicates — and a sequence that costs nothing once
   * the chunk finishes, because `unparkWhatIsStuck` finds nothing to un-park.
   * The α is asserted beside the texts for the reason the head docblock gives:
   * the harm is corroboration, and a ledger deduplicated after the fact would
   * still have moved the posterior twice.
   */
  it('writes each proposition once, however often the chunk is un-parked and re-drained', async () => {
    const cleanly = await alphaFromACleanBatch();
    const receipt = await submitGateDocument();
    scriptBatch(BATCH_AROUND_IT);

    await drainExtraction(harness.extraction);
    unparkWhatIsStuck(receipt.enqueued);
    await drainExtraction(harness.extraction);
    unparkWhatIsStuck(receipt.enqueued);
    await drainExtraction(harness.extraction);

    expect({
      members: [...memberTexts(harness.store)].sort(),
      alpha: existenceAlpha(harness.store, harness.ingest, VALVE_SEAT),
      rejections: rejections().length,
    }).toStrictEqual({
      members: [ADMITTED_CLAIM, SECOND_ADMITTED_CLAIM].sort(),
      alpha: cleanly,
      rejections: 1,
    });
  });

  /*
   * ---------------------------------------------------------------------------
   * Everything above is the door refusing a message. Below is everything that
   * is *not*, and must not be mistaken for it.
   * ---------------------------------------------------------------------------
   *
   * The fix above has one dangerous near-miss, and it is the implementation a
   * reader reaches for first: a `try`/`catch` around `ingest.submit`. It passes
   * every assertion in this section — same rows, same states, same receipt —
   * because on this harness the only thing `submit` ever throws is the door's
   * own `ZodError`. It differs on the one input the harness could not previously
   * produce: a store that stops answering partway through the batch. A catch
   * wide enough to hold a `ZodError` is wide enough to hold a `StoreBusyError`,
   * and then a five-minute outage is filed as a permanent `mentionsAbsent`
   * verdict about the *model* and the chunk is settled `done` — unrecoverable
   * silent work loss, and §13's audit corrupted with failures the model never
   * had.
   *
   * So the outage is arranged, with `partial-write.test.ts`'s instrument.
   */

  /** The wait a contended write would have given up after. @spec §5.7 */
  const REFUSED_AFTER_MS = 250;

  /**
   * A real store whose write of one named claim goes busy.
   *
   * `partial-write.test.ts`'s `refusingSubmissions`, one method over: a `Proxy`
   * and not a stand-in, so every other method is the real store's, bound to the
   * real instance because the methods behind them read private fields. What it
   * arranges is a second process taking the write lock *between two proposals of
   * one batch*, which is the one failure the drain harness has no other way to
   * produce and the one the discrimination above is built against.
   *
   * Keyed on the claim's text rather than on a call count, so the outage lands
   * on a named proposal and how many spine claims §5.2's ladder had to mint
   * first is not part of the fixture.
   *
   * @spec §5.7, §11, §12
   */
  const busyWritingClaim = (store: GraphStore, text: string): GraphStore =>
    new Proxy(store, {
      get: (target, property: string | symbol) => {
        if (property === 'putClaim')
          return (claim: ClaimRecord) => {
            if (claim.text === text) throw new StoreBusyError('putClaim', REFUSED_AFTER_MS);
            target.putClaim(claim);
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  /** The same drain, over a store that will refuse to write `text`. @spec §5.7, §11 */
  const drainOverABusyStore = (text: string): ExtractionPort =>
    openExtraction({
      store: busyWritingClaim(harness.store, text),
      embeddings: harness.embeddings,
      adjudicator: harness.adjudicator,
      extractor: harness.extractor,
      cosineFloor: COSINE_FLOOR,
      tauPromote: TAU_PROMOTE,
    });

  /** How each parked job ended, and how many attempts it has spent. @spec §9 */
  const queueState = (jobIds: readonly number[]) => ({
    states: jobIds.map((id) => harness.store.getJob(id)?.state),
    attempts: jobIds.map((id) => harness.store.getJob(id)?.attempts),
  });

  /*
   * The outage, alone in the batch. `states: ['pending', ...]` is what proves
   * the instrument fired at all — without it `reasons: []` would pass on a store
   * that never went busy.
   *
   * The error text is asserted because it is the only thing an operator will
   * read, and because it is the half a catch destroys: a swallowed
   * `StoreBusyError` leaves `last_error` null and the queue with nothing to say.
   */
  it('is not what a store outage is, so a busy store leaves the chunk retryable and the log empty', async () => {
    const receipt = await submitGateDocument();
    scriptBatch([ADMITTED_FIRST, ADMITTED_LAST]);

    await drainExtraction(drainOverABusyStore(SECOND_ADMITTED_CLAIM));

    expect({
      ...queueState(receipt.enqueued),
      reasons: reasonsLogged(),
      lastError: harness.store.getJob(receipt.enqueued[0]!)?.lastError,
      claimableAgain: harness.store.claimJob(EXTRACT_JOB_KIND) !== undefined,
    }).toStrictEqual({
      states: ['pending', 'done'],
      attempts: [1, 0],
      reasons: [],
      lastError: new StoreBusyError('putClaim', REFUSED_AFTER_MS).message,
      claimableAgain: false,
    });
  });

  /*
   * And the outage beside a genuine refusal, which is the reading that matters
   * to §13: the log is a count of what the *model* did wrong, so one batch
   * holding one refused proposal and one store failure leaves exactly one row.
   * A catch around `submit` writes two — the second a verdict about a claim
   * whose mentions were never in question — and settles the chunk `done`, so
   * the outage is both miscounted and unrecoverable.
   */
  it('keeps the log a count of the model’s failures, not the store’s', async () => {
    const receipt = await submitGateDocument();
    scriptBatch([NAMES_NOTHING, ADMITTED_LAST]);

    await drainExtraction(drainOverABusyStore(SECOND_ADMITTED_CLAIM));

    expect({
      ...queueState(receipt.enqueued),
      logged: refusalsLogged().map((entry) => [entry.claimText, entry.reason] as const),
    }).toStrictEqual({
      states: ['pending', 'done'],
      attempts: [1, 0],
      logged: [[UNNAMED_CLAIM, 'mentionsAbsent']],
    });
  });

  /*
   * The other half of the discrimination, and the branch GREEN flagged
   * uncovered: `doorRefusalFor` answers `undefined` for a message the door
   * refuses over some field that is *not* `mentions`, and that proposal falls
   * through to `submit` and throws.
   *
   * Reachable, and not only in theory. `Extractor` is a port — anything
   * implementing it can propose anything — and the one implementation there is
   * reaches it too: `ProposedClaim.text` is a bare `z.string()` with no floor
   * while `ClaimMessage.text` is `.min(1)`, so a model answering with an empty
   * `text` clears the adapter and is refused at the door. The second row is the
   * mixed case, where the message is bad on `text` *and* on `mentions` at once.
   *
   * Both must stay loud. `mentionsAbsent` is a counting instrument §13 groups by
   * model, so a row carrying it has to mean the mentions were the whole of the
   * objection; a refusal nobody has yet decided how to count borrows no arm and
   * is handed back attempt-counted instead, where an operator finds it. What
   * this pins is that neither case quietly acquires a diagnosis: the log stays
   * empty, the ledger stays empty, and the job stays retryable.
   */
  it.each([
    ['its referents in order', [VALVE_SEAT]],
    ['nothing named either', []],
  ] as ReadonlyArray<readonly [string, readonly string[]]>)(
    'borrows no arm of the vocabulary when the door refuses it over its text, with %s',
    async (_why, mentions) => {
      const receipt = await submitGateDocument();
      scriptBatch([proposal({ text: '', quote: UNNAMED_QUOTE, mentions })]);

      await drainExtraction(harness.extraction);

      expect({
        ...queueState(receipt.enqueued),
        reasons: reasonsLogged(),
        wroteNothing: claimTexts(harness.store),
        lastErrorWritten:
          (harness.store.getJob(receipt.enqueued[0]!)?.lastError ?? '').length > 0,
      }).toStrictEqual({
        states: ['pending', 'done'],
        attempts: [1, 0],
        reasons: [],
        wroteNothing: [],
        lastErrorWritten: true,
      });
    },
  );

  /*
   * Which gate answers first, when both would.
   *
   * A proposal can be bad on its span *and* name nobody, and the two orders give
   * different rows. The span is asked first because a proposal whose quote the
   * chunk does not hold is a bad citation whatever its referents, and the quote
   * arms are the older and more specific diagnosis — but the sharper reason is
   * the second row here. `quoteAbsent` is stored unanchored, deliberately:
   * `ExtractionRejection.chunkOrdinal` is nullable because *"a `quoteAbsent`
   * rejection has no span to anchor"*. Ask the door first and that proposal is
   * filed `mentionsAbsent` instead — which *is* anchored — so a blank quote gets
   * written into the `quote` column as evidence of a span, which is the one
   * thing that column's nullability exists to prevent.
   */
  it.each([
    ['a span the chunk does not hold', PHANTOM_QUOTE, 'quoteNotVerbatim', true],
    ['no span at all', BLANK_QUOTE, 'quoteAbsent', false],
  ] as ReadonlyArray<readonly [string, string, string, boolean]>)(
    'is diagnosed by its quote and not by its referents when it names nobody and carries %s',
    async (_why, quote, reason, anchored) => {
      await submitGateDocument();
      scriptBatch([proposal({ text: UNNAMED_CLAIM, quote, mentions: [] })]);

      await drainExtraction(harness.extraction);

      expect(refusalsLogged()).toStrictEqual([
        {
          chunkOrdinal: anchored ? 0 : null,
          chunkHash: anchored ? chunkZero().hash : null,
          claimText: UNNAMED_CLAIM,
          quote: anchored ? quote : null,
          reason,
          modelId: EXTRACTOR_MODEL_ID,
        },
      ]);
    },
  );
});
