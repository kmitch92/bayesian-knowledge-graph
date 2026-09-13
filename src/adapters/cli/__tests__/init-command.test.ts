/**
 * `kgmem init [path]` — the command that makes a directory a workspace, and
 * does nothing else.
 *
 * Until this command exists, every `ingest` and `reflect` from a clean checkout
 * refuses with `Config`: `requireWorkspace` wants a `.kgmem` directory and no
 * production path makes one. Every other suite in this directory steps around
 * that by building `.kgmem` by hand. This one does not.
 *
 * ── What `init` is, and what it is not ──────────────────────────────────────
 *
 * It creates `.kgmem/`, the store inside it and a configuration beside the
 * store. It does not read the directory it is pointed at: getting content into
 * the graph is a separate, explicit action (`kgmem ingest`). A directory of
 * notes and a code repository are initialised identically, which is why every
 * fixture below is a bare temp directory and never a repository.
 *
 * ── The rulings pinned here ─────────────────────────────────────────────────
 *
 * 1. **Running it again is success and destroys nothing.** Proven against a
 *    graph with real rows in it and a configuration an operator edited — an
 *    empty file surviving proves nothing.
 * 2. **The path is optional and defaults to the working directory.** A path
 *    that does not exist, or is a file, is a command typed wrong (`Usage`), and
 *    leaves no `.kgmem` anywhere.
 * 3. **The store is made at `init`, not on first use**, so a store that cannot
 *    be made fails at `init`. The headline proof is end to end: `init`, then the
 *    existing `ingest`, with nothing built by hand in between.
 * 4. **The configuration it writes is `{"models": {}}`**: the one key an
 *    operator edits, present and empty, and read by `reflect` as unconfigured
 *    rather than unreadable.
 * 5. **A directory already inside a workspace is reported, not given a second
 *    one.** `init` in a subdirectory of a directory holding `.kgmem/` creates
 *    nothing, succeeds, and names the parent's `.kgmem` — the one every later
 *    command run there finds.
 * 6. **A file called `.kgmem` blocks `init` as `Usage`.** Not `Config`, which a
 *    hook reads as "run `kgmem init`" — the command that just refused — and not
 *    `Failed`, which reads as "try again later" against an obstacle that will
 *    still be there. The operator's fix is to move the file or pick another
 *    path: the command as typed cannot be run.
 *
 * @spec §11
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../commands';

import {
  CONFIG_FILE,
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  KGMEM_DIR,
  NOTEBOOK_FILE,
  NOTHING,
  REFUSED,
  STORE_FILE,
  bareWorkspace,
  failureShape,
  notebookFileText,
  refusedOnItsOwnTerms,
  runCli,
  seedIngest,
  snapshot,
  sourceFor,
  type BareWorkspace,
  type CliRun,
  type Snapshot,
} from './cli-fixtures';

/**
 * The command an operator is pointed at once the workspace exists.
 *
 * Not vacuous against any output this binary can produce today: the help text
 * says `ingest <path>` and `Usage: kgmem <command>`, never `kgmem ingest`, and
 * `NoWorkspaceError` names `kgmem init`.
 *
 * @spec §5.10
 */
const NEXT_COMMAND = 'kgmem ingest';

/**
 * What a re-run says that a first run does not.
 *
 * Asserted true on the re-run and false on the first run, so an `init` that
 * prints the same sentence both times fails one of the two.
 */
const SAYS_IT_ALREADY_EXISTED = /already/iu;

/** `UnconfiguredPortError`'s own words for the extractor. @spec §5.10 */
const NO_EXTRACTOR_CONFIGURED = /no extractor is configured/iu;

/**
 * The system-call codes a raw `mkdir` failure reports itself with.
 *
 * `report.ts` reports an unanticipated error as its bare message, so an `init`
 * that let `mkdirSync` throw into `refuse` prints one of these.
 */
const RAW_ERRNO = /\b(EEXIST|ENOTDIR|ENOENT)\b/u;

/**
 * A configuration an operator wrote by hand, in formatting no serializer
 * produces: inner spaces, no trailing newline. A re-run that parsed and
 * re-wrote it — even unchanged in meaning — changes its bytes.
 *
 * The module it names does not exist, and `init` has no business finding that
 * out.
 */
const OPERATOR_CONFIG = '{ "models": { "extractor": "./named-by-the-operator.js" } }';

/**
 * The ports `ingest` needs, named by hand in the same serializer-proof
 * formatting as {@link OPERATOR_CONFIG}.
 *
 * Faked for the reason every suite here fakes them: the default embeddings load
 * ~250MB of ONNX weights. Writing this file is the operator's step after `init`;
 * the directory and the store are `init`'s alone.
 *
 * @spec §5.2, §5.3
 */
const OPERATOR_PORTS_CONFIG = `{ "models": { "embeddings": ${JSON.stringify(FAKE_EMBEDDINGS_MODULE)}, "adjudicator": ${JSON.stringify(FAKE_ADJUDICATOR_MODULE)} } }`;

/** What sits in a file that happens to be called `.kgmem`. */
const BLOCKING_FILE_TEXT = 'a file, not a workspace, that happens to be called .kgmem\n';

/** The name a missing directory is given. */
const NEVER_MADE = 'never-made';

/** Where a workspace rooted at a directory keeps its parts. @spec §11 */
interface Layout {
  readonly home: string;
  readonly storePath: string;
  readonly configPath: string;
}

const layoutOf = (root: string): Layout => {
  const home = join(root, KGMEM_DIR);
  return { home, storePath: join(home, STORE_FILE), configPath: join(home, CONFIG_FILE) };
};

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/**
 * The store's contents, or `undefined` when there is no file.
 *
 * Guarded so that a missing store reads as a failed assertion rather than as
 * `snapshot` creating an empty file and throwing on its first query.
 */
const storeIfPresent = (storePath: string): Snapshot | undefined =>
  existsSync(storePath) ? snapshot(storePath) : undefined;

const textIfPresent = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;

describe('kgmem init with no path, in a directory that is not a workspace', () => {
  let workspace: BareWorkspace;
  let layout: Layout;
  let run: CliRun;
  let storeExistedAfterInit: boolean;
  let configAfterInit: string | undefined;
  let reflectRun: CliRun;

  beforeAll(async () => {
    workspace = bareWorkspace();
    layout = layoutOf(realpathSync(workspace.root));

    run = await runCli(['init'], workspace.root);
    storeExistedAfterInit = existsSync(layout.storePath);
    configAfterInit = textIfPresent(layout.configPath);

    reflectRun = await runCli(['reflect'], workspace.root);
  }, 120_000);

  afterAll(() => {
    workspace.close();
  });

  it('succeeds, and says so on stderr rather than on the stdout the transports own', () => {
    expect({ code: run.code, stdout: run.stdout, reported: run.stderr.length > 0 }).toStrictEqual({
      code: ExitCode.Ok,
      stdout: '',
      reported: true,
    });
  });

  it('makes `.kgmem` a directory in the directory it was run in', () => {
    expect(isDirectory(layout.home)).toBe(true);
  });

  /*
   * `ingest` would make the store on first use if `init` did not, so "ingest
   * works afterwards" cannot tell the two apart. This can: a migrated store
   * answers every table `snapshot` reads, and an empty file or no file does not.
   */
  it('creates the store now, migrated and empty, rather than leaving it to the first command that needs one', () => {
    expect({
      existed: storeExistedAfterInit,
      contents: storeIfPresent(layout.storePath),
    }).toStrictEqual({ existed: true, contents: NOTHING });
  });

  it('writes a configuration naming no model yet', () => {
    const parsed: unknown =
      configAfterInit === undefined ? undefined : (JSON.parse(configAfterInit) as unknown);

    expect(parsed).toStrictEqual({ models: {} });
  });

  /*
   * Through the configuration reader the other commands use, rather than a
   * second copy of its schema here. A file it rejects is `Config` too, so the
   * sentence is the discriminator; a missing file reads as unconfigured as well,
   * which is what the test above rules out.
   */
  it('writes that configuration in a form `reflect` reads as unconfigured, not as unreadable', () => {
    expect({
      code: reflectRun.code,
      unconfigured: NO_EXTRACTOR_CONFIGURED.test(reflectRun.stderr),
    }).toStrictEqual({ code: ExitCode.Config, unconfigured: true });
  });

  /*
   * argv was `['init']` alone, so neither the workspace path nor the next
   * command can be echoed back from input.
   */
  it('says where the workspace is and which command comes next', () => {
    expect({
      code: run.code,
      namesTheWorkspace: run.stderr.includes(layout.home),
      pointsAtTheNextCommand: run.stderr.includes(NEXT_COMMAND),
      saysItAlreadyExisted: SAYS_IT_ALREADY_EXISTED.test(run.stderr),
    }).toStrictEqual({
      code: ExitCode.Ok,
      namesTheWorkspace: true,
      pointsAtTheNextCommand: true,
      saysItAlreadyExisted: false,
    });
  });
});

describe('ingesting straight after init, into a directory nobody built by hand', () => {
  let elsewhere: BareWorkspace;
  let target: BareWorkspace;
  let layout: Layout;
  let documentId: string;
  let initRun: CliRun;
  let ingestRun: CliRun;

  beforeAll(async () => {
    elsewhere = bareWorkspace();
    target = bareWorkspace();
    layout = layoutOf(target.root);

    initRun = await runCli(['init', target.root], elsewhere.root);
    if (isDirectory(layout.home)) writeFileSync(layout.configPath, OPERATOR_PORTS_CONFIG, 'utf8');

    const filePath = target.file(NOTEBOOK_FILE, notebookFileText());
    documentId = (await sourceFor(filePath)).id;
    ingestRun = await runCli(['ingest', filePath], target.root);
  }, 180_000);

  afterAll(() => {
    elsewhere.close();
    target.close();
  });

  it('lets the existing ingest succeed and write the document into the workspace init made', () => {
    expect({
      init: initRun.code,
      ingest: ingestRun.code,
      documents: storeIfPresent(layout.storePath)?.documents,
    }).toStrictEqual({ init: ExitCode.Ok, ingest: ExitCode.Ok, documents: [documentId] });
  });

  /*
   * A router that echoed argv would quote `target.root`, but never
   * `target.root/.kgmem`.
   */
  it('puts the workspace at the path it was handed, not where it was run, and says so', () => {
    expect({
      atTheNamedPath: isDirectory(layout.home),
      whereItWasRun: existsSync(join(elsewhere.root, KGMEM_DIR)),
      namesTheWorkspace: initRun.stderr.includes(layout.home),
    }).toStrictEqual({ atTheNamedPath: true, whereItWasRun: false, namesTheWorkspace: true });
  });
});

describe('kgmem init over a workspace an operator has already been using', () => {
  let workspace: BareWorkspace;
  let layout: Layout;
  let documentId: string;
  let first: CliRun;
  let second: CliRun;
  let configBefore: string | undefined;
  let configAfter: string | undefined;
  let storeBefore: Snapshot | undefined;
  let storeAfter: Snapshot | undefined;

  beforeAll(async () => {
    workspace = bareWorkspace();
    layout = layoutOf(realpathSync(workspace.root));

    first = await runCli(['init'], workspace.root);

    const filePath = workspace.file(NOTEBOOK_FILE, notebookFileText());
    documentId = (await sourceFor(filePath)).id;
    if (existsSync(layout.storePath)) await seedIngest(layout.storePath, filePath);
    if (isDirectory(layout.home)) writeFileSync(layout.configPath, OPERATOR_CONFIG, 'utf8');

    configBefore = textIfPresent(layout.configPath);
    storeBefore = storeIfPresent(layout.storePath);

    second = await runCli(['init'], workspace.root);

    configAfter = textIfPresent(layout.configPath);
    storeAfter = storeIfPresent(layout.storePath);
  }, 180_000);

  afterAll(() => {
    workspace.close();
  });

  it('succeeds again rather than refusing, on stderr only', () => {
    expect({ first: first.code, second: second.code, stdout: second.stdout }).toStrictEqual({
      first: ExitCode.Ok,
      second: ExitCode.Ok,
      stdout: '',
    });
  });

  it('says the workspace was already there, and where', () => {
    expect({
      code: second.code,
      saysItAlreadyExisted: SAYS_IT_ALREADY_EXISTED.test(second.stderr),
      namesTheWorkspace: second.stderr.includes(layout.home),
    }).toStrictEqual({ code: ExitCode.Ok, saysItAlreadyExisted: true, namesTheWorkspace: true });
  });

  it('leaves the operator’s configuration byte for byte as they wrote it', () => {
    expect({ before: configBefore, after: configAfter }).toStrictEqual({
      before: OPERATOR_CONFIG,
      after: OPERATOR_CONFIG,
    });
  });

  /*
   * `held` is the precondition that makes `after` mean something: a graph with
   * a document in it, not an empty store that any re-migration would also
   * leave empty.
   */
  it('leaves every row the graph already held', () => {
    expect({ held: storeBefore?.documents, after: storeAfter }).toStrictEqual({
      held: [documentId],
      after: storeBefore,
    });
  });
});

/*
 * One populated parent, two nested runs, and the snapshots between them, so a
 * run that damages the parent is named by which form did it.
 *
 * The parent's `.kgmem` path is never a substring of the subdirectory's would-be
 * one — `<root>/.kgmem` against `<root>/notes/deep/.kgmem` — and neither is in
 * argv. `namesASubdirectoryWorkspace` is asserted false beside it anyway, so an
 * `init` that printed both paths cannot pass.
 */
describe('kgmem init inside a directory that already belongs to a workspace', () => {
  let parent: BareWorkspace;
  let elsewhere: BareWorkspace;
  let parentLayout: Layout;
  let subdirectory: string;
  let subdirectoryHome: string;
  let seededId: string;
  let subdirectoryDocumentId: string;
  let parentInit: CliRun;
  let fromTheSubdirectory: CliRun;
  let handedTheSubdirectory: CliRun;
  let ingestFromTheSubdirectory: CliRun;
  let storeBefore: Snapshot | undefined;
  let configAfterFromTheSubdirectory: string | undefined;
  let storeAfterFromTheSubdirectory: Snapshot | undefined;
  let configAfterHandedTheSubdirectory: string | undefined;
  let storeAfterHandedTheSubdirectory: Snapshot | undefined;
  let storeAfterIngest: Snapshot | undefined;

  beforeAll(async () => {
    parent = bareWorkspace();
    elsewhere = bareWorkspace();
    const parentRoot = realpathSync(parent.root);
    parentLayout = layoutOf(parentRoot);
    subdirectory = join(parentRoot, 'notes', 'deep');
    subdirectoryHome = join(subdirectory, KGMEM_DIR);

    parentInit = await runCli(['init'], parent.root);

    const seededPath = parent.file(NOTEBOOK_FILE, notebookFileText());
    seededId = (await sourceFor(seededPath)).id;
    if (existsSync(parentLayout.storePath)) await seedIngest(parentLayout.storePath, seededPath);
    if (isDirectory(parentLayout.home))
      writeFileSync(parentLayout.configPath, OPERATOR_PORTS_CONFIG, 'utf8');
    storeBefore = storeIfPresent(parentLayout.storePath);

    mkdirSync(subdirectory, { recursive: true });
    const subdirectoryPath = join(subdirectory, NOTEBOOK_FILE);
    writeFileSync(subdirectoryPath, notebookFileText(), 'utf8');
    subdirectoryDocumentId = (await sourceFor(subdirectoryPath)).id;

    fromTheSubdirectory = await runCli(['init'], subdirectory);
    configAfterFromTheSubdirectory = textIfPresent(parentLayout.configPath);
    storeAfterFromTheSubdirectory = storeIfPresent(parentLayout.storePath);

    handedTheSubdirectory = await runCli(['init', subdirectory], elsewhere.root);
    configAfterHandedTheSubdirectory = textIfPresent(parentLayout.configPath);
    storeAfterHandedTheSubdirectory = storeIfPresent(parentLayout.storePath);

    ingestFromTheSubdirectory = await runCli(['ingest', subdirectoryPath], subdirectory);
    storeAfterIngest = storeIfPresent(parentLayout.storePath);
  }, 180_000);

  afterAll(() => {
    parent.close();
    elsewhere.close();
  });

  describe('run from the subdirectory with no path', () => {
    it('succeeds and makes no `.kgmem` in the subdirectory', () => {
      expect({
        parentInit: parentInit.code,
        code: fromTheSubdirectory.code,
        stdout: fromTheSubdirectory.stdout,
        madeOneInTheSubdirectory: existsSync(subdirectoryHome),
      }).toStrictEqual({
        parentInit: ExitCode.Ok,
        code: ExitCode.Ok,
        stdout: '',
        madeOneInTheSubdirectory: false,
      });
    });

    it('says it is already inside a workspace, naming the parent’s `.kgmem` and not one of its own', () => {
      expect({
        code: fromTheSubdirectory.code,
        saysItAlreadyExisted: SAYS_IT_ALREADY_EXISTED.test(fromTheSubdirectory.stderr),
        namesTheParentWorkspace: fromTheSubdirectory.stderr.includes(parentLayout.home),
        namesASubdirectoryWorkspace: fromTheSubdirectory.stderr.includes(subdirectoryHome),
      }).toStrictEqual({
        code: ExitCode.Ok,
        saysItAlreadyExisted: true,
        namesTheParentWorkspace: true,
        namesASubdirectoryWorkspace: false,
      });
    });

    it('leaves the parent’s configuration bytes and rows as they were', () => {
      expect({
        held: storeBefore?.documents,
        config: configAfterFromTheSubdirectory,
        store: storeAfterFromTheSubdirectory,
      }).toStrictEqual({ held: [seededId], config: OPERATOR_PORTS_CONFIG, store: storeBefore });
    });
  });

  describe('run from elsewhere, handed the subdirectory', () => {
    it('succeeds and makes no `.kgmem` in the subdirectory or where it was run', () => {
      expect({
        code: handedTheSubdirectory.code,
        stdout: handedTheSubdirectory.stdout,
        madeOneInTheSubdirectory: existsSync(subdirectoryHome),
        madeOneWhereItWasRun: existsSync(join(elsewhere.root, KGMEM_DIR)),
      }).toStrictEqual({
        code: ExitCode.Ok,
        stdout: '',
        madeOneInTheSubdirectory: false,
        madeOneWhereItWasRun: false,
      });
    });

    it('says it is already inside a workspace, naming the parent’s `.kgmem` and not one of its own', () => {
      expect({
        code: handedTheSubdirectory.code,
        saysItAlreadyExisted: SAYS_IT_ALREADY_EXISTED.test(handedTheSubdirectory.stderr),
        namesTheParentWorkspace: handedTheSubdirectory.stderr.includes(parentLayout.home),
        namesASubdirectoryWorkspace: handedTheSubdirectory.stderr.includes(subdirectoryHome),
      }).toStrictEqual({
        code: ExitCode.Ok,
        saysItAlreadyExisted: true,
        namesTheParentWorkspace: true,
        namesASubdirectoryWorkspace: false,
      });
    });

    it('leaves the parent’s configuration bytes and rows as they were', () => {
      expect({
        held: storeBefore?.documents,
        config: configAfterHandedTheSubdirectory,
        store: storeAfterHandedTheSubdirectory,
      }).toStrictEqual({ held: [seededId], config: OPERATOR_PORTS_CONFIG, store: storeBefore });
    });
  });

  it('leaves a later ingest from the subdirectory landing in the parent’s store', () => {
    expect({
      code: ingestFromTheSubdirectory.code,
      documents: storeAfterIngest?.documents,
      madeOneInTheSubdirectory: existsSync(subdirectoryHome),
    }).toStrictEqual({
      code: ExitCode.Ok,
      documents: [seededId, subdirectoryDocumentId].toSorted(),
      madeOneInTheSubdirectory: false,
    });
  });
});

describe('kgmem init handed a path that is not a directory', () => {
  describe('because nothing is there', () => {
    let elsewhere: BareWorkspace;
    let parent: BareWorkspace;
    let missing: string;
    let run: CliRun;

    beforeAll(async () => {
      elsewhere = bareWorkspace();
      parent = bareWorkspace();
      missing = join(parent.root, NEVER_MADE);

      run = await runCli(['init', missing], elsewhere.root);
    }, 120_000);

    afterAll(() => {
      elsewhere.close();
      parent.close();
    });

    it('refuses it as a command typed wrong, on its own terms', () => {
      expect({ code: run.code, shape: failureShape(run) }).toStrictEqual({
        code: ExitCode.Usage,
        shape: REFUSED,
      });
    });

    /*
     * `refused` rides along because the unknown-command message quotes argv,
     * path included. A raw `mkdir` error would name the path too, and is
     * `Failed`, which the test above rules out.
     */
    it('names the path it could not use', () => {
      expect({
        namesThePath: run.stderr.includes(missing),
        refused: refusedOnItsOwnTerms(run),
      }).toStrictEqual({ namesThePath: true, refused: true });
    });

    it('makes nothing: not the directory, not a workspace beside it, not one where it was run', () => {
      expect({
        madeThePath: existsSync(missing),
        besideIt: existsSync(join(parent.root, KGMEM_DIR)),
        whereItWasRun: existsSync(join(elsewhere.root, KGMEM_DIR)),
        refused: refusedOnItsOwnTerms(run),
      }).toStrictEqual({ madeThePath: false, besideIt: false, whereItWasRun: false, refused: true });
    });
  });

  describe('because it is a file', () => {
    let elsewhere: BareWorkspace;
    let parent: BareWorkspace;
    let filePath: string;
    let run: CliRun;

    beforeAll(async () => {
      elsewhere = bareWorkspace();
      parent = bareWorkspace();
      filePath = parent.file(NOTEBOOK_FILE, notebookFileText());

      run = await runCli(['init', filePath], elsewhere.root);
    }, 120_000);

    afterAll(() => {
      elsewhere.close();
      parent.close();
    });

    it('refuses it as a command typed wrong, on its own terms', () => {
      expect({ code: run.code, shape: failureShape(run) }).toStrictEqual({
        code: ExitCode.Usage,
        shape: REFUSED,
      });
    });

    it('names the path it could not use', () => {
      expect({
        namesThePath: run.stderr.includes(filePath),
        refused: refusedOnItsOwnTerms(run),
      }).toStrictEqual({ namesThePath: true, refused: true });
    });

    it('makes no workspace beside the file or where it was run, and leaves the file as it was', () => {
      expect({
        file: readFileSync(filePath, 'utf8'),
        besideIt: existsSync(join(parent.root, KGMEM_DIR)),
        whereItWasRun: existsSync(join(elsewhere.root, KGMEM_DIR)),
        refused: refusedOnItsOwnTerms(run),
      }).toStrictEqual({
        file: notebookFileText(),
        besideIt: false,
        whereItWasRun: false,
        refused: true,
      });
    });
  });
});

describe('kgmem init where a file called `.kgmem` is in the way', () => {
  let elsewhere: BareWorkspace;
  let blocked: BareWorkspace;
  let blockingPath: string;
  let run: CliRun;

  beforeAll(async () => {
    elsewhere = bareWorkspace();
    blocked = bareWorkspace();
    blockingPath = join(blocked.root, KGMEM_DIR);
    writeFileSync(blockingPath, BLOCKING_FILE_TEXT, 'utf8');

    run = await runCli(['init', blocked.root], elsewhere.root);
  }, 120_000);

  afterAll(() => {
    elsewhere.close();
    blocked.close();
  });

  /*
   * `rawErrno` is the crash this guards against: a bare `mkdirSync` over the
   * file throws EEXIST into `refuse`'s unnamed arm, which exits `Failed` and
   * prints the system error as the whole diagnosis.
   */
  it('refuses as a command that cannot be run as typed, not as a crash', () => {
    expect({
      code: run.code,
      shape: failureShape(run),
      rawErrno: RAW_ERRNO.test(run.stderr),
    }).toStrictEqual({ code: ExitCode.Usage, shape: REFUSED, rawErrno: false });
  });

  /*
   * argv holds `blocked.root`, never `blocked.root/.kgmem`. A raw EEXIST names
   * the blocking path too, which is why the code rides along.
   */
  it('names the file that is in the way', () => {
    expect({
      code: run.code,
      namesTheBlockingPath: run.stderr.includes(blockingPath),
    }).toStrictEqual({ code: ExitCode.Usage, namesTheBlockingPath: true });
  });

  it('leaves the file byte for byte as it was and creates nothing else', () => {
    expect({
      stillAFile: isFile(blockingPath),
      text: textIfPresent(blockingPath),
      entries: readdirSync(blocked.root),
      whereItWasRun: existsSync(join(elsewhere.root, KGMEM_DIR)),
      refused: refusedOnItsOwnTerms(run),
    }).toStrictEqual({
      stillAFile: true,
      text: BLOCKING_FILE_TEXT,
      entries: [KGMEM_DIR],
      whereItWasRun: false,
      refused: true,
    });
  });
});
