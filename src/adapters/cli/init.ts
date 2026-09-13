/**
 * `kgmem init [path]` — makes a directory a workspace, and does nothing else.
 *
 * A directory in; `.kgmem/`, a migrated empty store inside it and a
 * configuration naming no model out. It never reads the directory it is pointed
 * at: content enters the graph through `kgmem ingest`, a separate and explicit
 * step, so every directory is initialised identically whatever it holds.
 *
 * ── The order the steps are in is the design ────────────────────────────────
 *
 * The target, then the workspace it may already belong to, then anything in the
 * way, then the writes. Every refusal is decided before the first write, so a
 * refused `init` leaves nothing behind. The workspace search walks up from the
 * target rather than the working directory, so a directory already inside a
 * workspace is reported by the `.kgmem` every later command run there finds,
 * and is not given a second one.
 *
 * The store is made here rather than on first use, so a store that cannot be
 * made fails at `init` and not at the first command that needs it.
 *
 * @spec §7.6, §11
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ExitCode } from './commands.js';
import { refuse, report } from './report.js';
import {
  CONFIG_FILE,
  KGMEM_DIR,
  STORE_FILE,
  findWorkspace,
  openWorkspaceStore,
  type Workspace,
} from './workspace.js';

/**
 * The configuration a new workspace starts with: the one key an operator edits,
 * present and empty, which `config.ts` reads as unconfigured.
 *
 * @spec §7.6
 */
const INITIAL_CONFIGURATION = `${JSON.stringify({ models: {} }, null, 2)}\n`;

/**
 * Runs one init.
 *
 * `args` is argv with the subcommand token already taken off; its one optional
 * token is resolved against `cwd`, which it defaults to.
 *
 * @spec §7.6, §11
 */
export const runInit = (args: readonly string[], cwd: string): ExitCode => {
  const target = resolve(cwd, args[0] ?? '.');

  if (!existsSync(target)) {
    report(`cannot make ${target} a workspace: there is no such directory. Check the path and try again.`);
    return ExitCode.Usage;
  }
  if (!statSync(target).isDirectory()) {
    report(`cannot make ${target} a workspace: it is a file, not a directory. Check the path and try again.`);
    return ExitCode.Usage;
  }

  const existing = findWorkspace(target);
  if (existing !== undefined) {
    report(`${target} already belongs to the workspace at ${existing.home}; nothing was created or changed.`);
    return ExitCode.Ok;
  }

  const home = join(target, KGMEM_DIR);
  if (existsSync(home)) {
    report(
      `cannot make ${target} a workspace: ${home} is in the way, and it is a file, not a directory. Move it or choose another path.`,
    );
    return ExitCode.Usage;
  }

  const workspace: Workspace = {
    root: target,
    home,
    storePath: join(home, STORE_FILE),
    configPath: join(home, CONFIG_FILE),
  };

  try {
    mkdirSync(home);
    openWorkspaceStore(workspace).close();
    writeFileSync(workspace.configPath, INITIAL_CONFIGURATION, 'utf8');
  } catch (error) {
    return refuse(error);
  }

  report(`created a workspace at ${home}. Add content to it with: kgmem ingest <path>`);
  return ExitCode.Ok;
};
