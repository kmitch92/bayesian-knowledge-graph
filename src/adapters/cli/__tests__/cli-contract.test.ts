/**
 * What `kgmem` promises about itself, once two of its subcommands are real.
 *
 * Four claims, none of which belongs to `ingest` or to `reflect` alone.
 *
 * ── The table is the advertisement ──────────────────────────────────────────
 *
 * `commands.ts` makes the table *"the single source of truth for both `--help`
 * and the NOT_IMPLEMENTED messages, so a subcommand cannot be advertised without
 * also being routable, or routable without being advertised"*. A wired `ingest`
 * with no row is routable and unadvertised; a row whose footer still tells the
 * operator that every subcommand is a P0 stub is advertised as something it is
 * not. Both are pinned here.
 *
 * ── Where the store comes from ──────────────────────────────────────────────
 *
 * No P0 command opens one, so this suite settles it: `<root>/.kgmem/graph.db`,
 * where `<root>` is the nearest ancestor of the working directory holding a
 * `.kgmem` directory. See `cli-fixtures.ts` for the argument. The arm asserted
 * here is the refusal, because it is the one with a wrong answer available:
 * `openGraphStore` migrates whatever path it is handed, so a CLI that resolved
 * `.kgmem/graph.db` against the working directory and opened it would *succeed*
 * anywhere — scattering empty graphs through the filesystem, reporting a
 * successful ingest into a store nobody will ever read, and leaving §7.7's
 * health view to be computed over an empty file. `git init` refuses to be
 * implicit for the same reason.
 *
 * ── The wait an operator is asked to make ───────────────────────────────────
 *
 * §5.7's `BUSY_TIMEOUT_MS` is thirty seconds, and generous on purpose: on the
 * write path a collision has to resolve as a wait, because *"a writer that
 * surfaces SQLITE_BUSY has dropped evidence just as surely as a lost update
 * would have"*. `GraphStoreOptions.busyTimeoutMs` exists because that is the
 * wrong trade somewhere, and its own docblock names the somewhere: *"A git hook
 * that would block a commit, a health check, a test fixture: each would rather
 * be told it is contended than wait thirty seconds to find out."* An interactive
 * CLI is that caller. Worse, the wait is not interruptible: `connection.ts`
 * parks the thread in `Atomics.wait`, which runs no timers, no signal handlers
 * and no JavaScript at all — an operator pressing ^C waits out the full thirty
 * seconds regardless.
 *
 * The test is black-box on purpose. It does not read what the CLI passed to
 * `openGraphStore`; it holds the write lock from a second real process — the
 * same `lock-holder-worker.ts` the store's own failure-mode suite uses — and
 * measures how long the CLI takes to give up. That is the property, and it is
 * the only form of it an operator ever experiences.
 *
 * @spec §5.7, §5.10, §7.6, §7.7, §11
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnWorker } from '../../../store/__tests__/worker-harness';

import { COMMANDS, ExitCode, findCommand } from '../commands';

import {
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  KGMEM_DIR,
  NOTEBOOK_FILE,
  REFUSED,
  bareWorkspace,
  failureShape,
  notebookFileText,
  refusedOnItsOwnTerms,
  repo,
  runCli,
  type BareWorkspace,
  type CliRun,
  type Repo,
} from './cli-fixtures';

/** The section that makes text the universal ingress. @spec §5.10 */
const INGEST_SPEC = '§5.10';

/** The usage line `ingest` must be advertised under. @spec §7.6 */
const INGEST_USAGE = 'ingest <path>';

/**
 * The sentence the P0 help closes with, which two wired subcommands make false.
 *
 * Pinned as an absence rather than rewritten here, because what replaces it is
 * E5's to word. What is not E5's is leaving it: a help text that tells an
 * operator `ingest` will exit NOT_IMPLEMENTED, above a line advertising
 * `ingest`, is the exact drift the table exists to prevent.
 *
 * @spec §7.6
 */
const STUB_DISCLAIMER = 'Every subcommand is a routing stub in P0';

/** A plan §5 phase name: `P0` through `P8`. @spec §7.6 */
const NUMBERED_PHASE = /^P\d/u;

/**
 * How long the CLI may take, from spawn to exit, against a store it cannot get
 * the write lock on.
 *
 * Ten seconds is not a pin on {@link GraphStoreOptions.busyTimeoutMs} — it is
 * the discriminator. It sits far enough above process start-up (a Node process
 * loading tsx, better-sqlite3 and sqlite-vec costs a second or two) to admit any
 * short wait E5 might choose, and far enough below §5.7's thirty-second default
 * that accepting the default cannot pass.
 *
 * @spec §5.7
 */
const GIVES_UP_WITHIN_MS = 10_000;

/**
 * How long the second process holds the lock.
 *
 * Longer than the default wait, so that a CLI which accepted the default is
 * measured giving up at thirty seconds rather than measured succeeding the
 * instant the holder let go — a run that succeeded late would fail this test on
 * the exit code and hide what actually happened.
 *
 * @spec §5.7
 */
const HOLD_MS = 120_000;

const holderPath = fileURLToPath(new URL('../../../store/__tests__/lock-holder-worker.ts', import.meta.url));

describe('the subcommand table, once ingest is wired', () => {
  it('routes `ingest`, with a path argument and no fail-open exemption', () => {
    const row = findCommand(['ingest', 'notes/winter-overhaul.md']);

    expect({ name: row?.name, args: row?.args, failOpen: row?.failOpen }).toStrictEqual({
      name: 'ingest',
      args: '<path>',
      failOpen: false,
    });
  });

  it('cites the section that makes text the universal ingress', () => {
    expect(findCommand(['ingest'])?.spec ?? '').toContain(INGEST_SPEC);
  });

  /*
   * The table's own rule, applied to the new row rather than invented for it:
   * every existing row either names a plan §5 phase or explains why plan §5 has
   * none, which is what `jobs run`'s `phaseNote` is. Text ingest arrived on a
   * track plan §5 does not number, so `ingest` needs the same explanation —
   * and the `lists` half is what makes this fail while there is no row at all.
   */
  it('says which phase delivers every row, or why plan §5 names none', () => {
    const unexplained = COMMANDS.filter(
      (command) => !NUMBERED_PHASE.test(command.phase) && command.phaseNote === undefined,
    ).map((command) => command.name);

    expect({
      unexplained,
      lists: COMMANDS.some((command) => command.name === 'ingest'),
    }).toStrictEqual({ unexplained: [], lists: true });
  });
});

describe('kgmem --help', () => {
  let workspace: BareWorkspace;
  let help: CliRun;

  beforeAll(async () => {
    workspace = bareWorkspace();
    help = await runCli(['--help'], workspace.root);
  }, 120_000);

  afterAll(() => {
    workspace.close();
  });

  it('is the one thing that does go to stdout, and goes there alone', () => {
    expect({ code: help.code, stderr: help.stderr, spoke: help.stdout.length > 0 }).toStrictEqual({
      code: ExitCode.Ok,
      stderr: '',
      spoke: true,
    });
  });

  it('lists ingest with its argument and the section it serves', () => {
    const line = help.stdout
      .split('\n')
      .find((candidate) => candidate.trimStart().startsWith('ingest '));

    expect({
      advertised: line !== undefined,
      usage: line?.includes(INGEST_USAGE) ?? false,
      spec: line?.includes(INGEST_SPEC) ?? false,
    }).toStrictEqual({ advertised: true, usage: true, spec: true });
  });

  it('no longer tells an operator that every subcommand is a stub', () => {
    expect(help.stdout).not.toContain(STUB_DISCLAIMER);
  });
});

describe('running where no store has been created', () => {
  let workspace: BareWorkspace;
  let run: CliRun;

  beforeAll(async () => {
    workspace = bareWorkspace();
    const filePath = workspace.file(NOTEBOOK_FILE, notebookFileText());

    run = await runCli(['ingest', filePath], workspace.root);
  }, 120_000);

  afterAll(() => {
    workspace.close();
  });

  it('refuses rather than reporting a successful write into a graph it invented', () => {
    expect(failureShape(run)).toStrictEqual(REFUSED);
  });

  /*
   * Both of the next two carry `refused` for the reason `failureShape`'s
   * docblock gives: an absent `.kgmem` is also what a router that never looked
   * for one leaves behind, and today's unknown-command message prints the whole
   * command table — `init` row included — onto stderr.
   */
  it('leaves no store behind where it was run', () => {
    expect({
      created: existsSync(join(workspace.root, KGMEM_DIR)),
      refused: refusedOnItsOwnTerms(run),
    }).toStrictEqual({ created: false, refused: true });
  });

  it('names the command that would make one', () => {
    expect({
      namesInit: run.stderr.includes('init'),
      refused: refusedOnItsOwnTerms(run),
    }).toStrictEqual({ namesInit: true, refused: true });
  });
});

describe('running against a store another process holds the write lock on', () => {
  let repository: Repo;
  let filePath: string;

  beforeAll(() => {
    repository = repo();
    repository.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      adjudicator: FAKE_ADJUDICATOR_MODULE,
    });
    filePath = repository.file(NOTEBOOK_FILE, notebookFileText());
  });

  afterAll(() => {
    repository.close();
  });

  /*
   * One test, two assertions, and both are needed. The shape alone passes today
   * — a NOT_IMPLEMENTED stub is non-zero and instant — and the clock alone
   * passes against a CLI that never touched the store at all.
   */
  it(
    'gives up in seconds rather than parking uninterruptibly for §5.7’s default',
    async () => {
      const holder = spawnWorker(holderPath, [repository.dbPath, String(HOLD_MS)]);
      if (!(await holder.ready))
        throw new Error(`the lock holder died: ${(await holder.done).stderr}`);

      try {
        const run = await runCli(['ingest', filePath], repository.root);

        expect(failureShape(run)).toStrictEqual(REFUSED);
        expect(run.elapsedMs).toBeLessThan(GIVES_UP_WITHIN_MS);
      } finally {
        holder.kill();
        await holder.done;
      }
    },
    180_000,
  );
});
