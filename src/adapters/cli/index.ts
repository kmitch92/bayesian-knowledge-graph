/**
 * `kgmem` — the single binary every transport shells out to.
 *
 * Plan §2 commits to one bin with subcommands (`init`, `mcp`, `hook serve`,
 * `hook capture`, `githook`, `jobs run`, `reflect`, `harness`) and to no daemon
 * in v1: the MCP server is a stdio process per session, the hooks shell out to
 * this same binary, and every process shares one SQLite file under WAL.
 *
 * This module is the P0 routing skeleton for that binary. It resolves argv to a
 * row in the command table, prints help or version, and otherwise reports
 * NOT_IMPLEMENTED. It loads no config, opens no store, and pulls in no CLI
 * framework — argv handling is hand-rolled to keep the dependency list
 * deliberate.
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
 * @spec §7.6
 */
export function run(argv: readonly string[]): ExitCode {
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

  return reportNotImplemented(command);
}

// Setting process.exitCode rather than calling process.exit() lets buffered
// stdout/stderr writes flush before the process ends.
process.exitCode = run(process.argv.slice(2));
