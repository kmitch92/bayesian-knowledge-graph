/**
 * The width the embedding provider a fresh install gets actually produces.
 *
 * `config.ts`'s head docblock argues embeddings are the one port that falls back
 * to a real adapter rather than a refusing stub, because "there *is* one in this
 * repository, an ingest without it can do nothing at all, and §5.3's geometry is
 * the store's own." That argument is load-bearing — it is the whole reason
 * `kgmem ingest` is runnable on a repository whose `config.json` names nothing —
 * and until this file the branch implementing it had no test.
 *
 * The CLI suite's other files all route embeddings through
 * {@link ./fake-embeddings-module.ts}, which emits vectors at the width the
 * store pins. So every test in this repository that touches the write path has
 * been exercising a provider that agrees with the store, and none of them has
 * ever exercised the provider a user with no `config.json` is handed. Those are
 * different objects, and only the first was ever checked.
 *
 * ── What these tests pin, and why in this form ──────────────────────────────
 *
 * Two widths exist and they are not interchangeable. {@link PINNED_DIMENSIONS}
 * (spike S2's retrieval pin) is the width of the *int8 ANN index*;
 * {@link RERANK_DIMENSIONS} is the width of the *stored f32 rerank copy*. The
 * store takes the full-width vector and derives the narrow one itself — see
 * `vectors.ts`'s `toAnnVector`, which Matryoshka-slices then quantizes — so the
 * only width a provider may hand it is {@link STORED_VECTOR_DIMENSIONS}. A
 * provider configured with the *index* constant is handing over a vector that is
 * already the derived form, and the store has no way to widen it back.
 *
 * Every assertion below therefore compares the provider's declared width to
 * `STORED_VECTOR_DIMENSIONS` rather than to the literal 768. If spike S2 is ever
 * re-run and the pins move, a test written the first way still states the rule;
 * one written the second way becomes a lie that passes.
 *
 * `vectors.test.ts` already pins the store's half of this — that the ANN width
 * is `PINNED_DIMENSIONS`, the stored width is `RERANK_DIMENSIONS`, and the
 * former is the narrower. Nothing here restates that. What is missing, and what
 * this file adds, is the *provider* half: that the thing feeding the store
 * agrees with the width the store keeps.
 *
 * ── Why no weights are loaded ───────────────────────────────────────────────
 *
 * `@huggingface/transformers` costs ~3.4s to import before a single byte of ONNX
 * weight is touched, and the weights themselves are ~250MB on first use. Neither
 * is acceptable in a suite that has to stay runnable. It is also not necessary:
 * the width a provider produces is fixed by its constructor, not by the model —
 * `dimensions` is assigned from the options in the constructor body and
 * `embedBatch` projects to whatever it holds. So the dependency is stubbed and
 * the real adapter module is loaded, which leaves the constructor, the default,
 * the supported-width guard and the `modelId` string all under test.
 *
 * The stub's `pipeline` throws rather than returning a fake. Nothing below
 * should ever reach it, and a test that quietly started downloading a model
 * would otherwise look like a slow pass rather than the mistake it is.
 *
 * @spec §5.3, §11, §13
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EmbeddingProvider } from '../../../store/ports/embedding-provider';
import { DimensionMismatchError } from '../../../store/errors';
import type { NomicDimensions } from '../../../store/nomic-dimensions';
import { STORED_VECTOR_DIMENSIONS } from '../../../store/vectors';

import { openModels, readConfiguration } from '../config';
import { KGMEM_DIR, findWorkspace, type Workspace } from '../workspace';

/**
 * The 250MB dependency, absent.
 *
 * Hoisted by vitest above every import in this file, which is what lets the real
 * `nomic-embedding-provider.ts` be imported — including through `config.ts`'s
 * dynamic import, which resolves to the same module — without paying for ONNX.
 */
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: () => {
    throw new Error(
      'a width test loaded model weights: nothing in this file should reach the model',
    );
  },
}));

let workspace: Workspace;
let root: string;

/** A repository `init` has been run in, and nothing else: no `config.json`. @spec §7.6 */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kgmem-default-embeddings-'));
  mkdirSync(join(root, KGMEM_DIR));
  const found = findWorkspace(root);
  if (found === undefined) throw new Error('the fixture repository has no .kgmem to find');
  workspace = found;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The embeddings port a repository that configures nothing is handed. @spec §5.3 */
const fallbackProvider = async (): Promise<EmbeddingProvider> => {
  const configuration = readConfiguration(workspace);
  const models = await openModels(configuration, workspace);
  return models.embeddings;
};

/** @see document-store.test.ts, whose refusals are captured and typed the same way. */
const refusalFrom = (act: () => void): unknown => {
  try {
    act();
    return undefined;
  } catch (error) {
    return error;
  }
};

/**
 * A width the Matryoshka objective was never trained for, arriving the only way
 * it can: cast past the compiler. `NomicDimensions` constrains a TypeScript
 * caller and nothing else — the widths reaching this constructor can come from a
 * hand-edited `config.json`, from a JS consumer with no compiler, or from a
 * harness passing a number it computed. The cast is the point.
 */
const UNTRAINED_WIDTH = 384 as NomicDimensions;

/**
 * The store's own width boundary, reproduced from `vectors.ts`'s
 * `assertStoredWidth` rather than imported, so this file keeps working if that
 * helper is renamed. The rule it enforces is the one migration 0 pinned.
 */
const storeRefusalOf = (width: number): unknown =>
  refusalFrom(() => {
    if (width !== STORED_VECTOR_DIMENSIONS)
      throw new DimensionMismatchError('a chunk embedding', STORED_VECTOR_DIMENSIONS, width);
  });

describe('the embeddings port a repository with no config.json falls back to', () => {
  it('declares the width the store stores, not the width the store derives', async () => {
    const provider = await fallbackProvider();

    expect(provider.dimensions).toBe(STORED_VECTOR_DIMENSIONS);
  });

  it('offers a width the store will not refuse, which is the whole of the bug', async () => {
    const provider = await fallbackProvider();

    const refusal = storeRefusalOf(provider.dimensions);

    expect(refusal).toBeUndefined();
  });

  it('names the width the store stores, which is what §13 groups drift audits by', async () => {
    const provider = await fallbackProvider();

    expect(provider.modelId).toContain(`@${String(STORED_VECTOR_DIMENSIONS)}/`);
  });

  /**
   * No "modelId names the same width as dimensions" test lives here on purpose.
   *
   * That assertion — `provider.modelId` contains `` `@${provider.dimensions}/` ``
   * — reads its expectation from the same instance it checks, so it cannot fail
   * against a `modelId` hardcoded to `@768/`: the fallback default *is* 768, so
   * the hardcode and the real computation agree by coincidence every time this
   * block constructs a provider. The two tests above already pin both halves
   * (`dimensions` equals `STORED_VECTOR_DIMENSIONS`, `modelId` names
   * `STORED_VECTOR_DIMENSIONS`) against that independent constant, which is what
   * a discriminating check requires. The version of this assertion worth having
   * lives in the next `describe` block below, where a second construction at
   * {@link PINNED_DIMENSIONS} gives the hardcode something to disagree with.
   *
   * General form, worth watching for elsewhere: an assertion that derives its
   * "expected" value from the same object as the "actual" it is checking cannot
   * distinguish the correct computation from a mutant that ignores the input
   * entirely, unless the test also exercises an input for which the two would
   * diverge. Pin against an independent literal or constant, or exercise more
   * than one input, one of them not equal to the coincidental default.
   */
});

/**
 * Where the fix belongs.
 *
 * The CLI could have been corrected alone — `new NomicEmbeddingProvider({
 * dimensions: RERANK_DIMENSIONS })` — leaving the adapter's default at the index
 * width. These tests deliberately rule that out and pin the adapter instead,
 * because the default is a trap for every caller and not just this one: a
 * provider living in `src/store/adapters/`, implementing `src/store/ports/`, and
 * defaulting to a width `src/store/vectors.ts` throws on is incoherent on its own
 * terms, whoever constructs it.
 *
 * Nothing relies on the old default. The only other construction sites in the
 * repository are `scripts/spike-s2-embeddings.ts:380` and `:416`, and both pass
 * `{ dimensions: 256 }` explicitly, so moving the default cannot change what the
 * spike measures.
 *
 * The widths are also not symmetric in cost. 768 narrows to 512 exactly, by
 * `truncateEmbedding`; 512 does not widen back. A default that produces the
 * wider vector is recoverable by any caller wanting the narrower one, and the
 * reverse needs the model again.
 */
describe('the default width NomicEmbeddingProvider is constructed with', () => {
  it('is the width the store stores, not spike S2 ANN index pin', async () => {
    const { NomicEmbeddingProvider } = await import(
      '../../../store/adapters/nomic-embedding-provider'
    );

    expect(new NomicEmbeddingProvider().dimensions).toBe(STORED_VECTOR_DIMENSIONS);
  });

  it('still lets a caller ask for the narrower ANN width on purpose', async () => {
    const { NomicEmbeddingProvider, PINNED_DIMENSIONS } = await import(
      '../../../store/adapters/nomic-embedding-provider'
    );

    expect(new NomicEmbeddingProvider({ dimensions: PINNED_DIMENSIONS }).dimensions).toBe(
      PINNED_DIMENSIONS,
    );
  });

  it('reports the width in modelId whichever way it was chosen', async () => {
    const { NomicEmbeddingProvider, PINNED_DIMENSIONS } = await import(
      '../../../store/adapters/nomic-embedding-provider'
    );

    expect([
      new NomicEmbeddingProvider().modelId,
      new NomicEmbeddingProvider({ dimensions: PINNED_DIMENSIONS }).modelId,
    ]).toStrictEqual([
      `nomic-embed-text-v1.5@${String(STORED_VECTOR_DIMENSIONS)}/fp32`,
      `nomic-embed-text-v1.5@${String(PINNED_DIMENSIONS)}/fp32`,
    ]);
  });
});

/**
 * The guard the type system cannot enforce.
 *
 * The head docblock claims the supported-width guard is under test here. Until
 * this block it was not: every construction above passes a width the guard
 * admits, so a guard widened to accept anything at all still passed the whole
 * file. That matters more than an ordinary uncovered branch, because an
 * untrained width is not an error the model reports — `matryoshkaProject` will
 * happily slice to 384 and return a vector that is merely quietly worse. This
 * constructor is the only place that degradation can be converted into a refusal.
 *
 * Both directions are pinned. A guard that stopped refusing 384 admits the
 * silent degradation; a guard that started refusing 256 breaks
 * `scripts/spike-s2-embeddings.ts`, the only caller in this repository that asks
 * for a narrow width on purpose.
 *
 * @spec §11
 */
describe('the widths NomicEmbeddingProvider will accept', () => {
  it('refuses a width the Matryoshka objective was never trained for', async () => {
    const { NomicEmbeddingProvider } = await import(
      '../../../store/adapters/nomic-embedding-provider'
    );

    const refusal = refusalFrom(() => new NomicEmbeddingProvider({ dimensions: UNTRAINED_WIDTH }));

    expect(refusal).toBeInstanceOf(RangeError);
  });

  it('names the width it was handed, so the refusal points at the edit that caused it', async () => {
    const { NomicEmbeddingProvider } = await import(
      '../../../store/adapters/nomic-embedding-provider'
    );

    const refusal = refusalFrom(() => new NomicEmbeddingProvider({ dimensions: UNTRAINED_WIDTH }));

    expect(refusal instanceof RangeError ? refusal.message : refusal).toContain(
      String(UNTRAINED_WIDTH),
    );
  });

  it('accepts every width the model was trained for, since the spike harness asks for a narrow one', async () => {
    const { NomicEmbeddingProvider, NOMIC_SUPPORTED_DIMENSIONS } = await import(
      '../../../store/adapters/nomic-embedding-provider'
    );

    expect(
      NOMIC_SUPPORTED_DIMENSIONS.map(
        (width) => new NomicEmbeddingProvider({ dimensions: width }).dimensions,
      ),
    ).toStrictEqual([...NOMIC_SUPPORTED_DIMENSIONS]);
  });
});
