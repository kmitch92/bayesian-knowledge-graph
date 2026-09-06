/**
 * The same real adapter, against an API that is having an outage.
 *
 * The one failure the adapter deliberately draws no conclusion from: §9 put the
 * retry policy in the caller's hands, so a 500 is a throw and `extraction.ts`
 * decides what a throw costs. That division has two suites either side of it
 * and none across it — E7b pinned the throw, `extraction-drain.test.ts` pinned
 * the hand-back, and neither ran the adapter's own message into §9's queue.
 *
 * What crossing the seam adds is the `last_error` an operator reads. The
 * adapter's refusal names the status and quotes the body, and this fixture's
 * body deliberately contains no digits: an assertion that the failure names
 * `500` would otherwise be satisfied by the echo of a payload that said so
 * itself, and would go on passing for an adapter whose own prose diagnosed
 * nothing.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §9, §11, §12
 */

import type { Extractor } from '../../../extract/index';

import { realExtractorAnswering } from './anthropic-extractor-module';

/** The status the fake API refuses with. @spec §12 */
export const FAILURE_STATUS = 500;

/**
 * What the fake API says went wrong.
 *
 * Carries no digit anywhere, so {@link FAILURE_STATUS} appearing in a job's
 * `last_error` is the adapter's own diagnosis rather than an echo of this.
 *
 * @spec §12
 */
export const FAILURE_SAID = 'the extraction service is having a moment';

const FAILURE_BODY = JSON.stringify({
  type: 'error',
  error: { type: 'api_error', message: FAILURE_SAID },
});

/**
 * The request is still parsed before the refusal is sent.
 *
 * A fixture that answered `500` without reading the body would answer it just
 * as happily to a request the adapter had built wrongly, and this suite's whole
 * subject is what the adapter actually sends.
 *
 * @spec §5.10, §7.6
 */
export default (): Extractor =>
  realExtractorAnswering(
    () =>
      new Response(FAILURE_BODY, {
        status: FAILURE_STATUS,
        headers: { 'content-type': 'application/json' },
      }),
  );
