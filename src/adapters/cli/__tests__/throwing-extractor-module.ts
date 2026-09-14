/**
 * An extractor module whose factory throws at construction.
 *
 * This stands in for a real extractor adapter (e.g., the Anthropic extractor)
 * whose constructor needs a credential the environment lacks, such as
 * ANTHROPIC_API_KEY. The factory throws to simulate that condition.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §5.10
 */

/**
 * A factory that throws immediately to simulate a construction failure.
 *
 * This is called by `loadPort` inside `openModels`, and the thrown error
 * is caught and wrapped in a ConfigError.
 *
 * @spec §5.10
 */
export default (): never => {
  throw new Error('this extractor cannot be constructed here');
};
