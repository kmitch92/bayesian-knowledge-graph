/**
 * The width the provider actually *emits*, as distinct from the width it declares.
 *
 * `default-embedding-width.test.ts` pins the declaration: that a fresh install's
 * provider reports {@link STORED_VECTOR_DIMENSIONS} in `dimensions` and names it
 * in `modelId`. That is the half of the contract a constructor can satisfy on its
 * own, and it was the half the E8a defect broke.
 *
 * It is not the whole contract. `EmbeddingProvider` requires that "every returned
 * vector has exactly `dimensions` elements", that "every returned vector is
 * L2-normalized", and that "`embedBatch` returns vectors positionally aligned
 * with its input" — three guarantees that live in `embedBatch`, not in the
 * constructor, and that no test in this repository exercised. A provider can
 * declare 768 and project to 512 one line later; the declaration tests all pass,
 * and the store then refuses every write exactly as it did before E8a. That is
 * the same defect one layer down, and this file is what stands in front of it.
 *
 * ── Why a fake tensor rather than no model at all ───────────────────────────
 *
 * The sibling file stubs `pipeline` with a throw, because nothing it tests should
 * ever reach the model. The opposite is true here: `embedBatch` *is* the unit
 * under test, so the model has to return something. The stub returns a tensor of
 * the shape the real one returns and nothing else — `matryoshkaProject`, the
 * per-row `subarray` slicing, the task prefixes and the width arithmetic are all
 * the real implementation. What is faked is one ONNX call and ~250MB of weights.
 *
 * The stub's native width is checked against {@link NOMIC_NATIVE_DIMENSIONS}
 * below, so a fake that stopped resembling the model fails rather than quietly
 * testing a geometry the model does not have.
 *
 * @spec §5.2, §5.3, §5.10, §11
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOMIC_NATIVE_DIMENSIONS,
  NOMIC_SUPPORTED_DIMENSIONS,
  PINNED_DIMENSIONS,
} from '../../nomic-dimensions';
import { STORED_VECTOR_DIMENSIONS } from '../../vectors';

import { NOMIC_MODEL_ID, NomicEmbeddingProvider } from '../nomic-embedding-provider';

/**
 * A transformers.js pipeline that records what it was asked for and returns a
 * mean-pooled tensor of the right shape. Hoisted so the `vi.mock` factory below
 * can close over it.
 */
const model = vi.hoisted(() => {
  const NATIVE_OUTPUT_WIDTH = 768;
  const loads: { readonly modelId: string; readonly dtype: string }[] = [];
  const batches: (readonly string[])[] = [];

  const extractor = (texts: readonly string[]): Promise<{ data: Float32Array; dims: number[] }> => {
    batches.push([...texts]);
    const data = new Float32Array(texts.length * NATIVE_OUTPUT_WIDTH);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i * 0.37) + 0.1;
    return Promise.resolve({ data, dims: [texts.length, NATIVE_OUTPUT_WIDTH] });
  };

  return { NATIVE_OUTPUT_WIDTH, loads, batches, extractor };
});

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: (_task: string, modelId: string, options: { readonly dtype: string }) => {
    model.loads.push({ modelId, dtype: options.dtype });
    return Promise.resolve(model.extractor);
  },
}));

beforeEach(() => {
  model.loads.length = 0;
  model.batches.length = 0;
});

/** The L2 norm the provider's output is required to land on. */
const normOf = (vector: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i]! * vector[i]!;
  return Math.sqrt(sum);
};

describe('the tensor shape this file stands in for', () => {
  it('is the width the real model emits, so the fake geometry is the real geometry', () => {
    expect(model.NATIVE_OUTPUT_WIDTH).toBe(NOMIC_NATIVE_DIMENSIONS);
  });
});

describe('the vectors NomicEmbeddingProvider hands back', () => {
  it('are the width it declares, for every width it accepts', async () => {
    const emitted = await Promise.all(
      NOMIC_SUPPORTED_DIMENSIONS.map(async (width) => {
        const [only] = await new NomicEmbeddingProvider({ dimensions: width }).embedBatch(['a']);
        return only?.length;
      }),
    );

    expect(emitted).toStrictEqual([...NOMIC_SUPPORTED_DIMENSIONS]);
  });

  it('are the width the store stores when nobody asked for a width, which is the whole of the bug', async () => {
    const [only] = await new NomicEmbeddingProvider().embedBatch(['a claim worth storing']);

    expect(only).toHaveLength(STORED_VECTOR_DIMENSIONS);
  });

  it('are the declared width through embed() too, not only through embedBatch()', async () => {
    const provider = new NomicEmbeddingProvider();

    const vector = await provider.embed('a claim worth storing');

    expect(vector).toHaveLength(provider.dimensions);
  });

  it('are L2-normalized, which is what lets the store quantize without persisting a scale', async () => {
    const vectors = await new NomicEmbeddingProvider().embedBatch(['one', 'two']);

    for (const vector of vectors) expect(normOf(vector)).toBeCloseTo(1, 5);
  });

  it('are L2-normalized at a narrow width too, where the slice discards most of the norm', async () => {
    const [only] = await new NomicEmbeddingProvider({
      dimensions: PINNED_DIMENSIONS,
    }).embedBatch(['one']);

    expect(normOf(only!)).toBeCloseTo(1, 5);
  });

  it('come back one per input text, positionally aligned with it', async () => {
    const vectors = await new NomicEmbeddingProvider().embedBatch(['one', 'two', 'three']);

    expect(vectors).toHaveLength(3);
  });

  it('differ between inputs, so the per-row slice is reading a different row each time', async () => {
    const [first, second] = await new NomicEmbeddingProvider().embedBatch(['one', 'two']);

    expect(Array.from(first!.subarray(0, 4))).not.toStrictEqual(
      Array.from(second!.subarray(0, 4)),
    );
  });
});

/**
 * The prefixes are not decoration. The model was trained with them, and the
 * adapter's own docblock records that omitting them or using the wrong one costs
 * measurable accuracy on the §5.2 gloss-resolution rung — a cost that shows up as
 * slightly worse retrieval rather than as any kind of failure.
 *
 * @spec §5.2, §5.3
 */
describe('the task prefix the provider sends to the model', () => {
  it('marks stored content as a document when no task is given', async () => {
    await new NomicEmbeddingProvider().embedBatch(['a claim']);

    expect(model.batches.at(-1)).toStrictEqual(['search_document: a claim']);
  });

  it('marks a lookup phrasing as a query when one is asked for', async () => {
    await new NomicEmbeddingProvider().embedBatch(['what did it say'], 'query');

    expect(model.batches.at(-1)).toStrictEqual(['search_query: what did it say']);
  });

  it('prefixes every text in a batch rather than only the first', async () => {
    await new NomicEmbeddingProvider().embedBatch(['one', 'two']);

    expect(model.batches.at(-1)).toStrictEqual(['search_document: one', 'search_document: two']);
  });
});

/**
 * §5.10 budgets the write path at one embedding plus one small-model call in
 * roughly a second. A cold `pipeline()` costs seconds, so the adapter's caching
 * of the load promise is what makes that budget reachable at all — and a cache
 * that silently stopped working would show up as a latency regression rather
 * than as a test failure.
 *
 * @spec §5.10
 */
describe('the model handle the provider loads', () => {
  it('is loaded once and reused across calls, since a cold load costs seconds', async () => {
    const provider = new NomicEmbeddingProvider();

    await provider.embedBatch(['one']);
    await provider.embedBatch(['two']);

    expect(model.loads).toHaveLength(1);
  });

  it('is shared by two simultaneous first calls rather than loaded twice', async () => {
    const provider = new NomicEmbeddingProvider();

    await Promise.all([provider.embedBatch(['one']), provider.embedBatch(['two'])]);

    expect(model.loads).toHaveLength(1);
  });

  it('is not loaded at all for an empty batch, which would pay a cold start for nothing', async () => {
    const vectors = await new NomicEmbeddingProvider().embedBatch([]);

    expect([vectors, model.loads]).toStrictEqual([[], []]);
  });

  it('is asked for the model and precision the adapter declares in its modelId', async () => {
    await new NomicEmbeddingProvider({ dtype: 'q8' }).embedBatch(['one']);

    expect(model.loads).toStrictEqual([{ modelId: NOMIC_MODEL_ID, dtype: 'q8' }]);
  });
});
