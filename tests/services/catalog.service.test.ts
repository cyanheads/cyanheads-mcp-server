/**
 * @fileoverview Tests for CatalogService and RemoteJsonCatalogProvider.
 * Mocks globalThis.fetch and injects a deterministic embeddings runtime — no
 * live network or model loading.
 * @module tests/services/catalog.service.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import type { IEmbeddingsRuntime } from '@/services/catalog/embeddings-runtime.js';
import type { FleetPayload } from '@/services/catalog/types.js';

// ---------------------------------------------------------------------------
// Deterministic test vectors (4-dim, L2-normalized basis vectors)
// ---------------------------------------------------------------------------

const E0 = [1, 0, 0, 0];
const E1 = [0, 1, 0, 0];
const E2 = [0, 0, 1, 0];
const E3 = [0, 0, 0, 1];

const TEST_MODEL = 'test/mock-embed-v1';

const MINIMAL_PAYLOAD: FleetPayload = {
  version: '2',
  generatedAt: '2026-05-28T00:00:00Z',
  embeddingModel: TEST_MODEL,
  embeddingDims: 4,
  embeddingQueryPrefix: 'Q: ',
  servers: [
    {
      name: 'earthquake-mcp-server',
      displayName: 'Earthquake',
      description: 'Search USGS seismic data.',
      category: 'public-data',
      endpoint: 'https://earthquake.caseyjhand.com/mcp',
      npm: '@cyanheads/earthquake-mcp-server',
      github: 'https://github.com/cyanheads/earthquake-mcp-server',
      version: '0.2.1',
      auth: 'none',
      embedding: E0,
      tools: [
        {
          name: 'earthquake_search',
          description: 'Query seismic events by location and magnitude.',
          embedding: E0,
        },
        {
          name: 'earthquake_get_feed',
          description: 'Fetch real-time USGS earthquake feed.',
          embedding: E2,
        },
      ],
    },
    {
      name: 'arxiv-mcp-server',
      displayName: 'arXiv',
      description: 'Search arXiv papers and fetch full-text content.',
      category: 'research',
      endpoint: 'https://arxiv.caseyjhand.com/mcp',
      npm: '@cyanheads/arxiv-mcp-server',
      github: 'https://github.com/cyanheads/arxiv-mcp-server',
      version: '1.2.7',
      auth: 'none',
      embedding: E1,
      tools: [
        {
          name: 'arxiv_search',
          description: 'Search arXiv papers by query.',
          embedding: E1,
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Config + mocks
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  catalogUrl: 'https://test.example.com/fleet.json',
  catalogFetchTimeoutMs: 5000,
  catalogRefreshSeconds: 0, // disable background refresh in tests
  embeddingModelId: TEST_MODEL,
  similarityFloor: 0.3,
};

/**
 * Mock embeddings runtime that returns a pre-set vector per query string.
 * Pass a map keyed by the QUERY TEXT (without the prefix); the runtime
 * normalizes the vector before returning.
 */
function makeMockEmbeddings(
  vectors: Record<string, number[]>,
  fallback: number[] = E3,
): IEmbeddingsRuntime {
  return {
    modelId: TEST_MODEL,
    async embedQuery(text: string, dims: number) {
      const raw = vectors[text] ?? fallback;
      let sumSq = 0;
      for (const v of raw) sumSq += v * v;
      const norm = sumSq === 0 ? 1 : Math.sqrt(sumSq);
      const out = new Float32Array(dims);
      for (let i = 0; i < dims; i++) out[i] = (raw[i] ?? 0) / norm;
      return out;
    },
  };
}

function mockFetchOk(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(payload),
    }),
  );
}

function mockFetchStatus(status: number, statusText: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText,
      json: () => Promise.reject(new Error('body not available')),
    }),
  );
}

function mockFetchReject(err: Error): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
}

function mockFetchBadJson(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    }),
  );
}

// ---------------------------------------------------------------------------
// CatalogService — initialize()
// ---------------------------------------------------------------------------

describe('CatalogService', () => {
  let service: CatalogService;

  beforeEach(() => {
    service = new CatalogService(TEST_CONFIG, makeMockEmbeddings({}));
  });

  afterEach(() => {
    service.shutdown();
    vi.restoreAllMocks();
  });

  describe('initialize() — happy path', () => {
    it('populates servers and tools from the remote payload', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();
      const stats = service.stats();
      expect(stats.serverCount).toBe(2);
      expect(stats.toolCount).toBe(3);
      expect(stats.embeddingModel).toBe(TEST_MODEL);
      expect(typeof stats.initializedAt).toBe('string');
    });

    it('indexes tools with serverRecord pointers', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();
      const tool = service.getTool('earthquake_search');
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe('earthquake_search');
      expect(tool!.serverRecord.name).toBe('earthquake-mcp-server');
    });
  });

  describe('initialize() — failure cases', () => {
    it('throws on network rejection', async () => {
      mockFetchReject(new TypeError('Failed to fetch'));
      await expect(service.initialize()).rejects.toThrow('Catalog fetch failed');
    });

    it('throws on non-2xx HTTP response', async () => {
      mockFetchStatus(503, 'Service Unavailable');
      await expect(service.initialize()).rejects.toThrow('503');
    });

    it('throws on JSON parse failure', async () => {
      mockFetchBadJson();
      await expect(service.initialize()).rejects.toThrow('not valid JSON');
    });

    it('throws on Zod validation failure (missing required field)', async () => {
      mockFetchOk({
        version: '2',
        generatedAt: '2026-05-28T00:00:00Z',
        embeddingModel: TEST_MODEL,
        embeddingDims: 4,
        embeddingQueryPrefix: 'Q: ',
        servers: [{ name: 'missing-fields-server' }],
      });
      await expect(service.initialize()).rejects.toThrow('validation');
    });

    it('throws on wrong embedding model id', async () => {
      mockFetchOk({
        ...MINIMAL_PAYLOAD,
        embeddingModel: 'different/model-id',
      });
      await expect(service.initialize()).rejects.toThrow('mismatch');
    });

    it('throws when payload version is not "2"', async () => {
      mockFetchOk({ ...MINIMAL_PAYLOAD, version: '1' });
      await expect(service.initialize()).rejects.toThrow('validation');
    });

    it('throws when server name contains underscores', async () => {
      mockFetchOk({
        ...MINIMAL_PAYLOAD,
        servers: [
          {
            ...MINIMAL_PAYLOAD.servers[0],
            name: 'bad_server_name',
          },
        ],
      });
      await expect(service.initialize()).rejects.toThrow('underscores');
    });

    it('throws when embedding dims do not match', async () => {
      mockFetchOk({
        ...MINIMAL_PAYLOAD,
        servers: [
          {
            ...MINIMAL_PAYLOAD.servers[0],
            embedding: [1, 0, 0], // 3 dims but payload declares 4
          },
        ],
      });
      await expect(service.initialize()).rejects.toThrow('dims');
    });
  });

  describe('search() — semantic ranking', () => {
    it('ranks tools by cosine similarity to the query vector', async () => {
      const embeddings = makeMockEmbeddings({ 'earthquake activity': E0 });
      service = new CatalogService(TEST_CONFIG, embeddings);
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();

      const results = await service.search({
        query: 'earthquake activity',
        scope: 'tools',
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
      // E0-aligned tool (earthquake_search) should rank first.
      expect(results[0].name).toBe('earthquake_search');
      expect(results[0].score).toBeGreaterThan(0.9);
      // E2-aligned tool (earthquake_get_feed) is orthogonal → filtered by floor 0.3.
      expect(results.find((r) => r.name === 'earthquake_get_feed')).toBeUndefined();
    });

    it('returns server-level results when scope is "servers"', async () => {
      const embeddings = makeMockEmbeddings({ 'arxiv research': E1 });
      service = new CatalogService(TEST_CONFIG, embeddings);
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();

      const results = await service.search({
        query: 'arxiv research',
        scope: 'servers',
        limit: 5,
      });

      expect(results[0].name).toBe('arxiv-mcp-server');
      expect(results[0].server).toBe('arxiv-mcp-server');
      expect(results[0].score).toBeGreaterThan(0.9);
    });

    it('returns empty when every score is below the similarity floor', async () => {
      const embeddings = makeMockEmbeddings({ unrelated: E3 });
      service = new CatalogService(TEST_CONFIG, embeddings);
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();

      const results = await service.search({
        query: 'unrelated',
        scope: 'tools',
        limit: 5,
      });

      expect(results).toHaveLength(0);
    });

    it('filters by category', async () => {
      const embeddings = makeMockEmbeddings({ generic: [0.5, 0.5, 0, 0] });
      service = new CatalogService(TEST_CONFIG, embeddings);
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();

      const results = await service.search({
        query: 'generic',
        scope: 'servers',
        category: 'research',
        limit: 5,
      });

      for (const r of results) {
        expect(r.category).toBe('research');
      }
    });

    it('respects the limit parameter', async () => {
      const embeddings = makeMockEmbeddings({ broad: [0.5, 0.5, 0.5, 0.5] });
      service = new CatalogService(TEST_CONFIG, embeddings);
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();

      const results = await service.search({
        query: 'broad',
        scope: 'tools',
        limit: 1,
      });
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('lookups', () => {
    beforeEach(async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();
    });

    it('returns the server record for a known server', () => {
      const record = service.getServer('earthquake-mcp-server');
      expect(record).not.toBeNull();
      expect(record!.npm).toBe('@cyanheads/earthquake-mcp-server');
    });

    it('returns null for an unknown server', () => {
      expect(service.getServer('unknown-server')).toBeNull();
    });

    it('returns null for an unknown tool', () => {
      expect(service.getTool('nonexistent_tool')).toBeNull();
    });

    it('listCategories returns sorted unique categories', () => {
      const cats = service.listCategories();
      expect(cats).toContain('public-data');
      expect(cats).toContain('research');
      for (let i = 1; i < cats.length; i++) {
        expect(cats[i].localeCompare(cats[i - 1])).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('uninitialized state', () => {
    it('throws serviceUnavailable before initialize() is called', () => {
      expect(() => service.getTool('foo')).toThrow();
    });
  });

  describe('background refresh', () => {
    const REFRESH_CONFIG = { ...TEST_CONFIG, catalogRefreshSeconds: 1 };

    beforeEach(() => {
      vi.useFakeTimers();
      service.shutdown();
      service = new CatalogService(REFRESH_CONFIG, makeMockEmbeddings({}));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('swaps the index when generatedAt changes', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();
      expect(service.stats().serverCount).toBe(2);

      const updated: FleetPayload = {
        ...MINIMAL_PAYLOAD,
        generatedAt: '2026-05-29T00:00:00Z',
        servers: [MINIMAL_PAYLOAD.servers[0]!],
      };
      mockFetchOk(updated);

      await vi.advanceTimersByTimeAsync(1100);
      expect(service.stats().serverCount).toBe(1);
    });

    it('keeps the old index when generatedAt is unchanged', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();
      const initial = service.stats().initializedAt;

      // Same generatedAt — refresh should no-op.
      mockFetchOk(MINIMAL_PAYLOAD);
      await vi.advanceTimersByTimeAsync(1100);

      expect(service.stats().initializedAt).toBe(initial);
      expect(service.stats().serverCount).toBe(2);
    });

    it('keeps the old index when the refreshed payload declares a different model', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();

      mockFetchOk({
        ...MINIMAL_PAYLOAD,
        generatedAt: '2026-05-29T00:00:00Z',
        embeddingModel: 'different/model-v2',
      });

      await vi.advanceTimersByTimeAsync(1100);
      // Old state preserved — model mismatch refuses the swap.
      expect(service.stats().embeddingModel).toBe(TEST_MODEL);
      expect(service.stats().serverCount).toBe(2);
    });

    it('keeps the old index when the background fetch fails', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();

      mockFetchReject(new TypeError('network down'));
      await vi.advanceTimersByTimeAsync(1100);

      expect(service.stats().serverCount).toBe(2);
    });
  });
});
