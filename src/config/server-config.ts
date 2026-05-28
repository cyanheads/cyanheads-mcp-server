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
    .string()
    .default('https://caseyjhand.com/fleet.json')
    .describe('URL of the remote fleet.json catalog endpoint.'),

  /**
   * Timeout in milliseconds for the remote catalog fetch.
   */
  catalogFetchTimeoutMs: z.coerce
    .number()
    .default(10000)
    .describe('HTTP timeout for remote catalog fetch in milliseconds.'),

  /**
   * Background poll interval. The service re-fetches fleet.json on this cadence
   * and swaps in the new vector index if `generatedAt` changed.
   * Set to 0 to disable background refresh.
   */
  catalogRefreshSeconds: z.coerce
    .number()
    .default(3600)
    .describe('Seconds between background catalog re-fetches. 0 disables background refresh.'),

  /**
   * Embedding model identifier. Must match `embeddingModel` declared in fleet.json,
   * or the server refuses to load (since vectors live in the same space as the
   * model that produced them).
   */
  embeddingModelId: z
    .string()
    .default('Snowflake/snowflake-arctic-embed-m-v1.5')
    .describe(
      'Hugging Face model id used for query embedding at search time. Must match fleet.json.embeddingModel.',
    ),

  /**
   * Minimum cosine similarity for a result to surface in cyanheads_search output.
   * Tunable post-launch based on observed query patterns.
   */
  similarityFloor: z.coerce
    .number()
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
