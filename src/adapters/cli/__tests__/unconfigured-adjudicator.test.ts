/**
 * The §5.2 port a fresh install is handed, and what the write path does when it
 * reaches rung 4 holding one.
 *
 * `config.ts` used to give a repository that names no `models.adjudicator` a stub
 * whose `tiebreakReferent` *rejected* with {@link UnconfiguredPortError}. That is
 * every user who has not edited `.kgmem/config.json`, which is the default.
 * `ladder.ts` does not catch it — rung 4 is one bare `await`, and deliberately so
 * — which meant the first genuinely ambiguous mention in the graph aborted the
 * write it was in the middle of. The stub now *declines* instead, and this file
 * is what holds it there.
 *
 * Nothing tested that stub. This was the hole `default-embedding-width.test.ts`
 * closed for §5.3: the branch every default user takes had no test at all, so it
 * was free to contradict the contract it sits under.
 *
 * ── The contract it contradicted ────────────────────────────────────────────
 *
 * {@link Adjudicator}'s own docblock, in as many words: *"A port, so the write
 * path can run with no model at all — a graph with no adjudicator resolves three
 * rungs and mints on the fourth, which is a humbler graph and not a broken one."*
 * §5.2 agrees from the spec's side — *"if nothing resolves above threshold, the
 * mention mints a provisional existence claim"*, and *"fragmentation is answered
 * by minting into a lifecycle, not by refusing to mint."*
 *
 * ── The discrimination this file exists for ─────────────────────────────────
 *
 * Two ways rung 4 can fail, and they are not the same failure.
 *
 * **Unconfigured** is a settled, permanent fact about this repository: there is
 * no model to ask, there will not be one before someone edits a file, and
 * retrying cannot manufacture one. §5.2's answer to a question nobody can settle
 * is to mint into a lifecycle.
 *
 * **Anything else** — a timeout, a 5xx, a malformed verdict from a model that is
 * really there — is transient. Minting on one writes a permanent duplicate
 * referent as the consequence of a temporary outage, and §8.4's split is then
 * needed to undo by hand what five minutes of downtime caused. The failure has
 * to reach the caller.
 *
 * So the fix that satisfies this file cannot be a broad `catch` at rung 4, and
 * it equally cannot be a pre-flight `requirePort(configuration, 'adjudicator',
 * …)` in the commands: that would refuse on every fresh install, which is exactly
 * the breakage `default-embedding-width.test.ts` was written to repair.
 * `resolution-ladder.test.ts` holds the first half of that fence — a rejecting
 * adjudicator's failure reaching the caller — and this file holds the second.
 *
 * ── Where the assertions are made, and why not elsewhere ────────────────────
 *
 * Through `openIngest.submit`, §1's one door, and through a spawned `kgmem
 * reflect`. Never against the port object itself: whether the stub declines, or
 * the ladder learns to run without one, or the absence becomes representable in
 * {@link LadderContext}, is a question about which module changes. What an
 * operator observes is that a write completes and a graph grows by one referent,
 * and that is what is pinned here — every shape of the fix has to produce it.
 *
 * ── What is faked ───────────────────────────────────────────────────────────
 *
 * The store is real: `:memory:` for the port-level cases, a real file under a
 * real temp repository for the spawned one. The embedding provider is the
 * declared-cluster fake, because the real one loads ~250MB of ONNX weights and
 * `default-embedding-width.test.ts` already owns the question of which provider a
 * fresh install gets. The adjudicator is emphatically *not* faked in the cases
 * that matter: it is whatever `openModels` builds for a configuration that names
 * none, which is the whole subject.
 *
 * @spec §1, §5.2, §5.10, §7.6, §8.4, §9, §11, §15
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { chunkText, type TextSource } from '../../../extract/index';
import {
  OVERHAUL_LEDGER,
  memberTexts,
} from '../../../extract/__tests__/extraction-fixtures';
import { openIngest, type IngestPort, type IngestReceipt } from '../../../ingest/index';
import type { Adjudicator } from '../../../referents/index';
import {
  COSINE_FLOOR,
  agentOrigin,
  attestationMessage,
  claimMessage,
  declaredCosine,
  emitterOrigin,
  fakeAdjudicator,
  fakeEmbeddings,
  rejectingAdjudicator,
} from '../../../referents/__tests__/fixtures';
import { openGraphStore, type GraphStore } from '../../../store/index';

import { ExitCode } from '../commands';
import { openModels, readConfiguration } from '../config';
import { KGMEM_DIR, findWorkspace, type Workspace } from '../workspace';

import {
  FAKE_EMBEDDINGS_MODULE,
  FAKE_EXTRACTOR_MODULE,
  NOTEBOOK_FILE,
  notebookFileText,
  queueStates,
  repo,
  runCli,
  seedIngest,
  snapshot,
  withStore,
  type CliRun,
  type Repo,
} from './cli-fixtures';
import { MEMBERS_PER_CHUNK, MEMBER_MARK } from './fake-extractor-module';

/**
 * The 250MB dependency, absent.
 *
 * `openModels` falls back to the real local embedding adapter for any
 * configuration that names no provider, and constructing it imports
 * `@huggingface/transformers`. Hoisted above every import here for
 * `default-embedding-width.test.ts`'s reason: the adapter is reachable through
 * `config.ts`'s dynamic import, and nothing in this file has any business
 * downloading a model.
 */
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: () => {
    throw new Error(
      'an adjudicator test loaded model weights: nothing in this file should reach the model',
    );
  },
}));

/*
 * ---------------------------------------------------------------------------
 * The ambiguity.
 * ---------------------------------------------------------------------------
 */

/**
 * The form two referents come to share, and the only question rung 4 is asked
 * below.
 *
 * Borrowed from the extraction fixtures rather than invented, because the
 * spawned case needs the *extractor's* own noun to be the ambiguous one:
 * `membersPerChunk` names {@link OVERHAUL_LEDGER} in every proposal, so making
 * that form ambiguous is what puts the drain in front of rung 4 without a second
 * extractor fixture existing to do it.
 */
const SHARED = OVERHAUL_LEDGER;

/** What the first referent is actually called. Undeclared, so geometry cannot see it. */
const YARD_DAYBOOK = 'the yard daybook';

/** What the second is actually called. Likewise undeclared, and likewise unreachable. */
const PUMP_HOUSE_JOURNAL = 'the pump-house journal';

/** What one alias binding is worth. The ladder never reads it; `deriveName` does. @spec §4.2 */
const ONE_NAMING = 1;

/** How many referents the arrangement holds before the shared form is ever used. */
const RIVALS = 2;

/** The claim that uses the shared form, and the text rung 4 gets as its context. */
const THE_CLAIM = `Episode 9 had something to say about ${SHARED}.`;

/**
 * Two referents, each declared under a name of its own, each since nicknamed
 * {@link SHARED}.
 *
 * The declarations go through §1's door as attestations rather than as claims,
 * so the ledger gains nothing but spine — an existence claim and two naming
 * claims apiece, all of them spine-encoded and therefore invisible to
 * {@link memberTexts}. That keeps "how many members did the drain write" a
 * statement about the drain.
 *
 * The nickname is written straight onto the mention index, which is
 * `mention-ambiguity.test.ts`'s arrangement and its argument: every rung records
 * what it resolved, so a second referent can never *acquire* a form the first one
 * already holds by going through the ladder — the ladder would hand the form back
 * to the first one. The state arrives from §8.4's split, from a rebuild, or from
 * a graph merged in from elsewhere, and `putMention` is the store's own public
 * write that stands in for all three.
 *
 * Neither referent is *called* the shared form, so no canonical match outranks
 * the other and §5.2 has a plurality at equal strength — the one thing neither
 * the index nor an embedding can settle.
 *
 * @spec §3.1, §5.2, §8.4
 */
const anAmbiguity = async (
  adjudicator: Adjudicator,
  path = ':memory:',
): Promise<{ store: GraphStore; ingest: IngestPort; rivals: readonly string[] }> => {
  const store = openGraphStore({ path });
  const ingest = openIngest({ store, embeddings: fakeEmbeddings(), adjudicator });
  const rivals: string[] = [];
  for (const [at, form] of [YARD_DAYBOOK, PUMP_HOUSE_JOURNAL].entries()) {
    const receipt = await ingest.submit(
      attestationMessage(form, { origin: emitterOrigin(at + 1) }),
    );
    const referentId = receipt.resolutions[0]?.referentId;
    if (referentId === undefined) throw new Error(`the door minted no referent for "${form}"`);
    store.putMention({ surfaceForm: SHARED, referentId, weight: ONE_NAMING });
    rivals.push(referentId);
  }
  return { store, ingest, rivals };
};

/** Uses the shared form once, in an episode of its own. @spec §4.2, §5.2 */
const useTheSharedForm = (ingest: IngestPort): Promise<IngestReceipt> =>
  ingest.submit(claimMessage(THE_CLAIM, [SHARED], { origin: agentOrigin(9) }));

/*
 * ---------------------------------------------------------------------------
 * The port a repository that configures nothing is handed.
 * ---------------------------------------------------------------------------
 */

let root: string;
let workspace: Workspace;

/** A repository `init` has been run in, and nothing else: no `config.json`. @spec §7.6 */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kgmem-default-adjudicator-'));
  mkdirSync(join(root, KGMEM_DIR));
  const found = findWorkspace(root);
  if (found === undefined) throw new Error('the fixture repository has no .kgmem to find');
  workspace = found;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** §5.2's port, exactly as a user who has configured nothing receives it. @spec §5.2, §7.6 */
const defaultAdjudicator = async (): Promise<Adjudicator> =>
  (await openModels(readConfiguration(workspace), workspace)).adjudicator;

/**
 * The arrangement above, driven to rung 4 under a given port, reported as the
 * rung that answered — or as {@link REJECTED} when the caller was handed a
 * failure instead.
 *
 * One word for the whole outcome because the assertion that matters is a
 * *comparison* of two ports over one arrangement, and a comparison needs both
 * sides in the same vocabulary. `ResolutionRung` has no `'threw'` arm, so the
 * two cannot collide.
 */
const REJECTED = 'the write was abandoned';

const outcomeUnder = async (adjudicator: Adjudicator): Promise<string> => {
  const { store, ingest } = await anAmbiguity(adjudicator);
  try {
    const receipt = await useTheSharedForm(ingest);
    return receipt.resolutions[0]?.rung ?? 'no resolution was reported';
  } catch {
    return REJECTED;
  } finally {
    store.close();
  }
};

describe('the arrangement this file provokes rung 4 with', () => {
  /*
   * Both referents sit in private planes of the declared semantic space, so the
   * gloss channel reaches neither from the shared form. Without this, "the ladder
   * minted" would be satisfied by a ladder that never escalated at all, and every
   * assertion below would be about the wrong rung.
   */
  it('puts the shared form out of the gloss channel’s reach of either referent', () => {
    expect([
      declaredCosine(SHARED, YARD_DAYBOOK),
      declaredCosine(SHARED, PUMP_HOUSE_JOURNAL),
    ].every((cosine) => cosine < COSINE_FLOOR)).toBe(true);
  });

  /*
   * The load-bearing precondition, asserted against a port that answers rather
   * than one that fails: rung 4 is genuinely reached, once, with both rivals on
   * the slate. A test file about "what happens at rung 4" that never reached it
   * would be a file about minting.
   */
  it('reaches rung 4, offering the model both referents the form names', async () => {
    const model = fakeAdjudicator();
    const { store, ingest, rivals } = await anAmbiguity(model);

    await useTheSharedForm(ingest);

    expect({
      escalations: model.requests.length,
      offered: (model.requests[0]?.candidates ?? [])
        .map((candidate) => candidate.referentId)
        .sort(),
      asked: model.requests[0]?.surfaceForm,
    }).toStrictEqual({ escalations: 1, offered: [...rivals].sort(), asked: SHARED });
    store.close();
  });
});

describe('a rung-4 ambiguity in a repository that names no adjudicator', () => {
  it('mints, rather than abandoning the write it was in the middle of', async () => {
    const { store, ingest } = await anAmbiguity(await defaultAdjudicator());

    const receipt = await useTheSharedForm(ingest);

    expect(receipt.resolutions.map((entry) => entry.rung)).toStrictEqual(['minted']);
    store.close();
  });

  /*
   * The ledger row, read back off the store rather than off the receipt: a
   * receipt that names a claim id is the port's own account of what it wrote, and
   * §5.2's mint is only worth anything if the claim it was minted for landed.
   */
  it('lands the claim that used the form, and one new referent to hang it on', async () => {
    const { store, ingest } = await anAmbiguity(await defaultAdjudicator());

    const receipt = await useTheSharedForm(ingest);

    expect({
      text: store.getClaimSummary(receipt.claimId ?? '')?.text,
      referents: ingest.referents.all().length,
    }).toStrictEqual({ text: THE_CLAIM, referents: RIVALS + 1 });
    store.close();
  });

  /*
   * §5.2's point about minting into a lifecycle. A graph with no model to ask
   * settles the question *once* and answers it from the index thereafter — the
   * humbler graph, not a graph that mints a fresh referent every time the form is
   * used.
   */
  it('settles the form, so the next use answers at rung 1 without escalating', async () => {
    const { store, ingest } = await anAmbiguity(await defaultAdjudicator());
    const first = await useTheSharedForm(ingest);

    const again = await useTheSharedForm(ingest);

    expect({
      rung: again.resolutions[0]?.rung,
      sameReferent: again.resolutions[0]?.referentId === first.resolutions[0]?.referentId,
      referents: ingest.referents.all().length,
    }).toStrictEqual({ rung: 'exact', sameReferent: true, referents: RIVALS + 1 });
    store.close();
  });

  /*
   * The guard against the other wrong fix. A pre-flight `requirePort` would make
   * this throw, and `openModels` refusing outright would too — either way a fresh
   * install could not open the write path at all, which is the breakage E8a
   * repaired for §5.3's port.
   */
  it('is still a port the write path can be opened with', async () => {
    const adjudicator = await defaultAdjudicator();

    expect(typeof adjudicator.tiebreakReferent).toBe('function');
  });
});

/**
 * The other half of "absent means absent": present has to mean present.
 *
 * Every assertion above is about the port a repository that named nothing
 * receives, and all of them would still pass if `openModels` ignored
 * `models.adjudicator` and handed every caller the unconfigured stub — the
 * adjudicator every other suite in this directory configures is
 * `fake-adjudicator-module.ts`, which declines by default, and a decline is
 * exactly what the stub does. Nothing in the suite could tell the two apart, so
 * an operator who paid for a model could have it silently dropped under a green
 * run.
 *
 * `resolving-adjudicator-module.ts` is the port that can tell them apart, because
 * it answers. `tiebreak` is a rung neither stub in `config.ts` can produce.
 *
 * @spec §5.2, §7.6, §11
 */
describe('a rung-4 ambiguity in a repository that does name an adjudicator', () => {
  /** The module `.kgmem/config.json` points at, resolved as a path the loader takes. */
  const RESOLVING_ADJUDICATOR_MODULE = fileURLToPath(
    new URL('./resolving-adjudicator-module.ts', import.meta.url),
  );

  let configured: Repo;
  let configuredWorkspace: Workspace;

  beforeAll(() => {
    configured = repo();
    configured.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      adjudicator: RESOLVING_ADJUDICATOR_MODULE,
    });
    const found = findWorkspace(configured.root);
    if (found === undefined) throw new Error('the configured fixture repository has no .kgmem');
    configuredWorkspace = found;
  });

  afterAll(() => {
    configured.close();
  });

  it('asks the model the configuration named, instead of declining in its place', async () => {
    const models = await openModels(readConfiguration(configuredWorkspace), configuredWorkspace);
    const { store, ingest, rivals } = await anAmbiguity(models.adjudicator);

    const receipt = await useTheSharedForm(ingest);

    expect({
      rung: receipt.resolutions[0]?.rung,
      resolvedToARival: rivals.includes(receipt.resolutions[0]?.referentId ?? ''),
      referents: ingest.referents.all().length,
    }).toStrictEqual({ rung: 'tiebreak', resolvedToARival: true, referents: RIVALS });
    store.close();
  });
});

/**
 * The heart of it: one arrangement, two failing ports, two different endings.
 *
 * Today both end the same way, which is the defect stated as an equality. A fix
 * that made them both mint would pass the block above and fail here, and that is
 * the point of running them side by side rather than in separate files.
 */
describe('the two ways rung 4 can fail', () => {
  /** What a model that is really there, and really broken, rejects with. */
  const outage = (): Error => new Error('adjudicator request timed out after 30s');

  it('mints for the port a fresh install gets, and refuses for a model that failed', async () => {
    expect([
      await outcomeUnder(await defaultAdjudicator()),
      await outcomeUnder(rejectingAdjudicator(outage())),
    ]).toStrictEqual(['minted', REJECTED]);
  });

  /*
   * Identity, not shape. A ladder that caught the outage and rethrew a diagnosis
   * of its own would satisfy "it rejected" while destroying the one thing a
   * caller deciding whether to retry has to read.
   */
  it('hands the caller the very failure the configured model produced', async () => {
    const failure = outage();
    const { store, ingest } = await anAmbiguity(rejectingAdjudicator(failure));

    await expect(useTheSharedForm(ingest)).rejects.toBe(failure);
    store.close();
  });

  /*
   * The cost of getting this wrong, priced. A mint here is a permanent second
   * referent for a thing the graph already holds, bought with a temporary
   * outage, and §8.4's split is the only way back.
   */
  it('writes nothing at all for a mention a configured model failed on', async () => {
    const { store, ingest } = await anAmbiguity(rejectingAdjudicator(outage()));

    await useTheSharedForm(ingest).catch(() => undefined);

    expect({
      referents: ingest.referents.all().length,
      namedByTheSharedForm: store.findReferentsByMention(SHARED).length,
    }).toStrictEqual({ referents: RIVALS, namedByTheSharedForm: RIVALS });
    store.close();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The same defect, from outside the process.
 * ---------------------------------------------------------------------------
 */

/**
 * `kgmem reflect` is where a default install actually meets rung 4.
 *
 * Not `kgmem ingest`: `documentSource` never guesses an anchor (§3.6 — *"a prior,
 * not an inheritance"*), so the ingest command hands `openTextIngest` an
 * adjudicator it has no occasion to use. The drain is different — it submits one
 * claim per proposal through §1's door, and every one of those runs §5.2's ladder
 * per mention. A repository that configured an extractor and not an adjudicator
 * is the ordinary shape of a install that has got as far as reflecting, and it is
 * the one this block runs.
 *
 * The failure it produces today is worse than an abort. `extraction.ts`'s drain
 * treats anything thrown from `submit` as transient and hands the job back with
 * an attempt counted and a `retryAt` a minute out — the right answer for a model
 * that timed out, and the wrong one for a configuration that will never change on
 * its own. The backlog silently burns the retry budget §9 leaves for a caller to
 * cap, `reflect` reports a successful pass over chunks it mined nothing from, and
 * at {@link MAX_ATTEMPTS} the chunks are parked for good.
 *
 * So the exit code is not the instrument here — it is 0 either way. The queue and
 * the ledger are.
 *
 * @spec §1, §3.6, §5.10, §9, §12
 */
describe('kgmem reflect on a repository that configures no adjudicator', () => {
  let repository: Repo;
  let source: TextSource;
  let run: CliRun;

  beforeAll(async () => {
    repository = repo();
    repository.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      extractor: FAKE_EXTRACTOR_MODULE,
    });
    const filePath = repository.file(NOTEBOOK_FILE, notebookFileText());
    source = await seedIngest(repository.dbPath, filePath);
    // The graph has content before the drain runs, which is what makes the
    // extractor's noun ambiguous. On an empty store it would mint at rung 3 and
    // this defect would not fire — which is exactly why it looks fine on install
    // and aborts partway through a write later.
    const seeded = await anAmbiguity(fakeAdjudicator(), repository.dbPath);
    seeded.store.close();

    run = await runCli(['reflect'], repository.root);
  }, 180_000);

  afterAll(() => {
    repository.close();
  });

  /** How many chunks the seeded document parks jobs for. @spec §5.10 */
  const parked = (): number => chunkText(source.text).length;

  it('settles every parked job rather than handing it back to burn its retries', () => {
    const jobs = snapshot(repository.dbPath).jobs;

    expect({
      states: queueStates(jobs),
      attempts: jobs.reduce((total, job) => total + job.attempts, 0),
    }).toStrictEqual({
      states: { pending: 0, running: 0, done: parked(), failed: 0 },
      attempts: 0,
    });
  });

  it('succeeds having written the member every chunk proposed', () => {
    const members = withStore(repository.dbPath, memberTexts);

    expect({
      code: run.code,
      stdout: run.stdout,
      members: members.length,
      allFromTheExtractor: members.every((text) => text.includes(MEMBER_MARK)),
    }).toStrictEqual({
      code: ExitCode.Ok,
      stdout: '',
      members: parked() * MEMBERS_PER_CHUNK,
      allFromTheExtractor: true,
    });
  });

  /*
   * One referent for the ambiguous noun, not one per chunk. The first proposal
   * mints it and every proposal after that answers at rung 1, because a mint
   * records the form it minted under — so a drain that minted per chunk would
   * leave three referents all *called* the same thing, and a count of the graph
   * would not notice while a count of the canonical bindings does.
   */
  it('mints one referent for the ambiguous noun, and settles it for the chunks behind', () => {
    const bindings = withStore(repository.dbPath, (store) =>
      store.findReferentsByMention(SHARED),
    );

    expect({
      canonical: bindings.filter((candidate) => candidate.canonicalName).length,
      total: bindings.length,
    }).toStrictEqual({ canonical: 1, total: RIVALS + 1 });
  });
});
