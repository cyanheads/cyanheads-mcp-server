/**
 * @fileoverview CatalogService — fleet catalog with semantic search.
 * Loads fleet.json (v2 with baked embeddings) at startup, packs vectors into a
 * Float32Array for cache locality, and serves cosine-similarity search by
 * embedding the query at runtime and dot-producting against the in-memory index.
 * Polls the remote payload on a configurable interval; atomic swap on change.
 * @module services/catalog/catalog-service
 */

import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import { type IEmbeddingsRuntime, TransformersEmbeddingsRuntime } from './embeddings-runtime.js';
import { RemoteJsonCatalogProvider } from './remote-catalog-provider.js';
import type {
  CatalogCategory,
  CatalogRecord,
  CatalogSearchResult,
  CatalogTool,
  FleetPayload,
  ICatalogService,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal index shape
// ---------------------------------------------------------------------------

interface CatalogIndex {
  dims: number;
  initializedAt: string;
  payload: FleetPayload;
  serverByName: Map<string, CatalogRecord>;
  /** Packed [serverCount × dims] row-major. */
  serverVectors: Float32Array;
  toolByName: Map<string, CatalogTool & { serverRecord: CatalogRecord }>;
  /** Parallel to toolVectors row order: toolByName entries built in this order. */
  toolNamesInOrder: string[];
  /** Packed [toolCount × dims] row-major. */
  toolVectors: Float32Array;
}

type CatalogServiceConfig = Pick<
  ServerConfig,
  | 'catalogUrl'
  | 'catalogFetchTimeoutMs'
  | 'catalogRefreshSeconds'
  | 'embeddingModelId'
  | 'similarityFloor'
>;

// ---------------------------------------------------------------------------
// CatalogService
// ---------------------------------------------------------------------------

export class CatalogService implements ICatalogService {
  private _index: CatalogIndex | null = null;
  private readonly _provider: RemoteJsonCatalogProvider;
  private readonly _embeddings: IEmbeddingsRuntime;
  private readonly _config: CatalogServiceConfig;
  private _refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CatalogServiceConfig, embeddings?: IEmbeddingsRuntime) {
    this._config = config;
    this._provider = new RemoteJsonCatalogProvider(config);
    this._embeddings = embeddings ?? new TransformersEmbeddingsRuntime(config.embeddingModelId);
  }

  async initialize(): Promise<void> {
    logger.info(`Loading fleet catalog from ${this._config.catalogUrl}`);
    const payload = await this._provider.load();

    this._assertModelMatch(payload);
    this._index = this._buildIndex(payload);

    logger.info(
      `Fleet catalog loaded: ${payload.servers.length} servers, ${this._index.toolByName.size} tools ` +
        `(model=${payload.embeddingModel}, dims=${payload.embeddingDims}, generatedAt=${payload.generatedAt})`,
    );

    /**
     * Background warm-up: trigger the embedding model load now, off the
     * critical startup path. Running pipeline() from setup() succeeds where
     * the same call from a request-handler context fails on a cold cache —
     * OpenTelemetry HTTP instrumentation interferes with transformers.js's
     * model fetch once the request scope is active. First user query awaits
     * the in-flight _loadPromise instead of starting a fresh load.
     */
    void this._embeddings
      .embedQuery('warmup', this._index.dims, this._index.payload.embeddingQueryPrefix)
      .catch((err) => {
        logger.warning(
          `Background embedding warm-up failed; first cyanheads_search will retry. ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    if (this._config.catalogRefreshSeconds > 0) {
      this._refreshTimer = setInterval(() => {
        void this._maybeRefresh();
      }, this._config.catalogRefreshSeconds * 1000);
    }
  }

  async search(params: {
    query: string;
    scope: 'tools' | 'servers';
    category?: CatalogCategory;
    limit?: number;
  }): Promise<CatalogSearchResult[]> {
    const index = this._assertInitialized();
    const queryVec = await this._embeddings.embedQuery(
      params.query,
      index.dims,
      index.payload.embeddingQueryPrefix,
    );

    const floor = this._config.similarityFloor;
    const results: CatalogSearchResult[] = [];

    if (params.scope === 'servers') {
      for (const [i, server] of index.payload.servers.entries()) {
        if (params.category && server.category !== params.category) continue;
        const score = dotRow(queryVec, index.serverVectors, i, index.dims);
        if (score < floor) continue;
        results.push({
          name: server.name,
          server: server.name,
          brief: server.description,
          category: server.category,
          score,
        });
      }
    } else {
      let toolI = 0;
      for (const server of index.payload.servers) {
        for (const tool of server.tools) {
          if (params.category && server.category !== params.category) {
            toolI++;
            continue;
          }
          const score = dotRow(queryVec, index.toolVectors, toolI, index.dims);
          toolI++;
          if (score < floor) continue;
          results.push({
            name: tool.name,
            server: server.name,
            brief: tool.description,
            category: server.category,
            score,
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return params.limit != null ? results.slice(0, params.limit) : results;
  }

  getTool(name: string): (CatalogTool & { serverRecord: CatalogRecord }) | null {
    const index = this._assertInitialized();
    return index.toolByName.get(name) ?? null;
  }

  getServer(name: string): CatalogRecord | null {
    const index = this._assertInitialized();
    return index.serverByName.get(name) ?? null;
  }

  listCategories(): CatalogCategory[] {
    const index = this._assertInitialized();
    const cats = new Set<CatalogCategory>();
    for (const server of index.payload.servers) cats.add(server.category);
    return Array.from(cats).sort();
  }

  stats(): {
    toolCount: number;
    serverCount: number;
    initializedAt: string;
    embeddingModel: string;
  } {
    const index = this._assertInitialized();
    return {
      toolCount: index.toolByName.size,
      serverCount: index.payload.servers.length,
      initializedAt: index.initializedAt,
      embeddingModel: index.payload.embeddingModel,
    };
  }

  /** Stop the background refresh timer (test-only / shutdown). */
  shutdown(): void {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _assertModelMatch(payload: FleetPayload): void {
    if (payload.embeddingModel !== this._config.embeddingModelId) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Catalog embedding model mismatch: payload declares "${payload.embeddingModel}" but server expects "${this._config.embeddingModelId}". ` +
          'Update EMBEDDING_MODEL_ID or regenerate the catalog with the matching model.',
        {
          payloadModel: payload.embeddingModel,
          expected: this._config.embeddingModelId,
        },
      );
    }
  }

  private _buildIndex(payload: FleetPayload): CatalogIndex {
    const dims = payload.embeddingDims;
    const serverCount = payload.servers.length;
    let toolCount = 0;
    for (const s of payload.servers) toolCount += s.tools.length;

    const serverVectors = new Float32Array(serverCount * dims);
    const toolVectors = new Float32Array(toolCount * dims);
    const toolByName = new Map<string, CatalogTool & { serverRecord: CatalogRecord }>();
    const serverByName = new Map<string, CatalogRecord>();
    const toolNamesInOrder: string[] = [];

    let toolI = 0;
    for (const [si, server] of payload.servers.entries()) {
      if (server.name.includes('_')) {
        throw new McpError(
          JsonRpcErrorCode.InternalError,
          `Server name "${server.name}" contains underscores. Fleet naming convention requires hyphenated server names.`,
        );
      }
      if (server.embedding.length !== dims) {
        throw new McpError(
          JsonRpcErrorCode.InternalError,
          `Server "${server.name}" embedding has ${server.embedding.length} dims; expected ${dims}.`,
        );
      }

      serverVectors.set(server.embedding, si * dims);
      serverByName.set(server.name, server);

      for (const tool of server.tools) {
        if (tool.embedding.length !== dims) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            `Tool "${tool.name}" embedding has ${tool.embedding.length} dims; expected ${dims}.`,
          );
        }
        toolVectors.set(tool.embedding, toolI * dims);
        toolByName.set(tool.name, { ...tool, serverRecord: server });
        toolNamesInOrder.push(tool.name);
        toolI++;
      }
    }

    return {
      payload,
      serverVectors,
      toolVectors,
      toolByName,
      serverByName,
      toolNamesInOrder,
      dims,
      initializedAt: new Date().toISOString(),
    };
  }

  private async _maybeRefresh(): Promise<void> {
    try {
      const current = this._index;
      if (!current) return;
      const payload = await this._provider.load();
      if (payload.generatedAt === current.payload.generatedAt) {
        logger.debug(`Catalog refresh: no change (generatedAt=${payload.generatedAt})`);
        return;
      }
      if (payload.embeddingModel !== this._config.embeddingModelId) {
        logger.warning(
          `Catalog refresh skipped: payload claims model "${payload.embeddingModel}" but server expects "${this._config.embeddingModelId}". Keeping last-known state.`,
        );
        return;
      }
      const next = this._buildIndex(payload);
      this._index = next;
      logger.info(
        `Catalog refreshed: ${payload.servers.length} servers, ${next.toolByName.size} tools (generatedAt=${payload.generatedAt})`,
      );
    } catch (err) {
      logger.warning(
        `Catalog refresh failed; keeping last-known state. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private _assertInitialized(): CatalogIndex {
    if (!this._index) {
      throw serviceUnavailable('CatalogService not initialized — call initialize() in setup()', {
        reason: 'catalog_empty',
      });
    }
    return this._index;
  }
}

// ---------------------------------------------------------------------------
// Dot product helper
// ---------------------------------------------------------------------------

function dotRow(query: Float32Array, store: Float32Array, rowIdx: number, dims: number): number {
  const offset = rowIdx * dims;
  let sum = 0;
  for (let i = 0; i < dims; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds enforced by loop + Float32Array sizing
    sum += query[i]! * store[offset + i]!;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Init / accessor
// ---------------------------------------------------------------------------

let _service: CatalogService | undefined;

export function initCatalogService(
  config: CatalogServiceConfig,
  embeddings?: IEmbeddingsRuntime,
): void {
  _service = new CatalogService(config, embeddings);
}

export function getCatalogService(): CatalogService {
  if (!_service) {
    throw serviceUnavailable(
      'CatalogService not initialized — call initCatalogService() in setup()',
      { reason: 'catalog_empty' },
    );
  }
  return _service;
}

/** Test-only reset. */
export function resetCatalogServiceForTests(): void {
  _service?.shutdown();
  _service = undefined;
}
