/**
 * §5.3's port, as `.kgmem/config.json` names it.
 *
 * This module is not a test double smuggled into production. It is the fixture
 * end of the seam E5 has to have anyway: an embedding provider cannot be a
 * hard-coded import if the write path is ever to run under a different one, and
 * the *shape* of the seam is what this file exercises — a module specifier, a
 * default export, a factory, a port.
 *
 * Faked rather than real because the real one loads ONNX weights: several
 * seconds and several hundred megabytes per spawn, in a suite that spawns
 * repeatedly. The vectors are the declared-cluster ones every other suite in
 * this repo embeds with, at the width the store pins, so the geometry the CLI
 * writes is the geometry the store already knows how to hold.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it — the same rule `job-drain-worker.ts` follows.
 *
 * @spec §5.3, §11
 */

import { fakeEmbeddings, type FakeEmbeddings } from '../../../referents/__tests__/fixtures';

/** @spec §5.3 */
export default (): FakeEmbeddings => fakeEmbeddings();
