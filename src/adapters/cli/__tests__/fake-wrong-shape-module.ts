/**
 * A module a configuration may name that resolves, exports a factory, and still
 * is not the port it was named for.
 *
 * The mistake this stands in for is the ordinary one: a specifier pointed at the
 * wrong file in the right package, or at a module whose export shape drifted a
 * major version ago. Both resolve, both default-export a function, and both
 * produce an object with nothing the write path can call.
 *
 * It matters *when* that is discovered. `openModels` runs before the store is
 * opened, so a factory checked at load time turns this into a refusal that costs
 * the graph nothing; a factory checked at the call site turns it into a crash
 * partway through a write, after the document row has landed. This module is how
 * the suite tells those two apart.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it — the same rule `fake-embeddings-module.ts` follows.
 *
 * @spec §5.3, §11
 */

/** The method name the object below is missing, quoted in the refusal. @spec §5.3 */
export const REQUIRED_EMBEDDING_METHOD = 'embedBatch';

/**
 * Answers with an object that is emphatically not an {@link EmbeddingProvider}.
 *
 * Typed as `unknown` on the way out because it is not one: giving it the port's
 * type to satisfy the compiler would be the fixture asserting the very thing the
 * test exists to deny.
 *
 * @spec §5.3
 */
export default (): unknown => ({
  modelId: 'wrong-shape@0',
  dimensions: 768,
  summarise: () => Promise.resolve('not an embedding provider'),
});
