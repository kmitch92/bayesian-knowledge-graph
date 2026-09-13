/**
 * `kgmem reflect` — §5.10's expensive half, reachable from a shell, including
 * when the model it needs is not there.
 *
 * ── The refusal is the load-bearing half of this file ───────────────────────
 *
 * Nothing in `src/` implements {@link Extractor}. That is deliberate: the
 * extraction prompt is this system's precision ceiling and gets its own phase.
 * So the ordinary state of `reflect` today, and for as long as that phase takes,
 * is *"no extractor configured"* — which makes the refusal the common path
 * rather than the corner case, and makes three of its properties non-negotiable.
 *
 * **It must not crash.** A stack trace tells an operator that kgmem is broken.
 * It is not broken; it is unconfigured, and the difference is a five-line edit
 * to a file the message can name.
 *
 * **It must not succeed.** A `reflect` that exits 0 having mined nothing reads,
 * in a cron entry or a session-end hook, as a backlog that is always empty. The
 * queue would grow forever behind a green tick.
 *
 * **It must not spend the queue.** This is the arm with real teeth. §9's
 * `claimJob` is one atomic statement and a claimed job is *gone* from the
 * pending set; a drain that claimed a job, discovered it had no model and died
 * would leave that chunk `running` and unclaimable forever — work parked by
 * §5.10 and then lost, which is worse than never having run. Even the polite
 * version is wrong here: handing the job back with an attempt counted and a
 * `retryAt` a minute out means a configuration error burns the retry budget of
 * every chunk in the backlog, and §9's `failJob` docblock leaves that budget for
 * a caller to cap. The extractor's absence is knowable before the queue is
 * touched, so the queue must not be touched.
 *
 * The last of those is why `claimableNow` exists rather than a state count: a
 * job handed back with a future `retryAt` is `pending` and is not claimable, and
 * only asking the queue for it can tell the two apart.
 *
 * ── The other half ──────────────────────────────────────────────────────────
 *
 * With an extractor configured, `reflect` drains and the members land — through
 * `openIngest.submit()`, the same door an agent's `observe` uses, which is what
 * `memberTexts` reads back. The queue is deliberately shallow (three chunks), so
 * nothing here pins whether a single invocation is allowed a per-run ceiling;
 * what it pins is that an operator who runs `reflect` over a backlog this size
 * does not have to run it again.
 *
 * @spec §1, §4.2, §5.10, §7.6, §9, §11, §12
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXTRACT_JOB_KIND, chunkText, type TextSource } from '../../../extract/index';
import { memberTexts } from '../../../extract/__tests__/extraction-fixtures';

import { ExitCode } from '../commands';

import {
  CONFIG_FILE,
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  FAKE_EXTRACTOR_MODULE,
  NOTEBOOK_FILE,
  REFUSED,
  claimableNow,
  failureShape,
  notebookFileText,
  queueStates,
  refusedOnItsOwnTerms,
  repo,
  runCli,
  seedIngest,
  snapshot,
  withStore,
  type CliRun,
  type Repo,
} from './cli-fixtures';

import { MEMBERS_PER_CHUNK, MEMBER_MARK } from './fake-extractor-module';

/** How many chunks the seeded document parks jobs for. @spec §5.10 */
const parkedChunks = (source: TextSource): number => chunkText(source.text).length;

/**
 * Fills the queue in this process, through E2's own ingress.
 *
 * Neither describe below is about how the jobs got there, and `kgmem ingest` has
 * its own file. Seeding through `openTextIngest` rather than through a second
 * spawn keeps the jobs identical to the ones the CLI parks — same payload, same
 * episode — while costing no process.
 *
 * @spec §5.10, §9
 */
const seedThroughTheRealIngress = async (
  repository: Repo,
  filePath: string,
): Promise<TextSource> => seedIngest(repository.dbPath, filePath);

describe('reflecting with no extractor configured', () => {
  let repository: Repo;
  let source: TextSource;
  let run: CliRun;

  beforeAll(async () => {
    repository = repo();
    repository.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      adjudicator: FAKE_ADJUDICATOR_MODULE,
    });
    const filePath = repository.file(NOTEBOOK_FILE, notebookFileText());
    source = await seedThroughTheRealIngress(repository, filePath);

    run = await runCli(['reflect'], repository.root);
  }, 180_000);

  afterAll(() => {
    repository.close();
  });

  it('refuses as a failure of its own, not as an unimplemented stub and not as a crash', () => {
    expect(failureShape(run)).toStrictEqual(REFUSED);
  });

  /*
   * Both halves. "extractor" alone is a diagnosis; the configuration file is
   * the cure, and a refusal that names only the first leaves an operator to
   * grep the source for the second.
   */
  it('says what is missing and where to put it, on stderr', () => {
    expect({
      namesTheMissingPort: /extractor/iu.test(run.stderr),
      namesWhereItGoes: run.stderr.includes(CONFIG_FILE),
    }).toStrictEqual({ namesTheMissingPort: true, namesWhereItGoes: true });
  });

  /*
   * `refused` rides along in this assertion on purpose. Every other field here
   * describes a queue nobody touched, which is also what the P0 stub leaves
   * behind — so without the discriminator this test would pass today against a
   * binary that never looked for an extractor at all.
   */
  it('leaves every parked job unclaimed, unattempted and claimable right now', () => {
    const parked = parkedChunks(source);
    const before = snapshot(repository.dbPath).jobs;

    expect({
      states: queueStates(before),
      attempts: before.reduce((total, job) => total + job.attempts, 0),
      claimable: claimableNow(repository.dbPath, EXTRACT_JOB_KIND),
      refused: refusedOnItsOwnTerms(run),
    }).toStrictEqual({
      states: { pending: parked, running: 0, done: 0, failed: 0 },
      attempts: 0,
      claimable: parked,
      refused: true,
    });
  });

  it('writes no member, since it read nothing', () => {
    expect({
      members: withStore(repository.dbPath, memberTexts),
      refused: refusedOnItsOwnTerms(run),
    }).toStrictEqual({ members: [], refused: true });
  });
});

describe('reflecting with an extractor configured', () => {
  let repository: Repo;
  let source: TextSource;
  let run: CliRun;

  beforeAll(async () => {
    repository = repo();
    repository.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      adjudicator: FAKE_ADJUDICATOR_MODULE,
      extractor: FAKE_EXTRACTOR_MODULE,
    });
    const filePath = repository.file(NOTEBOOK_FILE, notebookFileText());
    source = await seedThroughTheRealIngress(repository, filePath);

    run = await runCli(['reflect'], repository.root);
  }, 180_000);

  afterAll(() => {
    repository.close();
  });

  it('succeeds without saying anything on the stdout the transports own', () => {
    expect({ code: run.code, stdout: run.stdout, reported: run.stderr.length > 0 }).toStrictEqual({
      code: ExitCode.Ok,
      stdout: '',
      reported: true,
    });
  });

  it('reports its tally with a failure count of zero, and nothing else', () => {
    const parked = parkedChunks(source);

    expect(run.stderr.split('\n').filter((line) => line.startsWith('kgmem: '))).toStrictEqual([
      `kgmem: reflected over ${String(parked)} chunks: ${String(parked * MEMBERS_PER_CHUNK)} members admitted, 0 rejected, 0 failed`,
    ]);
  });

  it('settles every job the ingest parked, leaving none running and none waiting', () => {
    const parked = parkedChunks(source);

    expect(queueStates(snapshot(repository.dbPath).jobs)).toStrictEqual({
      pending: 0,
      running: 0,
      done: parked,
      failed: 0,
    });
  });

  /*
   * Read through `memberTexts`, which filters the spine out: every existence
   * and naming claim §5.2's ladder had to mint on the way is in the ledger too,
   * and counting those as members would make this pass at any drain depth.
   */
  it('writes a member for every chunk it read, through the one ingest door', () => {
    const members = withStore(repository.dbPath, memberTexts);

    expect({
      count: members.length,
      allFromTheExtractor: members.every((text) => text.includes(MEMBER_MARK)),
    }).toStrictEqual({
      count: parkedChunks(source) * MEMBERS_PER_CHUNK,
      allFromTheExtractor: true,
    });
  });
});
