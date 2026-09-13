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
 * ── A half-made workspace is finished, not reported ─────────────────────────
 *
 * A `.kgmem` missing its store or its configuration — left by an `init` that
 * failed partway, or by hand — is the workspace every later command finds, and
 * one they cannot run against. So `init` makes only the part or parts it lacks,
 * touches nothing that is there, and says it completed that workspace rather
 * than that it was already there.
 *
 * The store is made here rather than on first use, so a store that cannot be
 * made fails at `init` and not at the first command that needs it — and fails
 * naming the store, because the driver's own words name no path.
 *
 * @spec §7.6, §11
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ExitCode } from './commands.js';
import { refuse, report } from './report.js';
import { findWorkspace, openWorkspaceStore, workspaceAt, type Workspace } from './workspace.js';

/**
 * The configuration a new workspace starts with: the one key an operator edits,
 * present and empty, which `config.ts` reads as unconfigured.
 *
 * @spec §7.6
 */
const INITIAL_CONFIGURATION = `${JSON.stringify({ models: {} }, null, 2)}\n`;

/** One of the two files a workspace needs inside its `.kgmem`. @spec §7.6, §11 */
type Part = 'store' | 'configuration';

/** Every part, store first, so a store that cannot be made leaves no configuration behind. */
const PARTS: readonly Part[] = ['store', 'configuration'];

const pathOf = (workspace: Workspace, part: Part): string =>
  part === 'store' ? workspace.storePath : workspace.configPath;

const missingParts = (workspace: Workspace): readonly Part[] =>
  PARTS.filter((part) => !existsSync(pathOf(workspace, part)));

const reasonFor = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Makes and closes the store, or says which store it could not make.
 *
 * `Failed`, as `refuse`'s unnamed arm would answer, but in words that name the
 * path: SQLite's "unable to open database file" leaves the operator guessing
 * which file.
 *
 * @spec §7.6, §11
 */
const createStore = (workspace: Workspace): ExitCode => {
  try {
    openWorkspaceStore(workspace).close();
    return ExitCode.Ok;
  } catch (error) {
    report(
      `cannot create the store at ${workspace.storePath}: ${reasonFor(error)}. Make that a path a database file can be created at, or choose another directory, and run init again.`,
    );
    return ExitCode.Failed;
  }
};

const createConfiguration = (workspace: Workspace): ExitCode => {
  try {
    writeFileSync(workspace.configPath, INITIAL_CONFIGURATION, 'utf8');
    return ExitCode.Ok;
  } catch (error) {
    return refuse(error);
  }
};

/** Makes each named part in order, stopping at the first that cannot be made. */
const createParts = (workspace: Workspace, parts: readonly Part[]): ExitCode => {
  for (const part of parts) {
    const code = part === 'store' ? createStore(workspace) : createConfiguration(workspace);
    if (code !== ExitCode.Ok) return code;
  }
  return ExitCode.Ok;
};

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
    const missing = missingParts(existing);
    if (missing.length === 0) {
      report(`${target} already belongs to the workspace at ${existing.home}; nothing was created or changed.`);
      return ExitCode.Ok;
    }

    const code = createParts(existing, missing);
    if (code !== ExitCode.Ok) return code;

    report(
      `completed the workspace at ${existing.home} by creating its missing ${missing.join(' and ')}; nothing that was there was changed. Add content to it with: kgmem ingest <path>`,
    );
    return ExitCode.Ok;
  }

  const workspace = workspaceAt(target);
  if (existsSync(workspace.home)) {
    report(
      `cannot make ${target} a workspace: ${workspace.home} is in the way, and it is a file, not a directory. Move it or choose another path.`,
    );
    return ExitCode.Usage;
  }

  try {
    mkdirSync(workspace.home);
  } catch (error) {
    return refuse(error);
  }

  const code = createParts(workspace, PARTS);
  if (code !== ExitCode.Ok) return code;

  report(`created a workspace at ${workspace.home}. Add content to it with: kgmem ingest <path>`);
  return ExitCode.Ok;
};
