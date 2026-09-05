/**
 * §5.10's port, as `.kgmem/config.json` names it — and the whole reason the
 * configuration seam exists.
 *
 * Nothing in `src/` implements {@link Extractor}. Building the adapter is a
 * later phase on purpose, because the extraction prompt is this system's
 * precision ceiling. So the CLI cannot import one, and `reflect` has to be able
 * to say so; this module is what a configured extractor looks like from the
 * CLI's side, and the only difference between it and the real one is which
 * module the configuration names.
 *
 * It proposes exactly one member per chunk, carrying a slice of that chunk as
 * its quote — verbatim by construction, so the gate admits it and the test is
 * about the drain rather than about the gate, which
 * `src/extract/__tests__/verbatim-gate.test.ts` already owns. Every proposal's
 * text is distinct across chunks, because stage 0 keys on `(episode, text)` and
 * §5.10 makes a whole document one episode: repeated texts would arrive as
 * replays, move no posterior, and make "the drain ran" indistinguishable from
 * "the drain ran twice".
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §5.10, §11
 */

import {
  fakeExtractor,
  membersPerChunk,
  type FakeExtractor,
} from '../../../extract/__tests__/extraction-fixtures';

/**
 * How many members this extractor proposes per chunk.
 *
 * One, so that "a member per chunk landed" is a statement about coverage of the
 * document rather than about arithmetic — §4.2's episode-cap arithmetic over
 * many members of one document is `extraction-drain.test.ts`'s subject and not
 * this suite's.
 *
 * @spec §4.2, §5.10
 */
export const MEMBERS_PER_CHUNK = 1;

/** The tail every member this extractor proposes carries. @spec §5.10 */
export const MEMBER_MARK = 'of the overhaul ledger';

/** @spec §5.10 */
export default (): FakeExtractor => {
  const extractor = fakeExtractor();
  extractor.answerWith(membersPerChunk(MEMBERS_PER_CHUNK));
  return extractor;
};
