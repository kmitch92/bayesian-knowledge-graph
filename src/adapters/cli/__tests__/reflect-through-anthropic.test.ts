/**
 * `kgmem reflect` over the **real** extraction adapter, with only the socket
 * faked — the one composition every other suite in this repository is one seam
 * short of.
 *
 * Each layer is green on its own and each was measured against a fake of the
 * next:
 *
 * - `anthropic-extractor.test.ts` drove the real adapter through an injected
 *   `fetch`, in one process, never through `loadPort` and never near a store.
 * - `reflect-command.test.ts` drove the real CLI through
 *   `fake-extractor-module.ts`, whose quotes are slices of the chunk and are
 *   therefore verbatim *by construction* — the gate cannot refuse them.
 * - `verbatim-gate.test.ts` and `extraction-drain.test.ts` drove the real gate
 *   and the real queue through a scripted {@link Extractor}.
 *
 * So the adapter's parse and the gate's `chunkText.includes(quote)` have never
 * met. Between them sit a JSON round trip, a tool call, a prompt that frames
 * the chunk between markers, a dynamic `import()` of a module named in a JSON
 * file, and a process boundary — and a normalization anywhere along that path
 * does not fail loudly. It moves claims into `extraction_rejections` and exits
 * zero. This file is where that path runs end to end.
 *
 * ── Deterministic fakes, not scripted ones ──────────────────────────────────
 *
 * `loadPort` calls a factory with no arguments inside a child process, so a
 * test cannot hold the extractor the CLI built. The fixture modules here need
 * no handle: their `fetch` reads the chunk out of the request body it was given
 * and answers with a span cut from *that* text, so the quote is verbatim
 * because the round trip preserved it and not because two sides agreed on a
 * constant. Four scenarios, four modules, one CLI run each — see
 * `anthropic-extractor-module.ts` for the machinery they share.
 *
 * ── Read the store, never the report ────────────────────────────────────────
 *
 * `reflect` prints `reflected over N chunks: A admitted, R rejected`, and every
 * assertion below could be satisfied by that line while the ledger held
 * nothing. So nothing here reads it: members come from `memberTexts`,
 * refusals from `readExtractionRejections`, and the queue from the table.
 *
 * @spec §1, §3.6, §4.2, §5.2, §5.10, §7.6, §9, §11, §12, §13, §15
 */

import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ANTHROPIC_MODEL_ID } from '../../../extract/adapters/anthropic-extractor';
import { EXTRACT_JOB_KIND, chunkText, type ChunkView, type TextSource } from '../../../extract/index';
import { claimTexts, memberTexts } from '../../../extract/__tests__/extraction-fixtures';
import type { ExtractionRejection } from '../../../store/index';

import { ExitCode } from '../commands';

import {
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  claimableNow,
  queueStates,
  repo,
  runCli,
  seedIngest,
  snapshot,
  withStore,
  type CliRun,
  type Repo,
} from './cli-fixtures';

import { awkwardQuoteOf, memberTextFor } from './anthropic-extractor-module';
import {
  COMPOSED_QUOTE,
  composedClaimTextFor,
  straightenedQuoteOf,
} from './anthropic-paraphrasing-module';
import { FAILURE_SAID, FAILURE_STATUS } from './anthropic-failing-module';

/*
 * ---------------------------------------------------------------------------
 * The four ports a configuration can name for this suite.
 * ---------------------------------------------------------------------------
 *
 * Here rather than in `cli-fixtures.ts`, which holds the ports every E5 suite
 * shares: these four are one suite's scenarios, and a fixture module naming a
 * scenario belongs beside the file that runs it.
 */

/** The real adapter, answering with spans it copied out of the request. @spec §5.10 */
const ANTHROPIC_MODULE = fileURLToPath(
  new URL('./anthropic-extractor-module.ts', import.meta.url),
);

/** The real adapter, answering with spans the chunk does not hold. @spec §12 */
const PARAPHRASING_MODULE = fileURLToPath(
  new URL('./anthropic-paraphrasing-module.ts', import.meta.url),
);

/** The real adapter, against an API that is down. @spec §9 */
const FAILING_MODULE = fileURLToPath(new URL('./anthropic-failing-module.ts', import.meta.url));

/** The real adapter, against an answer the output budget cut off. @spec §15 */
const TRUNCATING_MODULE = fileURLToPath(
  new URL('./anthropic-truncating-module.ts', import.meta.url),
);

/*
 * ---------------------------------------------------------------------------
 * The corpus.
 * ---------------------------------------------------------------------------
 */

/** What the file is called on disk. Its stem becomes the document's title. @spec §3.6 */
const LEDGER_FILE = 'winter-overhaul-notes.md';

/**
 * Two paragraphs, each hard-wrapped and each carrying every character class a
 * helpful normalizer eats.
 *
 * E5's notebook is not reused here, and the reason is this suite's whole
 * subject. A quote that survives a fold is a quote that cannot tell a
 * byte-exact gate from a forgiving one, and the notebook's prose folds cleanly:
 * straight punctuation, one line per paragraph, no interior whitespace worth
 * eating. These paragraphs are written so the span the fixture cites begins in
 * an indent, carries a curly apostrophe, holds trailing spaces before an
 * interior line break, and runs across that break — so *"the quote survived"*
 * is a statement about bytes rather than about words.
 *
 * Two rather than one, following `INGEST_PARAGRAPHS`: at a single chunk, *"a
 * member per chunk landed"* is satisfied by accident.
 *
 * Written as joined literals so the trailing spaces are inside a string rather
 * than at the end of a source line, where an editor would eat the very thing
 * under test.
 *
 * @spec §3.6, §5.10, §12
 */
const LEDGER_PARAGRAPHS: readonly string[] = [
  [
    'The inlet gauge reads 4 bar at idle.  ',
    '  The fitter’s note says the seat was lapped, not replaced,  ',
    'and the ledger agrees.',
  ].join('\n'),
  [
    'The second reading was taken at the end of the shift.  ',
    '  Nobody initialled it, and the fitter’s hand is not the one  ',
    'that wrote the first entry.',
  ].join('\n'),
];

/** The file's bytes. @spec §3.6 */
const ledgerText = (): string => `${LEDGER_PARAGRAPHS.join('\n\n')}\n`;

/**
 * The chunking the CLI will derive, derived here the same way.
 *
 * Not a second copy of the corpus: `submitText` stores the file's bytes whole
 * in `content_ref` and `chunksOf` re-runs this exact pure function over them,
 * so this is the same derivation the drain makes, made in the test process
 * because the drain's answer is on the far side of a `spawn`.
 *
 * @spec §3.6, §5.10
 */
const CHUNKS: readonly ChunkView[] = chunkText(ledgerText());

/*
 * ---------------------------------------------------------------------------
 * One scenario: a repository, a backlog, and one run over it.
 * ---------------------------------------------------------------------------
 */

/** What one scenario leaves behind for its `it`s to read. */
interface Scenario {
  readonly repository: Repo;
  /** The document the CLI mined, for the reads that are keyed by its id. @spec §3.6 */
  readonly source: TextSource;
  readonly run: CliRun;
}

/**
 * Seeds a backlog through E2's own ingress and drains it through the CLI.
 *
 * The queue is filled in this process for `reflect-command.test.ts`'s reason —
 * neither the seeding nor a second spawn is what any of these tests are about —
 * while the drain is a real child process, because what this suite measures
 * sits behind `loadPort`, which only the CLI calls.
 *
 * @spec §5.10, §7.6, §9
 */
const reflectThrough = async (extractorModule: string): Promise<Scenario> => {
  const repository = repo();
  repository.configure({
    embeddings: FAKE_EMBEDDINGS_MODULE,
    adjudicator: FAKE_ADJUDICATOR_MODULE,
    extractor: extractorModule,
  });
  const filePath = repository.file(LEDGER_FILE, ledgerText());
  const source = await seedIngest(repository.dbPath, filePath);
  const run = await runCli(['reflect'], repository.root);
  return { repository, source, run };
};

/** How many jobs the queue holds in each state, after the run. @spec §9 */
const settled = (scenario: Scenario): ReturnType<typeof queueStates> =>
  queueStates(snapshot(scenario.repository.dbPath).jobs);

/** How many attempts the whole backlog has cost. @spec §9 */
const attemptsSpent = (scenario: Scenario): number =>
  snapshot(scenario.repository.dbPath).jobs.reduce((total, job) => total + job.attempts, 0);

/** The ordinary claims in the ledger — the members, without §3.5's spine. @spec §3.5 */
const membersIn = (scenario: Scenario): string[] =>
  withStore(scenario.repository.dbPath, memberTexts);

/** Every claim, spine included: the right read for *"nothing reached the graph"*. @spec §3.5 */
const everyClaimIn = (scenario: Scenario): string[] =>
  withStore(scenario.repository.dbPath, claimTexts);

/** The refusal log for the document under extraction, in the order it was written. @spec §13 */
const refusalsIn = (scenario: Scenario): ExtractionRejection[] =>
  withStore(scenario.repository.dbPath, (store) =>
    store.readExtractionRejections(scenario.source.id),
  );

/**
 * What each job's `last_error` says — the only thing an operator reads about a
 * failure, and the only place the adapter's own prose survives the CLI.
 *
 * @spec §9, §12
 */
const lastErrorsIn = (scenario: Scenario): string[] => {
  const ids = snapshot(scenario.repository.dbPath).jobs.map((job) => job.id);
  return withStore(scenario.repository.dbPath, (store) =>
    ids.map((id) => store.getJob(id)?.lastError ?? ''),
  );
};

/** A refusal row, projected onto what §13 audits it by. @spec §3.6, §13 */
const audited = (rejection: ExtractionRejection): Record<string, unknown> => ({
  ordinal: rejection.chunkOrdinal,
  hash: rejection.chunkHash,
  reason: rejection.reason,
  modelId: rejection.modelId,
  claimText: rejection.claimText,
  quote: rejection.quote,
});

/*
 * ---------------------------------------------------------------------------
 * Reading a diagnosis that is not an echo.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a message names `token` **in its own words**, rather than only inside
 * the answer it quotes.
 *
 * Restated from `anthropic-extractor.test.ts`, which found the trap: every
 * refusal this adapter raises ends by quoting what came back, and the answer a
 * truncation refusal quotes is by definition one carrying
 * `"stop_reason":"max_tokens"`. A bare `includes('max_tokens')` is satisfied by
 * that echo and would go on passing for an adapter that diagnosed nothing.
 * Removing the JSON rendering of the token leaves only the prose.
 *
 * @spec §12
 */
const namesInItsOwnWords = (message: string, token: string): boolean =>
  message.split(JSON.stringify(token)).join('').includes(token);

/*
 * ---------------------------------------------------------------------------
 * What makes a span hard to carry.
 * ---------------------------------------------------------------------------
 */

/** The four ways the cited span is awkward, each a thing some layer might tidy. @spec §5.10 */
const awkwardnessOf = (quote: string): Record<string, boolean> => ({
  startsInWhitespace: /^\s/u.test(quote),
  carriesACurlyApostrophe: quote.includes('’'),
  runsAcrossALineBreak: quote.includes('\n'),
  holdsWhitespaceBeforeThatBreak: /[^\S\n]\n/u.test(quote),
});

/** All four, which is what every chunk's cited span has to be for this suite to mean anything. */
const AWKWARD_IN_EVERY_WAY: Record<string, boolean> = {
  startsInWhitespace: true,
  carriesACurlyApostrophe: true,
  runsAcrossALineBreak: true,
  holdsWhitespaceBeforeThatBreak: true,
};

/** Every chunk answers the same way, so the expectations are written this way. */
const forEveryChunk = <T>(value: T): readonly T[] => CHUNKS.map(() => value);

describe('reflecting through the real Anthropic adapter', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectThrough(ANTHROPIC_MODULE);
  }, 180_000);

  afterAll(() => {
    scenario.repository.close();
  });

  it('settles every job the ingest parked, saying nothing on the stdout the transports own', () => {
    expect({
      code: scenario.run.code,
      stdout: scenario.run.stdout,
      reported: scenario.run.stderr.length > 0,
      states: settled(scenario),
    }).toStrictEqual({
      code: ExitCode.Ok,
      stdout: '',
      reported: true,
      states: { pending: 0, running: 0, done: CHUNKS.length, failed: 0 },
    });
  });

  /*
   * The whole composition, read from the far end: a configuration file naming a
   * module, `loadPort`'s dynamic import, the real adapter's request, its parse
   * of the answer, the gate, and `openIngest.submit()`. Read through
   * `memberTexts`, which filters §3.5's spine out — every existence and naming
   * claim §5.2's ladder minted for the mention is in the ledger too, and
   * counting those would make this pass at any drain depth.
   */
  it('lands one member per chunk in the graph, through the one ingest door', () => {
    expect([...membersIn(scenario)].sort()).toStrictEqual(
      CHUNKS.map((chunk) => memberTextFor(chunk.text)).sort(),
    );
  });

  /*
   * The assertion this phase exists for.
   *
   * The first two fields are statements about the fixture — that the span it
   * cites really is awkward, and really is a span of the chunk — and they are
   * here because without them the third proves nothing: a fixture quoting
   * `'The'` would be admitted too. The third is the round trip. The fourth is
   * the arm that would carry a fold if one existed anywhere between the
   * adapter's parse and `refusalFor`, because a tidied span is not thrown away
   * loudly, it is logged and the command still exits zero.
   */
  it('admits a quote the adapter passed through untouched, awkward characters and all', () => {
    const members = membersIn(scenario);

    expect({
      awkward: CHUNKS.map((chunk) => awkwardnessOf(awkwardQuoteOf(chunk.text))),
      verbatimInTheChunk: CHUNKS.map((chunk) => chunk.text.includes(awkwardQuoteOf(chunk.text))),
      admitted: CHUNKS.map((chunk) => members.includes(memberTextFor(chunk.text))),
      refused: refusalsIn(scenario),
    }).toStrictEqual({
      awkward: forEveryChunk(AWKWARD_IN_EVERY_WAY),
      verbatimInTheChunk: forEveryChunk(true),
      admitted: forEveryChunk(true),
      refused: [],
    });
  });
});

/**
 * The other half of the same contract: a span the model composed instead of
 * copying, and a span it copied and then tidied.
 *
 * @spec §5.10, §12, §13
 */
describe('reflecting when the model does not copy its span', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectThrough(PARAPHRASING_MODULE);
  }, 180_000);

  afterAll(() => {
    scenario.repository.close();
  });

  /*
   * `done`, not `failed` and not `pending`: the model answered, the answer was
   * readable, and the gate judged it. Nothing about a refused proposal is a
   * reason to mine the paragraph again, and the command exits zero because a
   * rejection is a finding rather than a failure of the run.
   */
  it('mines the chunk, writes nothing, and still exits zero', () => {
    expect({
      code: scenario.run.code,
      states: settled(scenario),
      claims: everyClaimIn(scenario),
    }).toStrictEqual({
      code: ExitCode.Ok,
      states: { pending: 0, running: 0, done: CHUNKS.length, failed: 0 },
      claims: [],
    });
  });

  /*
   * §13 groups the rejection log by model, and this is the only place the real
   * adapter's `modelId` survives a CLI run at all — an admitted member records
   * nothing about which model proposed it. A grouping key that disagreed with
   * the model that ran would attribute one model's failures to another.
   *
   * The quote is read back byte for byte because the column is documented as
   * *"neither trimmed nor folded"*: a span that fails only on whitespace is a
   * different diagnosis from one the paragraph never contained, and a log that
   * normalized on the way in would erase the difference before anyone read it.
   */
  it('logs every refusal against the chunk, the model and the span exactly as offered', () => {
    expect(refusalsIn(scenario).map(audited)).toStrictEqual(
      CHUNKS.flatMap((chunk) => [
        {
          ordinal: chunk.ordinal,
          hash: chunk.hash,
          reason: 'quoteNotVerbatim',
          modelId: ANTHROPIC_MODEL_ID,
          claimText: composedClaimTextFor(chunk.text),
          quote: COMPOSED_QUOTE,
        },
        {
          ordinal: chunk.ordinal,
          hash: chunk.hash,
          reason: 'quoteNotVerbatim',
          modelId: ANTHROPIC_MODEL_ID,
          claimText: memberTextFor(chunk.text),
          quote: straightenedQuoteOf(chunk.text),
        },
      ]),
    );
  });

  /*
   * The pair, stated. The second refusal above carries the *same* `claimText`
   * the run before it admitted, and a span the same length as the one it
   * admitted, differing in one code unit. Nothing else about the two runs
   * differs — same corpus, same adapter, same gate — so the apostrophe is what
   * decided it, which is exactly what "verbatim" was defined to mean.
   */
  it('refuses a span one code unit away from the one it admits', () => {
    expect(
      CHUNKS.map((chunk) => ({
        sameLength: straightenedQuoteOf(chunk.text).length === awkwardQuoteOf(chunk.text).length,
        differentBytes: straightenedQuoteOf(chunk.text) !== awkwardQuoteOf(chunk.text),
        absentFromTheChunk: !chunk.text.includes(straightenedQuoteOf(chunk.text)),
        composedSpanAbsentToo: !chunk.text.includes(COMPOSED_QUOTE),
      })),
    ).toStrictEqual(
      forEveryChunk({
        sameLength: true,
        differentBytes: true,
        absentFromTheChunk: true,
        composedSpanAbsentToo: true,
      }),
    );
  });
});

/**
 * §9's retry policy, exercised from a shell for the first time.
 *
 * The adapter throws and draws no conclusion; `extraction.ts` reads the throw
 * as transient and hands the job back with the attempt counted and a `retryAt`
 * strictly in the future. Both halves have suites; the round trip between them
 * — the adapter's own message becoming a queue row an operator reads — does
 * not.
 *
 * @spec §9, §12
 */
describe('reflecting when the Messages API is down', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectThrough(FAILING_MODULE);
  }, 180_000);

  afterAll(() => {
    scenario.repository.close();
  });

  it('hands every job back to the queue with the attempt counted, and exits as a failure', () => {
    expect({
      code: scenario.run.code,
      states: settled(scenario),
      attempts: attemptsSpent(scenario),
    }).toStrictEqual({
      code: ExitCode.Failed,
      states: { pending: CHUNKS.length, running: 0, done: 0, failed: 0 },
      attempts: CHUNKS.length,
    });
  });

  /*
   * Nothing is written until the model has answered, so a failed attempt leaves
   * the graph exactly as it found it — spine included, which is why this reads
   * every claim rather than the members: a run that got as far as resolving a
   * mention would have minted a referent and left an existence claim behind.
   */
  it('leaves the graph exactly as the ingest left it', () => {
    expect({ claims: everyClaimIn(scenario), refused: refusalsIn(scenario) }).toStrictEqual({
      claims: [],
      refused: [],
    });
  });

  /*
   * The adapter's own words, arriving where §9 puts them. `FAILURE_SAID`
   * carries no digit anywhere, so `500` in the message is the adapter's
   * diagnosis rather than an echo of the body it quotes — the failure mode
   * E7b-2 found in its own suite, where an assertion on `max_tokens` passed
   * unconditionally because the refusal quoted a payload containing it.
   */
  it('carries the adapter’s own diagnosis into the job an operator will read', () => {
    expect(
      lastErrorsIn(scenario).map((error) => ({
        namesTheStatus: error.includes(String(FAILURE_STATUS)),
        namesWhatTheApiSaid: error.includes(FAILURE_SAID),
      })),
    ).toStrictEqual(forEveryChunk({ namesTheStatus: true, namesWhatTheApiSaid: true }));
  });

  /*
   * Mutating, and last in this describe for it: `claimableNow` claims what it
   * counts, which leaves every job it took `running`.
   *
   * The sharp end of *"retryable"*. A job handed back with a `retryAt` a minute
   * out is `pending` and is not claimable, and a state count alone cannot tell
   * that apart from a job the run never touched — which is the difference
   * between a backlog that will retry itself and a drain loop that would spin
   * on the job that just killed it.
   */
  it('holds those jobs back from the very next drain, without parking them', () => {
    const stillPending = settled(scenario).pending;

    expect({
      stillPending,
      claimable: claimableNow(scenario.repository.dbPath, EXTRACT_JOB_KIND),
    }).toStrictEqual({ stillPending: CHUNKS.length, claimable: 0 });
  });
});

/**
 * E7b-2's truncation guard, through the CLI.
 *
 * The only scenario here whose answer is indistinguishable from a successful
 * one but for a single field: the tool call is well formed, its claim is well
 * typed, and its quote is the same byte-exact span the first describe gets
 * admitted. Without the guard this run ends `done` with two members in the
 * ledger and no trace that anything was lost; with it, the job is back on the
 * queue with an attempt spent.
 *
 * @spec §9, §12, §15
 */
describe('reflecting when the answer ran out of room', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectThrough(TRUNCATING_MODULE);
  }, 180_000);

  afterAll(() => {
    scenario.repository.close();
  });

  it('refuses the truncated call instead of marking the chunk mined of half an answer', () => {
    expect({
      code: scenario.run.code,
      states: settled(scenario),
      attempts: attemptsSpent(scenario),
      members: membersIn(scenario),
      refused: refusalsIn(scenario),
    }).toStrictEqual({
      code: ExitCode.Failed,
      states: { pending: CHUNKS.length, running: 0, done: 0, failed: 0 },
      attempts: CHUNKS.length,
      members: [],
      refused: [],
    });
  });

  /*
   * `quotesTheAnswer` is not decoration: it proves the echo this assertion has
   * to see past is really present, so `namesTheSignal` is measuring the
   * stripping rather than passing because there was nothing to strip.
   */
  it('names the budget signal in its own words, not only in the answer it quotes', () => {
    expect(
      lastErrorsIn(scenario).map((error) => ({
        namesTheSignal: namesInItsOwnWords(error, 'max_tokens'),
        quotesTheAnswer: error.includes('"stop_reason":"max_tokens"'),
      })),
    ).toStrictEqual(forEveryChunk({ namesTheSignal: true, quotesTheAnswer: true }));
  });
});
