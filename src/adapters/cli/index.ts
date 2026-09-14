/**
 * `kgmem` — the single binary every transport shells out to.
 *
 * Plan §2 commits to one bin with subcommands (`init`, `mcp`, `hook serve`,
 * `hook capture`, `githook`, `jobs run`, `reflect`, `harness`) and to no daemon
 * in v1: the MCP server is a stdio process per session, the hooks shell out to
 * this same binary, and every process shares one SQLite file under WAL.
 *
 * This module is the router for that binary. It resolves argv to a row in the
 * command table, prints help or version, hands `ingest` and `reflect` to the
 * modules that implement them, and reports NOT_IMPLEMENTED for every row whose
 * phase is still outstanding. It pulls in no CLI framework — argv handling is
 * hand-rolled to keep the dependency list deliberate — and it knows nothing
 * about where the store is or which models are configured: `workspace.ts` and
 * `config.ts` own those, and only a command that needs them pays for them.
 *
 * Stream discipline: stdout carries only help and version output. Every
 * diagnostic — usage errors and NOT_IMPLEMENTED alike — goes to stderr, because
 * `mcp` will own stdout for the MCP protocol and the hook subcommands run with
 * their stdout consumed by the Claude Code host (§10, §7.6).
 *
 * @spec §7.6, §5.9, §10
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ExitCode,
  COMMANDS,
  findCommand,
  formatHelp,
  formatNotImplemented,
  type CommandSpec,
} from './commands.js';

/** How far up the tree to look for the owning package.json. */
const PACKAGE_SEARCH_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read the package version from package.json at runtime.
 *
 * Resolved by walking up from this module rather than by importing the JSON, so
 * the same code works whether it runs bundled from `dist/kgmem.js` or straight
 * from source under `tsx`, and so the version is never baked into a build.
 *
 * @spec §7.6
 */
export function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < PACKAGE_SEARCH_DEPTH; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
        if (isRecord(parsed)) {
          const version = parsed['version'];
          if (typeof version === 'string' && version.length > 0) return version;
        }
      } catch {
        // Unreadable or malformed package.json: keep walking, then fall back.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return 'unknown';
}

/**
 * Report a subcommand that this phase does not implement yet.
 *
 * Non-hook subcommands exit 2. Exiting 0 would let a wiring mistake in a later
 * phase pass silently in a script, a cron entry or a git hook.
 *
 * `hook serve` and `hook capture` are the deliberate exception: spec §7.6
 * requires ambient reads to fail open — "a dead daemon degrades to a memoryless
 * agent, never a blocked one" — and spec §5.9 requires capture to be
 * enqueue-only and best-effort — "a dead daemon loses events, never blocks the
 * agent". So those two exit 0, and write nothing to stdout, since a Claude Code
 * hook's stdout is consumed by the host. Their diagnostic goes to stderr only.
 * This inconsistency is load-bearing; a later phase must not flatten it.
 *
 * @spec §7.6, §5.9
 */
export function reportNotImplemented(command: CommandSpec): ExitCode {
  process.stderr.write(`${formatNotImplemented(command)}\n`);
  return command.failOpen ? ExitCode.Ok : ExitCode.NotImplemented;
}

/**
 * Route argv (already stripped of `node` and the script path) to an exit code.
 *
 * Asynchronous because two of the rows now do work: a document is on a disk, a
 * model port is a dynamic import, and a drain is a loop of model calls. Every
 * command answers with a code rather than throwing — see `report.ts` — so this
 * promise resolves for a refusal exactly as it does for a success.
 *
 * @spec §5.10, §7.6
 */
export async function run(argv: readonly string[]): Promise<ExitCode> {
  const first = argv[0];

  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    process.stdout.write(`${formatHelp(readVersion())}\n`);
    return ExitCode.Ok;
  }

  if (first === '--version' || first === '-V') {
    process.stdout.write(`${readVersion()}\n`);
    return ExitCode.Ok;
  }

  const command = findCommand(argv);
  if (command === undefined) {
    const attempted = argv.slice(0, 2).join(' ');
    const known = COMMANDS.map((entry) => entry.name).join(', ');
    process.stderr.write(`kgmem: unknown command '${attempted}'. Known commands: ${known}.\n\n`);
    process.stderr.write(`${formatHelp(readVersion())}\n`);
    return ExitCode.Usage;
  }

  // The four rows this phase wired. Everything else is still a stub, and the
  // switch is what says which is which — a row cannot claim to be implemented
  // without a case here, or be reachable without a row.
  //
  // All four cases import their module here rather than at the top of the
  // file. `init.js`, `ingest.js`, `mcp.js`, and `reflect.js` all reach
  // `workspace.js`, which reaches the store — and the store's own top-level
  // imports load better-sqlite3 and sqlite-vec's native bindings. A static
  // import of any of them would make that load happen for every invocation of
  // this binary, `--help` and an unknown command included, and — the case that
  // matters per §7.6 — for `hook serve` and `hook capture` too, which fall to
  // `default` below and are required to fail open cheaply. A dynamic import
  // confines that cost to the four rows that actually need a store.
  switch (command.name) {
    case 'init': {
      const { runInit } = await import('./init.js');
      return runInit(argv.slice(1), process.cwd());
    }
    case 'ingest': {
      const { runIngest } = await import('./ingest.js');
      return runIngest(argv.slice(1), process.cwd());
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp.js');
      return runMcp(process.cwd(), readVersion());
    }
    case 'reflect': {
      const { runReflect } = await import('./reflect.js');
      return runReflect(process.cwd());
    }
    default:
      return reportNotImplemented(command);
  }
}

// Setting process.exitCode rather than calling process.exit() lets buffered
// stdout/stderr writes flush before the process ends.
process.exitCode = await run(process.argv.slice(2));
