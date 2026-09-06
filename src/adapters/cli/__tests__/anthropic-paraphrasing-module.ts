/**
 * The same real adapter, answering with spans the chunk does not hold.
 *
 * §5.10's gate is `chunkText.includes(quote)` and nothing else, and this is the
 * arm of it that has never run against a real adapter's own output: E7b proved
 * the adapter hands a quote through untouched, `verbatim-gate.test.ts` proved
 * the gate refuses a span the chunk lacks, and nothing has ever put one of
 * those outputs into the other. What this module offers is two ways of getting
 * it wrong, one obvious and one one character wide:
 *
 * 1. **A composed span.** {@link COMPOSED_QUOTE} is a sentence the corpus never
 *    contained — §12's phantom, cited rather than copied.
 * 2. **A tidied span.** {@link straightenedQuoteOf} is the *admitted* quote from
 *    `anthropic-extractor-module.ts` with its curly apostrophe straightened, and
 *    nothing else changed. Same claim text, same span, one code unit apart —
 *    admitted in the sibling module's run and refused in this one. That pair is
 *    the whole of what byte-exactness means, and the near miss is the half that
 *    a normalization anywhere between the model and the gate would produce.
 *
 * Both are `quoteNotVerbatim` rather than `quoteAbsent`: each is a span the
 * model actually offered, so each is anchored to the chunk it was offered
 * against, and §13 can group the pair by the model that produced them.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §5.10, §12, §13
 */

import type { ExtractedClaim, Extractor } from '../../../extract/index';

import {
  MENTIONED,
  awkwardQuoteOf,
  openingOf,
  realExtractorAnswering,
  toolCallAnswer,
  verbatimClaimFor,
} from './anthropic-extractor-module';

/**
 * A span no chunk of the corpus contains, in the corpus's own register.
 *
 * A constant rather than something derived, because the property that matters
 * here is absence and a derivation would have to be checked for it anyway — the
 * suite asserts it against every chunk before relying on it.
 *
 * @spec §5.10, §12
 */
export const COMPOSED_QUOTE = 'the seat was replaced by the night shift';

/** The assertion the composed span is offered in support of. @spec §12 */
export const composedClaimTextFor = (chunk: string): string =>
  `${openingOf(chunk)} The seat was replaced rather than lapped.`;

/**
 * The admitted quote with its typographic apostrophe straightened.
 *
 * The cheapest way for a well-meaning implementation to stop being verbatim,
 * and the one §5.10's gate is written strictly to catch: a folded match implies
 * nothing about the document, and testimony decay re-runs the exact search
 * later and disagrees with whatever the fold decided.
 *
 * @spec §5.10, §12
 */
export const straightenedQuoteOf = (chunk: string): string =>
  awkwardQuoteOf(chunk).replaceAll('’', "'");

/** What a model that tidied its citations proposes for one chunk. @spec §5.10, §12 */
const uncopiedClaimsFor = (chunk: string): readonly ExtractedClaim[] => [
  {
    text: composedClaimTextFor(chunk),
    quote: COMPOSED_QUOTE,
    kind: 'fact',
    tier: 'inferred',
    mentions: [MENTIONED],
  },
  // The sibling module's claim, unchanged but for the apostrophe: the same
  // `claimText` that lands in the graph when the span is copied exactly.
  { ...verbatimClaimFor(chunk), quote: straightenedQuoteOf(chunk) },
];

/** @spec §5.10, §7.6 */
export default (): Extractor =>
  realExtractorAnswering((seen) => toolCallAnswer(seen, uncopiedClaimsFor(seen.chunk)));
