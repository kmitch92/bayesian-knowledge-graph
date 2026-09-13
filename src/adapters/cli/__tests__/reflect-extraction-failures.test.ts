/**
 * `kgmem reflect` when the model fails — spec §14.15, and the ruling that closes
 * it.
 *
 * The drain catches a thrown extractor and hands the job back, or parks it at the
 * retry cap, instead of rethrowing. So a run where every model call failed used
 * to print a tally of zeroes and exit 0, which a cron entry or a session-end hook
 * reads as an empty backlog. `reflect` already refuses the unconfigured case
 * non-zero for that reason, and an outage has the same shape.
 *
 * ── The rulings pinned here ─────────────────────────────────────────────────
 *
 * - **A chunk succeeded when the model answered.** An answer the gate refused in
 *   full, or an empty answer, is a finding about the chunk and settles its job
 *   `done`; asking again would ask the same question. A chunk **failed** when
 *   its attempt was handed back — to retry later, or parked because it spent the
 *   last of its attempts in this run.
 * - **Every attempted chunk failed ⇒ exit `Failed` (4)**: at least one chunk
 *   attempted and none succeeded. Zero chunks is an empty backlog and exits 0.
 * - **Some failed ⇒ exit 0.** The backlog moved; each failed job keeps its own
 *   `last_error` and retries on schedule.
 * - **The tally always carries the failure count**, `0 failed` included. A line
 *   whose fields come and go with the outcome is harder to grep, and a missing
 *   count reads the same as a build that never counted. A non-zero count splits
 *   into `will retry` and `parked`, because a parked chunk does not come back
 *   without an operator and "will retry" would be untrue of it.
 * - **Exit 4 adds one line after the tally**: the count, that none succeeded,
 *   and the *last* error the model raised — one message rather than one per
 *   chunk, enough to tell a bad key from an outage. It is the extractor's own
 *   message, without the cap note a parked job's `last_error` appends. A run
 *   that exits 0 quotes no error.
 * - Everything is said on stderr; stdout belongs to the transports.
 *
 * @spec §5.10, §7.6, §9, §12, §14.15, §15
 */

import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chunkText } from '../../../extract/index';
import { claimTexts, memberTexts } from '../../../extract/__tests__/extraction-fixtures';

import { ExitCode } from '../commands';

import {
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  queueStates,
  repo,
  runCli,
  seedIngest,
  snapshot,
  withStore,
  type CliRun,
} from './cli-fixtures';

import {
  MISQUOTED_MARK,
  OUTCOME_MARKS,
  QUOTABLE_MARK,
  SILENT_MARK,
  UNREACHABLE_MARK,
  unreachableOnCall,
} from './faltering-extractor-module';

const FALTERING_EXTRACTOR_MODULE = fileURLToPath(
  new URL('./faltering-extractor-module.ts', import.meta.url),
);

/**
 * `extraction.ts`'s retry budget, which it does not export — restated as
 * `extraction-drain.test.ts` restates it. The parked scenario's job-row
 * assertion is what catches the two drifting apart.
 *
 * @spec §15
 */
const MAX_ATTEMPTS = 5;

/** A not-before already passed, so an arranged job stays claimable. @spec §9 */
const DUE_LONG_AGO = '2020-01-01T00:00:00.000Z';

/** How much of a chunk the quotable answer's member text opens with. */
const MEMBER_TEXT_OPENING = 24;

const LEDGER_FILE = 'overhaul-entries.md';

const ENTRY_NAMES: readonly string[] = ['one', 'two', 'three'];

const entryText = (mark: string, index: number): string =>
  `Entry ${ENTRY_NAMES[index] ?? String(index)} of the winter overhaul, as the fitter wrote it. ${mark} The clerk filed it with the others.`;

const ledgerOf = (marks: readonly string[]): string => `${marks.map(entryText).join('\n\n')}\n`;

const EVERY_CALL_FAILS: readonly string[] = [UNREACHABLE_MARK, UNREACHABLE_MARK, UNREACHABLE_MARK];

const SOME_CALLS_FAIL: readonly string[] = [QUOTABLE_MARK, UNREACHABLE_MARK, MISQUOTED_MARK];

const NOTHING_GETS_IN: readonly string[] = [MISQUOTED_MARK, SILENT_MARK, MISQUOTED_MARK];

const LEDGERS: readonly (readonly string[])[] = [EVERY_CALL_FAILS, SOME_CALLS_FAIL, NOTHING_GETS_IN];

interface Scenario {
  readonly dbPath: string;
  readonly run: CliRun;
  readonly close: () => void;
}

const configuredWorkspace = (): ReturnType<typeof repo> => {
  const workspace = repo();
  workspace.configure({
    embeddings: FAKE_EMBEDDINGS_MODULE,
    adjudicator: FAKE_ADJUDICATOR_MODULE,
    extractor: FALTERING_EXTRACTOR_MODULE,
  });
  return workspace;
};

const reflectOver = async (
  marks: readonly string[],
  arrange: (dbPath: string) => void = () => undefined,
): Promise<Scenario> => {
  const workspace = configuredWorkspace();
  await seedIngest(workspace.dbPath, workspace.file(LEDGER_FILE, ledgerOf(marks)));
  arrange(workspace.dbPath);
  const run = await runCli(['reflect'], workspace.root);
  return { dbPath: workspace.dbPath, run, close: workspace.close };
};

const reflectOverNothing = async (): Promise<Scenario> => {
  const workspace = configuredWorkspace();
  const run = await runCli(['reflect'], workspace.root);
  return { dbPath: workspace.dbPath, run, close: workspace.close };
};

/**
 * Leaves the lowest-id job one attempt short of the cap and still due, through
 * the public `failJob` — the only call that moves `attempts`.
 *
 * @spec §9, §15
 */
const spendAllButTheLastAttempt = (dbPath: string): void => {
  const first = snapshot(dbPath).jobs[0];
  if (first === undefined) throw new Error('the ingest parked no job to spend attempts on');
  withStore(dbPath, (store) => {
    Array.from({ length: MAX_ATTEMPTS - 1 }).forEach(() => {
      store.failJob({ id: first.id, error: 'an earlier run died the same way', retryAt: DUE_LONG_AGO });
    });
  });
};

const REPORT_PREFIX = 'kgmem: ';

/** Every line the command said to the operator, in order, without its prefix. @spec §7.6 */
const reported = (run: CliRun): readonly string[] =>
  run.stderr
    .split('\n')
    .filter((line) => line.startsWith(REPORT_PREFIX))
    .map((line) => line.slice(REPORT_PREFIX.length));

describe('the ledgers these scenarios reflect over', () => {
  it('give each entry its own chunk, carrying exactly one outcome mark and a distinct opening', () => {
    expect(
      LEDGERS.map((marks) => {
        const chunks = chunkText(ledgerOf(marks));
        return {
          marksPerChunk: chunks.map(
            (chunk) => OUTCOME_MARKS.filter((mark) => chunk.text.includes(mark)).length,
          ),
          marksInOrder: chunks.map((chunk) => OUTCOME_MARKS.find((mark) => chunk.text.includes(mark))),
          distinctOpenings: new Set(chunks.map((chunk) => chunk.text.slice(0, MEMBER_TEXT_OPENING)))
            .size,
        };
      }),
    ).toStrictEqual(
      LEDGERS.map((marks) => ({
        marksPerChunk: marks.map(() => 1),
        marksInOrder: [...marks],
        distinctOpenings: marks.length,
      })),
    );
  });
});

describe('reflecting when every model call fails', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectOver(EVERY_CALL_FAILS);
  }, 180_000);

  afterAll(() => {
    scenario.close();
  });

  it('exits as a failure rather than reading as an empty backlog, with nothing on stdout', () => {
    expect({ code: scenario.run.code, stdout: scenario.run.stdout }).toStrictEqual({
      code: ExitCode.Failed,
      stdout: '',
    });
  });

  it('reports the tally, then that none succeeded, quoting only the last error the model raised', () => {
    expect(reported(scenario.run)).toStrictEqual([
      'reflected over 3 chunks: 0 members admitted, 0 rejected, 3 failed (3 will retry, 0 parked)',
      `all 3 chunks attempted failed, none succeeded; last error: ${unreachableOnCall(3)}`,
    ]);
  });

  it('still attempts every chunk once, handing each back and leaving the graph untouched', () => {
    const jobs = snapshot(scenario.dbPath).jobs;

    expect({
      states: queueStates(jobs),
      attempts: jobs.map((job) => job.attempts),
      claims: withStore(scenario.dbPath, claimTexts),
    }).toStrictEqual({
      states: { pending: 3, running: 0, done: 0, failed: 0 },
      attempts: [1, 1, 1],
      claims: [],
    });
  });
});

describe('reflecting when every model call fails and one chunk spends its last attempt', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectOver(EVERY_CALL_FAILS, spendAllButTheLastAttempt);
  }, 180_000);

  afterAll(() => {
    scenario.close();
  });

  it('exits as a failure, with nothing on stdout', () => {
    expect({ code: scenario.run.code, stdout: scenario.run.stdout }).toStrictEqual({
      code: ExitCode.Failed,
      stdout: '',
    });
  });

  it('counts the parked chunk apart from the ones that will retry', () => {
    expect(reported(scenario.run)).toStrictEqual([
      'reflected over 3 chunks: 0 members admitted, 0 rejected, 3 failed (2 will retry, 1 parked)',
      `all 3 chunks attempted failed, none succeeded; last error: ${unreachableOnCall(3)}`,
    ]);
  });

  it('parks exactly the chunk that reached the cap and hands the others back', () => {
    expect(
      snapshot(scenario.dbPath).jobs.map((job) => ({ state: job.state, attempts: job.attempts })),
    ).toStrictEqual([
      { state: 'failed', attempts: MAX_ATTEMPTS },
      { state: 'pending', attempts: 1 },
      { state: 'pending', attempts: 1 },
    ]);
  });
});

describe('reflecting when some model calls fail and the rest answer', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectOver(SOME_CALLS_FAIL);
  }, 180_000);

  afterAll(() => {
    scenario.close();
  });

  it('exits zero, since the backlog moved, with nothing on stdout', () => {
    expect({ code: scenario.run.code, stdout: scenario.run.stdout }).toStrictEqual({
      code: ExitCode.Ok,
      stdout: '',
    });
  });

  it('adds the failure count to its one-line tally and quotes no error', () => {
    expect(reported(scenario.run)).toStrictEqual([
      'reflected over 3 chunks: 1 members admitted, 1 rejected, 1 failed (1 will retry, 0 parked)',
    ]);
  });

  it('settles both chunks the model answered and hands back only the one it did not', () => {
    expect({
      states: queueStates(snapshot(scenario.dbPath).jobs),
      members: withStore(scenario.dbPath, memberTexts).length,
    }).toStrictEqual({
      states: { pending: 1, running: 0, done: 2, failed: 0 },
      members: 1,
    });
  });
});

describe('reflecting when the model answers every chunk but nothing gets in', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectOver(NOTHING_GETS_IN);
  }, 180_000);

  afterAll(() => {
    scenario.close();
  });

  it('exits zero: a fully refused answer and an empty answer are findings, not failures', () => {
    expect({
      code: scenario.run.code,
      stdout: scenario.run.stdout,
      states: queueStates(snapshot(scenario.dbPath).jobs),
      members: withStore(scenario.dbPath, memberTexts),
    }).toStrictEqual({
      code: ExitCode.Ok,
      stdout: '',
      states: { pending: 0, running: 0, done: 3, failed: 0 },
      members: [],
    });
  });

  it('reports a failure count of zero', () => {
    expect(reported(scenario.run)).toStrictEqual([
      'reflected over 3 chunks: 0 members admitted, 2 rejected, 0 failed',
    ]);
  });
});

describe('reflecting over an empty backlog', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await reflectOverNothing();
  }, 180_000);

  afterAll(() => {
    scenario.close();
  });

  it('exits zero and reports zero of everything, failures included', () => {
    expect({
      code: scenario.run.code,
      stdout: scenario.run.stdout,
      said: reported(scenario.run),
    }).toStrictEqual({
      code: ExitCode.Ok,
      stdout: '',
      said: ['reflected over 0 chunks: 0 members admitted, 0 rejected, 0 failed'],
    });
  });
});
