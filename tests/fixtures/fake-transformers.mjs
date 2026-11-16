/**
 * @fileoverview Stands in for `@huggingface/transformers` in a spawned server.
 * Preloaded with `node --import`, it routes that package to this module, so
 * `setup()`'s embedding warm-up runs a constant pipeline instead of downloading
 * and loading the model.
 * @module tests/fixtures/fake-transformers
 */

import { registerHooks } from 'node:module';

registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === '@huggingface/transformers'
      ? { url: import.meta.url, shortCircuit: true }
      : nextResolve(specifier, context),
});

/** The runtime sets `env.cacheDir`; nothing reads it here. */
export const env = {};

/** A feature-extraction pipeline that embeds every input as `[1, 0]`. */
export const pipeline = () => (inputs) => ({ tolist: () => inputs.map(() => [1, 0]) });
