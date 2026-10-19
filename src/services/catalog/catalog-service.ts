/**
 * @fileoverview CatalogService — fleet catalog with semantic search.
 * Loads fleet.json (v2 with baked embeddings) at startup, normalizes each vector
 * and packs it into a Float32Array for cache locality, and serves
 * cosine-similarity search by embedding the query at runtime and
 * dot-producting against the in-memory index.
 * Polls the remote payload on a configurable interval; atomic swap on change.
 * @module services/catalog/catalog-service
 */

import { internalError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import { type IEmbeddingsRuntime, TransformersEmbeddingsRuntime } from './embeddings-runtime.js';
import { RemoteJsonCatalogProvider } from './remote-catalog-provider.js';
import { getSelfCatalogRecord, getSelfCatalogTool, SELF_RECORD_NAME } from './self-record.js';
import { setCatalogService } from './service-instance.js';
import type {
  CatalogCategory,
  CatalogRecord,
  CatalogSearchResult,
  CatalogToolEntry,
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
  serverByFoldedName: Map<string, CatalogRecord | null>;
  serverByName: Map<string, CatalogRecord>;
  /** Packed [serverCount × dims] row-major. */
  serverVectors: Float32Array;
  /** Every row per lowercased name, in payload order. */
  toolsByFoldedName: Map<string, CatalogToolEntry[]>;
  /** Every row per exact name, in payload order — one per owning server. */
  toolsByName: Map<string, CatalogToolEntry[]>;
  /** Packed [toolCount × dims] row-major. */
  toolVectors: Float32Array;
}

/**
 * Norm deviation past which a load logs a warning. Producer vectors are unit
 * length up to six-decimal rounding (measured drift below 1e-6); a deviation
 * past this means the producer skipped or misordered normalization. The vector
 * is normalized either way.
 */
const NORM_TOLERANCE = 1e-4;

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
      `Fleet catalog loaded: ${payload.servers.length} servers, ${this._index.toolVectors.length / this._index.dims} tools ` +
        `(model=${payload.embeddingModel}, dims=${payload.embeddingDims}, generatedAt=${payload.generatedAt})`,
    );

    /**
     * Eager warm-up: load the embedding model synchronously inside the setup
     * window. `pipeline()` must run before `@opentelemetry/instrumentation-http`
     * monkey-patches fetch — once the OTEL wrap is active, transformers.js
     * cannot complete the cold-cache model download from any later context
     * (verified against `Unable to get model file path or buffer` in 0.1.6 and
     * 0.1.7). `embedQuery` triggers the runtime's lazy `_ensureLoaded`, so the
     * model is fetched once here and stays warm for the process lifetime.
     */
    await this._embeddings.embedQuery(
      'warmup',
      this._index.dims,
      this._index.payload.embeddingQueryPrefix,
    );

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

  /**
   * The remote catalog is generated outside this repo and does not include the
   * discovery front door itself, so both name lookups fall back to the
   * server-local self record. The remote index is always consulted first: if the
   * generator ever starts emitting an exact or unique case-folded entry, that
   * entry wins on every request and the fallback becomes unreachable — no
   * duplication, no stale local metadata masking the real record. The static
   * record also survives `_maybeRefresh()`'s atomic index swap by construction,
   * since it is never part of `this._index`.
   *
   * Same-spelling tools under different servers are separate rows, so a name
   * can have several owners. Every candidate is returned in payload order and
   * the caller decides; `server` narrows to one owner's rows.
   */
  getTool(name: string, server?: string): CatalogToolEntry[] {
    const index = this._assertInitialized();
    const folded = name.toLowerCase();
    let exact = index.toolsByName.get(name) ?? [];
    let folds = index.toolsByFoldedName.get(folded) ?? [];
    if (server !== undefined) {
      const owner = this.getServer(server);
      if (!owner) return [];
      exact = exact.filter((t) => t.serverRecord === owner);
      folds = folds.filter((t) => t.serverRecord === owner);
      if (!exact.length && !folds.length && owner.name !== SELF_RECORD_NAME) return [];
    }
    if (exact.length) return exact;
    if (folds.length) return new Set(folds.map((t) => t.name)).size === 1 ? folds : [];
    const self = getSelfCatalogTool(folded);
    return self ? [self] : [];
  }

  getServer(name: string): CatalogRecord | null {
    const index = this._assertInitialized();
    const exact = index.serverByName.get(name);
    if (exact) return exact;
    const folded = name.toLowerCase();
    if (index.serverByFoldedName.has(folded)) return index.serverByFoldedName.get(folded) ?? null;
    return folded === SELF_RECORD_NAME ? getSelfCatalogRecord() : null;
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
      toolCount: index.toolVectors.length / index.dims,
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
      throw internalError(
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
    const toolEntries: CatalogToolEntry[] = [];
    const serverByName = new Map<string, CatalogRecord>();
    const serverByFoldedName = new Map<string, CatalogRecord | null>();

    /**
     * Scores are dot products, so each row is packed at unit length. The norm
     * is taken in float64 from the payload values before packing: a non-unit
     * producer vector keeps its direction and scores as a true cosine, and no
     * normalized component can overflow float32. Components are divided by the
     * largest magnitude before squaring, since squaring raw values overflows
     * above ~1e154 and underflows below ~1e-154; any nonzero vector then has a
     * finite, nonzero norm, and only a zero vector cannot be normalized.
     */
    let drifted = 0;
    let maxDrift = 0;
    const driftIdentities: string[] = [];
    const pack = (
      embedding: number[],
      store: Float32Array,
      row: number,
      kind: 'Server' | 'Tool',
      identity: string,
    ) => {
      if (embedding.length !== dims) {
        throw internalError(
          `${kind} "${identity}" embedding has ${embedding.length} dims; expected ${dims}.`,
        );
      }
      let max = 0;
      for (const v of embedding) max = Math.max(max, Math.abs(v));
      if (max === 0) {
        throw internalError(`${kind} "${identity}" embedding cannot be normalized: its norm is 0.`);
      }
      let sumSq = 0;
      for (const v of embedding) sumSq += (v / max) ** 2;
      const scaledNorm = Math.sqrt(sumSq);
      const drift = Math.abs(max * scaledNorm - 1);
      if (drift > NORM_TOLERANCE) {
        drifted++;
        maxDrift = Math.max(maxDrift, drift);
        if (driftIdentities.length < 10) driftIdentities.push(identity.slice(0, 160));
      }
      const offset = row * dims;
      // biome-ignore lint/style/noNonNullAssertion: bounds enforced by the dims check above
      for (let i = 0; i < dims; i++) store[offset + i] = embedding[i]! / max / scaledNorm;
    };

    let toolI = 0;
    for (const [si, server] of payload.servers.entries()) {
      if (server.name.includes('_')) {
        throw internalError(
          `Server name "${server.name}" contains underscores. Fleet naming convention requires hyphenated server names.`,
        );
      }

      pack(server.embedding, serverVectors, si, 'Server', server.name);
      serverByName.set(server.name, server);
      const serverFold = server.name.toLowerCase();
      serverByFoldedName.set(serverFold, serverByFoldedName.has(serverFold) ? null : server);

      for (const tool of server.tools) {
        pack(tool.embedding, toolVectors, toolI, 'Tool', `${server.name}/${tool.name}`);
        toolEntries.push({ ...tool, serverRecord: server });
        toolI++;
      }
    }

    if (drifted) {
      logger.warning(
        `Normalized ${drifted} catalog vectors whose norm deviates from 1 by more than ${NORM_TOLERANCE} ` +
          `(largest deviation ${maxDrift.toPrecision(4)}): ${JSON.stringify(driftIdentities)}`,
      );
    }

    return {
      payload,
      serverVectors,
      toolVectors,
      toolsByName: Map.groupBy(toolEntries, (t) => t.name),
      serverByName,
      toolsByFoldedName: Map.groupBy(toolEntries, (t) => t.name.toLowerCase()),
      serverByFoldedName,
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
        `Catalog refreshed: ${payload.servers.length} servers, ${next.toolVectors.length / next.dims} tools (generatedAt=${payload.generatedAt})`,
      );
    } catch (err) {
      logger.warning(
        `Catalog refresh failed; keeping last-known state. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private _assertInitialized(): CatalogIndex {
    if (!this._index) {
      /**
       * `retryable` rides the error data, not just the tools' declared
       * `errors[]` entry: the framework renders `data.retryable` into the
       * `content[]` trailer and clients branch on it there. Both tools
       * advertise this reason as retryable, so the throw has to say so.
       */
      throw serviceUnavailable('CatalogService not initialized — call initialize() in setup()', {
        reason: 'catalog_empty',
        retryable: true,
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
// Init
// ---------------------------------------------------------------------------

/**
 * Construct the service and install it as the process-wide instance. The
 * accessor itself lives in `service-instance.ts` — see that module for why.
 */
export function initCatalogService(
  config: CatalogServiceConfig,
  embeddings?: IEmbeddingsRuntime,
): void {
  setCatalogService(new CatalogService(config, embeddings));
}
