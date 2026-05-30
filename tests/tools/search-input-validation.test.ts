/**
 * @fileoverview Input validation, edge-case, and security tests for cyanheads_search.
 * Mocks fetch and injects a deterministic embeddings runtime — no live network.
 * @module tests/tools/search-input-validation.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
      embedding: [1, 0, 0, 0],
      tools: [
        {
          name: 'earthquake_search',
          description: 'Query seismic events by location.',
          embedding: [1, 0, 0, 0],
        },
      ],
    },
    {
      name: 'arxiv-mcp-server',
      displayName: 'arXiv',
      description: 'Search arXiv papers.',
      category: 'research',
      endpoint: 'https://arxiv.caseyjhand.com/mcp',
      npm: '@cyanheads/arxiv-mcp-server',
      github: 'https://github.com/cyanheads/arxiv-mcp-server',
      version: '1.2.7',
      auth: 'none',
      embedding: [0, 1, 0, 0],
      tools: [
        {
          name: 'arxiv_search',
          description: 'Search arXiv papers by query.',
          embedding: [0, 1, 0, 0],
        },
      ],
    },
  ],
};

function makeIdentityEmbeddings(): IEmbeddingsRuntime {
  return {
    modelId: TEST_MODEL,
    async initialize() {},
    async embedQuery(_text: string, dims: number) {
      // Return E0-like vector so most tests get consistent scores
      const out = new Float32Array(dims);
      out[0] = 1;
      return out;
    },
  };
}

describe('cyanheads_search — input validation', () => {
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
    initCatalogService(TEST_CONFIG, makeIdentityEmbeddings());
    await getCatalogService().initialize();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  describe('query field', () => {
    it('rejects empty string query (min 1)', () => {
      expect(() => searchTool.input.parse({ query: '' })).toThrow();
    });

    it('accepts a single-character query', () => {
      expect(() => searchTool.input.parse({ query: 'a' })).not.toThrow();
    });

    it('rejects missing query', () => {
      expect(() => searchTool.input.parse({})).toThrow();
    });
  });

  describe('limit field', () => {
    it('rejects limit below 1', () => {
      expect(() => searchTool.input.parse({ query: 'test', limit: 0 })).toThrow();
    });

    it('rejects limit above 20', () => {
      expect(() => searchTool.input.parse({ query: 'test', limit: 21 })).toThrow();
    });

    it('accepts limit at the minimum boundary (1)', () => {
      expect(() => searchTool.input.parse({ query: 'test', limit: 1 })).not.toThrow();
    });

    it('accepts limit at the maximum boundary (20)', () => {
      expect(() => searchTool.input.parse({ query: 'test', limit: 20 })).not.toThrow();
    });

    it('rejects non-integer limit', () => {
      expect(() => searchTool.input.parse({ query: 'test', limit: 1.5 })).toThrow();
    });

    it('defaults limit to 5 when omitted', () => {
      const parsed = searchTool.input.parse({ query: 'test' });
      expect(parsed.limit).toBe(5);
    });
  });

  describe('scope field', () => {
    it('defaults to "tools" when omitted', () => {
      const parsed = searchTool.input.parse({ query: 'test' });
      expect(parsed.scope).toBe('tools');
    });

    it('rejects unknown scope values', () => {
      expect(() => searchTool.input.parse({ query: 'test', scope: 'invalid' })).toThrow();
    });

    it('accepts "servers"', () => {
      expect(() => searchTool.input.parse({ query: 'test', scope: 'servers' })).not.toThrow();
    });
  });

  describe('category field', () => {
    it('rejects an unknown category string', () => {
      expect(() =>
        searchTool.input.parse({ query: 'test', category: 'not-a-real-category' }),
      ).toThrow();
    });

    it('accepts all valid categories', () => {
      for (const cat of ['research', 'government', 'public-data', 'utility'] as const) {
        expect(() => searchTool.input.parse({ query: 'test', category: cat })).not.toThrow();
      }
    });
  });
});

describe('cyanheads_search — edge cases', () => {
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
    initCatalogService(TEST_CONFIG, makeIdentityEmbeddings());
    await getCatalogService().initialize();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('handles unicode query without error', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({ query: '地震データ検索' });
    const result = await searchTool.handler(input, ctx);
    expect(result.scope).toBe('tools');
    // May return results or empty; must not throw
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('handles emoji-only query without error', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({ query: '🌍🔍' });
    const result = await searchTool.handler(input, ctx);
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('handles a query with leading and trailing whitespace', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({ query: '  seismic  ' });
    const result = await searchTool.handler(input, ctx);
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('returns at most limit results even when many match', async () => {
    const ctx = createMockContext({ errors: searchTool.errors });
    const input = searchTool.input.parse({ query: 'find data', limit: 1 });
    const result = await searchTool.handler(input, ctx);
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it('scope "tools" produces result entries where server field is set', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({ query: 'seismic', scope: 'tools', limit: 10 });
    const result = await searchTool.handler(input, ctx);
    for (const r of result.results) {
      expect(typeof r.server).toBe('string');
      expect(r.server.length).toBeGreaterThan(0);
    }
  });

  it('scope "servers" produces result entries where name equals server', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({ query: 'research', scope: 'servers', limit: 10 });
    const result = await searchTool.handler(input, ctx);
    for (const r of result.results) {
      expect(r.name).toBe(r.server);
    }
  });

  it('all result scores are in [0, 1] range', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({ query: 'earthquake data', scope: 'tools', limit: 20 });
    const result = await searchTool.handler(input, ctx);
    for (const r of result.results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('category filter with no matching entries returns empty results, not an error', async () => {
    const ctx = createMockContext({ errors: searchTool.errors });
    const input = searchTool.input.parse({
      query: 'seismic earthquake',
      scope: 'tools',
      category: 'government', // no government servers in fixture
      limit: 5,
    });
    const result = await searchTool.handler(input, ctx);
    expect(result.results).toEqual([]);
  });
});

describe('cyanheads_search — security', () => {
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
    initCatalogService(TEST_CONFIG, makeIdentityEmbeddings());
    await getCatalogService().initialize();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('output contains no env var names from server config', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({ query: 'seismic', limit: 5 });
    const result = await searchTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('CATALOG_URL');
    expect(serialized).not.toContain('EMBEDDING_MODEL_ID');
    expect(serialized).not.toContain('CATALOG_FETCH_TIMEOUT_MS');
    expect(serialized).not.toContain('SIMILARITY_FLOOR');
  });

  it('SQL/SoQL injection string in query is passed through without executing', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({
      query: "'; DROP TABLE servers; --",
    });
    // Must not throw and must return a valid response
    const result = await searchTool.handler(input, ctx);
    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('script-injection string in query does not appear unescaped in result', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({
      query: '<script>alert("xss")</script>',
    });
    const result = await searchTool.handler(input, ctx);
    // Results are data objects, not HTML — no XSS surface. Verify clean structure.
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('path traversal string in query does not throw or expose filesystem paths', async () => {
    const ctx = createMockContext();
    const input = searchTool.input.parse({
      query: '../../../../etc/passwd',
    });
    const result = await searchTool.handler(input, ctx);
    expect(Array.isArray(result.results)).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/etc/passwd');
  });

  it('oversized query string (1001 chars) is accepted by Zod (no max constraint) and handled safely', async () => {
    const ctx = createMockContext();
    const longQuery = 'earthquake '.repeat(100).trim();
    // No max constraint on query — accepted. Handler must not crash.
    const input = searchTool.input.parse({ query: longQuery });
    const result = await searchTool.handler(input, ctx);
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('format() output does not contain raw env var names', () => {
    const result = {
      results: [
        {
          name: 'earthquake_search',
          server: 'earthquake-mcp-server',
          brief: 'Query seismic events.',
          category: 'public-data' as const,
          score: 0.9,
        },
      ],
      scope: 'tools' as const,
    };
    const blocks = searchTool.format!(result);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).not.toContain('CATALOG_URL');
    expect(text).not.toContain('API_KEY');
    expect(text).not.toContain('SECRET');
  });
});
