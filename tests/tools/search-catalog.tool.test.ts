/**
 * @fileoverview Tests for the cyanheads_search_catalog tool.
 * Mocks globalThis.fetch and injects a deterministic embeddings runtime — no
 * live network or model loading.
 * @module tests/tools/search-catalog.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCatalogTool } from '@/mcp-server/tools/definitions/search-catalog.tool.js';
import { initCatalogService } from '@/services/catalog/catalog-service.js';
import type { IEmbeddingsRuntime } from '@/services/catalog/embeddings-runtime.js';
import {
  getCatalogService,
  resetCatalogServiceForTests,
  setCatalogService,
} from '@/services/catalog/service-instance.js';
import type { CatalogRecord, FleetPayload } from '@/services/catalog/types.js';
import { createCatalogServiceFake } from '../fixtures/catalog-service.js';

/**
 * The clamp counter, standing in for the instrument `createCounter` would bind
 * on the global MeterProvider. Every other export of the utils module is real.
 */
const clampCounter = vi.hoisted(() => ({ add: vi.fn(), name: '' }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => {
    clampCounter.name = name;
    return clampCounter;
  },
}));

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
}

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
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
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

    const top = result.results[0]!;
    expect(top.name).toBe('earthquake_search');
    expect(top.server).toBe('earthquake-mcp-server');
    expect(top.score).toBeGreaterThan(0.9);
    expect(typeof top.brief).toBe('string');
    expect(typeof top.category).toBe('string');
  });

  it('returns server-scope matches', async () => {
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
    const input = searchCatalogTool.input.parse({
      query: 'arxiv research papers',
      scope: 'servers',
      limit: 3,
    });
    const result = await searchCatalogTool.handler(input, ctx);

    expect(result.scope).toBe('servers');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.name).toBe('arxiv-mcp-server');
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
    expect(typeof enrichment.notice === 'string' && enrichment.notice.length).toBeGreaterThan(0);
  });

  it('includes servers roll-up in tools-scope results', async () => {
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
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
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
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
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
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
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
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
      expect(prev.score!).toBeGreaterThanOrEqual(curr.score!);
    }
  });

  it('renders output fields in format()', () => {
    const result = {
      offset: 0,
      nextOffset: null,
      serversOffset: 0,
      nextServersOffset: 1,
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
      offset: 0,
      nextOffset: null,
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
      offset: 0,
      nextOffset: null,
      serversOffset: 0,
      nextServersOffset: 1,
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

describe('cyanheads_search_catalog — list mode', () => {
  const embedQuery = vi.fn(makeMockEmbeddings({ 'seismic earthquake activity': E0 }).embedQuery);
  const row = (name: string, server: string, brief: string, category: string) => ({
    name,
    server,
    brief,
    category,
  });
  const TOOLS = [
    row('arxiv_search', 'arxiv-mcp-server', 'Search arXiv papers by query.', 'research'),
    row(
      'earthquake_get_event',
      'earthquake-mcp-server',
      'Fetch a single seismic event by ID.',
      'public-data',
    ),
    row(
      'earthquake_search',
      'earthquake-mcp-server',
      'Query seismic events by location and magnitude.',
      'public-data',
    ),
    row('pubmed_fetch_articles', 'pubmed-mcp-server', 'Fetch PubMed article details.', 'research'),
    row('pubmed_search_articles', 'pubmed-mcp-server', 'Search PubMed articles.', 'research'),
  ];
  const list = (args: Record<string, unknown>) =>
    runToolContract(searchCatalogTool, args as z.input<typeof searchCatalogTool.input>);
  const PAST_END = 'No results on this page. Use offset 0 to return to the first result page.';

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
    initCatalogService(TEST_CONFIG, { modelId: TEST_MODEL, embedQuery });
    await getCatalogService().initialize();
    embedQuery.mockClear();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('lists tools by name with no score, query echo, or roll-up on either surface', async () => {
    const result = await list({});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      offset: 0,
      nextOffset: null,
      scope: 'tools',
      results: TOOLS,
      totalCount: 5,
    });
    const text = textOf(result);
    expect(text).toContain(
      '### `arxiv_search`\n**Server:** `arxiv-mcp-server`\n\n**Category:** research\n```\nSearch arXiv papers by query.\n```',
    );
    expect(text).toContain('5 total');
    for (const absent of ['Score', 'Query:', '## Servers', 'serversOffset'])
      expect(text).not.toContain(absent);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it.each([{ query: '' }, { query: null }])(
    'reads %j as the same listing on both surfaces',
    async (args) => {
      const omitted = await list({});
      const blank = await list(args);
      expect(blank.structuredContent).toEqual(omitted.structuredContent);
      expect(blank.content).toEqual(omitted.content);
      expect(embedQuery).not.toHaveBeenCalled();
    },
  );

  it('keeps whitespace queries rejected before the embedding runtime', async () => {
    for (const query of ['   ', '\t\n', '  ']) {
      const result = await list({ query });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_arguments' } },
      });
    }
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('lists servers in a category by name', async () => {
    const result = await list({ scope: 'servers', category: 'research' });
    expect(result.structuredContent).toEqual({
      offset: 0,
      nextOffset: null,
      scope: 'servers',
      results: [
        row(
          'arxiv-mcp-server',
          'arxiv-mcp-server',
          'Search arXiv papers and fetch full-text content.',
          'research',
        ),
        row(
          'pubmed-mcp-server',
          'pubmed-mcp-server',
          'Search biomedical literature via PubMed.',
          'research',
        ),
      ],
      totalCount: 2,
    });
  });

  it('walks every listed tool exactly once with nextOffset', async () => {
    const walked: unknown[] = [];
    const offsets: (number | null)[] = [];
    let offset: number | null = 0;
    for (let page = 0; page < 3 && offset !== null; page++) {
      const result = await list({ limit: 2, offset });
      const content = result.structuredContent as { results: unknown[]; nextOffset: number | null };
      walked.push(...content.results);
      offset = content.nextOffset;
      offsets.push(offset);
    }
    expect(offsets).toEqual([2, 4, null]);
    expect(walked).toEqual(TOOLS);
  });

  it('names an empty page past the end and an empty category on both surfaces', async () => {
    const pastEnd = await list({ offset: 99 });
    expect(pastEnd.structuredContent).toEqual({
      offset: 99,
      nextOffset: null,
      scope: 'tools',
      results: [],
      totalCount: 5,
      notice: PAST_END,
    });
    expect(textOf(pastEnd).split('\n')).toContain(`> ${PAST_END}`);

    // No government server exists, so neither scope lists one and switching scope is no remedy.
    for (const scope of ['tools', 'servers'] as const) {
      const empty = await list({ scope, category: 'government' });
      const notice = `No ${scope} in category "government". Remove the category filter.`;
      expect(empty.structuredContent).toEqual({
        offset: 0,
        nextOffset: null,
        scope,
        results: [],
        totalCount: 0,
        notice,
      });
      expect(textOf(empty).split('\n')).toContain(`> ${notice}`);
      expect(textOf(empty)).not.toContain('query');
    }
  });

  /** The first offset with no row: the total itself. The query matches four of the five tools. */
  it.each([
    { mode: 'listing', args: { offset: 5 }, total: 5 },
    { mode: 'query search', args: { query: 'seismic earthquake activity', offset: 4 }, total: 4 },
  ])(
    'names an empty page at an offset equal to the $mode total on both surfaces',
    async ({ args, total }) => {
      const result = await list(args);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        offset: total,
        nextOffset: null,
        results: [],
        totalCount: total,
        notice: PAST_END,
      });
      expect(textOf(result).split('\n')).toContain(`> ${PAST_END}`);
    },
  );

  it('offers servers scope for a category whose servers expose no tools', async () => {
    const fake = createCatalogServiceFake();
    setCatalogService({
      ...fake,
      list: (params) => (params.scope === 'tools' ? [] : fake.list(params)),
    });
    const result = await list({ category: 'utility' });
    expect(result.structuredContent).toMatchObject({
      results: [],
      totalCount: 0,
      notice:
        'No tools in category "utility". Remove the category filter or switch to scope "servers".',
    });
  });

  it('names the scope when the catalog itself lists nothing in it', async () => {
    setCatalogService({ ...createCatalogServiceFake(), list: () => [] });
    const result = await list({});
    expect(result.structuredContent).toMatchObject({
      results: [],
      totalCount: 0,
      notice: 'No tools in the catalog. Switch to scope "servers".',
    });
  });

  it.each([
    { serversOffset: 1 },
    { query: '', serversOffset: 1 },
    { scope: 'servers', serversOffset: 1 },
  ])('rejects %j with invalid_servers_offset and its recovery', async (args) => {
    const result = await list(args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'invalid_servers_offset',
          recovery: {
            hint: 'Set serversOffset to zero in servers scope and when query is omitted; use offset to page results.',
          },
        },
      },
    });
    expect(textOf(result)).toContain('invalid_servers_offset');
  });

  it('leaves a query call unchanged: score, echo, and roll-up present', async () => {
    const result = await list({ query: 'seismic earthquake activity' });
    const page = searchCatalogTool.output.parse(result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      effectiveQuery: 'seismic earthquake activity',
      serversOffset: 0,
      serversTotal: 2,
    });
    expect(page.results[0]).toMatchObject({ name: 'earthquake_search', score: 1 });
    expect(page.results.every((r) => typeof r.score === 'number')).toBe(true);
    expect(page.servers?.map((s) => s.name)).toEqual([
      'earthquake-mcp-server',
      'pubmed-mcp-server',
    ]);
    expect(textOf(result)).toContain('**Score:** 1.000');
    expect(embedQuery).toHaveBeenCalledOnce();
  });
});

describe('cyanheads_search_catalog — limit clamp record', () => {
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
    initCatalogService(TEST_CONFIG, makeMockEmbeddings({}));
    await getCatalogService().initialize();
    clampCounter.add.mockClear();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('counts each clamped call once and no call at or under the cap', async () => {
    expect(clampCounter.name).toBe('mcp.input.count_clamped');
    for (const args of [{ query: 'q', limit: 5 }, { query: 'q', limit: 1000 }, { limit: 1000 }]) {
      expect((await runToolContract(searchCatalogTool, args)).isError).not.toBe(true);
    }
    expect(clampCounter.add).not.toHaveBeenCalled();

    await runToolContract(searchCatalogTool, { query: 'q', limit: 1001 });
    expect(clampCounter.add).toHaveBeenCalledExactlyOnceWith(1, {
      'mcp.tool.name': 'cyanheads_search_catalog',
      'mcp.input.field': 'limit',
    });
    await runToolContract(searchCatalogTool, { limit: 1e20 });
    expect(clampCounter.add).toHaveBeenCalledTimes(2);
  });

  it('records the requested and served limit on the search info line', async () => {
    const ctx = createMockContext({ errors: searchCatalogTool.errors });
    await searchCatalogTool.handler(searchCatalogTool.input.parse({ limit: 5000 }), ctx);
    const lines = (ctx.log as MockContextLogger).calls.filter((c) => c.msg === 'Searching catalog');
    expect(lines).toEqual([
      {
        level: 'info',
        msg: 'Searching catalog',
        data: { query: undefined, scope: 'tools', limit: 5000, servedLimit: 1000 },
      },
    ]);
  });
});

describe('cyanheads_search_catalog — server roll-up across a mid-search refresh', () => {
  const QUERY = 'broad seismic and research query';
  let current: FleetPayload;

  beforeEach(() => {
    vi.useFakeTimers();
    current = FLEET_PAYLOAD;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(current))),
    );
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('describes each roll-up server from the catalog that scored its rows', async () => {
    let reached!: () => void;
    let release!: () => void;
    const embedding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const vectors = makeMockEmbeddings({ [QUERY]: [1, 1, 0, 0] });
    initCatalogService(
      { ...TEST_CONFIG, catalogRefreshSeconds: 1 },
      {
        modelId: TEST_MODEL,
        async embedQuery(text, dims, prefix) {
          if (text === QUERY) {
            reached();
            await gate;
          }
          return vectors.embedQuery(text, dims, prefix);
        },
      },
    );
    await getCatalogService().initialize();

    const pending = runToolContract(searchCatalogTool, { query: QUERY, limit: 10 });
    await embedding;
    // The refresh drops one matched server and rewrites two others while the query embeds.
    const [, arxiv, pubmed] = FLEET_PAYLOAD.servers as [unknown, CatalogRecord, CatalogRecord];
    current = {
      ...FLEET_PAYLOAD,
      generatedAt: '2026-05-29T00:00:00Z',
      servers: [
        { ...arxiv, description: 'Rewritten after the search began.' },
        { ...pubmed, category: 'utility' },
      ],
    };
    await vi.advanceTimersByTimeAsync(1100);
    expect(getCatalogService().stats().serverCount).toBe(2);
    release();
    const result = await pending;

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      totalCount: 5,
      serversTotal: 3,
      servers: [
        {
          name: 'pubmed-mcp-server',
          brief: 'Search biomedical literature via PubMed.',
          category: 'research',
          matchedTools: 2,
        },
        {
          name: 'earthquake-mcp-server',
          brief: 'Search USGS seismic data.',
          category: 'public-data',
          matchedTools: 2,
        },
        {
          name: 'arxiv-mcp-server',
          brief: 'Search arXiv papers and fetch full-text content.',
          category: 'research',
          matchedTools: 1,
        },
      ],
    });
    const text = textOf(result);
    expect(text).toContain('(public-data) — 2 matched tools');
    expect(text).toContain('```\nSearch USGS seismic data.\n```');
    expect(text).not.toContain('(utility)');
    expect(text).not.toContain('Rewritten after the search began.');

    // The next search answers from the refreshed catalog, roll-up included.
    const after = await runToolContract(searchCatalogTool, { query: QUERY, limit: 10 });
    expect(after.structuredContent).toMatchObject({
      serversTotal: 2,
      servers: [
        { name: 'pubmed-mcp-server', category: 'utility' },
        { name: 'arxiv-mcp-server', brief: 'Rewritten after the search began.' },
      ],
    });
  });
});
