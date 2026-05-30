/**
 * @fileoverview Tests for the cyanheads_search tool.
 * Mocks globalThis.fetch and injects a deterministic embeddings runtime — no
 * live network or model loading.
 * @module tests/tools/search.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchTool } from '@/mcp-server/tools/definitions/search.tool.js';
import {
  getCatalogService,
  initCatalogService,
  resetCatalogServiceForTests,
} from '@/services/catalog/catalog-service.js';
import type { IEmbeddingsRuntime } from '@/services/catalog/embeddings-runtime.js';
import type { FleetPayload } from '@/services/catalog/types.js';

const TEST_MODEL = 'test/mock-embed-v1';
const E0 = [1, 0, 0, 0];
const E1 = [0, 1, 0, 0];

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

describe('cyanheads_search', () => {
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
    const input = searchTool.input.parse({
      query: 'seismic earthquake activity',
      scope: 'tools',
      limit: 5,
    });
    const result = await searchTool.handler(input, ctx);

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
    const input = searchTool.input.parse({
      query: 'arxiv research papers',
      scope: 'servers',
      limit: 3,
    });
    const result = await searchTool.handler(input, ctx);

    expect(result.scope).toBe('servers');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].name).toBe('arxiv-mcp-server');
    for (const r of result.results) {
      expect(r.name).toBe(r.server);
    }
  });

  it('respects the limit parameter and surfaces total in enrichment', async () => {
    const ctx = createMockContext({ errors: searchTool.errors });
    const input = searchTool.input.parse({
      query: 'seismic earthquake activity',
      limit: 1,
    });
    const result = await searchTool.handler(input, ctx);

    expect(result.results.length).toBeLessThanOrEqual(1);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBeGreaterThanOrEqual(result.results.length);
  });

  it('filters by category', async () => {
    const ctx = createMockContext({ errors: searchTool.errors });
    const input = searchTool.input.parse({
      query: 'arxiv research papers',
      scope: 'servers',
      category: 'research',
      limit: 10,
    });
    const result = await searchTool.handler(input, ctx);

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.category).toBe('research');
    }
  });

  it('throws no_results when every score is below the floor', async () => {
    const ctx = createMockContext({ errors: searchTool.errors });
    const input = searchTool.input.parse({
      query: 'totally unrelated capability',
    });

    await expect(searchTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });

    // Enrichment is still populated even on the error path
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('totally unrelated capability');
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
  });

  it('throws catalog_empty when the catalog has not been initialized', async () => {
    resetCatalogServiceForTests();
    const ctx = createMockContext({ errors: searchTool.errors });
    const input = searchTool.input.parse({ query: 'anything', limit: 5 });

    await expect(searchTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'catalog_empty' },
    });
  });

  it('ranks multiple matches in descending score order', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({
      query: 'both research and seismic',
      scope: 'servers',
      limit: 10,
    });
    const result = await searchTool.handler(input, ctx);

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
    };
    const blocks = searchTool.format!(result);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('earthquake_search');
    expect(text).toContain('earthquake-mcp-server');
    expect(text).toContain('Query seismic events.');
    expect(text).toContain('public-data');
    expect(text).toContain('0.82');
    expect(text).toContain('tools');
  });
});
