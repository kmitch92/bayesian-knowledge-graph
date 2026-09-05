/**
 * The two rulings E5 had to invent, driven from the outside.
 *
 * `cli-contract.test.ts` pins where the store lives and what a run costs when
 * the store is contended. It does that through the one arrangement every
 * subcommand shares: a repository `init` has already been run in, with a
 * `config.json` naming every port a command needs. That arrangement is the happy
 * shape of both rulings, and it leaves the edges of each unwritten.
 *
 * This file drives the edges. Every case below is a repository an operator can
 * actually produce — one that has just been `init`ed and never written to, one
 * where the command was typed two directories down, one where `config.json` was
 * hand-edited into invalid JSON, one where a specifier points at the wrong file
 * in the right package. None of them is exotic, and each has one answer the
 * implementation had to choose over an equally runnable wrong one:
 *
 * - a `.kgmem` that is a *file* could be accepted by an existence check;
 * - a search that did not walk up would still work from the repository root;
 * - a refusal that opened the store first would still refuse;
 * - a missing `config.json` could be an error, and a malformed one could be
 *   silently treated as absent;
 * - a port whose factory returns the wrong object could be discovered at the
 *   call site instead of at load;
 * - a refusal could account for what it left on disk, on a write path that is
 *   not one transaction and cannot.
 *
 * Each of those alternatives passes `cli-contract.test.ts` untouched. That is
 * what these tests are for.
 *
 * ── Everything here is a refusal, and refusals are cheap ────────────────────
 *
 * One deliberate exception: the run that proves a store gets created costs a
 * real ingest. Every other case answers before any model is imported, so the
 * spawns below are process start-up and nothing else — which is why this file
 * can afford one run per case rather than `ingest-command.test.ts`'s one run per
 * scenario.
 *
 * @spec §5.3, §5.10, §7.6, §11
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnWorker } from '../../../store/__tests__/worker-harness';
import { StoreBusyError } from '../../../store/index';

import { ExitCode } from '../commands';

import {
  CONFIG_FILE,
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  KGMEM_DIR,
  NOTEBOOK_FILE,
  NOTHING,
  REFUSED,
  STORE_FILE,
  failureShape,
  notebookFileText,
  refusedOnItsOwnTerms,
  repo,
  runCli,
  snapshot,
  sourceFor,
  type CliRun,
  type Repo,
} from './cli-fixtures';

import { REQUIRED_EMBEDDING_METHOD } from './fake-wrong-shape-module';

/** The module a configuration names that resolves but is not the port. @spec §5.3 */
const FAKE_WRONG_SHAPE_MODULE = fileURLToPath(
  new URL('./fake-wrong-shape-module.ts', import.meta.url),
);

/** A path in the repository with no file behind it. */
const ABSENT_FILE = 'never-written.md';

/**
 * How long the lock holder keeps the write lock.
 *
 * Longer than any wait the CLI could choose, so a run that gave up is
 * distinguishable from a run that outlasted the holder. `cli-contract.test.ts`
 * makes the same argument for the same number.
 *
 * @spec §5.7
 */
const HOLD_MS = 120_000;

const holderPath = fileURLToPath(
  new URL('../../../store/__tests__/lock-holder-worker.ts', import.meta.url),
);

/**
 * The claim a contended `ingest` currently makes about what it left behind.
 *
 * `submitText` is not one transaction. It writes the document, then one chunk
 * per paragraph, then parks a job only for chunks whose hash was not already
 * stored — so a busy timeout partway down that loop has already committed
 * everything above it. Six concurrent ingests produce it: one document landed
 * with seven chunks and no jobs where its siblings got eight of each, and every
 * re-run reads those seven as already stored and parks nothing for them. Seven
 * paragraphs embedded, anchored, and invisible to `reflect`, under a refusal
 * that said nothing was written.
 *
 * The non-atomicity is a separate fix at the store and ingest layers. What is
 * fixable here is the CLI asserting a fact it is not in a position to have:
 * `refuse` is handed a `StoreBusyError` and nothing else, and cannot tell which
 * write it gave up on.
 *
 * Pinned as an absence and *only* as an absence, matched loosely enough that a
 * reworded restatement — "nothing has been written", "nothing at all was
 * written" — does not slip past. What replaces the sentence is the fix's to
 * word, and a test naming the replacement would fail every time someone
 * improved it.
 *
 * @spec §5.7, §7.6
 */
const CLAIMS_NOTHING_WAS_WRITTEN = /\bnothing\b[^.]*\bwritten\b/iu;

/**
 * Proof a run reached §5.7's busy arm rather than falling over short of it.
 *
 * `StoreBusyError`'s own words, which is why this is the anchor: the sentences
 * around it are `refuse`'s to compose and are the thing under change, while the
 * message it wraps belongs to the store and survives any rewording of them.
 *
 * @spec §5.7
 */
const NAMES_THE_CONTENTION = /write lock/iu;

/** The two ports an `ingest` needs before it can reach the store. @spec §5.2, §5.3 */
const WORKING_PORTS = {
  embeddings: FAKE_EMBEDDINGS_MODULE,
  adjudicator: FAKE_ADJUDICATOR_MODULE,
} as const;

/**
 * A repository shaped exactly as `kgmem init` leaves one — and no further.
 *
 * `repo()` migrates a store into place, because almost every test needs one to
 * read afterwards. That is one write past what `init` promises: the directory.
 * The moment between `init` and the first successful ingest is a real state an
 * operator passes through every time, and it is the state in which "who creates
 * the store" and "does a refusal create it anyway" are answerable questions.
 *
 * @spec §7.6, §11
 */
interface FreshWorkspace {
  readonly root: string;
  readonly dbPath: string;
  file(name: string, text: string): string;
  close(): void;
}

const freshWorkspace = (config?: string): FreshWorkspace => {
  const root = mkdtempSync(join(tmpdir(), 'kg-cli-fresh-'));
  const home = join(root, KGMEM_DIR);
  mkdirSync(home, { recursive: true });
  if (config !== undefined) writeFileSync(join(home, CONFIG_FILE), config, 'utf8');

  return {
    root,
    dbPath: join(home, STORE_FILE),
    file: (name, text) => {
      const path = join(root, name);
      writeFileSync(path, text, 'utf8');
      return path;
    },
    close: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/** `.kgmem/config.json`, as a repository's own bytes. @spec §7.6 */
const configuring = (models: Record<string, string>): string =>
  `${JSON.stringify({ models }, null, 2)}\n`;

describe('finding the repository a command belongs to', () => {
  describe('when `.kgmem` is a file rather than a directory', () => {
    let root: string;
    let run: CliRun;

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'kg-cli-filekgmem-'));
      // Not a directory, and not a store either: whatever this is, it is not a
      // repository, and an existence check cannot tell the difference.
      writeFileSync(join(root, KGMEM_DIR), 'not a directory\n', 'utf8');
      const filePath = join(root, NOTEBOOK_FILE);
      writeFileSync(filePath, notebookFileText(), 'utf8');

      run = await runCli(['ingest', filePath], root);
    }, 120_000);

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    /*
     * `refused` rides along for `failureShape`'s reason: a CLI that accepted the
     * file as a workspace would go on to hand `<root>/.kgmem/graph.db` to
     * `openGraphStore`, which fails too — with a driver error about a path whose
     * parent is not a directory. Both are non-zero, and only one is a diagnosis.
     */
    it('refuses, and says the repository is what is missing', () => {
      expect({
        shape: failureShape(run),
        namesInit: run.stderr.includes('init'),
        refused: refusedOnItsOwnTerms(run),
      }).toStrictEqual({ shape: REFUSED, namesInit: true, refused: true });
    });
  });

  describe('when the command is typed two directories below the root', () => {
    let repository: Repo;
    let deep: string;
    let run: CliRun;
    let documentId: string;

    beforeAll(async () => {
      repository = repo();
      repository.configure(WORKING_PORTS);
      deep = join(repository.root, 'notes', 'deep');
      mkdirSync(deep, { recursive: true });
      const filePath = join(deep, NOTEBOOK_FILE);
      writeFileSync(filePath, notebookFileText(), 'utf8');
      documentId = (await sourceFor(filePath)).id;

      // Relative, because that is how it would be typed from here, and because
      // a resolver that mishandled it would land on a different document id.
      run = await runCli(['ingest', `./${NOTEBOOK_FILE}`], deep);
    }, 180_000);

    afterAll(() => {
      repository.close();
    });

    it('writes into the root’s store rather than starting one where it was run', () => {
      expect({
        code: run.code,
        documents: snapshot(repository.dbPath).documents,
        strayHome: existsSync(join(deep, KGMEM_DIR)),
      }).toStrictEqual({ code: ExitCode.Ok, documents: [documentId], strayHome: false });
    });
  });
});

describe('a repository `init` has made and nothing has written to yet', () => {
  describe('ingesting into it', () => {
    let workspace: FreshWorkspace;
    let run: CliRun;
    let documentId: string;

    beforeAll(async () => {
      workspace = freshWorkspace(configuring(WORKING_PORTS));
      const filePath = workspace.file(NOTEBOOK_FILE, notebookFileText());
      documentId = (await sourceFor(filePath)).id;

      run = await runCli(['ingest', filePath], workspace.root);
    }, 180_000);

    afterAll(() => {
      workspace.close();
    });

    /*
     * The store is the workspace's own artefact, so a command that has already
     * found the `.kgmem` an operator asked for may make it. That is the opposite
     * of the ruling one level up — where an absent `.kgmem` is refused rather
     * than invented — and the two are not in tension: the refusal protects
     * against writing into a repository nobody nominated, and this is the
     * repository they nominated. It is also the first thing that happens after
     * `init`, every time.
     */
    it('creates the store under the `.kgmem` it was given, and writes the document into it', () => {
      expect({
        code: run.code,
        created: existsSync(workspace.dbPath),
        documents: snapshot(workspace.dbPath).documents,
      }).toStrictEqual({ code: ExitCode.Ok, created: true, documents: [documentId] });
    });
  });

  describe('reflecting in it, with no extractor configured', () => {
    let workspace: FreshWorkspace;
    let run: CliRun;

    beforeAll(async () => {
      workspace = freshWorkspace(configuring(WORKING_PORTS));

      run = await runCli(['reflect'], workspace.root);
    }, 120_000);

    afterAll(() => {
      workspace.close();
    });

    /*
     * The refusal's whole claim is that it costs the queue nothing, and
     * `reflect-command.test.ts` proves that against a store that already exists
     * — where "nothing was spent" and "nothing was opened" look identical. Here
     * they do not: a `requirePort` moved even one line below
     * `openWorkspaceStore` leaves a migrated, empty `graph.db` behind, which is
     * §7.7's health view computed over a file no ingest ever touched.
     */
    it('leaves no store behind, having refused before it opened one', () => {
      expect({
        shape: failureShape(run),
        created: existsSync(workspace.dbPath),
        refused: refusedOnItsOwnTerms(run),
      }).toStrictEqual({ shape: REFUSED, created: false, refused: true });
    });
  });
});

describe('reading `.kgmem/config.json`', () => {
  describe('when there is no configuration file at all', () => {
    let repository: Repo;
    let run: CliRun;

    beforeAll(async () => {
      // Deliberately never `configure`d: `init` creates a directory, not an
      // opinion about models.
      repository = repo();

      run = await runCli(['reflect'], repository.root);
    }, 120_000);

    afterAll(() => {
      repository.close();
    });

    /*
     * `namesTheMissingPort` is the discriminator. A build that treated an absent
     * file as unreadable would refuse here too, with the same exit code and the
     * same file named — and would be telling an operator to repair a file they
     * have not written yet, rather than to write it.
     */
    it('is an unconfigured repository, not an unreadable one', () => {
      expect({
        shape: failureShape(run),
        namesTheMissingPort: /extractor/iu.test(run.stderr),
        namesWhereItGoes: run.stderr.includes(CONFIG_FILE),
      }).toStrictEqual({ shape: REFUSED, namesTheMissingPort: true, namesWhereItGoes: true });
    });
  });

  describe('when the configuration file is not JSON', () => {
    let workspace: FreshWorkspace;
    let run: CliRun;

    beforeAll(async () => {
      // A hand edit that lost a brace: the file an operator actually produces.
      workspace = freshWorkspace('{ "models": { "extractor": "./mine.js" \n');

      run = await runCli(['reflect'], workspace.root);
    }, 120_000);

    afterAll(() => {
      workspace.close();
    });

    /*
     * `readAsUnconfigured` is the trap. Falling back to "no models named" for a
     * file that failed to parse produces a refusal that is non-zero, on stderr,
     * and names `config.json` — indistinguishable from the case above by every
     * field but this one, and it would send an operator to add an extractor to a
     * file that already names one.
     */
    it('is refused as unreadable rather than read as naming nothing', () => {
      expect({
        shape: failureShape(run),
        namesTheFile: run.stderr.includes(CONFIG_FILE),
        readAsUnconfigured: /no extractor is configured/iu.test(run.stderr),
      }).toStrictEqual({ shape: REFUSED, namesTheFile: true, readAsUnconfigured: false });
    });
  });
});

describe('a configuration naming a module that is not the port it was named for', () => {
  let repository: Repo;
  let run: CliRun;

  beforeAll(async () => {
    repository = repo();
    repository.configure({
      embeddings: FAKE_WRONG_SHAPE_MODULE,
      adjudicator: FAKE_ADJUDICATOR_MODULE,
    });
    const filePath = repository.file(NOTEBOOK_FILE, notebookFileText());

    run = await runCli(['ingest', filePath], repository.root);
  }, 180_000);

  afterAll(() => {
    repository.close();
  });

  /*
   * Every field here is a discriminator, because the wrong build refuses too.
   * Dropping the load-time check leaves the object to fail at its first call
   * site, which in this order is still before any write — so an empty store and
   * a non-zero exit are what *both* builds produce, and the method name appears
   * in `TypeError: embeddings.embedBatch is not a function` either way.
   *
   * What differs is what the operator is told to do about it. Checked at load,
   * this is a `Config` refusal quoting `config.json` and the specifier that is
   * wrong — an edit they can make. Discovered at the call site it is a `Failed`
   * with a bare TypeError, which reads as kgmem being broken, and which in any
   * command whose first port call comes after a write would arrive with rows
   * already on disk.
   */
  it('refuses it as a configuration mistake, quoting the file and the method', () => {
    expect({
      code: run.code,
      shape: failureShape(run),
      namesTheFile: run.stderr.includes(CONFIG_FILE),
      namesTheMethod: run.stderr.includes(REQUIRED_EMBEDDING_METHOD),
      store: snapshot(repository.dbPath),
    }).toStrictEqual({
      code: ExitCode.Config,
      shape: REFUSED,
      namesTheFile: true,
      namesTheMethod: true,
      store: NOTHING,
    });
  });
});

describe('the exit codes a git hook branches on', () => {
  let repository: Repo;
  let bareRoot: string;
  let mistyped: CliRun;
  let unconfigured: CliRun;
  let contended: CliRun;

  beforeAll(async () => {
    repository = repo();
    repository.configure(WORKING_PORTS);
    const filePath = repository.file(NOTEBOOK_FILE, notebookFileText());

    // A path naming nothing readable: the operator typed it wrong.
    mistyped = await runCli(['ingest', join(repository.root, ABSENT_FILE)], repository.root);

    // A repository nobody has set up: nothing to act on until `init` runs.
    bareRoot = mkdtempSync(join(tmpdir(), 'kg-cli-codes-'));
    const strayPath = join(bareRoot, NOTEBOOK_FILE);
    writeFileSync(strayPath, notebookFileText(), 'utf8');
    unconfigured = await runCli(['ingest', strayPath], bareRoot);

    // A store another writer is holding: worth trying again later, unchanged.
    const holder = spawnWorker(holderPath, [repository.dbPath, String(HOLD_MS)]);
    if (!(await holder.ready)) throw new Error(`the lock holder died: ${(await holder.done).stderr}`);
    try {
      contended = await runCli(['ingest', filePath], repository.root);
    } finally {
      holder.kill();
      await holder.done;
    }
  }, 180_000);

  afterAll(() => {
    repository.close();
    rmSync(bareRoot, { recursive: true, force: true });
  });

  /*
   * §7.6 spends five codes rather than two because a caller acts on the
   * difference: a hook that finds the repository unconfigured should say so once
   * and carry on, where a hook that finds the store contended should try the
   * same command again later, and neither is the operator typing the command
   * wrong. Collapsing any pair still exits non-zero, still prints the right
   * sentence, and still passes every other test in this suite.
   *
   * Asserted as a set as well as by name: naming them alone would pass against a
   * table that had quietly given two reasons the same number.
   */
  it('tells a mistyped command, an unset-up repository and a contended store apart', () => {
    const codes = [mistyped.code, unconfigured.code, contended.code];

    expect({
      mistyped: mistyped.code,
      unconfigured: unconfigured.code,
      contended: contended.code,
      distinct: new Set(codes).size,
    }).toStrictEqual({
      mistyped: ExitCode.Usage,
      unconfigured: ExitCode.Config,
      contended: ExitCode.Failed,
      distinct: 3,
    });
  });
});

describe('what a refused ingest claims about the store it gave up on', () => {
  let repository: Repo;
  let run: CliRun;

  beforeAll(async () => {
    repository = repo();
    repository.configure(WORKING_PORTS);
    const filePath = repository.file(NOTEBOOK_FILE, notebookFileText());

    const holder = spawnWorker(holderPath, [repository.dbPath, String(HOLD_MS)]);
    if (!(await holder.ready)) throw new Error(`the lock holder died: ${(await holder.done).stderr}`);
    try {
      run = await runCli(['ingest', filePath], repository.root);
    } finally {
      holder.kill();
      await holder.done;
    }
  }, 180_000);

  afterAll(() => {
    repository.close();
  });

  /*
   * The run taken here is one where nothing *was* written — the lock is held
   * before the CLI starts, so it gives up on its first write — and the sentence
   * is still wrong, because it is the same sentence the same arm prints when
   * the timeout lands on the seventh chunk of eight. That is the whole point:
   * `refuse` is handed a `StoreBusyError` and nothing else, so a run that
   * committed a document, seven chunks and no jobs is indistinguishable from
   * this one. Asserting it against the arrangement where the claim happens to
   * be true is the strongest form of the test available at this boundary.
   *
   * `namesTheContention` and `reportedAsRawError` are both discriminators, and
   * both are needed. An absence passes for free against a run that fell over
   * before it reached the store, which is what the first rules out. The second
   * rules out the cheapest wrong GREEN: deleting the `StoreBusyError` arm
   * outright drops the error into `refuse`'s unnamed fallback, which prints
   * `StoreBusyError: …` — non-zero, still `Failed`, still free of the false
   * claim, and exactly the bare-name output `report.ts` argues an operator
   * reads as kgmem being broken.
   */
  it('does not tell the operator nothing was written, having no way to know that', () => {
    expect({
      claimsNothingWasWritten: CLAIMS_NOTHING_WAS_WRITTEN.test(run.stderr),
      namesTheContention: NAMES_THE_CONTENTION.test(run.stderr),
      reportedAsRawError: run.stderr.includes(StoreBusyError.name),
      refused: refusedOnItsOwnTerms(run),
    }).toStrictEqual({
      claimsNothingWasWritten: false,
      namesTheContention: true,
      reportedAsRawError: false,
      refused: true,
    });
  });

  /*
   * Fix A is a sentence, not a reclassification. The block above already pins
   * `Failed` for a contended store as one of three codes a hook tells apart;
   * what this adds is binding the code to *this* run — the one whose message
   * changes — so that rewording cannot quietly take the exit code with it, and
   * a hook that branches on 4 today branches on 4 after.
   */
  it('still exits with the contended-store code a git hook branches on', () => {
    expect({
      code: run.code,
      namesTheContention: NAMES_THE_CONTENTION.test(run.stderr),
    }).toStrictEqual({ code: ExitCode.Failed, namesTheContention: true });
  });
});
