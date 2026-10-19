/**
 * @fileoverview Tests for CatalogService and RemoteJsonCatalogProvider.
 * Mocks globalThis.fetch and injects a deterministic embeddings runtime — no
 * live network or model loading.
 * @module tests/services/catalog.service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import type { IEmbeddingsRuntime } from '@/services/catalog/embeddings-runtime.js';
import type { CatalogRecord, FleetPayload } from '@/services/catalog/types.js';

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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status, statusText })));
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
      const candidates = service.getTool('earthquake_search');
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.name).toBe('earthquake_search');
      expect(candidates[0]!.serverRecord.name).toBe('earthquake-mcp-server');
    });
  });

  describe('initialize() — failure cases', () => {
    it('throws on network rejection', async () => {
      mockFetchReject(new TypeError('Failed to fetch'));
      await expect(service.initialize()).rejects.toThrow('Network error during');
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
      expect(results[0]!.name).toBe('earthquake_search');
      expect(results[0]!.score).toBeGreaterThan(0.9);
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

      expect(results[0]!.name).toBe('arxiv-mcp-server');
      expect(results[0]!.server).toBe('arxiv-mcp-server');
      expect(results[0]!.score).toBeGreaterThan(0.9);
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

    it('returns no candidate for an unknown tool', () => {
      expect(service.getTool('nonexistent_tool')).toEqual([]);
    });

    it('falls back to the self record for this server, absent from the remote payload', () => {
      expect(MINIMAL_PAYLOAD.servers.some((s) => s.name === 'cyanheads-mcp-server')).toBe(false);

      const record = service.getServer('cyanheads-mcp-server');
      expect(record).not.toBeNull();
      expect(record!.npm).toBe('@cyanheads/cyanheads-mcp-server');
      expect(record!.endpoint).toBe('https://cyanheads.caseyjhand.com/mcp');
      expect(record!.tools.map((t) => t.name)).toEqual([
        'cyanheads_search_catalog',
        'cyanheads_describe_entry',
      ]);
    });

    it('falls back to the self record for this server’s own tools', () => {
      for (const name of ['cyanheads_search_catalog', 'cyanheads_describe_entry']) {
        for (const server of [undefined, 'cyanheads-mcp-server', 'CYANHEADS-MCP-SERVER']) {
          const candidates = service.getTool(name, server);
          expect(candidates).toHaveLength(1);
          expect(candidates[0]!.name).toBe(name);
          expect(candidates[0]!.serverRecord.name).toBe('cyanheads-mcp-server');
        }
      }
    });

    it('keeps the self record out of search, stats, and the vector index', async () => {
      expect(service.stats().serverCount).toBe(MINIMAL_PAYLOAD.servers.length);
      expect(service.stats().toolCount).toBe(3);

      // Every scope, every category — the static record is never a search candidate.
      for (const scope of ['tools', 'servers'] as const) {
        const results = await service.search({ query: 'anything at all', scope });
        expect(results.some((r) => r.name.startsWith('cyanheads'))).toBe(false);
      }
    });

    it('listCategories returns sorted unique categories', () => {
      const cats = service.listCategories();
      expect(cats).toContain('public-data');
      expect(cats).toContain('research');
      for (let i = 1; i < cats.length; i++) {
        expect(cats[i]!.localeCompare(cats[i - 1]!)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('self-record precedence', () => {
    /**
     * The remote catalog is generated outside this repo and currently omits this
     * server. Should the generator start emitting it, the remote entry must take
     * precedence — the fallback then becomes unreachable rather than shadowing
     * or duplicating the real record.
     */
    const PAYLOAD_WITH_SELF: FleetPayload = {
      ...MINIMAL_PAYLOAD,
      servers: [
        ...MINIMAL_PAYLOAD.servers,
        {
          name: 'cyanheads-mcp-server',
          displayName: 'Cyanheads Discovery',
          description: 'Remote-catalog description.',
          category: 'utility',
          endpoint: 'https://remote.example.com/mcp',
          npm: '@cyanheads/cyanheads-mcp-server',
          github: 'https://github.com/cyanheads/cyanheads-mcp-server',
          version: '99.0.0',
          auth: 'none',
          embedding: E1,
          tools: [
            {
              name: 'cyanheads_search_catalog',
              description: 'Remote-catalog tool description.',
              embedding: E1,
            },
          ],
        },
      ],
    };

    it('prefers a remote server entry over the fallback', async () => {
      mockFetchOk(PAYLOAD_WITH_SELF);
      await service.initialize();

      const record = service.getServer('cyanheads-mcp-server');
      expect(record!.displayName).toBe('Cyanheads Discovery');
      expect(record!.version).toBe('99.0.0');
      expect(record!.endpoint).toBe('https://remote.example.com/mcp');
      expect(service.stats().serverCount).toBe(3);
    });

    it('prefers a remote tool entry over the fallback', async () => {
      mockFetchOk(PAYLOAD_WITH_SELF);
      await service.initialize();

      for (const server of [undefined, 'cyanheads-mcp-server']) {
        const candidates = service.getTool('cyanheads_search_catalog', server);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.description).toBe('Remote-catalog tool description.');
        expect(candidates[0]!.serverRecord.version).toBe('99.0.0');
      }
    });

    it('still falls back for a tool the remote entry omits, with or without server', async () => {
      mockFetchOk(PAYLOAD_WITH_SELF);
      await service.initialize();

      for (const server of [undefined, 'cyanheads-mcp-server']) {
        const candidates = service.getTool('cyanheads_describe_entry', server);
        expect(
          candidates.map((t) => [t.name, t.serverRecord.name, t.serverRecord.endpoint]),
        ).toEqual([
          [
            'cyanheads_describe_entry',
            'cyanheads-mcp-server',
            'https://cyanheads.caseyjhand.com/mcp',
          ],
        ]);
      }
    });

    it('re-resolves precedence after a background refresh adds the remote entry', async () => {
      vi.useFakeTimers();
      service.shutdown();
      service = new CatalogService(
        { ...TEST_CONFIG, catalogRefreshSeconds: 1 },
        makeMockEmbeddings({}),
      );

      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();
      expect(service.getServer('cyanheads-mcp-server')!.version).not.toBe('99.0.0');

      mockFetchOk({ ...PAYLOAD_WITH_SELF, generatedAt: '2026-05-29T00:00:00Z' });
      await vi.advanceTimersByTimeAsync(1100);

      expect(service.getServer('cyanheads-mcp-server')!.version).toBe('99.0.0');
      vi.useRealTimers();
    });
  });

  describe('owner-aware tool lookups', () => {
    const [quake, arxiv] = MINIMAL_PAYLOAD.servers as [CatalogRecord, CatalogRecord];
    const shadow = { ...quake.tools[0]!, description: 'Shadow copy owned by arxiv-mcp-server.' };
    const owners = (rows: { serverRecord: CatalogRecord }[]) =>
      rows.map((r) => r.serverRecord.name);

    /** Both servers own earthquake_search; the copy's owner sits later or earlier in payload order. */
    function shared(order: 'later' | 'earlier', generatedAt = MINIMAL_PAYLOAD.generatedAt) {
      const withCopy = { ...arxiv, tools: [...arxiv.tools, shadow] };
      return {
        ...MINIMAL_PAYLOAD,
        generatedAt,
        servers: order === 'later' ? [quake, withCopy] : [withCopy, quake],
      } satisfies FleetPayload;
    }

    it.each(['later', 'earlier'] as const)(
      'returns every owner of a shared name in payload order (copy %s)',
      async (order) => {
        mockFetchOk(shared(order));
        await service.initialize();
        const expected =
          order === 'later'
            ? ['earthquake-mcp-server', 'arxiv-mcp-server']
            : ['arxiv-mcp-server', 'earthquake-mcp-server'];
        for (const name of ['earthquake_search', 'EARTHQUAKE_SEARCH']) {
          const candidates = service.getTool(name);
          expect(owners(candidates)).toEqual(expected);
          expect(candidates.map((t) => t.name)).toEqual(['earthquake_search', 'earthquake_search']);
        }
      },
    );

    it('narrows to the named owner by exact name, then unique case-fold', async () => {
      mockFetchOk(shared('later'));
      await service.initialize();
      const arxivRecord = service.getServer('arxiv-mcp-server')!;
      for (const name of ['earthquake_search', 'Earthquake_Search']) {
        for (const server of ['arxiv-mcp-server', 'ARXIV-MCP-SERVER']) {
          expect(service.getTool(name, server)).toEqual([{ ...shadow, serverRecord: arxivRecord }]);
        }
      }
      expect(
        service.getTool('earthquake_search', 'earthquake-mcp-server').map((t) => t.description),
      ).toEqual([quake.tools[0]!.description]);
    });

    it('returns no candidate for an unknown server or one that does not own the name', async () => {
      mockFetchOk(shared('later'));
      await service.initialize();
      expect(service.getTool('earthquake_search', 'nonexistent-mcp-server')).toEqual([]);
      expect(service.getTool('arxiv_search', 'earthquake-mcp-server')).toEqual([]);
      expect(service.getTool('cyanheads_search_catalog', 'earthquake-mcp-server')).toEqual([]);
    });

    it('leaves differing-spelling folds unresolved without server and resolves them with it', async () => {
      mockFetchOk({
        ...MINIMAL_PAYLOAD,
        servers: [quake, { ...arxiv, tools: [{ ...shadow, name: 'EARTHQUAKE_SEARCH' }] }],
      });
      await service.initialize();
      expect(service.getTool('Earthquake_Search')).toEqual([]);
      expect(owners(service.getTool('earthquake_search'))).toEqual(['earthquake-mcp-server']);
      expect(owners(service.getTool('EARTHQUAKE_SEARCH'))).toEqual(['arxiv-mcp-server']);
      expect(service.getTool('Earthquake_Search', 'arxiv-mcp-server').map((t) => t.name)).toEqual([
        'EARTHQUAKE_SEARCH',
      ]);
    });

    it('keeps a remote self-tool name winning bare lookups while server reaches the self tool', async () => {
      mockFetchOk({
        ...MINIMAL_PAYLOAD,
        servers: [quake, { ...arxiv, tools: [{ ...shadow, name: 'cyanheads_describe_entry' }] }],
      });
      await service.initialize();
      expect(owners(service.getTool('cyanheads_describe_entry'))).toEqual(['arxiv-mcp-server']);
      expect(owners(service.getTool('cyanheads_describe_entry', 'cyanheads-mcp-server'))).toEqual([
        'cyanheads-mcp-server',
      ]);
    });

    it('rebuilds lookups on refresh and keeps them when a refresh is rejected', async () => {
      vi.useFakeTimers();
      service.shutdown();
      service = new CatalogService(
        { ...TEST_CONFIG, catalogRefreshSeconds: 1 },
        makeMockEmbeddings({}),
      );
      try {
        mockFetchOk(MINIMAL_PAYLOAD);
        await service.initialize();
        expect(owners(service.getTool('earthquake_search'))).toEqual(['earthquake-mcp-server']);

        mockFetchOk(shared('later', '2026-05-29T00:00:00Z'));
        await vi.advanceTimersByTimeAsync(1100);
        expect(owners(service.getTool('earthquake_search'))).toEqual([
          'earthquake-mcp-server',
          'arxiv-mcp-server',
        ]);

        const rejected = shared('earlier', '2026-05-30T00:00:00Z');
        rejected.servers[0] = { ...rejected.servers[0]!, embedding: [0, 0, 0, 0] };
        mockFetchOk(rejected);
        await vi.advanceTimersByTimeAsync(1100);
        expect(owners(service.getTool('earthquake_search'))).toEqual([
          'earthquake-mcp-server',
          'arxiv-mcp-server',
        ]);
        expect(service.getTool('earthquake_search', 'arxiv-mcp-server')[0]!.description).toBe(
          shadow.description,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('uninitialized state', () => {
    it('throws serviceUnavailable before initialize() is called', () => {
      expect(() => service.getTool('foo')).toThrow();
    });

    /**
     * Both tools advertise `catalog_empty` as retryable. The framework renders
     * `data.retryable` into the `content[]` trailer, so the throw itself has to
     * carry it — the declared `errors[]` entry alone never reaches the wire.
     */
    it.each(['getTool', 'getServer', 'listCategories', 'stats'] as const)(
      '%s() throws catalog_empty marked retryable',
      (method) => {
        let thrown: unknown;
        try {
          (service[method] as (name?: string) => unknown)('foo');
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'catalog_empty', retryable: true },
        });
      },
    );

    it('search() rejects with the same retryable catalog_empty contract', async () => {
      await expect(service.search({ query: 'anything', scope: 'tools' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'catalog_empty', retryable: true },
      });
    });
  });

  describe('shutdown()', () => {
    /**
     * `createApp({ teardown })` calls this on every shutdown path. If the
     * interval survived, the process would keep a ref'd handle the framework
     * cuts rather than releases.
     */
    it('stops the background refresh timer', async () => {
      vi.useFakeTimers();
      service.shutdown();
      service = new CatalogService(
        { ...TEST_CONFIG, catalogRefreshSeconds: 1 },
        makeMockEmbeddings({}),
      );

      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();

      service.shutdown();

      mockFetchOk({ ...MINIMAL_PAYLOAD, generatedAt: '2026-05-29T00:00:00Z', servers: [] });
      await vi.advanceTimersByTimeAsync(5000);

      // The swap never ran: the timer was cleared, not merely skipped.
      expect(service.stats().serverCount).toBe(2);
      vi.useRealTimers();
    });

    it('is idempotent', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      await service.initialize();
      expect(() => {
        service.shutdown();
        service.shutdown();
      }).not.toThrow();
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

  describe('vector normalization', () => {
    const UNIT = [0.6, 0.8, 0, 0];
    const COSINE = 1.4 / Math.SQRT2; // UNIT · normalize([1, 1, 0, 0])
    const scaled = (v: number[], s: number) => v.map((x) => x * s);
    const queries = { mixed: [1, 1, 0, 0], quake: E0, arxiv: E1 };

    /** MINIMAL_PAYLOAD with the earthquake server vector and its earthquake_search vector replaced. */
    function withEarthquakeVectors(
      serverVec: number[],
      toolVec: number[],
      generatedAt = MINIMAL_PAYLOAD.generatedAt,
    ): FleetPayload {
      const [quake, arxiv] = MINIMAL_PAYLOAD.servers;
      return {
        ...MINIMAL_PAYLOAD,
        generatedAt,
        servers: [
          {
            ...quake!,
            embedding: serverVec,
            tools: [{ ...quake!.tools[0]!, embedding: toolVec }, quake!.tools[1]!],
          },
          arxiv!,
        ],
      };
    }

    const UNNORMALIZABLE = [
      {
        defect: 'zero-norm tool vector',
        server: E0,
        tool: [0, 0, 0, 0],
        message:
          'Tool "earthquake-mcp-server/earthquake_search" embedding cannot be normalized: its norm is 0.',
      },
      {
        defect: 'zero-norm server vector',
        server: [0, 0, 0, 0],
        tool: E0,
        message: 'Server "earthquake-mcp-server" embedding cannot be normalized: its norm is 0.',
      },
      {
        defect: 'non-finite tool vector component',
        server: E0,
        tool: [Number.POSITIVE_INFINITY, 0, 0, 0],
        message:
          'Catalog payload failed validation at servers.0.tools.0.embedding.0: Invalid input: expected number, received Infinity',
      },
      {
        defect: 'non-finite server vector component',
        server: [Number.NaN, 0, 0, 0],
        tool: E0,
        message:
          'Catalog payload failed validation at servers.0.embedding.0: Invalid input: expected number, received NaN',
      },
      {
        defect: 'wrong-dimension tool vector',
        server: E0,
        tool: [1, 0, 0],
        message: 'Tool "earthquake-mcp-server/earthquake_search" embedding has 3 dims; expected 4.',
      },
      {
        defect: 'wrong-dimension server vector',
        server: [1, 0, 0],
        tool: E0,
        message: 'Server "earthquake-mcp-server" embedding has 3 dims; expected 4.',
      },
    ];

    // 1e200 and 1e-200 square past float64 range; 1e-160 squares into subnormals.
    it.each([10, 0.1, 1e200, 1e-160, 1e-200])(
      'scores tool and server vectors scaled ×%s as the cosine of their direction',
      async (s) => {
        service = new CatalogService(TEST_CONFIG, makeMockEmbeddings(queries));
        mockFetchOk(withEarthquakeVectors(scaled(UNIT, s), scaled(UNIT, s)));
        await service.initialize();

        const tools = await service.search({ query: 'mixed', scope: 'tools' });
        expect(tools.find((r) => r.name === 'earthquake_search')?.score).toBeCloseTo(COSINE, 6);
        const servers = await service.search({ query: 'mixed', scope: 'servers' });
        expect(servers.find((r) => r.name === 'earthquake-mcp-server')?.score).toBeCloseTo(
          COSINE,
          6,
        );

        // A scaled server vector no longer outranks the server the query is about.
        const ranked = await service.search({ query: 'arxiv', scope: 'servers' });
        expect(ranked.map((r) => r.name)).toEqual(['arxiv-mcp-server', 'earthquake-mcp-server']);
        expect(ranked[1]!.score).toBeCloseTo(0.8, 6);
      },
    );

    it('packs float32-overflow components as finite unit rows', async () => {
      service = new CatalogService(TEST_CONFIG, makeMockEmbeddings(queries));
      mockFetchOk(withEarthquakeVectors([1e39, 0, 0, 0], [1e39, 1, 0, 0]));
      await service.initialize();

      for (const query of Object.keys(queries)) {
        for (const scope of ['tools', 'servers'] as const) {
          const rows = await service.search({ query, scope });
          expect(rows.every((r) => Number.isFinite(r.score))).toBe(true);
        }
      }
      const [top] = await service.search({ query: 'quake', scope: 'tools' });
      expect(top).toMatchObject({ name: 'earthquake_search', server: 'earthquake-mcp-server' });
      expect(top!.score).toBeCloseTo(1, 6);
    });

    it('normalizes drift within tolerance without a warning', async () => {
      const warning = vi.spyOn(logger, 'warning');
      service = new CatalogService(TEST_CONFIG, makeMockEmbeddings(queries));
      mockFetchOk(withEarthquakeVectors([1 + 5e-5, 0, 0, 0], [1 - 5e-5, 0, 0, 0]));
      await service.initialize();

      expect(warning).not.toHaveBeenCalled();
      const [tool] = await service.search({ query: 'quake', scope: 'tools' });
      expect(tool!.score).toBeCloseTo(1, 6);
      const [server] = await service.search({ query: 'quake', scope: 'servers' });
      expect(server!.score).toBeCloseTo(1, 6);
    });

    it('warns for drift just past tolerance', async () => {
      const warning = vi.spyOn(logger, 'warning');
      mockFetchOk(withEarthquakeVectors(E0, [1 + 2e-4, 0, 0, 0]));
      await service.initialize();
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'Normalized 1 catalog vectors whose norm deviates from 1 by more than 0.0001 (largest deviation 0.0002000): ["earthquake-mcp-server/earthquake_search"]',
      );
    });

    it('logs one bounded warning naming at most ten drifting vectors', async () => {
      const warning = vi.spyOn(logger, 'warning');
      const [quake, arxiv] = MINIMAL_PAYLOAD.servers;
      const tools = Array.from({ length: 12 }, (_, i) => ({
        name: `drift_${String(i).padStart(2, '0')}`,
        description: 'Drifting vector.',
        embedding: [2, 0, 0, 0],
      }));
      mockFetchOk({
        ...MINIMAL_PAYLOAD,
        servers: [{ ...quake!, embedding: [0, 0.5, 0, 0], tools }, arxiv!],
      });
      await service.initialize();

      expect(warning).toHaveBeenCalledOnce();
      const message = warning.mock.calls[0]![0];
      expect(message.slice(0, message.indexOf('['))).toBe(
        'Normalized 13 catalog vectors whose norm deviates from 1 by more than 0.0001 (largest deviation 1.000): ',
      );
      expect(JSON.parse(message.slice(message.indexOf('[')))).toEqual([
        'earthquake-mcp-server',
        ...tools.slice(0, 9).map((t) => `earthquake-mcp-server/${t.name}`),
      ]);
    });

    it.each(UNNORMALIZABLE)(
      'rejects a startup payload with a $defect',
      async ({ server, tool, message }) => {
        mockFetchOk(withEarthquakeVectors(server, tool));
        await expect(service.initialize()).rejects.toThrow(message);
      },
    );

    describe('on refresh', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        service.shutdown();
        service = new CatalogService(
          { ...TEST_CONFIG, catalogRefreshSeconds: 1 },
          makeMockEmbeddings(queries),
        );
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('normalizes a scaled refresh payload before the swap', async () => {
        mockFetchOk(MINIMAL_PAYLOAD);
        await service.initialize();
        const initial = service.stats().initializedAt;

        mockFetchOk(
          withEarthquakeVectors(scaled(UNIT, 10), scaled(UNIT, 10), '2026-05-29T00:00:00Z'),
        );
        await vi.advanceTimersByTimeAsync(1100);

        expect(service.stats().initializedAt).not.toBe(initial);
        const tools = await service.search({ query: 'mixed', scope: 'tools' });
        expect(tools.find((r) => r.name === 'earthquake_search')?.score).toBeCloseTo(COSINE, 6);
        const servers = await service.search({ query: 'mixed', scope: 'servers' });
        expect(servers.find((r) => r.name === 'earthquake-mcp-server')?.score).toBeCloseTo(
          COSINE,
          6,
        );
      });

      it('normalizes a refresh payload whose squared components leave float64 range', async () => {
        mockFetchOk(MINIMAL_PAYLOAD);
        await service.initialize();

        mockFetchOk(
          withEarthquakeVectors(scaled(UNIT, 1e200), scaled(UNIT, 1e-200), '2026-05-29T00:00:00Z'),
        );
        await vi.advanceTimersByTimeAsync(1100);

        const tools = await service.search({ query: 'mixed', scope: 'tools' });
        expect(tools.find((r) => r.name === 'earthquake_search')?.score).toBeCloseTo(COSINE, 6);
        const servers = await service.search({ query: 'mixed', scope: 'servers' });
        expect(servers.find((r) => r.name === 'earthquake-mcp-server')?.score).toBeCloseTo(
          COSINE,
          6,
        );
      });

      it.each(UNNORMALIZABLE)(
        'keeps the previous index, stats, and lookups when a refresh carries a $defect',
        async ({ server, tool, message }) => {
          mockFetchOk(MINIMAL_PAYLOAD);
          await service.initialize();
          const stats = service.stats();
          const rows = {
            tools: await service.search({ query: 'quake', scope: 'tools' }),
            servers: await service.search({ query: 'quake', scope: 'servers' }),
          };
          const record = service.getServer('earthquake-mcp-server');
          const warning = vi.spyOn(logger, 'warning');

          mockFetchOk(withEarthquakeVectors(server, tool, '2026-05-29T00:00:00Z'));
          await vi.advanceTimersByTimeAsync(1100);

          expect(service.stats()).toEqual(stats);
          expect(await service.search({ query: 'quake', scope: 'tools' })).toEqual(rows.tools);
          expect(await service.search({ query: 'quake', scope: 'servers' })).toEqual(rows.servers);
          expect(service.getServer('earthquake-mcp-server')).toBe(record);
          expect(warning).toHaveBeenCalledOnce();
          expect(warning.mock.calls[0]![0]).toBe(
            `Catalog refresh failed; keeping last-known state. ${message}`,
          );
        },
      );
    });
  });
});
