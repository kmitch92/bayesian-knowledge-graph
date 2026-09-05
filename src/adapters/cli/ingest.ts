/**
 * `kgmem ingest <path>` — §5.10's universal ingress, from a shell.
 *
 * A path in; a document, its chunks and one parked extraction job per changed
 * chunk out. All of that work already exists: E4's `documentSource` turns a file
 * into a {@link TextSource}, E2's `submitText` chunks, embeds, anchors and parks
 * it. This module is the wiring, and it stays wiring — §1 allows exactly one door
 * (*"every source of knowledge writes claims through one ingest port"*), so
 * nothing here writes a row itself.
 *
 * ── The order the steps are in is the design ────────────────────────────────
 *
 * Workspace, then configuration, then the file, then the models, then the store.
 * Each step is cheaper than the one after it and can refuse on its own, so a
 * mistyped path costs no ONNX load and an uninitialised directory costs no file
 * read. The store is opened last and only when there is something to write into
 * it.
 *
 * @spec §1, §3.6, §5.10, §7.6, §9, §11
 */

import { documentSource, openTextIngest } from '../../extract/index.js';
import type { Origin } from '../../ingest/index.js';
import type { GraphStore } from '../../store/index.js';

import { ExitCode } from './commands.js';
import { openModels, readConfiguration } from './config.js';
import { refuse, report } from './report.js';
import { openWorkspaceStore, requireWorkspace } from './workspace.js';

/**
 * §4.7's pathway half for a document a human handed the CLI.
 *
 * Deliberately coarse. The channel records how a contribution *arrived*, and
 * what a `kgmem ingest` run honestly knows is that somebody typed it — not which
 * agent, session or tool sat behind the shell.
 *
 * @spec §4.7
 */
const CLI_CHANNEL = 'cli-ingest';

/**
 * The submitter's own episode, one per invocation.
 *
 * Not the document's episode: §5.10 makes the document one episode and E2
 * derives that one from the document id, so this is only what `text-ingest`
 * records as `submittedBy` in its stage log — which run filed the document.
 *
 * @spec §4.2, §5.8, §5.10
 */
const invocationOrigin = (): Origin => ({
  episodeId: `cli:ingest:${new Date().toISOString()}`,
  channel: CLI_CHANNEL,
});

/**
 * Runs one ingest.
 *
 * `args` is argv with the subcommand token already taken off.
 *
 * @spec §5.10, §7.6
 */
export const runIngest = async (args: readonly string[], cwd: string): Promise<ExitCode> => {
  const path = args[0];
  if (path === undefined) {
    report('ingest needs a path to read: kgmem ingest <path>');
    return ExitCode.Usage;
  }

  let store: GraphStore | undefined;
  try {
    const workspace = requireWorkspace(cwd);
    const configuration = readConfiguration(workspace);
    const source = await documentSource({ path, provenance: invocationOrigin() });
    const models = await openModels(configuration, workspace);

    store = openWorkspaceStore(workspace);
    const text = openTextIngest({
      store,
      embeddings: models.embeddings,
      adjudicator: models.adjudicator,
    });
    const receipt = await text.submitText(source);

    report(
      `ingested ${source.id} into ${workspace.storePath}: ${String(receipt.chunks.length)} chunks, ${String(receipt.enqueued.length)} queued for extraction`,
    );
    return ExitCode.Ok;
  } catch (error) {
    return refuse(error);
  } finally {
    store?.close();
  }
};
