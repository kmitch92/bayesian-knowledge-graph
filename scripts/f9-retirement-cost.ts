/**
 * What one containment retirement costs at S3's benchmark ledger size.
 *
 * Diagnostic only: builds a real SQLite ledger of N claims by the shortest legal
 * route (`putClaim`, no ingest pipeline, no embedding provider), then times
 * `retireClaim` on a containment claim under the three shapes the conditional
 * delete can take — no survivor (full scan), an early survivor (first-page
 * return), a late survivor (near-full scan) — against an ordinary claim
 * retirement, which the payload guard short-circuits.
 *
 * Run: pnpm exec tsx scripts/f9-retirement-cost.ts [ledgerSize]
 */

import Database from 'better-sqlite3';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { retireClaim } from '../src/ingest/spine-writer.js';
import { scanClaimIds } from '../src/referents/index-view.js';
import { encodeSpineClaim } from '../src/referents/spine.js';
import {
  openGraphStore,
  type ClaimRecord,
  type EntityShape,
  type GraphStore,
} from '../src/store/index.js';

const LEDGER_SIZE = Number(process.argv[2] ?? 100_000);

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A schema-valid, monotonically ordered ULID for row `n`. */
const idAt = (prefix: string, n: number): string => {
  let rest = n;
  let tail = '';
  for (let place = 0; place < 12; place += 1) {
    tail = ULID_ALPHABET[rest % 32]! + tail;
    rest = Math.floor(rest / 32);
  }
  const head = [...prefix.toUpperCase()].filter((char) => ULID_ALPHABET.includes(char)).join('');
  return (head + tail).slice(0, 26).padEnd(26, '0');
};

const PARENT_ID = idAt('ZZZENTITYPARENT', 0);
const CHILD_ID = idAt('ZZZENTITYCH1LD0', 0);

const embedding = (): number[] => {
  const width = 768;
  const value = 1 / Math.sqrt(width);
  return Array.from({ length: width }, () => value);
};

const VECTOR = embedding();

const claimAt = (id: string, text: string): ClaimRecord => ({
  id,
  text,
  embedding: VECTOR,
  kind: 'convention',
  tier: 'observed',
  status: 'active',
  regime: 'evidence',
  evidence: { alpha: 1, beta: 1 },
  scope: PARENT_ID,
  temporal: { createdAt: '2026-08-22T09:14:03.000Z' },
  provenance: {
    episodes: ['ep-2026-08-22-0001'],
    changeEvents: [],
    artifacts: [],
    channel: 'live-observe',
    agent: 'claude-code',
  },
  canonical: true,
});

const containmentText = (): string =>
  encodeSpineClaim({
    v: 1,
    claim: 'containment',
    parent: PARENT_ID,
    child: CHILD_ID,
    childLevel: null,
  });

const referentAt = (id: string, name: string): EntityShape => ({
  id,
  name,
  aliases: [],
  kind: 'component',
  level: null,
  gloss: `${name} is a spine node this benchmark hangs claims from.`,
  glossEmbedding: VECTOR,
  facets: [],
  locator: null,
  regime: 'evidence',
});

interface Seeded {
  readonly store: GraphStore;
  readonly directory: string;
}

/**
 * A ledger of `size` ordinary claims, plus containment claims at the positions
 * the timings need: `subjectId` is the one retired, `survivorIds` are further
 * live claims over the same pair placed at the given fractions of the scan.
 */
const seed = (size: number, survivorAt: readonly number[]): Seeded => {
  const directory = mkdtempSync(join(tmpdir(), 'f9-cost-'));
  const store = openGraphStore({ path: join(directory, 'graph.db') });

  store.putEntity(referentAt(PARENT_ID, 'Parent'));
  store.putEntity(referentAt(CHILD_ID, 'Child'));

  const survivorRows = new Set(survivorAt.map((fraction) => Math.floor(size * fraction)));

  for (let n = 0; n < size; n += 1) {
    const id = idAt('CLA1M', n);
    const text = survivorRows.has(n)
      ? containmentText()
      : `Ordinary belief number ${n} about the retry pathway and its idempotence.`;
    store.putClaim(claimAt(id, text));
  }

  store.putContainment({ parent: PARENT_ID, child: CHILD_ID });
  return { store, directory };
};

const time = (label: string, run: () => void): number => {
  const started = process.hrtime.bigint();
  run();
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`${label.padEnd(52)} ${elapsed.toFixed(1)} ms`);
  return elapsed;
};

const scenario = (
  label: string,
  survivorAt: readonly number[],
  options: { readonly ordinary?: boolean; readonly size?: number; readonly quiet?: boolean } = {},
): void => {
  const size = options.size ?? LEDGER_SIZE;
  const { store, directory } = seed(size, survivorAt);
  const subjectId = idAt('ZSVBJECTCONTA1NMENT', 0);
  store.putClaim(claimAt(subjectId, options.ordinary === true ? 'An ordinary belief.' : containmentText()));

  const run = (): void => {
    retireClaim(store, subjectId);
  };
  if (options.quiet === true) run();
  else time(label, run);

  const survived = store.getChildren(PARENT_ID).length === 1;
  const expected = options.ordinary === true || survivorAt.length > 0;
  if (options.quiet !== true && survived !== expected)
    throw new Error(`${label}: edge ${survived ? 'survived' : 'went'}, which is not what the scenario means`);

  store.close();
  rmSync(directory, { recursive: true, force: true });
};

scenario('warmup', [], { size: 5_000, quiet: true });
scenario('warmup', [0.5], { size: 5_000, quiet: true });

console.log(`ledger size: ${LEDGER_SIZE.toLocaleString()} claims\n`);

scenario('ordinary claim retirement (payload guard returns)', [], { ordinary: true });
scenario('containment, no survivor (full scan + delete)', []);
scenario('containment, survivor at 1% (early return)', [0.01]);
scenario('containment, survivor at 50%', [0.5]);
scenario('containment, survivor at 99% (late return)', [0.99]);

const floor = seed(LEDGER_SIZE, []);
time('  of which: scanClaimIds id enumeration alone', () => {
  scanClaimIds(floor.store);
});
time('  of which: getClaim hydration of every id', () => {
  for (const id of scanClaimIds(floor.store)) floor.store.getClaim(id);
});
floor.store.close();

const side = new Database(join(floor.directory, 'graph.db'), { readonly: true });
time('  what a text-and-status-only scan would cost', () => {
  side.prepare('SELECT id, text, status FROM claims ORDER BY id').all();
});
side.close();
rmSync(floor.directory, { recursive: true, force: true });
