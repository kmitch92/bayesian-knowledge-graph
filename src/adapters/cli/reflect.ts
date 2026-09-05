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
 * @spec §1, §5.10, §7.6, §9, §11
 */

import { openExtraction } from '../../extract/index.js';
import type { GraphStore } from '../../store/index.js';

import { ExitCode } from './commands.js';
import { openModels, readConfiguration, requirePort } from './config.js';
import { refuse, report } from './report.js';
import { openWorkspaceStore, requireWorkspace } from './workspace.js';

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

    let drained = 0;
    let admitted = 0;
    let rejected = 0;
    for (;;) {
      const outcome = await extraction.drainOnce();
      if (outcome === undefined) break;
      drained += 1;
      admitted += outcome.admitted.length;
      rejected += outcome.rejected;
    }

    report(
      `reflected over ${String(drained)} chunks: ${String(admitted)} members admitted, ${String(rejected)} rejected`,
    );
    return ExitCode.Ok;
  } catch (error) {
    return refuse(error);
  } finally {
    store?.close();
  }
};
