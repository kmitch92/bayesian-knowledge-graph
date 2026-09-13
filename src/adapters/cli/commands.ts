/**
 * The `kgmem` subcommand table and its help rendering.
 *
 * This is the routing surface only: one row per subcommand, naming the spec
 * section the subcommand serves and the implementation-plan phase that delivers
 * it. No behaviour lives here — `index.ts` routes a row either to the module
 * that implements it or, while its phase is outstanding, to the NOT_IMPLEMENTED
 * stub (plan §5).
 *
 * The table is the single source of truth for both `--help` and the
 * NOT_IMPLEMENTED messages, so a subcommand cannot be advertised without also
 * being routable, or routable without being advertised.
 *
 * @spec §7.6, §5.9, §10
 */

/**
 * Process exit codes used by the CLI.
 *
 * One code per *reason a caller would act on differently*, which is why there
 * are five and not two: a git hook that finds the workspace unconfigured should
 * report it once and carry on, where a hook that finds the store contended
 * should try again later, and neither is the operator typing the command wrong.
 *
 * `NotImplemented` is deliberately non-zero: a stub that exited 0 would let a
 * wiring mistake in a later phase pass silently inside a script, cron entry or
 * git hook. The one exception is the ambient hook transports — see
 * {@link CommandSpec.failOpen}.
 *
 * @spec §7.6
 */
export const ExitCode = {
  /** Everything asked for happened. */
  Ok: 0,
  /** The command as typed cannot be run: an argument missing, or naming nothing readable. */
  Usage: 1,
  /** Routed, but the phase that builds it has not landed. */
  NotImplemented: 2,
  /** The workspace is not set up for it: no `.kgmem`, or no model configured for the port it needs. */
  Config: 3,
  /** It was attempted and did not finish: a contended store, or a failure this build did not anticipate. */
  Failed: 4,
} as const;

/** A process exit code. @spec §7.6 */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * One routable subcommand.
 *
 * `name` may contain a space (`hook serve`, `jobs run`); the router matches
 * multi-token names before single-token ones.
 *
 * @spec §7.6, §5.9
 */
export interface CommandSpec {
  /** Space-separated command path, e.g. `hook serve`. */
  readonly name: string;
  /** Positional argument sketch shown in help, e.g. `<path>`. */
  readonly args?: string;
  /** One-line purpose, shown in help. */
  readonly purpose: string;
  /** Reference-spec sections this subcommand serves. */
  readonly spec: string;
  /** Implementation-plan phase that delivers it (plan §5). */
  readonly phase: string;
  /** Extra phase context, where plan §5 is not a clean single-phase answer. */
  readonly phaseNote?: string;
  /**
   * When true, the unimplemented stub exits 0 and keeps stdout empty.
   *
   * Only the two ambient hook transports set this. Spec §7.6 requires reads to
   * fail open — "a dead daemon degrades to a memoryless agent, never a blocked
   * one" — and spec §5.9 requires capture to be enqueue-only and best-effort —
   * "capture is best-effort — a dead daemon loses events, never blocks the
   * agent". A hook that exits non-zero, or that prints to the stdout the host
   * consumes, blocks or corrupts the agent's turn. That is a worse failure than
   * having no memory at all, so these two stubs stay silent and successful.
   *
   * This asymmetry with every other subcommand is intentional. Do not
   * "fix" it in a later phase.
   *
   * @spec §7.6, §5.9
   */
  readonly failOpen: boolean;
}

/**
 * Every `kgmem` subcommand, in the order plan §2 lists them.
 *
 * @spec §3.1, §4.5, §5.2, §5.9, §7.6, §9, §10, §13
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    args: '[path]',
    purpose: 'Make a directory a workspace: .kgmem/ with an empty store and configuration.',
    spec: '§7.6, §11',
    phase: 'no numbered phase',
    phaseNote:
      'plan §5 lists `kgmem init` under P2; the workspace it creates arrived on the text track instead, because `ingest` and `reflect` cannot run without one',
    failOpen: false,
  },
  {
    name: 'ingest',
    args: '<path>',
    purpose: 'Read a file as a document: chunk, embed, anchor, park its extraction.',
    spec: '§3.6, §5.10',
    phase: 'no numbered phase',
    phaseNote:
      'plan §5 numbers no text-ingest phase; §5.10’s universal ingress arrived on the text track — chunk-and-park, then the extraction drain, then the sources, then this wiring',
    failOpen: false,
  },
  {
    name: 'mcp',
    purpose: 'Run the MCP stdio server (query, observe, contradict, drill_down).',
    spec: '§10',
    phase: 'P4 (retrieval + MCP)',
    failOpen: false,
  },
  {
    name: 'hook serve',
    purpose: 'Ambient read transport: SessionStart / UserPromptSubmit / PreToolUse injection.',
    spec: '§7.6',
    phase: 'P6 (ambient transports)',
    failOpen: true,
  },
  {
    name: 'hook capture',
    purpose: 'Ambient write transport: PostToolUse / Stop episode capture.',
    spec: '§5.9',
    phase: 'P6 (ambient transports)',
    failOpen: true,
  },
  {
    name: 'githook',
    purpose: 'Commit clock: churn decay toward the prior after a commit.',
    spec: '§4.5',
    phase: 'P7 (commit clock)',
    failOpen: false,
  },
  {
    name: 'jobs run',
    purpose: 'Calendar clock: TTL sweep, re-verification sampler, facet re-cluster.',
    spec: '§9',
    phase: 'no numbered phase',
    phaseNote:
      'plan §5 assigns the calendar clock no phase of its own; the jobs table lands in P1 and the scheduler follows the P7 commit clock',
    failOpen: false,
  },
  {
    name: 'reflect',
    purpose: 'Mine the parked chunks: extraction backlog into member claims.',
    spec: '§5.9, §5.10',
    phase: 'P8 (reflector)',
    phaseNote:
      '§5.10’s extraction drain is wired; P8 adds §5.9’s episode-log reflector behind the same command',
    failOpen: false,
  },
  {
    name: 'harness',
    purpose: 'Replay runner, A/B task runner, adjudicator drift audit.',
    spec: '§13',
    phase: 'P5 (harness)',
    failOpen: false,
  },
];

/**
 * Resolve argv to a subcommand, matching two-token names before one-token ones.
 *
 * Returns `undefined` when no row matches, which the caller renders as a usage
 * error rather than guessing.
 *
 * @spec §7.6
 */
export function findCommand(argv: readonly string[]): CommandSpec | undefined {
  const [first, second] = argv;
  if (first === undefined) return undefined;

  const twoToken = second === undefined ? undefined : `${first} ${second}`;
  if (twoToken !== undefined) {
    const nested = COMMANDS.find((command) => command.name === twoToken);
    if (nested !== undefined) return nested;
  }

  return COMMANDS.find((command) => command.name === first);
}

/**
 * Render the full help text: every subcommand, its purpose and its spec section.
 *
 * Citing the spec section per line is this codebase's convention — code points
 * back at the document that justifies it.
 *
 * @spec §7.6
 */
export function formatHelp(version: string): string {
  const usages = COMMANDS.map(
    (command) => `${command.name}${command.args === undefined ? '' : ` ${command.args}`}`,
  );
  const width = usages.reduce((widest, usage) => Math.max(widest, usage.length), 0);

  const lines = COMMANDS.map((command, index) => {
    const usage = usages[index] ?? command.name;
    return `  ${usage.padEnd(width)}  ${command.purpose}  [spec ${command.spec}]`;
  });

  return [
    `kgmem ${version} — knowledge-graph memory for coding agents`,
    '',
    'Usage: kgmem <command> [args]',
    '',
    'Commands:',
    ...lines,
    '',
    'Options:',
    '  -h, --help     Show this help.',
    '  -V, --version  Print the version.',
    '',
    'A subcommand whose phase has not landed exits with NOT_IMPLEMENTED rather',
    'than doing nothing quietly — except the ambient hook transports, which fail',
    'open per spec §7.6 and §5.9.',
  ].join('\n');
}

/**
 * The NOT_IMPLEMENTED message for a stubbed subcommand.
 *
 * @spec §7.6
 */
export function formatNotImplemented(command: CommandSpec): string {
  const phase =
    command.phaseNote === undefined
      ? command.phase
      : `${command.phase} — ${command.phaseNote}`;
  return `kgmem: NOT_IMPLEMENTED: '${command.name}' is a P0 routing stub (spec ${command.spec}); delivered by ${phase}.`;
}
