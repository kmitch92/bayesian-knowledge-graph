/**
 * `kgmem reflect` — §5.10's expensive half, from a shell, including when the
 * model it needs is not there.
 *
 * ── The refusal comes before the queue is touched ───────────────────────────
 *
 * Nothing in `src/` implements {@link Extractor}, so *"no extractor
 * configured"* is this command's ordinary state rather than its corner case, and
 * three properties of the refusal are non-negotiable.
 *
 * It must not crash: kgmem is not broken, it is unconfigured, and the difference
 * is a five-line edit to a file the message names. It must not succeed: a
 * `reflect` that exits 0 having mined nothing reads, in a cron entry or a
 * session-end hook, as a backlog that is always empty. And **it must not spend
 * the queue**: §9's `claimJob` is one atomic statement and a claimed job is gone
 * from the pending set, so a drain that claimed a job and then discovered it had
 * no model would leave that chunk `running` and unclaimable forever. Even handing
 * the job back is wrong here — an attempt counted and a `retryAt` a minute out
 * means a configuration error burns the retry budget §9 leaves a caller to cap.
 *
 * The extractor's absence is knowable from a JSON file, so it is checked from
 * that file: {@link requirePort} reads the configuration before the store is
 * opened, let alone claimed against.
 *
 * ── The drain ───────────────────────────────────────────────────────────────
 *
 * With an extractor configured this drains until §9's queue answers with
 * nothing, which is E3's own "no work left" signal rather than a count this
 * module invents. No per-invocation ceiling is pinned: an operator who runs
 * `reflect` over a backlog should not have to run it again, and what a ceiling
 * should be is a question for a phase with a real extractor and real latencies.
 *
 * ── A pass the model never answered ─────────────────────────────────────────
 *
 * The drain hands a failed attempt back rather than rethrowing, so the queue
 * running dry says nothing about whether the model was there. A pass in which
 * every chunk failed is an outage with the same shape as the unconfigured case,
 * and exits {@link ExitCode.Failed} for the same reason, quoting the last error
 * the model raised. A pass where only some failed moved the backlog and exits 0;
 * each failed job keeps its own `last_error` and retries on schedule.
 *
 * @spec §1, §5.10, §7.6, §9, §11, §14.15
 */

import { openExtraction, type DrainOutcome } from '../../extract/index.js';
import type { GraphStore } from '../../store/index.js';

import { ExitCode } from './commands.js';
import { openModels, readConfiguration, requirePort } from './config.js';
import { refuse, report } from './report.js';
import { openWorkspaceStore, requireWorkspace } from './workspace.js';

/** What one reflection pass did, folded one drained chunk at a time. @spec §5.10, §9 */
interface Tally {
  readonly chunks: number;
  readonly admitted: number;
  readonly rejected: number;
  /** Failed attempts handed back to `pending`. @spec §9 */
  readonly retrying: number;
  /** Failed attempts that spent the last of their budget. @spec §9, §15 */
  readonly parked: number;
  /** The most recent failed attempt's error, in drain order. @spec §9, §12 */
  readonly lastError: string | undefined;
}

const NOTHING_DRAINED: Tally = {
  chunks: 0,
  admitted: 0,
  rejected: 0,
  retrying: 0,
  parked: 0,
  lastError: undefined,
};

const tallied = (tally: Tally, outcome: DrainOutcome): Tally => ({
  chunks: tally.chunks + 1,
  admitted: tally.admitted + outcome.admitted.length,
  rejected: tally.rejected + outcome.rejected,
  retrying: tally.retrying + (outcome.failure?.parked === false ? 1 : 0),
  parked: tally.parked + (outcome.failure?.parked === true ? 1 : 0),
  lastError: outcome.failure?.error ?? tally.lastError,
});

const failedOf = (tally: Tally): number => tally.retrying + tally.parked;

/**
 * The tally line. The failure count is always there, `0 failed` included, so the
 * line's fields do not come and go with the outcome.
 *
 * @spec §7.6, §9
 */
const tallyLine = (tally: Tally): string => {
  const failed = failedOf(tally);
  const failures =
    failed === 0
      ? '0 failed'
      : `${String(failed)} failed (${String(tally.retrying)} will retry, ${String(tally.parked)} parked)`;
  return `reflected over ${String(tally.chunks)} chunks: ${String(tally.admitted)} members admitted, ${String(tally.rejected)} rejected, ${failures}`;
};

/** Runs one reflection pass. @spec §5.10, §7.6, §9 */
export const runReflect = async (cwd: string): Promise<ExitCode> => {
  let store: GraphStore | undefined;
  try {
    const workspace = requireWorkspace(cwd);
    const configuration = readConfiguration(workspace);
    // Before the store is opened and before anything is claimed: an unconfigured
    // repository must cost the queue nothing at all.
    requirePort(configuration, 'extractor', workspace);

    const models = await openModels(configuration, workspace);
    store = openWorkspaceStore(workspace);
    const extraction = openExtraction({
      store,
      embeddings: models.embeddings,
      adjudicator: models.adjudicator,
      extractor: models.extractor,
    });

    let tally = NOTHING_DRAINED;
    for (;;) {
      const outcome = await extraction.drainOnce();
      if (outcome === undefined) break;
      tally = tallied(tally, outcome);
    }

    report(tallyLine(tally));

    const failed = failedOf(tally);
    if (failed === 0 || failed < tally.chunks) return ExitCode.Ok;
    report(
      `all ${String(failed)} chunks attempted failed, none succeeded; last error: ${tally.lastError ?? ''}`,
    );
    return ExitCode.Failed;
  } catch (error) {
    return refuse(error);
  } finally {
    store?.close();
  }
};
