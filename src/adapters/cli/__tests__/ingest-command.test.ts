/**
 * `kgmem ingest <path>` — the command that makes §5.10's universal ingress
 * reachable from a shell.
 *
 * E2 built the cheap half (*"chunk, embed, anchor — the document serves whole
 * immediately"*), E4 built the two ways text arrives, and neither is reachable
 * from anywhere but a test. This file pins the wiring between them: a path in,
 * a document row, its chunks and one parked job per chunk out.
 *
 * ── What is asserted, and where ─────────────────────────────────────────────
 *
 * **Through the store, never through the printed output.** What `ingest` prints
 * is an operator's convenience; what it wrote is the system. A suite that read
 * the report would pass against a command that printed a summary and wrote
 * nothing, which is precisely the failure a first wiring produces. The only
 * claims made about the streams here are the ones that are *about* the streams:
 * stdout stays empty because `mcp` will own it for protocol and the hook
 * subcommands run with it consumed by the host (§10, §7.6).
 *
 * ── The three properties, and why each one has teeth ────────────────────────
 *
 * 1. **A real document in a real store.** The id is not restated here — E4 makes
 *    it a function of the path, and `sourceFor` computes it by calling the same
 *    `documentSource` the CLI must call. A command that invented its own id, or
 *    that read the file some other way, disagrees with it.
 * 2. **A missing path costs nothing.** Non-zero, actionable, and — the arm that
 *    matters — *nothing written*. E4 throws `UnreadableDocumentError` before it
 *    returns anything, so there is nothing to write; this pins that the CLI does
 *    not manage to write a half-document on the way to reporting the failure.
 * 3. **A second ingest of an unchanged file is free.** E2 already gives this:
 *    a job is parked for a chunk whose anchor the previous chunking did not
 *    hold, and for no other, *"so an unchanged document parks nothing at all"*.
 *    The CLI can defeat it in one line — a fresh id per run, a timestamped
 *    title, a re-read that normalizes bytes — and the queue silently doubles on
 *    every commit. Comparing the whole queue before and after is what catches
 *    that.
 *
 * @spec §3.6, §5.8, §5.10, §7.6, §9, §11
 */

import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXTRACT_JOB_KIND, chunkText, type TextSource } from '../../../extract/index';

import { ExitCode } from '../commands';

import {
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  NOTEBOOK_FILE,
  NOTHING,
  REFUSED,
  episodeFrom,
  extractJobShape,
  failureShape,
  notebookFileText,
  refusedOnItsOwnTerms,
  repo,
  runCli,
  snapshot,
  sourceFor,
  withStore,
  type CliRun,
  type Repo,
  type Snapshot,
} from './cli-fixtures';

/** A path in the repository with no file behind it. */
const ABSENT_FILE = 'never-written.md';

/**
 * §5.8's stage name for E2's half of the pipeline.
 *
 * Named here because it is the one piece of evidence that separates *"the CLI
 * called `submitText`"* from *"the CLI wrote the same rows itself"*. §1 allows
 * exactly one door — *"every source of knowledge writes claims through one
 * ingest port"* — and a second write path is invisible in the tables it happens
 * to produce correctly, right up until it produces one incorrectly.
 *
 * @spec §1, §5.8
 */
const INGEST_STAGE = 'text-ingest';

describe('ingesting a file that is there', () => {
  let repository: Repo;
  let filePath: string;
  let source: TextSource;
  let first: CliRun;
  let second: CliRun;
  let afterFirst: Snapshot;
  let afterSecond: Snapshot;

  /*
   * One scenario, two runs, two snapshots, read from seven directions below.
   * `job-claim-race.test.ts`'s arrangement and its reason: spawning a process
   * per assertion would be the slowest fixture in the suite, and every
   * assertion here is about the same two runs anyway.
   */
  beforeAll(async () => {
    repository = repo();
    repository.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      adjudicator: FAKE_ADJUDICATOR_MODULE,
    });
    filePath = repository.file(NOTEBOOK_FILE, notebookFileText());
    source = await sourceFor(filePath);

    first = await runCli(['ingest', filePath], repository.root);
    afterFirst = snapshot(repository.dbPath);
    second = await runCli(['ingest', filePath], repository.root);
    afterSecond = snapshot(repository.dbPath);
  }, 180_000);

  afterAll(() => {
    repository.close();
  });

  it('writes one document, under the id the file’s own path gives it', () => {
    expect(afterFirst.documents).toStrictEqual([source.id]);
  });

  it('stores the file’s bytes and its name, neither reflowed nor decorated', () => {
    const document = withStore(repository.dbPath, (store) => store.getDocument(source.id));

    expect({
      title: document?.title,
      origin: document?.origin,
      contentRef: document?.contentRef,
    }).toStrictEqual({ title: source.title, origin: 'authored', contentRef: source.text });
  });

  it('cuts it at its own paragraph boundaries, one chunk row per paragraph', () => {
    expect(afterFirst.chunks).toStrictEqual(
      chunkText(source.text).map((chunk) => ({
        documentId: source.id,
        ordinal: chunk.ordinal,
        hash: chunk.hash,
      })),
    );
  });

  it('parks exactly one extraction job per chunk, each naming the chunk it is for', () => {
    expect(afterFirst.jobs.map(extractJobShape)).toStrictEqual(
      chunkText(source.text).map((chunk) => ({
        kind: EXTRACT_JOB_KIND,
        state: 'pending',
        attempts: 0,
        documentId: source.id,
        ordinal: chunk.ordinal,
        hash: chunk.hash,
      })),
    );
  });

  it('goes through §5.10’s ingress rather than writing those rows itself', () => {
    const episodeId = episodeFrom(afterFirst.jobs[0]);

    const stages = withStore(repository.dbPath, (store) =>
      store.readStageLog(episodeId).map((entry) => entry.stage),
    );

    expect(stages).toContain(INGEST_STAGE);
  });

  it('succeeds without saying anything on the stdout the transports own', () => {
    expect({ code: first.code, stdout: first.stdout, reported: first.stderr.length > 0 }).toStrictEqual(
      { code: ExitCode.Ok, stdout: '', reported: true },
    );
  });

  /*
   * The whole queue, not a count of it: a CLI that parked three fresh jobs for
   * the same three unchanged chunks has the same *number* of jobs after the
   * second run if it also happened to complete the first three, and a count
   * would call that unchanged.
   */
  it('parks nothing and rewrites nothing when the same unchanged file arrives again', () => {
    expect({
      code: second.code,
      documents: afterSecond.documents,
      chunks: afterSecond.chunks,
      jobs: afterSecond.jobs,
    }).toStrictEqual({
      code: ExitCode.Ok,
      documents: afterFirst.documents,
      chunks: afterFirst.chunks,
      jobs: afterFirst.jobs,
    });
  });
});

describe('ingesting a path with no file behind it', () => {
  let repository: Repo;
  let absentPath: string;
  let run: CliRun;

  beforeAll(async () => {
    repository = repo();
    repository.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      adjudicator: FAKE_ADJUDICATOR_MODULE,
    });
    absentPath = join(repository.root, ABSENT_FILE);

    run = await runCli(['ingest', absentPath], repository.root);
  }, 180_000);

  afterAll(() => {
    repository.close();
  });

  /*
   * `REFUSED` rather than "exits non-zero", because every subcommand in the P0
   * skeleton exits non-zero already: an assertion on the code alone passes
   * against a binary that never opened the store or looked for the file.
   */
  it('refuses it as a failure of its own, not as an unimplemented stub', () => {
    expect(failureShape(run)).toStrictEqual(REFUSED);
  });

  /*
   * `refusedOnItsOwnTerms` rides along because today's unknown-command message
   * quotes the argv it was handed — path included — so the first field alone
   * passes against a router that never opened a file.
   */
  it('names the path it could not read, so an operator can fix the command', () => {
    expect({
      namesThePath: run.stderr.includes(absentPath),
      refused: refusedOnItsOwnTerms(run),
    }).toStrictEqual({ namesThePath: true, refused: true });
  });

  /*
   * Same guard, for the stronger reason: an empty store is exactly what a
   * command that did nothing at all leaves behind.
   */
  it('leaves the store exactly as it found it: no document, no chunk, no parked job', () => {
    expect({
      store: snapshot(repository.dbPath),
      refused: refusedOnItsOwnTerms(run),
    }).toStrictEqual({ store: NOTHING, refused: true });
  });
});
