/**
 * @fileoverview Tests for the cyanheads_search_catalog tool.
 * Mocks globalThis.fetch and injects a deterministic embeddings runtime — no
 * live network or model loading.
 * @module tests/tools/search-catalog.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCatalogTool } from '@/mcp-server/tools/definitions/search-catalog.tool.js';
import { initCatalogService } from '@/services/catalog/catalog-service.js';
import type { IEmbeddingsRuntime } from '@/services/catalog/embeddings-runtime.js';
import {
  getCatalogService,
  resetCatalogServiceForTests,
} from '@/services/catalog/service-instance.js';
import type { FleetPayload } from '@/services/catalog/types.js';

const TEST_MODEL = 'test/mock-embed-v1';
const E0 = [1, 0, 0, 0];
const E1 = [0, 1, 0, 0];
const E2 = [0.7, 0.7, 0, 0]; // partial overlap with both E0 and E1

const TEST_CONFIG = {
  catalogUrl: 'https://test.example.com/fleet.json',
  catalogFetchTimeoutMs: 5000,
  catalogRefreshSeconds: 0,
  embeddingModelId: TEST_MODEL,
  similarityFloor: 0.3,
};

const FLEET_PAYLOAD: FleetPayload = {
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
          name: 'earthquake_get_event',
          description: 'Fetch a single seismic event by ID.',
          embedding: [0.9, 0.1, 0, 0],
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
    {
      name: 'pubmed-mcp-server',
      displayName: 'PubMed',
      description: 'Search biomedical literature via PubMed.',
      category: 'research',
      endpoint: 'https://pubmed.caseyjhand.com/mcp',
      npm: '@cyanheads/pubmed-mcp-server',
      github: 'https://github.com/cyanheads/pubmed-mcp-server',
      version: '1.0.0',
      auth: 'none',
      embedding: E2,
      tools: [
        {
          name: 'pubmed_search_articles',
          description: 'Search PubMed articles.',
          embedding: E2,
        },
        {
          name: 'pubmed_fetch_articles',
          description: 'Fetch PubMed article details.',
          embedding: E2,
        },
      ],
    },
  ],
};

function makeMockEmbeddings(vectors: Record<string, number[]>): IEmbeddingsRuntime {
  return {
    modelId: TEST_MODEL,
    async initialize() {},
    async embedQuery(text: string, dims: number) {
      const raw = vectors[text] ?? [0, 0, 0, 1];
      let sumSq = 0;
      for (const v of raw) sumSq += v * v;
      const norm = sumSq === 0 ? 1 : Math.sqrt(sumSq);
      const out = new Float32Array(dims);
      for (let i = 0; i < dims; i++) out[i] = (raw[i] ?? 0) / norm;
      return out;
    },
  };
}

describe('cyanheads_search_catalog', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(FLEET_PAYLOAD),
      }),
    );
    const embeddings = makeMockEmbeddings({
      'seismic earthquake activity': E0,
      'arxiv research papers': E1,
      'totally unrelated capability': [0, 0, 0, 1],
      'both research and seismic': [1, 1, 0, 0],
      'broad seismic and research query': [1, 1, 0, 0],
    });
    initCatalogService(TEST_CONFIG, embeddings);
    await getCatalogService().initialize();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('returns ranked tool matches for a query', async () => {
    const ctx = createMockContext();
    const input = searchCatalogTool.input.parse({
      query: 'seismic earthquake activity',
      scope: 'tools',
      limit: 5,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    expect(result.scope).toBe('tools');
    expect(result.results.length).toBeGreaterThan(0);

    // Query echo and total land in enrichment, not the handler return
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('seismic earthquake activity');
    expect(typeof enrichment.totalCount).toBe('number');
    expect(enrichment.totalCount).toBeGreaterThanOrEqual(result.results.length);

    const top = result.results[0];
    expect(top.name).toBe('earthquake_search');
    expect(top.server).toBe('earthquake-mcp-server');
    expect(top.score).toBeGreaterThan(0.9);
    expect(typeof top.brief).toBe('string');
    expect(typeof top.category).toBe('string');
  });

  it('returns server-scope matches', async () => {
    const ctx = createMockContext();
    const input = searchCatalogTool.input.parse({
      query: 'arxiv research papers',
      scope: 'servers',
      limit: 3,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    expect(result.scope).toBe('servers');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].name).toBe('arxiv-mcp-server');
    for (const r of result.results) {
      expect(r.name).toBe(r.server);
    }
  });

  it('respects the limit parameter and surfaces total in enrichment', async () => {
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
    const input = searchCatalogTool.input.parse({
      query: 'seismic earthquake activity',
      limit: 1,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    expect(result.results.length).toBeLessThanOrEqual(1);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBeGreaterThanOrEqual(result.results.length);
  });

  it('filters by category', async () => {
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
    const input = searchCatalogTool.input.parse({
      query: 'arxiv research papers',
      scope: 'servers',
      category: 'research',
      limit: 10,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.category).toBe('research');
    }
  });

  it('returns structured empty when every score is below the floor', async () => {
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
    const input = searchCatalogTool.input.parse({
      query: 'totally unrelated capability',
    });

    const result = await searchCatalogTool.handler(input, ctx);

    expect(result.results).toEqual([]);
    expect(result.scope).toBe('tools');

    // Enrichment carries the query echo, zero total, and a notice
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('totally unrelated capability');
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice!.length).toBeGreaterThan(0);
  });

  it('includes servers roll-up in tools-scope results', async () => {
    const ctx = createMockContext();
    const input = searchCatalogTool.input.parse({
      query: 'broad seismic and research query',
      scope: 'tools',
      limit: 1,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    // Results respect the limit
    expect(result.results.length).toBeLessThanOrEqual(1);

    // servers roll-up covers all matched servers from the full set
    expect(result.servers).toBeDefined();
    expect(result.servers!.length).toBeGreaterThan(0);
    expect(result.serversTotal).toBeDefined();
    expect(result.serversTotal).toBeGreaterThanOrEqual(result.servers!.length);

    // Each roll-up entry has required fields
    for (const s of result.servers!) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.brief).toBe('string');
      expect(typeof s.matchedTools).toBe('number');
      expect(s.matchedTools).toBeGreaterThan(0);
      expect(typeof s.topScore).toBe('number');
    }

    // Ordered by topScore descending
    for (let i = 1; i < result.servers!.length; i++) {
      expect(result.servers![i - 1]!.topScore).toBeGreaterThanOrEqual(result.servers![i]!.topScore);
    }
  });

  it('omits servers roll-up in servers scope', async () => {
    const ctx = createMockContext();
    const input = searchCatalogTool.input.parse({
      query: 'arxiv research papers',
      scope: 'servers',
      limit: 5,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    expect(result.scope).toBe('servers');
    expect(result.servers).toBeUndefined();
    expect(result.serversTotal).toBeUndefined();
  });

  it('servers roll-up is capped at 10', async () => {
    // With 3 servers in the fixture, cap is not exercised — verify it never exceeds 10
    const ctx = createMockContext();
    const input = searchCatalogTool.input.parse({
      query: 'both research and seismic',
      scope: 'tools',
      limit: 5,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    if (result.servers) {
      expect(result.servers.length).toBeLessThanOrEqual(10);
      expect(result.serversTotal).toBeGreaterThanOrEqual(result.servers.length);
    }
  });

  it('throws catalog_empty when the catalog has not been initialized', async () => {
    resetCatalogServiceForTests();
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
    const input = searchCatalogTool.input.parse({ query: 'anything', limit: 5 });

    await expect(searchCatalogTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'catalog_empty' },
    });
  });

  it('ranks multiple matches in descending score order', async () => {
    const ctx = createMockContext();
    const input = searchCatalogTool.input.parse({
      query: 'both research and seismic',
      scope: 'servers',
      limit: 10,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    expect(result.results.length).toBeGreaterThan(1);
    for (let i = 1; i < result.results.length; i++) {
      const prev = result.results[i - 1]!;
      const curr = result.results[i]!;
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
    }
  });

  it('renders output fields in format()', () => {
    const result = {
      results: [
        {
          name: 'earthquake_search',
          server: 'earthquake-mcp-server',
          brief: 'Query seismic events.',
          category: 'public-data' as const,
          score: 0.82,
        },
      ],
      scope: 'tools' as const,
      servers: [
        {
          name: 'earthquake-mcp-server',
          brief: 'Search USGS seismic data.',
          category: 'public-data' as const,
          matchedTools: 2,
          topScore: 0.82,
        },
      ],
      serversTotal: 2,
    };
    const blocks = searchCatalogTool.format!(result);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('earthquake_search');
    expect(text).toContain('earthquake-mcp-server');
    expect(text).toContain('Query seismic events.');
    expect(text).toContain('public-data');
    expect(text).toContain('0.82');
    expect(text).toContain('tools');
    // servers roll-up
    expect(text).toContain('## Servers');
    expect(text).toContain('Search USGS seismic data.');
    expect(text).toContain('2 matched tools');
  });

  it('renders empty results in format()', () => {
    const result = {
      results: [],
      scope: 'tools' as const,
    };
    const blocks = searchCatalogTool.format!(result);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('No results matched.');
    expect(text).toContain('tools');
  });

  it('renders servers roll-up with cap header in format()', () => {
    const result = {
      results: [],
      scope: 'tools' as const,
      servers: [
        {
          name: 'some-mcp-server',
          brief: 'Does something.',
          category: 'utility' as const,
          matchedTools: 1,
          topScore: 0.9,
        },
      ],
      serversTotal: 15,
    };
    const blocks = searchCatalogTool.format!(result);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('showing 1 of 15');
  });
});
