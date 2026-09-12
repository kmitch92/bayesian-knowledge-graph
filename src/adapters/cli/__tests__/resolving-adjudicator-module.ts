/**
 * §5.2's port as a repository that actually named one receives it: a model that
 * answers.
 *
 * Its sibling `fake-adjudicator-module.ts` is the one every other suite
 * configures, and it is deliberately silent — `fakeAdjudicator()` declines by
 * default, which is the same verdict `config.ts` builds for a repository that
 * named nothing at all. That makes it useless for the one question this module
 * exists to ask: *was the configured module loaded, or was the unconfigured stub
 * used in its place?* Two ports that both decline cannot answer it, because a
 * `openModels` that discarded `models.adjudicator` outright would produce
 * identical behaviour.
 *
 * So this one resolves, to the first candidate on the slate. `tiebreak` is a rung
 * no stub in `config.ts` can reach — the decline mints and the refusal throws —
 * so a write that comes back reporting it could only have gone through the module
 * the configuration named.
 *
 * Which candidate it picks is not the subject and is not asserted on beyond its
 * being one of the two the arrangement offered; a model is entitled to either.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §5.2, §7.6, §11
 */

import type { Adjudicator } from '../../../referents/index';

/** @spec §5.2 */
export default (): Adjudicator => ({
  tiebreakReferent: (request) =>
    Promise.resolve(
      request.candidates[0] === undefined
        ? { outcome: 'unresolved' }
        : { outcome: 'resolved', referentId: request.candidates[0].referentId },
    ),
});
