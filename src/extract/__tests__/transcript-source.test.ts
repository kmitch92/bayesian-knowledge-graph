/**
 * E4's first source: a session of messages, rendered into the one {@link
 * TextSource} E2 already knows how to swallow.
 *
 * Nothing here is a second write path. `transcriptSource` chunks nothing,
 * embeds nothing, anchors nothing, enqueues nothing and adjudicates nothing —
 * it produces a value, and `submitText` does all of that to the value if the
 * caller hands it over. That is why most of this file needs no store: a source
 * that needed one would already be doing E2's job twice.
 *
 * ── The unit, which is derived rather than chosen ───────────────────────────
 *
 * **One session is one document, therefore one episode.** §5.10 says *"a
 * document is one episode"*, §5.11 says *"resumed session chains are one
 * episode"* and *"documents and commits are one episode per artifact"*, and E2
 * already derives the episode from the document id. Follow those three and the
 * unit is settled: a session is one artifact.
 *
 * The consequence is the point. Forty assertions mined out of one conversation
 * are **one source, not forty observations** — §4.2's episode cap is what says
 * so, and it can only fire if the forty share an episode. A source that minted a
 * document per message would hand §4.4 forty independent corroborations of
 * whatever the model kept repeating, and the machinery would look like it was
 * working the whole time.
 *
 * ── The four properties a rendering has to have ─────────────────────────────
 *
 * **Verbatim.** E3's gate tests a quote by exact containment in the chunk, with
 * no trimming and no folding, so a rendering that reflowed, re-wrapped or
 * summarised a turn silently destroys every quote that turn could have
 * supported. {@link notVerbatimIn} holds the rendering to the gate's own
 * standard.
 *
 * **Cut at the turns.** E2 chunks on blank lines, so turns have to land in
 * separate paragraphs. A chunk carrying two speakers is a paragraph whose
 * members cannot be attributed to either of them; a chunk carrying no speaker at
 * all — a banner, a header, a bare label — is a paragraph E2 embeds and parks a
 * job for and E3 hands to a model, and anything mined out of it is §12's phantom
 * manufactured by the ingester rather than by the model. Asserted through
 * `chunksOf`, never by reading the rendering's punctuation.
 *
 * **Tool results included, and labelled.** §5.10 wants *"claims grounded in tool
 * output visible in the transcript → observed, with claim-with-quote against the
 * tool result"*. Two things follow, and only two: the tool output must be in the
 * document byte for byte, and the extractor must be able to tell it apart from
 * an assistant thinking aloud. E3 hands the model `{ chunkText }` and nothing
 * else, so the second one means the speaker sits in the chunk beside what it
 * said. **Which tier the extractor then assigns is the extractor's contract,
 * not the source's, and nothing here asserts one.**
 *
 * **Append-only.** A resumed session must re-chunk only its new tail, and E2
 * gives that for free — but only if the rendering of the first N turns is a
 * *prefix* of the rendering of N+2. A header that counted messages, a footer, or
 * per-turn numbering would reflow the whole document on every resumption, decay
 * every member of it against §5.10's testimony decay, and re-park every job.
 * Silently: the transcript would still look like a transcript.
 *
 * ── Flagged, not resolved ───────────────────────────────────────────────────
 *
 * §5.10 wants a claim grounded in tool output to cite that tool output, but E3's
 * gate tests the quote against **the chunk under extraction** — and an
 * assistant's assertion and the tool result it rests on are different turns,
 * therefore different chunks. So a claim in turn N cannot cite evidence in turn
 * N−1 under the current gate. This file pins only the part both readings need:
 * the tool result reaches the model as a chunk of its own, carrying its speaker,
 * with a quote the gate admits. Which turn the grounded claim is extracted *from*
 * is left open on purpose.
 *
 * @spec §3.6, §4.2, §4.4, §5.10, §5.11, §9, §11, §12
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTRACT_JOB_KIND,
  openExtraction,
  openTextIngest,
  transcriptSource,
  type ChunkView,
  type DrainOutcome,
} from '../index';

import {
  UNKNOWN_ANCHOR,
  drainJobs,
  harnessFor,
  isNamedRefusal,
  refusalFrom,
  type Harness,
} from './fixtures';

import {
  VALVE_SEAT,
  extractionHarnessFor,
  forChunkMarked,
  proposal,
  type ExtractionHarness,
} from './extraction-fixtures';

import {
  CLOSING_INSTRUCTION,
  CODE_TWIN,
  GROUNDED_ASSERTION,
  OPENING_QUESTION,
  OTHER_SESSION_ID,
  OVERHAUL_CONTENTS,
  PROSE_TWIN,
  SESSION_ID,
  SESSION_TITLE,
  SPLIT_TURN_CONTENT,
  TOOL_GROUNDED_CLAIM,
  TOOL_QUOTE,
  TOOL_RESULT,
  TRANSCRIPT_ORIGIN,
  VERSE_TWIN,
  blankTurnSession,
  chunksCarrying,
  chunksOfText,
  contentsInside,
  contentsOf,
  emptySession,
  frameOf,
  notVerbatimIn,
  overhaulSession,
  resumedSession,
  scaffoldingOnly,
  sessionOf,
  singleMessageSession,
  splitTurnSession,
  unfamiliarRoleSession,
  BLANK_ROLE,
  BROKEN_ROLE,
  MARKED_CONTENT,
  MARKED_ROLE,
  RAGGED_ROLE,
  roleSession,
  wordsIn,
  QUOTED_ROLE_LABEL,
  UNBROKEN_TURN,
  WORDLIKE,
  additionsAround,
  filledBlankTurnSession,
  markedSession,
  quotedLabelSession,
  unbrokenTurnSession,
} from './source-fixtures';

let harness: Harness;

beforeEach(() => {
  harness = harnessFor(openTextIngest);
});

afterEach(() => {
  harness.close();
});

/** More passes than this suite parks jobs, so a drain that never empties fails loudly. */
const DRAIN_CEILING = 100;

/** Every job the drain will take, worked. @spec §9 */
const drainAll = async (mining: ExtractionHarness): Promise<DrainOutcome[]> => {
  const outcomes: DrainOutcome[] = [];
  for (let pass = 0; pass < DRAIN_CEILING; pass += 1) {
    const outcome = await mining.extraction.drainOnce();
    if (outcome === undefined) return outcomes;
    outcomes.push(outcome);
  }
  throw new Error('the extraction queue never emptied');
};

/** Which episode E2 parked a job under. @spec §4.2, §5.10 */
const episodeOfJob = (harnessed: Harness, jobId: number): unknown =>
  (harnessed.store.getJob(jobId)?.payload as { episodeId?: unknown } | undefined)?.episodeId;

describe('one session is one document, therefore one episode', () => {
  it('renders a whole session as a single source the caller submits once', async () => {
    const source = transcriptSource(overhaulSession());
    const receipt = await harness.text.submitText(source);

    expect(source.origin).toBe('authored');
    expect(source.provenance).toStrictEqual(TRANSCRIPT_ORIGIN);
    expect(receipt.documentId).toStrictEqual(source.id);
    expect(receipt.chunks.length).toBeGreaterThan(1);
  });

  it('attributes every chunk of a session to one episode, not one per turn', async () => {
    const receipt = await harness.text.submitText(transcriptSource(overhaulSession()));

    const episodes = receipt.enqueued.map((id) => episodeOfJob(harness, id));

    expect(receipt.enqueued.length).toStrictEqual(OVERHAUL_CONTENTS.length);
    expect([...new Set(episodes)]).toStrictEqual([receipt.episodeId]);
  });

  it('gives two sessions two episodes, so one conversation cannot corroborate another', async () => {
    const first = await harness.text.submitText(transcriptSource(overhaulSession()));
    const second = await harness.text.submitText(
      transcriptSource(overhaulSession({ id: OTHER_SESSION_ID })),
    );

    expect(second.documentId).not.toStrictEqual(first.documentId);
    expect(second.episodeId).not.toStrictEqual(first.episodeId);
  });

  it('keeps a resumed session in the document and the episode it already had', async () => {
    const first = await harness.text.submitText(transcriptSource(overhaulSession()));
    const resumed = await harness.text.submitText(transcriptSource(resumedSession()));

    expect(resumed.documentId).toStrictEqual(first.documentId);
    expect(resumed.episodeId).toStrictEqual(first.episodeId);
  });

  it('names the session in the title, and names it the same after it is resumed', () => {
    const titled = transcriptSource(overhaulSession());
    const untitled = transcriptSource(overhaulSession({ title: undefined }));

    expect(titled.title).toStrictEqual(SESSION_TITLE);
    expect(untitled.title.length).toBeGreaterThan(0);
    expect(transcriptSource(resumedSession()).title).toStrictEqual(titled.title);
  });

  it('anchors the document at nothing the session did not name, and at what it did', () => {
    const unanchored = transcriptSource(overhaulSession());
    const anchored = transcriptSource(overhaulSession({ anchor: UNKNOWN_ANCHOR }));

    expect(unanchored.anchor).toBeUndefined();
    expect(anchored.anchor).toStrictEqual(UNKNOWN_ANCHOR);
  });
});

describe('every turn survives byte for byte, in the order it was said', () => {
  it('carries each message verbatim, so E3’s gate can match a quote against it', () => {
    const session = overhaulSession();

    expect(notVerbatimIn(transcriptSource(session).text, contentsOf(session))).toStrictEqual([]);
  });

  it('carries a turn the author broke into paragraphs without touching either half', () => {
    const halves = SPLIT_TURN_CONTENT.split('\n\n');

    expect(notVerbatimIn(transcriptSource(splitTurnSession()).text, halves)).toStrictEqual([]);
  });

  it('carries a turn whose role it has never heard of, rather than dropping what it cannot classify', () => {
    const unfamiliar = transcriptSource(unfamiliarRoleSession());

    expect(notVerbatimIn(unfamiliar.text, OVERHAUL_CONTENTS)).toStrictEqual([]);
    expect(chunksOfText(unfamiliar.text).length).toStrictEqual(
      chunksOfText(transcriptSource(overhaulSession()).text).length,
    );
  });
});

describe('a turn boundary is a chunk boundary', () => {
  it('gives each turn its own chunk, so no chunk carries two speakers', async () => {
    const session = overhaulSession();
    const source = transcriptSource(session);
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);
    const contents = contentsOf(session);

    expect(contents.map((content) => chunksCarrying(chunks, content).length)).toStrictEqual(
      contents.map(() => 1),
    );
    expect(chunks.map((chunk) => contentsInside(chunk, contents).length)).toStrictEqual(
      chunks.map(() => 1),
    );
  });

  it('parks no chunk nobody spoke, so no job asks a model to mine the scaffolding', async () => {
    const session = overhaulSession();
    const source = transcriptSource(session);
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);

    expect(scaffoldingOnly(chunks, contentsOf(session)).map((chunk) => chunk.text)).toStrictEqual(
      [],
    );
    expect(chunks.length).toStrictEqual(OVERHAUL_CONTENTS.length);
  });

  it('puts each turn’s speaker in the chunk that carries what it said', async () => {
    const session = overhaulSession();
    const source = transcriptSource(session);
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);
    const unattributable = session.messages.filter((turn) =>
      chunksCarrying(chunks, turn.content).every((chunk) => !chunk.text.includes(turn.role)),
    );

    expect(unattributable.map((turn) => turn.role)).toStrictEqual([]);
  });

  it('cuts a turn the author broke in two at its own blank line, never at its neighbours', async () => {
    const source = transcriptSource(splitTurnSession());
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);
    const spans = [OPENING_QUESTION, ...SPLIT_TURN_CONTENT.split('\n\n'), CLOSING_INSTRUCTION];

    expect(chunks.length).toStrictEqual(spans.length);
    expect(spans.map((span) => chunksCarrying(chunks, span).length)).toStrictEqual(
      spans.map(() => 1),
    );
    expect(chunks.map((chunk) => contentsInside(chunk, spans).length)).toStrictEqual(
      chunks.map(() => 1),
    );
  });
});

describe('a tool result is in the transcript, not summarised out of it', () => {
  let mining: ExtractionHarness;

  beforeEach(() => {
    mining = extractionHarnessFor(openExtraction);
  });

  afterEach(() => {
    mining.close();
  });

  it('hands the tool result to the model as a chunk of its own', async () => {
    await mining.text.submitText(transcriptSource(overhaulSession()));
    await drainAll(mining);

    const carrying = mining.extractor.requests.filter((request) =>
      request.chunkText.includes(TOOL_QUOTE),
    );

    expect(carrying.length).toStrictEqual(1);
    expect(carrying.filter((request) => request.chunkText.includes(GROUNDED_ASSERTION))).toStrictEqual(
      [],
    );
  });

  it('admits a member whose quote is a span of the tool result', async () => {
    await mining.text.submitText(transcriptSource(overhaulSession()));
    mining.extractor.answerWith(
      forChunkMarked(TOOL_QUOTE, [
        proposal({ text: TOOL_GROUNDED_CLAIM, quote: TOOL_QUOTE, mentions: [VALVE_SEAT] }),
      ]),
    );

    const outcomes = await drainAll(mining);

    expect(outcomes.flatMap((outcome) => outcome.admitted).length).toStrictEqual(1);
    expect(outcomes.reduce((total, outcome) => total + outcome.rejected, 0)).toStrictEqual(0);
  });
});

describe('a resumed session appends, and costs only its new tail', () => {
  it('renders the shorter session as a prefix of the longer one', () => {
    const before = transcriptSource(overhaulSession()).text;
    const after = transcriptSource(resumedSession()).text;

    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('re-chunks only the turns the session gained', async () => {
    const source = transcriptSource(overhaulSession());
    await harness.text.submitText(source);
    const before = harness.text.chunksOf(source.id);

    const resumed = await harness.text.submitText(transcriptSource(resumedSession()));
    const after = harness.text.chunksOf(source.id);

    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toStrictEqual(before);
    expect(resumed.enqueued.length).toStrictEqual(after.length - before.length);
  });

  it('costs nothing at all to submit a session that has not moved', async () => {
    await harness.text.submitText(transcriptSource(overhaulSession()));
    const again = await harness.text.submitText(transcriptSource(overhaulSession()));

    expect(again.enqueued).toStrictEqual([]);
  });
});

describe('the same session renders the same way every time', () => {
  it('renders identically on two calls', () => {
    expect(transcriptSource(overhaulSession())).toStrictEqual(transcriptSource(overhaulSession()));
  });

  it('renders identically for two sessions built separately out of the same turns', () => {
    expect(transcriptSource(sessionOf([...PROSE_TWIN], SESSION_ID))).toStrictEqual(
      transcriptSource(overhaulSession()),
    );
  });
});

describe('a session with nothing much in it', () => {
  it('does not invent a document out of a session nobody has spoken in', async () => {
    const refusal = await refusalFrom(async () => transcriptSource(emptySession()));
    const outcome =
      refusal === undefined
        ? { declined: 'no', chunks: chunksOfText(transcriptSource(emptySession()).text).length }
        : { declined: isNamedRefusal(refusal) ? 'by name' : 'by crash', chunks: 0 };

    expect([
      { declined: 'no', chunks: 0 },
      { declined: 'by name', chunks: 0 },
    ]).toContainEqual(outcome);
  });

  it('renders a session of one turn as a document of one chunk', async () => {
    const source = transcriptSource(singleMessageSession());
    const receipt = await harness.text.submitText(source);

    expect(notVerbatimIn(source.text, [OPENING_QUESTION])).toStrictEqual([]);
    expect(receipt.chunks.length).toStrictEqual(1);
    expect(receipt.enqueued.length).toStrictEqual(1);
  });

  it('keeps the turns either side of a turn that said nothing, and adds no empty chunk', async () => {
    const session = blankTurnSession();
    const source = transcriptSource(session);
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);
    const spoken = session.messages
      .map((turn) => turn.content)
      .filter((content) => content.length > 0);

    expect(notVerbatimIn(source.text, spoken)).toStrictEqual([]);
    expect(chunks.length).toStrictEqual(spoken.length);
    expect(scaffoldingOnly(chunks, spoken).map((chunk) => chunk.text)).toStrictEqual([]);
  });
});

describe('nothing here knows what the text is about', () => {
  it('wraps a turn of code in exactly what it wraps a turn of prose in', () => {
    const prose = transcriptSource(sessionOf([...PROSE_TWIN], SESSION_ID));
    const code = transcriptSource(sessionOf([...CODE_TWIN], SESSION_ID));
    const verse = transcriptSource(sessionOf([...VERSE_TWIN], SESSION_ID));

    expect(frameOf(code.text, CODE_TWIN)).toStrictEqual(frameOf(prose.text, PROSE_TWIN));
    expect(frameOf(verse.text, VERSE_TWIN)).toStrictEqual(frameOf(prose.text, PROSE_TWIN));
  });

  it('cuts a session of code into as many chunks as a session of prose or of verse', () => {
    const counts = [PROSE_TWIN, CODE_TWIN, VERSE_TWIN].map(
      (contents) => chunksOfText(transcriptSource(sessionOf([...contents], SESSION_ID)).text).length,
    );

    expect(counts).toStrictEqual([PROSE_TWIN.length, PROSE_TWIN.length, PROSE_TWIN.length]);
  });
});

describe('a source is a value, and writes nothing itself', () => {
  it('leaves the store exactly as it found it until the caller submits', () => {
    const ledgerBefore = harness.store.listClaimIds();
    const source = transcriptSource(overhaulSession());

    expect(harness.store.getDocument(source.id)).toBeUndefined();
    expect(drainJobs(harness.store, EXTRACT_JOB_KIND)).toStrictEqual([]);
    expect(harness.store.listClaimIds()).toStrictEqual(ledgerBefore);
  });
});

describe('the rendering adds nothing a model could mine', () => {
  it('puts nothing in a chunk but the name of who spoke and what they said', async () => {
    const session = overhaulSession();
    const source = transcriptSource(session);
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);
    const additions = session.messages.flatMap((turn) =>
      chunksCarrying(chunks, turn.content).map((chunk) => additionsAround(chunk, turn)),
    );

    expect(additions.length).toStrictEqual(session.messages.length);
    expect(additions.filter((addition) => WORDLIKE.test(addition))).toStrictEqual([]);
  });

  it('adds the same nothing whatever the turns are about', async () => {
    const session = unfamiliarRoleSession();
    const source = transcriptSource(session);
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);
    const additions = session.messages.flatMap((turn) =>
      chunksCarrying(chunks, turn.content).map((chunk) => additionsAround(chunk, turn)),
    );

    expect([...new Set(additions)].length).toStrictEqual(1);
    expect(additions.filter((addition) => WORDLIKE.test(addition))).toStrictEqual([]);
  });
});

describe('a label cannot split the turn it introduces', () => {
  /** What a session landed as: the chunks, and the one carrying the labelled turn. */
  const landing = async (role: string): Promise<{ chunks: ChunkView[]; carrying: ChunkView[] }> => {
    const source = transcriptSource(roleSession(role));
    await harness.text.submitText(source);
    const chunks = harness.text.chunksOf(source.id);
    return { chunks, carrying: chunksCarrying(chunks, TOOL_RESULT) };
  };

  it.each([
    ['a label broken by a blank line', BROKEN_ROLE],
    ['a label whose blank line carries whitespace of its own', RAGGED_ROLE],
  ])('gives %s one chunk and no paragraph nobody spoke', async (_name, role) => {
    const { chunks, carrying } = await landing(role);

    expect(chunks.length).toStrictEqual(roleSession(role).messages.length);
    expect(scaffoldingOnly(chunks, contentsOf(roleSession(role)))).toStrictEqual([]);
    expect(carrying.length).toStrictEqual(1);
  });

  it.each([
    ['a label broken by a blank line', BROKEN_ROLE],
    ['a label whose blank line carries whitespace of its own', RAGGED_ROLE],
  ])('keeps every word of %s, and touches no word of what was said', async (_name, role) => {
    const session = roleSession(role);
    const { carrying } = await landing(role);

    expect(notVerbatimIn(transcriptSource(session).text, contentsOf(session))).toStrictEqual([]);
    expect(carrying.map((chunk) => wordsIn(chunk.text.replace(TOOL_RESULT, '')))).toStrictEqual([
      wordsIn(role),
    ]);
  });

  it('never drops the turn, because a tool result missing from the document has no quote to match', async () => {
    const source = transcriptSource(roleSession(BROKEN_ROLE));
    const receipt = await harness.text.submitText(source);
    const { carrying } = await landing(BROKEN_ROLE);

    expect(notVerbatimIn(source.text, contentsOf(roleSession(BROKEN_ROLE)))).toStrictEqual([]);
    expect(carrying.map((chunk) => chunk.text.includes(TOOL_QUOTE))).toStrictEqual([true]);
    expect(receipt.enqueued.length).toStrictEqual(receipt.chunks.length);
  });

  it('invents no speaker for a label that is nothing but whitespace, and loses no turn to one', async () => {
    const { chunks, carrying } = await landing(BLANK_ROLE);
    const label = carrying.map((chunk) => chunk.text.replace(TOOL_RESULT, ''));

    expect(chunks.length).toStrictEqual(roleSession(BLANK_ROLE).messages.length);
    expect(carrying.map((chunk) => chunk.text.includes(TOOL_QUOTE))).toStrictEqual([true]);
    expect(label.map(wordsIn)).toStrictEqual([[]]);
  });
});

describe('a turn that arrives blank and fills in later costs only itself', () => {
  it('leaves every paragraph already chunked exactly as it was', async () => {
    const before = transcriptSource(blankTurnSession());
    await harness.text.submitText(before);
    const chunksBefore = harness.text.chunksOf(before.id);

    const filled = transcriptSource(filledBlankTurnSession());
    const receipt = await harness.text.submitText(filled);
    const chunksAfter = harness.text.chunksOf(filled.id);
    const survivingHashes = new Set(chunksAfter.map((chunk) => chunk.hash));

    expect(chunksAfter.length).toStrictEqual(chunksBefore.length + 1);
    expect(chunksBefore.filter((chunk) => !survivingHashes.has(chunk.hash))).toStrictEqual([]);
    expect(receipt.enqueued.length).toStrictEqual(1);
  });
});

describe('what a turn does to itself, the rendering does not undo', () => {
  it('leaves the paragraphs after a broken turn’s first one carrying no speaker at all', async () => {
    const session = splitTurnSession();
    const broken = session.messages[1];
    const source = transcriptSource(session);
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);
    const [opening, continuation] = SPLIT_TURN_CONTENT.split('\n\n');
    const speaks = (span: string): boolean[] =>
      chunksCarrying(chunks, span).map((chunk) => chunk.text.includes(broken?.role ?? ''));

    expect(speaks(opening ?? '')).toStrictEqual([true]);
    expect(speaks(continuation ?? '')).toStrictEqual([false]);
  });

  it('hands a quoted label to the model as a turn boundary, unescaped and unrelabelled', async () => {
    const source = transcriptSource(quotedLabelSession());
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);

    expect(notVerbatimIn(source.text, [QUOTED_ROLE_LABEL])).toStrictEqual([]);
    expect(chunksCarrying(chunks, QUOTED_ROLE_LABEL).map((chunk) => chunk.text)).toStrictEqual([
      QUOTED_ROLE_LABEL,
    ]);
  });

  it('renders one unbroken turn as one chunk, however long it runs', async () => {
    const source = transcriptSource(unbrokenTurnSession());
    const receipt = await harness.text.submitText(source);

    expect(notVerbatimIn(source.text, [UNBROKEN_TURN])).toStrictEqual([]);
    expect(receipt.chunks.length).toStrictEqual(1);
    expect(receipt.enqueued.length).toStrictEqual(1);
  });

  it('carries combining marks and astral characters through untouched', async () => {
    const session = markedSession();
    const source = transcriptSource(session);
    await harness.text.submitText(source);

    const chunks = harness.text.chunksOf(source.id);

    const carrying = chunksCarrying(chunks, MARKED_CONTENT);

    expect(notVerbatimIn(source.text, [MARKED_CONTENT])).toStrictEqual([]);
    expect(carrying.map((chunk) => chunk.text.includes(MARKED_ROLE))).toStrictEqual([true]);
    expect(
      carrying.filter((chunk) => WORDLIKE.test(additionsAround(chunk, session.messages[0]!))),
    ).toStrictEqual([]);
  });
});
