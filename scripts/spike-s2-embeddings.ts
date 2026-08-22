/**
 * Spike S2 — pin the embedding provider and dimensionality.
 *
 * Run: `pnpm exec tsx scripts/spike-s2-embeddings.ts [--dtypes fp32,q8] [--latency-n 50]`
 *
 * Measures, on the fixtures in `fixtures/embedding-eval/`:
 *   1. paraphrase vs near-miss cosine separation (§5.3, the ~0.70 candidate floor)
 *   2. polarity-flip cosine range (§5.4 — expected to be terrible; that is the point)
 *   3. gloss-resolution top-1 / top-3 / MRR (§5.2 resolution ladder, embedding rung)
 *   4. the same metrics at 768d / 512d / 256d / 128d / 64d, and int8 vs f32 (§11)
 *   5. model size on disk, cold start, warm per-embedding latency (§5.10 write budget)
 *
 * NOT measured here: dedupe-candidate recall@15 (§5.3). That needs a real claim
 * corpus, which does not exist until the spine phase lands. Faking one would measure
 * the fixture author, not the provider.
 */

import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { z } from 'zod';

import {
  NOMIC_MODEL_ID,
  NomicEmbeddingProvider,
  PINNED_DIMENSIONS,
  matryoshkaProject,
} from '../src/store/adapters/nomic-embedding-provider.js';

/** The width the adapter ships at; Tables 6, 8 and 9 report the shipped configuration. */
const PINNED = PINNED_DIMENSIONS;

// ---------------------------------------------------------------- fixtures

const RepoRoot = new URL('..', import.meta.url).pathname;
const FixtureDir = join(RepoRoot, 'fixtures', 'embedding-eval');
const ModelDir = join(RepoRoot, 'models');

const Relation = z.enum(['paraphrase', 'near_miss', 'polarity']);
type Relation = z.infer<typeof Relation>;

const ClaimPairs = z.object({
  pairs: z
    .array(
      z.object({
        id: z.string(),
        relation: Relation,
        a: z.string().min(1),
        b: z.string().min(1),
      }),
    )
    .min(1),
});

const Phrasing = z.enum(['exact', 'alias', 'vague']);
type Phrasing = z.infer<typeof Phrasing>;

const GlossSet = z.object({
  entities: z.array(z.object({ id: z.string(), name: z.string(), gloss: z.string() })).min(1),
  queries: z.array(z.object({ query: z.string(), expected: z.string(), phrasing: Phrasing })).min(1),
});

const loadJson = async <T>(file: string, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(JSON.parse(await readFile(join(FixtureDir, file), 'utf8')));

// ---------------------------------------------------------------- vector maths

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
};

/** All vectors under test are L2-normalized, so cosine is a plain dot product. */
const cosine = dot;

/**
 * Symmetric scalar int8 quantization over [-1, 1] — the scheme sqlite-vec's
 * `vec_quantize_int8(v, 'unit')` uses, and what §11's "stored quantized" means for a
 * unit-norm vector. Round-tripping here models exactly what in-traversal scoring
 * would see.
 */
const int8RoundTrip = (v: Float32Array): Float32Array => {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) {
    const q = Math.max(-127, Math.min(127, Math.round(v[i]! * 127)));
    out[i] = q / 127;
  }
  return out;
};

/** Mean-pool + L2 normalize with no layer-norm: the model's canonical full-width recipe. */
const plainNormalize = (pooled: Float32Array, dimensions: number): Float32Array => {
  const out = new Float32Array(dimensions);
  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    out[i] = pooled[i]!;
    norm += pooled[i]! * pooled[i]!;
  }
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  for (let i = 0; i < dimensions; i += 1) out[i] = out[i]! * inv;
  return out;
};

// ---------------------------------------------------------------- statistics

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};

const stdev = (xs: readonly number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
};

/**
 * Threshold-free separation: P(a random positive scores above a random negative),
 * via the Mann-Whitney U identity. 1.0 = perfectly separable, 0.5 = coin flip.
 * This is the number that decides whether a cosine floor can work at all.
 */
const rocAuc = (positive: readonly number[], negative: readonly number[]): number => {
  const all = [...positive.map((v) => ({ v, p: true })), ...negative.map((v) => ({ v, p: false }))].sort(
    (x, y) => x.v - y.v,
  );
  let rank = 1;
  let rankSum = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j += 1;
    const avgRank = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k += 1) if (all[k]!.p) rankSum += avgRank;
    rank += j - i + 1;
    i = j + 1;
  }
  const n = positive.length;
  return (rankSum - (n * (n + 1)) / 2) / (n * negative.length);
};

/** Best achievable paraphrase/near-miss accuracy over every candidate threshold. */
const bestThreshold = (
  positive: readonly number[],
  negative: readonly number[],
): { threshold: number; accuracy: number } => {
  const candidates = [...new Set([...positive, ...negative])].sort((a, b) => a - b);
  let best = { threshold: 0, accuracy: 0 };
  for (const t of candidates) {
    const correct =
      positive.filter((v) => v >= t).length + negative.filter((v) => v < t).length;
    const accuracy = correct / (positive.length + negative.length);
    if (accuracy > best.accuracy) best = { threshold: t, accuracy };
  }
  return best;
};

// ---------------------------------------------------------------- printing

const fmt = (n: number, dp = 3): string => (Number.isFinite(n) ? n.toFixed(dp) : '—');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const table = (title: string, headers: readonly string[], rows: readonly (readonly string[])[]): void => {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  console.log(`\n${title}`);
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
};

// ---------------------------------------------------------------- pooling

type Pooler = (texts: readonly string[], task: 'document' | 'query') => Promise<Float32Array[]>;

const PREFIX = { document: 'search_document: ', query: 'search_query: ' } as const;

/**
 * Raw 768d mean-pooled vectors, un-normalized. The dimension sweep projects these
 * in-process rather than re-running the model per width — Matryoshka truncation is a
 * pure post-hoc projection, so this is exact, not an approximation.
 */
const makePooler = (extractor: FeatureExtractionPipeline): Pooler => {
  return async (texts, task) => {
    const out: Float32Array[] = [];
    const BATCH = 16;
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH);
      const tensor = await extractor(
        chunk.map((t) => PREFIX[task] + t),
        { pooling: 'mean', normalize: false },
      );
      const flat = tensor.data as Float32Array;
      const width = tensor.dims[tensor.dims.length - 1]!;
      for (let k = 0; k < chunk.length; k += 1) {
        out.push(new Float32Array(flat.subarray(k * width, (k + 1) * width)));
      }
    }
    return out;
  };
};

// ---------------------------------------------------------------- variants

interface Variant {
  readonly label: string;
  readonly dimensions: number;
  readonly project: (pooled: Float32Array) => Float32Array;
}

const VARIANTS: readonly Variant[] = [
  { label: '768 f32 (canonical)', dimensions: 768, project: (p) => plainNormalize(p, 768) },
  { label: '768 f32 (matryoshka)', dimensions: 768, project: (p) => matryoshkaProject(p, 768) },
  { label: '512 f32', dimensions: 512, project: (p) => matryoshkaProject(p, 512) },
  { label: '256 f32', dimensions: 256, project: (p) => matryoshkaProject(p, PINNED) },
  { label: '256 int8', dimensions: 256, project: (p) => int8RoundTrip(matryoshkaProject(p, PINNED)) },
  { label: '128 f32', dimensions: 128, project: (p) => matryoshkaProject(p, 128) },
  { label: '128 int8', dimensions: 128, project: (p) => int8RoundTrip(matryoshkaProject(p, 128)) },
  { label: '64 f32', dimensions: 64, project: (p) => matryoshkaProject(p, 64) },
];

const FLOOR = 0.7;

// ---------------------------------------------------------------- measurements

interface PairScores {
  readonly paraphrase: number[];
  readonly near_miss: number[];
  readonly polarity: number[];
}

const scorePairs = (
  pairs: readonly { relation: Relation }[],
  aVecs: readonly Float32Array[],
  bVecs: readonly Float32Array[],
): PairScores => {
  const out: PairScores = { paraphrase: [], near_miss: [], polarity: [] };
  pairs.forEach((p, i) => out[p.relation].push(cosine(aVecs[i]!, bVecs[i]!)));
  return out;
};

interface GlossResult {
  readonly top1: number;
  readonly top3: number;
  readonly mrr: number;
  readonly byPhrasing: Record<Phrasing, number>;
  readonly winners: readonly string[];
}

const scoreGloss = (
  entityIds: readonly string[],
  entityVecs: readonly Float32Array[],
  queries: readonly { expected: string; phrasing: Phrasing }[],
  queryVecs: readonly Float32Array[],
): GlossResult => {
  let top1 = 0;
  let top3 = 0;
  let rrSum = 0;
  const hits: Record<Phrasing, number> = { exact: 0, alias: 0, vague: 0 };
  const totals: Record<Phrasing, number> = { exact: 0, alias: 0, vague: 0 };
  const winners: string[] = [];

  queries.forEach((q, qi) => {
    const ranked = entityVecs
      .map((v, ei) => ({ id: entityIds[ei]!, score: cosine(queryVecs[qi]!, v) }))
      .sort((x, y) => y.score - x.score);
    const rank = ranked.findIndex((r) => r.id === q.expected) + 1;
    winners.push(ranked[0]!.id);
    totals[q.phrasing] += 1;
    if (rank === 1) {
      top1 += 1;
      hits[q.phrasing] += 1;
    }
    if (rank > 0 && rank <= 3) top3 += 1;
    if (rank > 0) rrSum += 1 / rank;
  });

  return {
    top1: top1 / queries.length,
    top3: top3 / queries.length,
    mrr: rrSum / queries.length,
    byPhrasing: {
      exact: totals.exact === 0 ? Number.NaN : hits.exact / totals.exact,
      alias: totals.alias === 0 ? Number.NaN : hits.alias / totals.alias,
      vague: totals.vague === 0 ? Number.NaN : hits.vague / totals.vague,
    },
    winners,
  };
};

/**
 * Every non-paired (a_i, b_j) combination: same-repository text that is genuinely
 * about something else. This is the distractor distribution ANN actually faces
 * inside a scoped subtree, and at ~n² it is the only sample here large enough to
 * read a floor-pass rate off with confidence — the 20 curated near-misses are the
 * hard tail of the same distribution, not a substitute for it.
 */
const poolNegatives = (aVecs: readonly Float32Array[], bVecs: readonly Float32Array[]): number[] => {
  const out: number[] = [];
  for (let i = 0; i < aVecs.length; i += 1) {
    for (let j = 0; j < bVecs.length; j += 1) {
      if (i !== j) out.push(cosine(aVecs[i]!, bVecs[j]!));
    }
  }
  return out;
};

/**
 * Rank each paraphrase's partner against the whole fixture pool. A stand-in for
 * pooled retrieval behaviour — explicitly NOT the §5.3 recall@15 gate, which needs a
 * real claim corpus and is deferred to after the spine phase.
 */
const poolRetrieval = (
  pairs: readonly { relation: Relation }[],
  aVecs: readonly Float32Array[],
  bVecs: readonly Float32Array[],
): { at1: number; at5: number; at15: number; poolSize: number } => {
  const idx = pairs.map((p, i) => ({ p, i })).filter(({ p }) => p.relation === 'paraphrase');
  let at1 = 0;
  let at5 = 0;
  let at15 = 0;
  for (const { i } of idx) {
    const ranked = bVecs
      .map((v, j) => ({ j, score: cosine(aVecs[i]!, v) }))
      .sort((x, y) => y.score - x.score);
    const rank = ranked.findIndex((r) => r.j === i) + 1;
    if (rank === 1) at1 += 1;
    if (rank <= 5) at5 += 1;
    if (rank <= 15) at15 += 1;
  }
  return { at1: at1 / idx.length, at5: at5 / idx.length, at15: at15 / idx.length, poolSize: bVecs.length };
};

// ---------------------------------------------------------------- disk / latency

const dirSize = async (dir: string): Promise<number> => {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  try {
    await walk(dir);
  } catch {
    return 0;
  }
  return total;
};

/**
 * True cold start: a fresh process, because transformers.js memoises loaded models
 * in-process and this script has already loaded one by the time latency is measured.
 * Measuring in-process would report the memo hit, not the ONNX session build.
 */
const measureColdStart = (dtype: 'fp32' | 'q8'): number => {
  const self = new URL(import.meta.url).pathname;
  const r = spawnSync(process.execPath, ['--import', 'tsx', self, '--cold-probe', dtype], {
    encoding: 'utf8',
    cwd: RepoRoot,
  });
  const match = /COLD_MS=([\d.]+)/.exec(r.stdout + r.stderr);
  return match === null ? Number.NaN : Number(match[1]);
};

const measureLatency = async (
  dtype: 'fp32' | 'q8',
  n: number,
): Promise<{ p50: number; p95: number; batch32: number }> => {
  const provider = new NomicEmbeddingProvider({ dimensions: 256, dtype, cacheDir: ModelDir });
  await provider.warm();

  const sample = 'The cleared price is captured at session START and is the only price ever credited or owed.';
  for (let i = 0; i < 3; i += 1) await provider.embed(sample);

  const samples: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = performance.now();
    await provider.embed(`${sample} (${String(i)})`);
    samples.push(performance.now() - t);
  }

  const batchInput = Array.from({ length: 32 }, (_, i) => `${sample} (batch ${String(i)})`);
  const tb = performance.now();
  await provider.embedBatch(batchInput);
  const batch32 = (performance.now() - tb) / 32;

  return { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), batch32 };
};

// ---------------------------------------------------------------- main

const parseArgs = (): { dtypes: ('fp32' | 'q8')[]; latencyN: number } => {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dtypes = (get('--dtypes') ?? 'fp32').split(',').filter((d): d is 'fp32' | 'q8' => d === 'fp32' || d === 'q8');
  return { dtypes: dtypes.length > 0 ? dtypes : ['fp32'], latencyN: Number(get('--latency-n') ?? 50) };
};

/** Subprocess entry point for {@link measureColdStart}. Loads one model, prints, exits. */
const coldProbe = async (dtype: 'fp32' | 'q8'): Promise<void> => {
  const t0 = performance.now();
  await new NomicEmbeddingProvider({ dimensions: 256, dtype, cacheDir: ModelDir }).warm();
  console.log(`COLD_MS=${(performance.now() - t0).toFixed(1)}`);
};

const main = async (): Promise<void> => {
  const { dtypes, latencyN } = parseArgs();

  const { pairs } = await loadJson('claim-pairs.json', ClaimPairs);
  const gloss = await loadJson('gloss-resolution.json', GlossSet);

  console.log('SPIKE S2 — embedding provider and dimensionality');
  console.log(`model      ${NOMIC_MODEL_ID} (transformers.js ONNX, fp32)`);
  console.log(`pairs      ${String(pairs.length)}  (fixtures/embedding-eval/claim-pairs.json)`);
  console.log(
    `gloss      ${String(gloss.entities.length)} entities / ${String(gloss.queries.length)} queries  (fixtures/embedding-eval/gloss-resolution.json)`,
  );
  console.log(`floor      ${fmt(FLOOR, 2)} cosine (spec §5.3)`);

  env.cacheDir = ModelDir;
  env.allowLocalModels = false;
  const extractor = await pipeline('feature-extraction', NOMIC_MODEL_ID, { dtype: 'fp32' });
  const pool = makePooler(extractor);

  // One forward pass per text; every dimension variant reuses these pooled vectors.
  const pooledA = await pool(
    pairs.map((p) => p.a),
    'document',
  );
  const pooledB = await pool(
    pairs.map((p) => p.b),
    'document',
  );
  const pooledEntities = await pool(
    gloss.entities.map((e) => `${e.name}: ${e.gloss}`),
    'document',
  );
  const pooledQueriesQ = await pool(
    gloss.queries.map((q) => q.query),
    'query',
  );
  const pooledQueriesD = await pool(
    gloss.queries.map((q) => q.query),
    'document',
  );

  // ---- table 1: paraphrase vs near-miss separation, per variant
  const sepRows: string[][] = [];
  const floorRows: string[][] = [];
  const polarityRows: string[][] = [];
  const glossRows: string[][] = [];
  const poolRows: string[][] = [];

  const entityIds = gloss.entities.map((e) => e.id);

  for (const v of VARIANTS) {
    const a = pooledA.map(v.project);
    const b = pooledB.map(v.project);
    const s = scorePairs(pairs, a, b);

    const distractors = poolNegatives(a, b);
    const best = bestThreshold(s.paraphrase, s.near_miss);

    sepRows.push([
      v.label,
      fmt(mean(s.paraphrase)),
      fmt(quantile(s.paraphrase, 0.1)),
      fmt(mean(s.near_miss)),
      fmt(quantile(s.near_miss, 0.9)),
      fmt(mean(s.paraphrase) - mean(s.near_miss)),
      fmt(rocAuc(s.paraphrase, s.near_miss)),
      fmt(rocAuc(s.paraphrase, distractors)),
      `${fmt(best.threshold)} / ${pct(best.accuracy)}`,
    ]);

    floorRows.push([
      v.label,
      pct(s.paraphrase.filter((x) => x >= FLOOR).length / s.paraphrase.length),
      pct(s.near_miss.filter((x) => x >= FLOOR).length / s.near_miss.length),
      pct(distractors.filter((x) => x >= FLOOR).length / distractors.length),
      pct(s.polarity.filter((x) => x >= FLOOR).length / s.polarity.length),
      String(s.paraphrase.filter((x) => x < FLOOR).length),
    ]);

    polarityRows.push([
      v.label,
      fmt(Math.min(...s.polarity)),
      fmt(mean(s.polarity)),
      fmt(Math.max(...s.polarity)),
      fmt(stdev(s.polarity)),
      fmt(mean(s.polarity) - mean(s.paraphrase)),
      fmt(rocAuc(s.paraphrase, s.polarity)),
    ]);

    const e = pooledEntities.map(v.project);
    const gq = scoreGloss(entityIds, e, gloss.queries, pooledQueriesQ.map(v.project));
    const gd = scoreGloss(entityIds, e, gloss.queries, pooledQueriesD.map(v.project));
    glossRows.push([
      v.label,
      pct(gq.top1),
      pct(gq.top3),
      fmt(gq.mrr),
      pct(gq.byPhrasing.exact),
      pct(gq.byPhrasing.alias),
      pct(gq.byPhrasing.vague),
      pct(gd.top1),
    ]);

    const pr = poolRetrieval(pairs, a, b);
    poolRows.push([v.label, pct(pr.at1), pct(pr.at5), pct(pr.at15), String(pr.poolSize)]);
  }

  const distractorN = pairs.length * (pairs.length - 1);
  table(
    'TABLE 1 — paraphrase vs near-miss separation (within-pair cosine)',
    [
      'variant',
      'para.mean',
      'para.p10',
      'near.mean',
      'near.p90',
      'gap',
      'AUC vs near',
      `AUC vs pool(${String(distractorN)})`,
      'best thr / acc',
    ],
    sepRows,
  );

  table(
    `TABLE 2 — behaviour at the spec's ${fmt(FLOOR, 2)} candidate floor (§5.3). "pool" = ${String(distractorN)} unrelated same-repo pairs: the junk ANN admits.`,
    ['variant', 'para >= floor', 'near >= floor', 'pool >= floor', 'polarity >= floor', 'para missed'],
    floorRows,
  );

  table(
    'TABLE 3 — polarity flips (§5.4: embeddings cannot do this; measuring how bad)',
    ['variant', 'min', 'mean', 'max', 'sd', 'mean vs para', 'AUC para/pol'],
    polarityRows,
  );

  table(
    'TABLE 4 — gloss resolution (§5.2 embedding rung), query-prefixed',
    ['variant', 'top-1', 'top-3', 'MRR', 'exact', 'alias', 'vague', 'top-1 (doc prefix)'],
    glossRows,
  );

  table(
    `TABLE 5 — paraphrase retrieval within the fixture pool (NOT the §5.3 recall@15 gate)`,
    ['variant', 'r@1', 'r@5', 'r@15', 'pool'],
    poolRows,
  );

  // Tables 1-5 report the two 768 rows as near-identical. That is a real property,
  // not a copy-paste bug: layer-norm's rescale vanishes under the L2 normalize that
  // follows, leaving only the mean subtraction, and these pooled vectors are close
  // to zero-mean. Quantified here so the reader does not have to take it on trust.
  const canon768 = pooledA.map((p) => plainNormalize(p, 768));
  const matry768 = pooledA.map((p) => matryoshkaProject(p, 768));
  const selfSim = canon768.map((v, i) => cosine(v, matry768[i]!));
  console.log(
    `\nsanity: 768 canonical vs 768 matryoshka are the same vector to within cosine ${fmt(Math.min(...selfSim), 5)} (min over ${String(selfSim.length)} texts) — the identical rows above are expected.`,
  );

  // ---- int8 fidelity, measured as decision flips against the f32 baseline
  const f32Pin = { a: pooledA.map((p) => matryoshkaProject(p, PINNED)), b: pooledB.map((p) => matryoshkaProject(p, PINNED)) };
  const i8Pin = { a: f32Pin.a.map(int8RoundTrip), b: f32Pin.b.map(int8RoundTrip) };
  const deltas = pairs.map((_, i) => Math.abs(cosine(f32Pin.a[i]!, f32Pin.b[i]!) - cosine(i8Pin.a[i]!, i8Pin.b[i]!)));

  const ePin = pooledEntities.map((p) => matryoshkaProject(p, PINNED));
  const qPin = pooledQueriesQ.map((p) => matryoshkaProject(p, PINNED));
  const gF32 = scoreGloss(entityIds, ePin, gloss.queries, qPin);
  const gI8 = scoreGloss(entityIds, ePin.map(int8RoundTrip), gloss.queries, qPin.map(int8RoundTrip));
  const winnerFlips = gF32.winners.filter((w, i) => w !== gI8.winners[i]).length;

  const floorFlips = pairs.filter((_, i) => {
    const f = cosine(f32Pin.a[i]!, f32Pin.b[i]!) >= FLOOR;
    const q = cosine(i8Pin.a[i]!, i8Pin.b[i]!) >= FLOOR;
    return f !== q;
  }).length;

  table(
    `TABLE 6 — int8 round-trip fidelity at ${String(PINNED)}d (what the store actually holds, §11)`,
    ['metric', 'value'],
    [
      ['mean |Δcosine| vs f32', fmt(mean(deltas), 5)],
      ['max  |Δcosine| vs f32', fmt(Math.max(...deltas), 5)],
      [`pairs crossing the ${fmt(FLOOR, 2)} floor`, `${String(floorFlips)} / ${String(pairs.length)}`],
      ['gloss top-1 f32 / int8', `${pct(gF32.top1)} / ${pct(gI8.top1)}`],
      ['gloss top-1 winner flips', `${String(winnerFlips)} / ${String(gloss.queries.length)}`],
    ],
  );

  // ---- cost and latency
  const latRows: string[][] = [];
  for (const dtype of dtypes) {
    const cold = measureColdStart(dtype);
    const l = await measureLatency(dtype, latencyN);
    latRows.push([
      dtype,
      `${fmt(cold / 1000, 2)} s`,
      `${fmt(l.p50, 1)} ms`,
      `${fmt(l.p95, 1)} ms`,
      `${fmt(l.batch32, 1)} ms`,
    ]);
  }
  const bytes = await dirSize(ModelDir);
  table(
    `TABLE 7 — cost and latency (n=${String(latencyN)} warm single embeds; cold start measured in a fresh process; §5.10 budget is ~1 s for embed + adjudicate)`,
    ['dtype', 'cold start', 'warm p50', 'warm p95', 'per-item batch-32'],
    latRows,
  );
  console.log(`\nmodel cache  ${ModelDir}  (${fmt(bytes / 1024 / 1024, 1)} MiB, gitignored as /models/)`);

  // ---- worst offenders, for eyeballing
  const sPin = scorePairs(pairs, f32Pin.a, f32Pin.b);
  const rankedNear = pairs
    .map((p, i) => ({ p, c: cosine(f32Pin.a[i]!, f32Pin.b[i]!) }))
    .filter(({ p }) => p.relation === 'near_miss')
    .sort((x, y) => y.c - x.c)
    .slice(0, 5);
  const rankedPara = pairs
    .map((p, i) => ({ p, c: cosine(f32Pin.a[i]!, f32Pin.b[i]!) }))
    .filter(({ p }) => p.relation === 'paraphrase')
    .sort((x, y) => x.c - y.c)
    .slice(0, 5);

  table(
    `TABLE 8 — ${String(PINNED)}d f32 extremes (highest near-misses, lowest paraphrases)`,
    ['id', 'relation', 'cosine'],
    [
      ...rankedNear.map(({ p, c }) => [p.id, 'near_miss', fmt(c)]),
      ...rankedPara.map(({ p, c }) => [p.id, 'paraphrase', fmt(c)]),
    ],
  );

  const missedGloss = gloss.queries
    .map((q, i) => ({ q, won: gF32.winners[i]! }))
    .filter(({ q, won }) => q.expected !== won)
    .slice(0, 12);
  table(
    `TABLE 9 — ${String(PINNED)}d f32 gloss misses (query -> what won instead of the expected entity)`,
    ['query', 'expected', 'won', 'phrasing'],
    missedGloss.map(({ q, won }) => [q.query, q.expected, won, q.phrasing]),
  );

  // ---- is the pinned dimension reversible?
  //
  // The plan (§4) assumes S2 must pin the width because store migration 0 is final.
  // That is only true if narrowing later requires re-running the model. It does not:
  // Matryoshka projection is layer-norm over the full width, then slice, then
  // L2-normalize — so slicing an already-stored 768d f32 vector and renormalizing
  // reproduces the narrower vector exactly. Verified rather than asserted, because
  // the whole "migration 0 is final" claim turns on it.
  const stored768 = pooledA.map((p) => matryoshkaProject(p, 768));
  const reversibilityRows: string[][] = [];
  for (const target of [512, 256, 128, 64]) {
    const fromModel = pooledA.map((p) => matryoshkaProject(p, target));
    const fromStore = stored768.map((v) => plainNormalize(v.subarray(0, target) as Float32Array, target));
    const sims = fromModel.map((v, i) => cosine(v, fromStore[i]!));
    const maxComponentErr = Math.max(
      ...fromModel.map((v, i) => Math.max(...Array.from(v, (x, k) => Math.abs(x - fromStore[i]![k]!)))),
    );
    reversibilityRows.push([
      `768 -> ${String(target)}`,
      fmt(Math.min(...sims), 6),
      fmt(maxComponentErr, 8),
      Math.min(...sims) > 0.999999 ? 'exact' : 'LOSSY',
    ]);
  }
  table(
    'TABLE 10 — narrowing a stored 768d f32 vector without re-running the model',
    ['truncation', 'min cosine vs model output', 'max |Δcomponent|', 'verdict'],
    reversibilityRows,
  );

  console.log(
    `\nNOT MEASURED: §5.3 dedupe-candidate recall@15. No claim corpus exists before the spine phase; Table 5 is a ${String(pairs.length)}-item fixture-pool proxy, not the gate.`,
  );
  console.log(`polarity range at ${String(PINNED)}d f32: ${fmt(Math.min(...sPin.polarity))} .. ${fmt(Math.max(...sPin.polarity))}`);
};

const coldProbeIdx = process.argv.indexOf('--cold-probe');
if (coldProbeIdx >= 0) {
  const dt = process.argv[coldProbeIdx + 1];
  await coldProbe(dt === 'q8' ? 'q8' : 'fp32');
} else {
  await main();
}
