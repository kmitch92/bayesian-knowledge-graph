/**
 * `<root>/.kgmem/config.json`: which model each of the three ports is.
 *
 * A second ruling this phase has to make, for the reason `workspace.ts` makes
 * its first: nothing in `src/` implements {@link Extractor}, nobody may import
 * an adjudicator, and the embedding provider is a 250MB dependency the write
 * path is explicitly built to keep off its import graph. So the CLI cannot
 * hard-code any of the three, and something has to name them.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 * ```json
 * { "models": { "embeddings": "./my-embedder.js", "extractor": "@acme/kgmem-extractor" } }
 * ```
 *
 * Each value is a **module specifier whose default export is a factory** — a
 * function returning the port. Absolute paths and `./`-relative paths (resolved
 * against `.kgmem/`) are files; anything else is handed to the resolver as
 * written, so a published package works.
 *
 * Parsed with Zod because it is external input by the same standard a submitted
 * message is: a hand-edited file, read by a process that then writes to the
 * ledger.
 *
 * ── Configuration rather than environment ───────────────────────────────────
 *
 * Hooks and cron entries inherit an environment nobody controls, but they do run
 * inside the repository. A `KGMEM_EXTRACTOR` that is set in one operator's shell
 * and unset in the git hook that shells out from their editor is a system whose
 * behaviour depends on how it was launched; a file beside the store is the same
 * answer for every transport.
 *
 * ── Absent means absent, with two exceptions ────────────────────────────────
 *
 * A port the configuration does not name becomes a stub that **refuses when
 * called and names this file** — not a silent no-op, and not a crash. That is
 * the extractor's ruling, and after this phase it is the extractor's alone: with
 * no model to mine a chunk there is nothing §5.10 can do with the chunk at all,
 * so the work the operator asked for cannot be done, and the only honest answer
 * is to say which file would name the model. A store with no extractor
 * configured is the ordinary state of this system today, so that refusal has to
 * be as legible as any other diagnostic.
 *
 * The first exception is embeddings, which fall back to the real local adapter:
 * there *is* one in this repository, an ingest without it can do nothing at all,
 * and §5.3's geometry is the store's own. It is imported dynamically so that a
 * command running under a configured provider never pays for the ONNX weights.
 *
 * The second is the adjudicator, which **declines** where the extractor refuses.
 * Its absence does not mean the work cannot be done; it means one rung of §5.2's
 * ladder cannot answer. The ladder reaches that rung only after the mention
 * index and the gloss channel have both failed to settle a surface form, and
 * §5.2 already rules what becomes of a question nobody can settle —
 * *"fragmentation is answered by minting into a lifecycle, not by refusing to
 * mint"*. A graph with no model to ask therefore resolves three rungs and mints
 * on the fourth, which is a humbler graph and not a broken one. Refusing there
 * would instead abort a half-made write on every repository that has not edited
 * `config.json`, which is every repository by default.
 *
 * @spec §5.2, §5.3, §5.10, §7.6, §11
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { Extractor } from '../../extract/index.js';
import type { Adjudicator } from '../../referents/index.js';
import type { EmbeddingProvider } from '../../store/ports/embedding-provider.js';

import type { Workspace } from './workspace.js';

/** One of the three model-shaped ports a configuration may name. @spec §5.2, §5.3, §5.10 */
export type ModelPortName = 'embeddings' | 'adjudicator' | 'extractor';

/**
 * What a port's module must actually have produced.
 *
 * Checked because the factory is external code: a specifier that resolves to the
 * wrong module produces an object with no `extract` on it, and finding that out
 * at the call site means finding it out after the queue has been touched.
 *
 * @spec §5.2, §5.3, §5.10
 */
const REQUIRED_METHOD: Readonly<Record<ModelPortName, string>> = {
  embeddings: 'embedBatch',
  adjudicator: 'tiebreakReferent',
  extractor: 'extract',
};

/** The module specifiers a configuration names, all optional. @spec §5.2, §5.3, §5.10 */
const ModelModules = z.object({
  embeddings: z.string().min(1).optional(),
  adjudicator: z.string().min(1).optional(),
  extractor: z.string().min(1).optional(),
});

/** `.kgmem/config.json`, as this build reads it. @spec §7.6 */
const Configuration = z.object({
  models: ModelModules.default({}),
});

/** @spec §7.6 */
export type Configuration = z.infer<typeof Configuration>;

/** The configuration a repository with no `config.json` has. @spec §7.6 */
const UNCONFIGURED: Configuration = { models: {} };

/**
 * The configuration file is there but this build cannot use it.
 *
 * Separate from {@link UnconfiguredPortError}: "you have not said which
 * extractor to use" and "what you said is not readable" are different edits.
 *
 * @spec §7.6
 */
export class ConfigError extends Error {
  /** The file that could not be used. */
  readonly configPath: string;

  constructor(configPath: string, detail: string, cause?: unknown) {
    super(`${configPath} ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'ConfigError';
    this.configPath = configPath;
  }
}

/**
 * A command needed a port the configuration does not name.
 *
 * Carries both halves an operator needs — which port, and which file — because a
 * refusal naming only the first leaves them grepping the source for the second.
 *
 * @spec §5.10, §7.6
 */
export class UnconfiguredPortError extends Error {
  /** The port nobody named. */
  readonly port: ModelPortName;
  /** The file that would name it. */
  readonly configPath: string;

  constructor(port: ModelPortName, configPath: string) {
    super(
      `no ${port} is configured. Name a module that default-exports an ${port} factory under "models.${port}" in ${configPath}, then run this again.`,
    );
    this.name = 'UnconfiguredPortError';
    this.port = port;
    this.configPath = configPath;
  }
}

/**
 * Reads and validates the configuration, without importing anything it names.
 *
 * Synchronous and cheap on purpose: `reflect` has to be able to discover that no
 * extractor is configured *before* it claims a job, and reading a small JSON
 * file is the whole cost of knowing.
 *
 * A missing file is a valid unconfigured repository — `init` creates the
 * directory, not an opinion about models — while an unreadable or malformed one
 * is refused, because guessing at what a hand edit meant is how a typo becomes a
 * silently different write path.
 *
 * @spec §7.6
 */
export const readConfiguration = (workspace: Workspace): Configuration => {
  let raw: string;
  try {
    raw = readFileSync(workspace.configPath, 'utf8');
  } catch {
    return UNCONFIGURED;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(workspace.configPath, 'is not readable JSON', cause);
  }

  const configuration = Configuration.safeParse(parsed);
  if (!configuration.success)
    throw new ConfigError(
      workspace.configPath,
      `does not describe a kgmem configuration: ${configuration.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );

  return configuration.data;
};

/**
 * A module specifier as an import takes it.
 *
 * A bare specifier is left alone so a published package resolves normally;
 * anything path-shaped is resolved against the configuration file's own
 * directory and turned into a URL, because a relative import inside this module
 * would otherwise resolve against `src/adapters/cli/`.
 */
const specifierUrl = (specifier: string, configPath: string): string => {
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith('./') || specifier.startsWith('../'))
    return pathToFileURL(resolve(dirname(configPath), specifier)).href;
  return specifier;
};

/**
 * Imports one named port and builds it.
 *
 * Every failure between here and a working port is the same class of operator
 * mistake — a path that does not resolve, a module with no default export, a
 * factory that returns the wrong thing — so all three become one
 * {@link ConfigError} naming the specifier and the file that holds it.
 *
 * @spec §11
 */
const loadPort = async <T>(
  port: ModelPortName,
  specifier: string,
  configPath: string,
): Promise<T> => {
  let module: unknown;
  try {
    module = (await import(specifierUrl(specifier, configPath))) as unknown;
  } catch (cause) {
    throw new ConfigError(configPath, `names a ${port} module that will not load: ${specifier}`, cause);
  }

  const factory = (module as { readonly default?: unknown }).default;
  if (typeof factory !== 'function')
    throw new ConfigError(
      configPath,
      `names a ${port} module with no default-exported factory: ${specifier}`,
    );

  const made: unknown = await (factory as () => unknown)();
  const method = REQUIRED_METHOD[port];
  if (
    typeof made !== 'object' ||
    made === null ||
    typeof (made as Record<string, unknown>)[method] !== 'function'
  )
    throw new ConfigError(
      configPath,
      `names a ${port} module whose factory returned no ${method}(): ${specifier}`,
    );

  return made as T;
};

/** §5.3's port, when nobody named one: the local ONNX adapter this repo ships. @spec §5.3 */
const localEmbeddings = async (): Promise<EmbeddingProvider> => {
  const { NomicEmbeddingProvider } = await import(
    '../../store/adapters/nomic-embedding-provider.js'
  );
  return new NomicEmbeddingProvider();
};

/**
 * Builds only the embeddings port, importing only the module the configuration
 * actually names.
 *
 * `kgmem mcp` opens this one port rather than all three, so it serves from a
 * workspace configured for extraction without extraction credentials.
 *
 * @spec §5.3, §10
 */
export const openEmbeddings = async (
  configuration: Configuration,
  workspace: Workspace,
): Promise<EmbeddingProvider> => {
  const { models } = configuration;
  const { configPath } = workspace;

  return models.embeddings === undefined
    ? await localEmbeddings()
    : await loadPort<EmbeddingProvider>('embeddings', models.embeddings, configPath);
};

/**
 * Builds only the adjudicator port, importing only the module the configuration
 * actually names.
 *
 * `kgmem mcp` opens this one port rather than all three, so it serves from a
 * workspace configured for extraction without extraction credentials. The
 * adjudicator's absence does not prevent work — §5.2's ladder mints on
 * `unresolved` — so a declining stub suffices where no model is configured.
 *
 * @spec §5.2, §10
 */
export const openAdjudicator = async (
  configuration: Configuration,
  workspace: Workspace,
): Promise<Adjudicator> => {
  const { models } = configuration;
  const { configPath } = workspace;

  return models.adjudicator === undefined
    ? decliningAdjudicator()
    : await loadPort<Adjudicator>('adjudicator', models.adjudicator, configPath);
};

/**
 * §5.2's port, when nobody named one: a tiebreak that declines every question
 * put to it.
 *
 * Its sibling below refuses, and the asymmetry is the point rather than an
 * oversight. An unnamed extractor means §5.10's work cannot be done at all; an
 * unnamed adjudicator means only that the last rung of §5.2's ladder has nobody
 * to ask, and §5.2 has an answer for a rung that cannot answer — *"if nothing
 * resolves above threshold, the mention mints a provisional existence claim"*.
 * `unresolved` states exactly that in the vocabulary {@link Adjudicator} already
 * owns: the model cannot choose, which is true in the limit of a model that was
 * never configured. The ladder mints on it, the write it was in the middle of
 * completes, and the minted referent records the form — so every later use of
 * that form answers from the mention index without escalating again.
 *
 * Rejecting here instead is the same fact stated as a failure, and it costs
 * three things a decline does not. The write aborts mid-message, after the
 * mentions ahead of the ambiguous one have already been resolved. §5.10's drain
 * cannot tell the rejection apart from a model that timed out, so it hands the
 * chunk back as transient and burns an attempt per run against a configuration
 * that will not change until somebody edits a file — until §9's cap parks the
 * chunk for good. And all of it happens under an exit code of 0, because a
 * `reflect` that mined nothing still completed its pass.
 *
 * The configuration path is therefore not taken: there is no refusal to address
 * to an operator, and nothing here for {@link UnconfiguredPortError} to name.
 *
 * @spec §5.2, §5.10, §7.6, §9
 */
const decliningAdjudicator = (): Adjudicator => ({
  tiebreakReferent: () => Promise.resolve({ outcome: 'unresolved' }),
});

/**
 * §5.10's port, when nobody named one.
 *
 * `.extract` is unreachable through either caller today: `reflect.ts` asks
 * {@link requirePort} for `'extractor'` before it ever calls {@link openModels},
 * so an unconfigured repository never takes this branch there, and `ingest.ts`
 * calls `openModels` but never reads `models.extractor` at all. Kept anyway,
 * because `openModels` builds a complete {@link Models} for whichever caller
 * asks — it has no business knowing that today's two happen to guard or ignore
 * this one port. A caller added later that reads `models.extractor` without
 * `reflect.ts`'s pre-flight check gets the same named refusal promised above,
 * instead of a crash on `undefined`.
 *
 * @spec §5.10, §11
 */
const refusingExtractor = (configPath: string): Extractor => ({
  modelId: 'unconfigured',
  extract: () => Promise.reject(new UnconfiguredPortError('extractor', configPath)),
});

/** The three ports a command writes through. @spec §5.2, §5.3, §5.10, §11 */
export interface Models {
  readonly embeddings: EmbeddingProvider;
  readonly adjudicator: Adjudicator;
  readonly extractor: Extractor;
}

/**
 * Builds every port, importing only the modules the configuration actually
 * names.
 *
 * @spec §5.2, §5.3, §5.10, §11
 */
export const openModels = async (
  configuration: Configuration,
  workspace: Workspace,
): Promise<Models> => {
  const { models } = configuration;
  const { configPath } = workspace;

  return {
    embeddings: await openEmbeddings(configuration, workspace),
    adjudicator: await openAdjudicator(configuration, workspace),
    extractor:
      models.extractor === undefined
        ? refusingExtractor(configPath)
        : await loadPort<Extractor>('extractor', models.extractor, configPath),
  };
};

/**
 * The specifier for a port the caller cannot proceed without, or
 * {@link UnconfiguredPortError}.
 *
 * Asked of the *configuration* rather than of a built port, so a command can
 * refuse before it imports anything, opens anything or touches §9's queue.
 *
 * @spec §5.10, §7.6, §9
 */
export const requirePort = (
  configuration: Configuration,
  port: ModelPortName,
  workspace: Workspace,
): string => {
  const specifier = configuration.models[port];
  if (specifier === undefined) throw new UnconfiguredPortError(port, workspace.configPath);
  return specifier;
};
