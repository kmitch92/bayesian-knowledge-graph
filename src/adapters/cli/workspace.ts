/**
 * Where a `kgmem` command finds the graph it is meant to work on, and how it
 * opens it.
 *
 * Nothing in the reference spec or in plan §5 says where the store lives: P0
 * routed argv and opened nothing, so the question never had to be answered.
 * `ingest` and `reflect` cannot run without an answer, so this module owns one.
 * Both halves are **rulings made here**, not readings of the spec, and both are
 * one edit each to change.
 *
 * ── The store is `<root>/.kgmem/graph.db` ───────────────────────────────────
 *
 * `<root>` is the nearest ancestor of the working directory holding a
 * {@link KGMEM_DIR} directory. `kgmem init [path]` creates that directory, and
 * every other transport — the MCP server per session, a git hook, a cron entry —
 * finds it by being run inside the directory it was created in, which is the one
 * thing they all share.
 *
 * **A run that finds no `.kgmem` refuses rather than creating one**, and that
 * refusal is the load-bearing half. `openGraphStore` migrates whatever path it
 * is handed, so a CLI that resolved `.kgmem/graph.db` against the working
 * directory and opened it would *succeed* anywhere: empty graphs scattered
 * through the filesystem, a successful ingest reported into a store nobody will
 * ever read, and §7.7's health view computed over an empty file. `git init`
 * declines to be implicit for exactly this reason.
 *
 * ── The configuration is `<root>/.kgmem/config.json` ────────────────────────
 *
 * Beside the store, because it configures that store's write path — see
 * `config.ts`, which owns its contents.
 *
 * ── The wait, and why it is not §5.7's ──────────────────────────────────────
 *
 * §5.7's thirty seconds is chosen for the write path, where *"a writer that
 * surfaces SQLITE_BUSY has dropped evidence just as surely as a lost update
 * would have"*. `GraphStoreOptions.busyTimeoutMs` exists because that is the
 * wrong trade for a caller that must not stall, and an interactive CLI is that
 * caller: see {@link CLI_BUSY_TIMEOUT_MS}.
 *
 * @spec §5.7, §7.6, §7.7, §11
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { openGraphStore, type GraphStore } from '../../store/index.js';

/** The directory `init` leaves in a repository, and every other command finds. @spec §7.6 */
export const KGMEM_DIR = '.kgmem';

/** The store, inside it. @spec §11 */
export const STORE_FILE = 'graph.db';

/** The configuration, beside it. @spec §7.6 */
export const CONFIG_FILE = 'config.json';

/**
 * How long a `kgmem` command waits for another process's write lock.
 *
 * Two seconds, against §5.7's thirty. Long enough to ride out the collision this
 * design actually produces — another kgmem process (an MCP session, a hook)
 * finishing one write — and short enough that an operator is told it is
 * contended rather than left wondering.
 *
 * The wait is **uninterruptible**, which is what settles the number.
 * `connection.ts` parks the thread in `Atomics.wait`, which runs no timers, no
 * signal handlers and no JavaScript at all, so an operator pressing ^C waits out
 * whatever this constant says regardless. Thirty seconds of that in a git hook
 * is a commit that looks hung.
 *
 * @spec §5.7, §7.6
 */
export const CLI_BUSY_TIMEOUT_MS = 2_000;

/** A repository `init` has been run in, and everything a command needs from it. @spec §7.6 */
export interface Workspace {
  /** The nearest ancestor of the working directory holding `.kgmem`. */
  readonly root: string;
  /** The `.kgmem` directory itself. */
  readonly home: string;
  /** `<root>/.kgmem/graph.db`. @spec §11 */
  readonly storePath: string;
  /** `<root>/.kgmem/config.json`. @spec §7.6 */
  readonly configPath: string;
}

/**
 * A command was run outside any repository `init` has been run in.
 *
 * Names `init`, because the diagnosis is useless without the cure, and says
 * outright that nothing was created — an operator who has just been told "no
 * store" needs to know the tool did not quietly make one.
 *
 * @spec §7.6
 */
export class NoWorkspaceError extends Error {
  /** The directory the search started from. */
  readonly from: string;

  constructor(from: string) {
    super(
      `no ${KGMEM_DIR} directory in ${from} or in any directory above it, so there is no graph to work on. Run 'kgmem init [path]' to make a workspace of the directory this belongs to. Nothing was created here: a store made wherever a command happened to run is a store nobody reads.`,
    );
    this.name = 'NoWorkspaceError';
    this.from = from;
  }
}

const holdsKgmemDir = (directory: string): boolean => {
  const candidate = join(directory, KGMEM_DIR);
  return existsSync(candidate) && statSync(candidate).isDirectory();
};

/**
 * Walks up from a directory looking for the repository's `.kgmem`.
 *
 * `undefined` rather than a throw, so a caller that wants to ask without
 * refusing can — the refusal is {@link requireWorkspace}'s.
 *
 * @spec §7.6
 */
export const findWorkspace = (from: string): Workspace | undefined => {
  let directory = resolve(from);

  for (;;) {
    if (holdsKgmemDir(directory)) {
      const home = join(directory, KGMEM_DIR);
      return {
        root: directory,
        home,
        storePath: join(home, STORE_FILE),
        configPath: join(home, CONFIG_FILE),
      };
    }

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

/** The workspace, or {@link NoWorkspaceError}. Creates nothing either way. @spec §7.6 */
export const requireWorkspace = (from: string): Workspace => {
  const workspace = findWorkspace(from);
  if (workspace === undefined) throw new NoWorkspaceError(resolve(from));
  return workspace;
};

/**
 * Opens the workspace's store at the CLI's own wait.
 *
 * The one place a `kgmem` command opens a store, so {@link CLI_BUSY_TIMEOUT_MS}
 * cannot apply to one subcommand and not another.
 *
 * @spec §5.7, §11
 */
export const openWorkspaceStore = (workspace: Workspace): GraphStore =>
  openGraphStore({ path: workspace.storePath, busyTimeoutMs: CLI_BUSY_TIMEOUT_MS });
