/**
 * One of several processes racing to be the first to open a database.
 *
 * §11's migration guard is written for exactly this: "several processes may open
 * a fresh database at once, and the loser of that race must find the schema
 * already there rather than try to create it twice". In v1 that is the ordinary
 * case, not a corner one — an MCP server per session plus git hooks shelling out
 * to the same binary can all start against a brand-new graph in the same
 * instant.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * The worker parks *before* opening, so the barrier releases every process into
 * `openGraphStore` together — the whole point being that migration 0 is
 * attempted concurrently. Its imports are already resolved by then, so the
 * expensive part (loading better-sqlite3 and sqlite-vec) is behind it.
 *
 * Every read afterwards is chosen to touch a different part of the schema: an
 * ordinary table, the normalized provenance join, and both `vec0` virtual
 * tables. A half-applied migration fails one of them, and a nonzero exit is
 * what the parent sees.
 *
 * Usage: `open-worker.ts <dbPath>`
 *
 * @spec §5.7, §11
 */

import { openGraphStore } from '../index';

import { CLAIM_ID, ENTITY_ID, WORKER_READY, unitVector } from './fixtures';

/** Parses one positional argument as a non-empty string. @spec §11 */
export const requireStringArg = (raw: string | undefined, name: string): string => {
  if (raw === undefined || raw === '') throw new TypeError(`${name} is required`);
  return raw;
};

/** Announces readiness and blocks until the parent releases the barrier. @spec §5.7 */
export const parkAtBarrier = async (): Promise<void> => {
  process.stdout.write(`${WORKER_READY}\n`);
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => {
      resolve();
    });
    process.stdin.once('end', () => {
      resolve();
    });
  });
};

const [dbPath] = process.argv.slice(2);
const path = requireStringArg(dbPath, 'dbPath');

await parkAtBarrier();

const store = openGraphStore({ path });

store.getClaim(CLAIM_ID);
store.getEntity(ENTITY_ID);
store.getClaimsAbout(ENTITY_ID);
store.searchClaims({ embedding: unitVector(1), limit: 1 });

store.close();
