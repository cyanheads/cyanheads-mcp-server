/**
 * @fileoverview Server-specific configuration schema and lazy accessor.
 * Separate from the framework's core config — never merge these two schemas.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  /**
   * Remote catalog JSON endpoint. Must return a JSON body matching the FleetPayload (v2) schema.
   * Loaded at server startup via RemoteJsonCatalogProvider.
   */
  catalogUrl: z
    .url()
    .default('https://caseyjhand.com/fleet.json')
    .describe('URL of the remote fleet.json catalog endpoint.'),

  /**
   * AbortSignal.timeout requires integer milliseconds. Keep the same signed
   * 32-bit ceiling as the background timer, avoiding runtime-specific overflow.
   */
  catalogFetchTimeoutMs: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .default(10000)
    .describe('HTTP timeout for remote catalog fetch: integer milliseconds, 1–2147483647.'),

  /**
   * Background poll interval. The service re-fetches fleet.json on this cadence
   * and swaps in the new vector index if `generatedAt` changed.
   * Set to 0 to disable background refresh. Fractional seconds retain the
   * runtime's millisecond timer resolution within setInterval's signed range.
   */
  catalogRefreshSeconds: z.coerce
    .number()
    .nonnegative()
    .max(2_147_483.647)
    .default(3600)
    .describe(
      'Seconds between background catalog re-fetches: 0 disables refresh; positive values up to 2147483.647 use the runtime timer resolution.',
    ),

  /**
   * Embedding model identifier. Must match `embeddingModel` declared in fleet.json,
   * or the server refuses to load (since vectors live in the same space as the
   * model that produced them).
   */
  embeddingModelId: z
    .string()
    .min(1)
    .default('Snowflake/snowflake-arctic-embed-m-v1.5')
    .describe(
      'Hugging Face model id used for query embedding at search time. Must match fleet.json.embeddingModel.',
    ),

  /**
   * Minimum cosine similarity for a result to surface in cyanheads_search_catalog output.
   * Tunable post-launch based on observed query patterns.
   */
  similarityFloor: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe('Minimum cosine similarity in [0, 1] for a match to appear in search results.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    catalogUrl: 'CATALOG_URL',
    catalogFetchTimeoutMs: 'CATALOG_FETCH_TIMEOUT_MS',
    catalogRefreshSeconds: 'CATALOG_REFRESH_SECONDS',
    embeddingModelId: 'EMBEDDING_MODEL_ID',
    similarityFloor: 'SIMILARITY_FLOOR',
  });
  return _config;
}

/** Reset cached config (test-only). */
export function resetServerConfig(): void {
  _config = undefined;
}
