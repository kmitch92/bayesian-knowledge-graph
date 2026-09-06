/**
 * The same real adapter, against an answer that ran out of room.
 *
 * The one unreadable answer that does not look unreadable, and the only
 * scenario here whose fixture is *indistinguishable from success* but for one
 * field. The tool call is well formed, its claim is well typed, and its quote
 * is the same byte-exact span the sibling module gets admitted — so an adapter
 * without E7b-2's guard hands this over, `extraction.ts` calls `completeJob`,
 * and the chunk is marked mined of whatever fraction of the answer arrived,
 * with no `extraction_rejections` row and no trace anywhere.
 *
 * That makes the end-to-end reading sharp: with the guard, the job is back on
 * §9's queue with an attempt counted and the graph untouched; without it, the
 * job is `done` and the member is in the ledger. Nothing else in this suite
 * separates two outcomes that cleanly, and the guard is new enough that
 * nothing has ever run it through the CLI.
 *
 * `stop_reason: 'max_tokens'` with the `tool_use` block **last**, because that
 * is the case the adapter refuses: blocks arrive in order, so only the last one
 * can be half-written, and a tool call with a block after it was finished.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §5.10, §9, §12, §15
 */

import type { Extractor } from '../../../extract/index';

import {
  AT_THE_BUDGET,
  realExtractorAnswering,
  toolCallAnswer,
  verbatimClaimFor,
} from './anthropic-extractor-module';

/** @spec §5.10, §7.6, §15 */
export default (): Extractor =>
  realExtractorAnswering((seen) =>
    toolCallAnswer(seen, [verbatimClaimFor(seen.chunk)], AT_THE_BUDGET),
  );
