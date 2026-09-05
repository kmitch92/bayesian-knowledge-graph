/**
 * What a `kgmem` command says, and on which stream.
 *
 * **Everything a command says goes to stderr.** stdout carries help and version
 * output and nothing else, because `mcp` owns stdout for the MCP protocol and
 * the hook subcommands run with theirs consumed by the Claude Code host (§10,
 * §7.6). A success line on stdout would be indistinguishable from protocol to
 * one and a corrupted turn to the other.
 *
 * ── One refusal vocabulary, not one per subcommand ──────────────────────────
 *
 * Every command that opens a store can fail the same four ways — run outside a
 * repository, a configuration it cannot read, a port nobody named, a store
 * another process is holding — and an exit code a git hook branches on must not
 * depend on which subcommand happened to hit it. So the mapping lives here, once.
 *
 * @spec §7.6, §10
 */

import { UnreadableDocumentError } from '../../extract/index.js';
import { StoreBusyError } from '../../store/index.js';

import { ExitCode } from './commands.js';
import { ConfigError, UnconfiguredPortError } from './config.js';
import { NoWorkspaceError } from './workspace.js';

/** Says one thing to the operator, on the stream the transports do not own. @spec §7.6 */
export const report = (message: string): void => {
  process.stderr.write(`kgmem: ${message}\n`);
};

/**
 * Reports a refusal and answers with the exit code it earns.
 *
 * The unnamed arm reports the message rather than the stack: an operator reading
 * a stack trace concludes kgmem is broken, and every failure this CLI can
 * actually produce is something they can act on. The failure is still non-zero
 * and still {@link ExitCode.Failed}, so nothing silently succeeds.
 *
 * @spec §7.6
 */
export const refuse = (error: unknown): ExitCode => {
  if (error instanceof NoWorkspaceError) {
    report(error.message);
    return ExitCode.Config;
  }
  if (error instanceof UnconfiguredPortError || error instanceof ConfigError) {
    report(error.message);
    return ExitCode.Config;
  }
  if (error instanceof UnreadableDocumentError) {
    report(`${error.message} — check the path and try again.`);
    return ExitCode.Usage;
  }
  /*
   * The busy arm says what it knows and no more. `submitText` is not one
   * transaction — document, then a chunk per paragraph, then jobs only for
   * chunks whose hash was not already stored — so a timeout partway down that
   * loop has committed everything above it, and `refuse` is handed a
   * `StoreBusyError` and nothing else, with no way to tell which write gave up.
   * The retry advice stands: retrying is still the right first move on a
   * contended store, it is only not a repair when the run left a partial
   * document behind. When a scoped `submitDocument` makes the write atomic,
   * "nothing was written" becomes true again and can come back with a test
   * behind it.
   */
  if (error instanceof StoreBusyError) {
    report(
      `${error.message}. Part of this document may already be written. Wait for the other process to finish and run this again.`,
    );
    return ExitCode.Failed;
  }

  report(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  return ExitCode.Failed;
};
