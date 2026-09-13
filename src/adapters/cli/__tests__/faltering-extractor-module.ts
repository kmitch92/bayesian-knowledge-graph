/**
 * An extractor whose answer is decided by the chunk it is handed, so one module
 * stands in for a model that fails, answers, misquotes, or answers with nothing
 * — in whatever mix a scenario's ledger spells out.
 *
 * `loadPort` calls a factory with no arguments inside the child process, so a
 * scenario cannot script the extractor the CLI built. The ledger scripts it
 * instead: each entry carries one of the marks below, and the mark decides the
 * answer.
 *
 * The thrown message counts this process's model calls, so the error a run
 * chooses to quote says *which* failure it chose, independent of the order the
 * queue hands jobs out in.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §5.10, §9, §12, §14.15
 */

import type { ExtractedClaim, ExtractionRequest, Extractor } from '../../../extract/index';
import {
  EXTRACTOR_MODEL_ID,
  OVERHAUL_LEDGER,
  membersPerChunk,
  proposal,
} from '../../../extract/__tests__/extraction-fixtures';

/** The model call for an entry carrying this throws. @spec §9 */
export const UNREACHABLE_MARK = 'The model never answers for this entry.';

/** The model answers with a proposal whose quote the entry does not hold. @spec §5.10 */
export const MISQUOTED_MARK = 'The model misquotes this entry.';

/** The model answers with no proposals at all. @spec §5.10 */
export const SILENT_MARK = 'The model finds nothing in this entry.';

/** The model answers with one proposal quoting the entry verbatim. @spec §5.10 */
export const QUOTABLE_MARK = 'The model quotes this entry exactly.';

export const OUTCOME_MARKS: readonly string[] = [
  UNREACHABLE_MARK,
  MISQUOTED_MARK,
  SILENT_MARK,
  QUOTABLE_MARK,
];

/** A non-blank quote no entry contains, so the gate refuses it as not verbatim. @spec §5.10 */
const MISQUOTE = 'a sentence no entry in this ledger contains';

/** What the model call numbered `call` (from 1, in this process) throws. @spec §9, §12 */
export const unreachableOnCall = (call: number): string =>
  `fixture model unreachable on extraction call ${String(call)}`;

const answerFor = (request: ExtractionRequest): readonly ExtractedClaim[] => {
  if (request.chunkText.includes(MISQUOTED_MARK))
    return [
      proposal({
        text: `${request.chunkText.slice(0, 24)} — misread from the overhaul ledger.`,
        quote: MISQUOTE,
        mentions: [OVERHAUL_LEDGER],
      }),
    ];
  if (request.chunkText.includes(SILENT_MARK)) return [];
  if (request.chunkText.includes(QUOTABLE_MARK)) return membersPerChunk(1)(request);
  throw new Error('fixture entry carries no outcome mark');
};

/** @spec §5.10 */
export default (): Extractor => {
  let calls = 0;
  return {
    modelId: EXTRACTOR_MODEL_ID,
    extract: (request) => {
      calls += 1;
      if (request.chunkText.includes(UNREACHABLE_MARK))
        return Promise.reject(new Error(unreachableOnCall(calls)));
      return Promise.resolve(answerFor(request));
    },
  };
};
