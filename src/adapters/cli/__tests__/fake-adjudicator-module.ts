/**
 * §5.2's port, as `.kgmem/config.json` names it.
 *
 * Supplied by every fixture in this suite, and never actually called by one:
 * `documentSource` guesses no anchor, so `ingest` never climbs the ladder for a
 * document, and the nouns the faked extractor names are either unheard of (which
 * mints without adjudicating) or already in the mention index (which resolves at
 * rung 0). It is here so that no test in this suite accidentally pins *how* a
 * missing adjudicator behaves — that question belongs to the phase that builds
 * one, and this suite has no business answering it by omission.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §5.2, §11
 */

import { fakeAdjudicator, type FakeAdjudicator } from '../../../referents/__tests__/fixtures';

/** @spec §5.2 */
export default (): FakeAdjudicator => fakeAdjudicator();
