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
 * **A thrown extractor is transient by default.** §9 puts the retry policy in
 * the caller's hands precisely because neither automatic reading is right, and
 * a drain is the caller. So the job goes back to `pending` with its attempt
 * counted and a `retryAt` strictly in the future — the future part being what
 * stops the drain loop from immediately re-taking the job that just killed it.
 * How many attempts a job gets before it is parked is a §15 ⚙ constant tuned
 * offline, and is not pinned here.
 *
 * Real SQLite, `:memory:`, no mocks of the store.
 *
 * @spec §3.2, §3.3, §3.5, §3.6, §4.2, §4.4, §4.7, §5, §5.1, §5.2, §5.8, §5.10, §9, §12, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXTRACT_JOB_KIND, openExtraction } from '../index';

import { ReservedEdgeKindError } from '../../store/index';
import { agentOrigin, claimMessage } from '../../referents/__tests__/fixtures';

import {
  ABSENT_DOCUMENT_ID,
  ADMITTED_CLAIM,
  CHUNK_ZERO_MARKER,
  GATE_DOCUMENT_ID,
  LEDGER_DOCUMENT_ID,
  MEMBERS_PER_CHUNK,
  OVERHAUL_LEDGER,
  SECOND_HAND,
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
