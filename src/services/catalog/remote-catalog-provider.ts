/**
 * @fileoverview RemoteJsonCatalogProvider — fetches and validates the fleet.json
 * payload (schema v2, with baked embeddings) from a configurable URL. Caches the
 * validated result in memory after a successful load.
 * @module services/catalog/remote-catalog-provider
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';
import type { FleetPayload } from './types.js';

// ---------------------------------------------------------------------------
// Validation schema (v2)
// ---------------------------------------------------------------------------

const EmbeddingSchema = z.array(z.number());

const CatalogToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  embedding: EmbeddingSchema,
});

const CatalogRecordSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: z.enum(['research', 'government', 'public-data', 'utility']),
  endpoint: z.string().optional(),
  npm: z.string(),
  github: z.string(),
  version: z.string(),
  auth: z.string(),
  requiredEnvVars: z.array(z.string()).optional(),
  embedding: EmbeddingSchema,
  tools: z.array(CatalogToolSchema),
});

const FleetPayloadSchema = z.object({
  version: z.literal('2'),
  generatedAt: z.string(),
  embeddingModel: z.string(),
  embeddingDims: z.number().int().positive(),
  embeddingQueryPrefix: z.string(),
  servers: z.array(CatalogRecordSchema),
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class RemoteJsonCatalogProvider {
  private readonly _url: string;
  private readonly _timeoutMs: number;

  constructor(config: Pick<ServerConfig, 'catalogUrl' | 'catalogFetchTimeoutMs'>) {
    this._url = config.catalogUrl;
    this._timeoutMs = config.catalogFetchTimeoutMs;
  }

  /**
   * Fetch and validate the remote fleet.json payload.
   * Merges the provided signal (if any) with the configured timeout signal.
   * Throws McpError(InternalError) on any failure.
   */
  async load(signal?: AbortSignal): Promise<FleetPayload> {
    const timeoutSignal = AbortSignal.timeout(this._timeoutMs);

    const combinedSignal =
      signal != null ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(this._url, { signal: combinedSignal });
    } catch (err) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        { url: this._url },
        { cause: err },
      );
    }

    if (!response.ok) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Catalog fetch returned ${response.status} ${response.statusText}`,
        { url: this._url, status: response.status, statusText: response.statusText },
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (err) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Catalog response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { url: this._url },
        { cause: err },
      );
    }

    const parsed = FleetPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') ?? '(unknown)';
      const msg = first?.message ?? 'validation failed';
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Catalog payload failed validation at ${path}: ${msg}`,
        { url: this._url, issues: parsed.error.issues.slice(0, 5) },
      );
    }

    return parsed.data as FleetPayload;
  }
}
