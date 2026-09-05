/**
 * Shared fixtures for E5: driving the `kgmem` binary, and reading what it left.
 *
 * ── Why these tests spawn a real process ────────────────────────────────────
 *
 * `job-claim-race.test.ts` pays for three real processes because better-sqlite3
 * is synchronous and one Node process cannot race itself. E5's reason is a
 * different one that points the same way: what this phase is *about* is the
 * boundary a process has — an exit code, a stdout, a stderr, and the wall-clock
 * seconds an operator waits before reaching for ^C. Every one of those is a
 * property of the process, not of a function inside it. A harness that imported
 * a command function and spied on `process.stdout.write` would be asserting
 * against the spy: it could not tell stdout from stderr at the file descriptor
 * an MCP host actually reads, could not see the exit code a git hook branches
 * on, and could not tell "the CLI gave up after two seconds" apart from "the CLI
 * returned a rejected promise nobody awaited".
 *
 * There is a blunter reason too. `../index.ts` ends in `process.exitCode =
 * run(process.argv.slice(2))`, so importing it *runs the CLI* against vitest's
 * own argv. An in-process harness would have to change that first, which means
 * the suite would be pinning a factoring rather than a behaviour — and E5 would
 * be free to keep the entry point exactly as it is.
 *
 * The cost is managed the way `job-claim-race.test.ts` manages it: **one run per
 * scenario**, taken in a `beforeAll` and read from several directions by several
 * `it`s. Seeding is done in-process through the real ports wherever the thing
 * under test is not the seeding — `seedIngest` below parks the queue `reflect`
 * drains without spending a second process on it.
 *
 * ── Two conventions this suite establishes, and why they are here ───────────
 *
 * No command in the P0 skeleton opens a store, so nothing yet says where the
 * store *is* or how a model port is chosen. Both answers have to exist before
 * `ingest` can write a row or `reflect` can refuse for want of an extractor, so
 * both are settled here and reported. They are rulings, not readings of the
 * spec: see the report for the argument, and {@link KGMEM_DIR} and
 * {@link CONFIG_FILE} for the one edit each would cost to change.
 *
 * 1. **The store is `<root>/.kgmem/graph.db`**, where `<root>` is the nearest
 *    ancestor of the working directory holding a `.kgmem` directory. This
 *    follows `init <repo-path>`: the graph belongs to a repository, `init`
 *    creates the directory, and every other transport — an MCP server per
 *    session, a git hook, a cron entry — finds it by being run inside the
 *    repository, which is the one thing they all share. A run that finds no
 *    `.kgmem` refuses rather than creating one, for `git init`'s reason: a tool
 *    that silently makes a store wherever it was invoked leaves stray graphs
 *    around and reports success for work that went nowhere.
 * 2. **The model ports are named in `<root>/.kgmem/config.json`**, as module
 *    specifiers, because a model port cannot be a hard-coded import: the write
 *    path has to run without one. Config rather than environment because hooks
 *    and cron entries inherit an environment nobody controls but do run inside
 *    the repository. Absent means absent — a stub that refuses and says how to
 *    configure it — except for embeddings, which have a real local adapter to
 *    fall back on.
 *
 * ── What is faked, and what is not ──────────────────────────────────────────
 *
 * The store is never faked: real SQLite in a real temp directory, real vectors
 * at the real width, opened by the CLI as a second process over the same file.
 * Three model ports are stood in for and no others — the `EmbeddingProvider`
 * (§5.3), the `Adjudicator` (§5.2) and the `Extractor` (§5.10) — which is this
 * repo's established line, and here it is also the only affordable one: the real
 * embedding provider loads ONNX weights, and the real extractor does not exist.
 *
 * @spec §5.7, §5.9, §5.10, §7.6, §9, §10, §11
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { documentSource, openTextIngest, type TextSource } from '../../../extract/index';
import type { Origin } from '../../../ingest/index';
import { openGraphStore, type GraphStore } from '../../../store/index';
import {
  COSINE_FLOOR,
  TAU_PROMOTE,
  fakeAdjudicator,
  fakeEmbeddings,
} from '../../../referents/__tests__/fixtures';
import { notebook } from '../../../extract/__tests__/fixtures';

import { ExitCode } from '../commands';

/*
 * ---------------------------------------------------------------------------
 * The two conventions.
 * ---------------------------------------------------------------------------
 */

/** The directory `init` leaves in a repository, and every other command finds. @spec §7.6 */
export const KGMEM_DIR = '.kgmem';

/** The store, inside it. @spec §11 */
export const STORE_FILE = 'graph.db';

/**
 * The configuration, beside it.
 *
 * Named in the refusal `reflect` produces when no extractor is configured, which
 * is what makes that refusal actionable rather than merely correct.
 *
 * @spec §5.10, §7.6
 */
export const CONFIG_FILE = 'config.json';

/**
 * Environment variables the CLI is not allowed to be influenced by in a fixture.
 *
 * Nothing here pins an environment variable as part of the design — the point is
 * the opposite. A developer with `KGMEM_*` set in their shell must not change
 * what these tests measure, and a CI runner that has none must not measure
 * something different from a laptop that does.
 */
const ENV_PREFIX = 'KGMEM';

/** The binary under test, run from source. @spec §7.6 */
const CLI_PATH = fileURLToPath(new URL('../index.ts', import.meta.url));

/**
 * The TypeScript loader, as an absolute URL rather than the bare `tsx` other
 * fixtures pass.
 *
 * A bare specifier on `--import` is resolved against the child's *working
 * directory*, and a CLI run's working directory is a temp repository with no
 * `node_modules` above it — so `--import tsx` fails there with
 * `ERR_MODULE_NOT_FOUND` before the CLI runs at all. `job-drain-worker.ts` never
 * meets this because its workers inherit this project's cwd. Resolved from this
 * module instead, so the child loads the same loader the test process did.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** The module `.kgmem/config.json` names for §5.3's port. @spec §5.3 */
export const FAKE_EMBEDDINGS_MODULE = fileURLToPath(
  new URL('./fake-embeddings-module.ts', import.meta.url),
);

/** The module `.kgmem/config.json` names for §5.2's port. @spec §5.2 */
export const FAKE_ADJUDICATOR_MODULE = fileURLToPath(
  new URL('./fake-adjudicator-module.ts', import.meta.url),
);

/** The module `.kgmem/config.json` names for §5.10's port. @spec §5.10 */
export const FAKE_EXTRACTOR_MODULE = fileURLToPath(
  new URL('./fake-extractor-module.ts', import.meta.url),
);

/**
 * The model ports a configuration names, each as a module specifier.
 *
 * Every field optional, and that is the shape of the ruling: a store with no
 * extractor configured is the ordinary state of this system today, not a broken
 * one.
 *
 * @spec §5.2, §5.3, §5.10
 */
export interface ModelModules {
  readonly embeddings?: string;
  readonly adjudicator?: string;
  readonly extractor?: string;
}

/*
 * ---------------------------------------------------------------------------
 * The corpus.
 * ---------------------------------------------------------------------------
 */

/**
 * How many paragraphs the ingested file holds.
 *
 * Three, not one: "one job per chunk" is satisfied by accident at one chunk, and
 * a `reflect` that drained a single job would look like one that drained the
 * queue. Three is also small enough that draining it says nothing about any
 * per-invocation ceiling a later phase might want — see `reflect-command.test.ts`.
 *
 * @spec §5.10
 */
export const INGEST_PARAGRAPHS = 3;

/** What the file is called on disk. Its stem becomes the document's title. @spec §3.6 */
export const NOTEBOOK_FILE = 'winter-overhaul.md';

/** The file's bytes: E2's own corpus, reused so nothing here invents a second one. */
export const notebookFileText = (): string => notebook(INGEST_PARAGRAPHS);

/**
 * The submitter the fixture uses when it derives what the CLI *should* have
 * written.
 *
 * A document's id and title are functions of its path and its bytes alone (E4),
 * so the provenance a test passes cannot move either — which is what makes
 * {@link sourceFor} a legitimate way to compute the expected id without
 * duplicating E4's `file:` prefix here. The CLI will supply a provenance of its
 * own, and nothing below asserts what it is.
 *
 * @spec §3.5, §3.6
 */
export const FIXTURE_PROVENANCE: Origin = {
  episodeId: 'ep-e5-cli-fixture',
  channel: 'test-harness',
};

/** What E4 says a file at this path is, as a document. @spec §3.6 */
export const sourceFor = async (path: string): Promise<TextSource> =>
  documentSource({ path, provenance: FIXTURE_PROVENANCE });

/*
 * ---------------------------------------------------------------------------
 * A repository to run in.
 * ---------------------------------------------------------------------------
 */

/** A temp directory shaped like a repository `kgmem init` has already run in. */
export interface Repo {
  /** The working directory a CLI run is given. */
  readonly root: string;
  /** Where the store is, by the convention above. */
  readonly dbPath: string;
  /** Writes a file at the repository root and answers with its absolute path. */
  file(name: string, text: string): string;
  /** Writes `.kgmem/config.json`, naming the modules the CLI is to use. */
  configure(models: ModelModules): void;
  close(): void;
}

/**
 * A repository with a migrated, empty store in it — what `kgmem init` leaves.
 *
 * The store is created by opening it, because that is the only thing in this
 * codebase that knows how to make one, and because a file made any other way
 * would test the CLI against a schema no `GraphStore` ever wrote.
 *
 * @spec §11
 */
export const repo = (): Repo => {
  const root = mkdtempSync(join(tmpdir(), 'kg-cli-repo-'));
  const home = join(root, KGMEM_DIR);
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, STORE_FILE);
  openGraphStore({ path: dbPath }).close();

  return {
    root,
    dbPath,
    file: (name, text) => {
      const path = join(root, name);
      writeFileSync(path, text, 'utf8');
      return path;
    },
    configure: (models) => {
      writeFileSync(join(home, CONFIG_FILE), `${JSON.stringify({ models }, null, 2)}\n`, 'utf8');
    },
    close: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/** A directory with no `.kgmem` in it and none above it. */
export interface BareWorkspace {
  readonly root: string;
  file(name: string, text: string): string;
  close(): void;
}

/** @spec §7.6 */
export const bareWorkspace = (): BareWorkspace => {
  const root = mkdtempSync(join(tmpdir(), 'kg-cli-bare-'));
  return {
    root,
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

/*
 * ---------------------------------------------------------------------------
 * Running the binary.
 * ---------------------------------------------------------------------------
 */

/** What one `kgmem` invocation did, from outside it. @spec §7.6 */
export interface CliRun {
  /** `null` when the process died without one, which no assertion here accepts. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Wall clock, start of spawn to exit. The only honest read of "how long an operator waits". */
  readonly elapsedMs: number;
}

/** The environment a run gets: this one, minus anything that could speak for the fixture. */
const hermeticEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith(ENV_PREFIX)),
  );

/**
 * Runs `kgmem` as a real child process and collects both streams and its code.
 *
 * `--import tsx` is what `job-drain-worker.ts` uses and for the same reason: the
 * child runs the same TypeScript the test imports, rather than a build output
 * that could drift from it. It also means a module specifier in
 * `.kgmem/config.json` may name a `.ts` file, which is how the faked ports below
 * are loaded.
 *
 * @spec §7.6
 */
export const runCli = async (args: readonly string[], cwd: string): Promise<CliRun> => {
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_PATH, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: hermeticEnv(),
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise<CliRun>((resolve) => {
    child.on('error', (error: Error) => {
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        elapsedMs: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
};

/*
 * ---------------------------------------------------------------------------
 * Telling a refusal from a stub.
 * ---------------------------------------------------------------------------
 */

/**
 * The five things that separate "this command refused" from "this command is not
 * wired up yet".
 *
 * `pathway-signature.test.ts`'s `refusalFrom` makes the argument: a store that
 * refuses for an unrelated reason satisfies `toThrow` just as well as the right
 * one and never shows which rule did the refusing. Here the unrelated reason is
 * always available, in *two* shapes, and both are traps:
 *
 * - `reportedAsUnimplemented` — `reflect` has a row in the table and exits 2
 *   with NOT_IMPLEMENTED, so an assertion on the exit code alone passes against
 *   a binary that never looked for an extractor.
 * - `reportedAsUnroutable` — `ingest` has no row at all, so the router prints
 *   `unknown command 'ingest <path>'` *followed by the whole help text*, on
 *   stderr, and exits 1. That message quotes the argv it was given and lists
 *   every subcommand, which means it contains the path the CLI supposedly could
 *   not read and the word `init` an operator supposedly needs. Both of those are
 *   things a real refusal must say, so both would pass today without this field.
 *
 * `codeIsFromTheTable` reads {@link ExitCode} live rather than naming a number,
 * so a later phase that adds a justified code (§7.6 asks for the reason, not for
 * the number) is accommodated, while a hand-rolled `process.exit(17)` is not.
 *
 * @spec §7.6
 */
export interface FailureShape {
  readonly exitedNonZero: boolean;
  readonly codeIsFromTheTable: boolean;
  readonly reportedAsUnimplemented: boolean;
  readonly reportedAsUnroutable: boolean;
  readonly wroteToStdout: boolean;
}

/** What every refusal in this suite must look like. @spec §7.6 */
export const REFUSED: FailureShape = {
  exitedNonZero: true,
  codeIsFromTheTable: true,
  reportedAsUnimplemented: false,
  reportedAsUnroutable: false,
  wroteToStdout: false,
};

/** @spec §7.6 */
export const failureShape = (run: CliRun): FailureShape => ({
  exitedNonZero: run.code !== ExitCode.Ok,
  codeIsFromTheTable: (Object.values(ExitCode) as readonly number[]).includes(run.code ?? -1),
  reportedAsUnimplemented: run.stderr.includes('NOT_IMPLEMENTED'),
  reportedAsUnroutable: run.stderr.includes('unknown command'),
  wroteToStdout: run.stdout.length > 0,
});

/**
 * Whether the CLI failed on its own terms.
 *
 * Carried into the assertions whose *expected* end state is also the state a
 * command that did nothing leaves behind — an untouched queue, an unwritten
 * store, a directory with no `.kgmem` in it. Those are the properties that
 * matter most and the ones that pass most easily for the wrong reason, so each
 * of them asserts this alongside.
 *
 * @spec §7.6
 */
export const refusedOnItsOwnTerms = (run: CliRun): boolean => {
  const shape = failureShape(run);
  return shape.exitedNonZero && !shape.reportedAsUnimplemented && !shape.reportedAsUnroutable;
};

/*
 * ---------------------------------------------------------------------------
 * Reading what the run left in the store.
 * ---------------------------------------------------------------------------
 */

/** Opens the store for one read and closes it, so no fixture holds a lock. @spec §11 */
export const withStore = <T>(dbPath: string, read: (store: GraphStore) => T): T => {
  const store = openGraphStore({ path: dbPath });
  try {
    return read(store);
  } finally {
    store.close();
  }
};

/** One queue row, as the table holds it. @spec §9 */
export interface JobRow {
  readonly id: number;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly payload: unknown;
}

/** One chunk row, as the table holds it. @spec §3.6 */
export interface ChunkRow {
  readonly documentId: string;
  readonly ordinal: number;
  readonly hash: string;
}

/**
 * Everything a run could have written that this suite reads.
 *
 * Taken straight off the file rather than through the port, for
 * `job-claim-race.test.ts`'s reason: the port has no "list every document" and
 * no "show me the queue", and a snapshot built out of the reads it does have
 * would be a snapshot of the ids the test already knew to ask about — which is
 * exactly the wrong instrument for *"the CLI wrote nothing"*.
 *
 * @spec §3.6, §9
 */
export interface Snapshot {
  readonly documents: readonly string[];
  readonly chunks: readonly ChunkRow[];
  readonly jobs: readonly JobRow[];
}

const parsePayload = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/** @spec §3.6, §9 */
export const snapshot = (dbPath: string): Snapshot => {
  // Not `readonly: true`: a read-only connection cannot create the `-shm` file a
  // WAL database needs, so it fails on exactly the store this suite produces.
  const db = new Database(dbPath);
  try {
    const documents = db.prepare('SELECT id FROM documents ORDER BY id').all() as readonly {
      readonly id: string;
    }[];
    const chunks = db
      .prepare(
        'SELECT document_id AS documentId, ordinal, hash FROM document_chunks ORDER BY document_id, ordinal',
      )
      .all() as readonly ChunkRow[];
    const jobs = db
      .prepare('SELECT id, kind, state, attempts, payload FROM jobs ORDER BY id')
      .all() as readonly {
      readonly id: number;
      readonly kind: string;
      readonly state: string;
      readonly attempts: number;
      readonly payload: string;
    }[];

    return {
      documents: documents.map((row) => row.id),
      chunks: chunks.map((row) => ({
        documentId: row.documentId,
        ordinal: row.ordinal,
        hash: row.hash,
      })),
      jobs: jobs.map((row) => ({
        id: row.id,
        kind: row.kind,
        state: row.state,
        attempts: row.attempts,
        payload: parsePayload(row.payload),
      })),
    };
  } finally {
    db.close();
  }
};

/** Nothing at all: what a refused command must leave behind. @spec §7.6 */
export const NOTHING: Snapshot = { documents: [], chunks: [], jobs: [] };

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** A queue row projected onto what an extract job is *for*. @spec §5.10, §9 */
export interface ExtractJobShape {
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly documentId: unknown;
  readonly ordinal: unknown;
  readonly hash: unknown;
}

/** @spec §5.10, §9 */
export const extractJobShape = (row: JobRow): ExtractJobShape => {
  const payload = asRecord(row.payload);
  return {
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    documentId: payload['documentId'],
    ordinal: payload['ordinal'],
    hash: payload['hash'],
  };
};

/**
 * The episode a parked job attributes its chunk to.
 *
 * Read off the queue rather than derived, because the `document:` prefix E2
 * builds it from is private to `text-ingest.ts` and restating it here would be a
 * second copy of a rule with one owner. `''` when there is no job to read it
 * from, so a suite with an empty queue fails on the assertion it meant rather
 * than on a thrown fixture.
 *
 * @spec §4.2, §5.10
 */
export const episodeFrom = (row: JobRow | undefined): string => {
  const value = asRecord(row?.payload)['episodeId'];
  return typeof value === 'string' ? value : '';
};

/** How many jobs sit in each state. @spec §9 */
export interface QueueStates {
  readonly pending: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
}

/** @spec §9 */
export const queueStates = (jobs: readonly JobRow[]): QueueStates => ({
  pending: jobs.filter((job) => job.state === 'pending').length,
  running: jobs.filter((job) => job.state === 'running').length,
  done: jobs.filter((job) => job.state === 'done').length,
  failed: jobs.filter((job) => job.state === 'failed').length,
});

/**
 * How many jobs of one kind the queue will hand out *right now*.
 *
 * The sharp end of *"leaves every job claimable"*. A job handed back with a
 * `retryAt` a minute in the future is `pending` and is not claimable, and a
 * state count alone cannot tell the two apart — which is the difference between
 * a refusal that cost nothing and one that quietly delayed the backlog.
 *
 * Mutating, and knowingly: this claims the jobs it counts. Call it last.
 *
 * @spec §9
 */
export const claimableNow = (dbPath: string, kind: string, ceiling = 1_000): number =>
  withStore(dbPath, (store) => {
    for (let taken = 0; taken < ceiling; taken += 1) {
      if (store.claimJob(kind) === undefined) return taken;
    }
    throw new Error(`the ${kind} queue never emptied`);
  });

/*
 * ---------------------------------------------------------------------------
 * Seeding the queue the drain is supposed to work.
 * ---------------------------------------------------------------------------
 */

/**
 * Puts a file through E2's ingress in this process, exactly as `kgmem ingest`
 * will.
 *
 * `reflect`'s tests are about the drain, not about how the queue got filled, so
 * they do not spend a second process on filling it. Using the real
 * `openTextIngest` rather than hand-written rows is what makes the jobs
 * indistinguishable from the ones the CLI parks — including the payload the
 * drain parses and the episode it attributes members to.
 *
 * @spec §5.10, §9
 */
export const seedIngest = async (dbPath: string, path: string): Promise<TextSource> => {
  const store = openGraphStore({ path: dbPath });
  try {
    const source = await sourceFor(path);
    const text = openTextIngest({
      store,
      embeddings: fakeEmbeddings(),
      adjudicator: fakeAdjudicator(),
      cosineFloor: COSINE_FLOOR,
      tauPromote: TAU_PROMOTE,
    });
    await text.submitText(source);
    return source;
  } finally {
    store.close();
  }
};
