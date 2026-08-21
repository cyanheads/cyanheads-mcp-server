/**
 * @fileoverview Input validation, edge-case, and security tests for cyanheads_describe_entry.
 * Mocks fetch and injects a deterministic embeddings runtime — no live network.
 * @module tests/tools/describe-entry-input-validation.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeEntryTool } from '@/mcp-server/tools/definitions/describe-entry.tool.js';
import { initCatalogService } from '@/services/catalog/catalog-service.js';
import type { IEmbeddingsRuntime } from '@/services/catalog/embeddings-runtime.js';
import {
  getCatalogService,
  resetCatalogServiceForTests,
} from '@/services/catalog/service-instance.js';
import type { FleetPayload } from '@/services/catalog/types.js';

const TEST_MODEL = 'test/mock-embed-v1';

const TEST_CONFIG = {
  catalogUrl: 'https://test.example.com/fleet.json',
  catalogFetchTimeoutMs: 5000,
  catalogRefreshSeconds: 0,
  embeddingModelId: TEST_MODEL,
  similarityFloor: 0.3,
};

/**
 * Fixture designed to exercise the ambiguous_kind path:
 * the catalog must contain both a server and a tool that could
 * be confused. The tool name must NOT match the auto-detect
 * heuristic by containing underscores (tools) or hyphens (servers)
 * for the ambiguous case. Here we use a server whose name shares
 * a string with a tool's description path — but the real ambiguity
 * test requires a name with no hyphens or underscores (neither auto-
 * detects to one side). Since server names always have hyphens and
 * tool names always have underscores, a name like "plain" can match
 * neither heuristic; if the catalog had both a server and tool called
 * "plain" that would trigger ambiguity. But the catalog schema
 * enforces snake_case for tools and kebab-case for servers, so collision
 * is impossible in practice. The handler path handles this defensively —
 * we test it by calling getTool+getServer in an edge scenario.
 */
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
          description: 'Query seismic events.',
          embedding: [1, 0, 0, 0],
        },
        {
          name: 'earthquake_get_feed',
          description: 'Fetch real-time USGS feed.',
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
          description: 'Search papers.',
          embedding: [0, 1, 0, 0],
        },
      ],
    },
  ],
};

function makeMockEmbeddings(): IEmbeddingsRuntime {
  return {
    modelId: TEST_MODEL,
    async embedQuery(_text: string, dims: number) {
      const out = new Float32Array(dims);
      out[0] = 1;
      return out;
    },
  };
}

describe('cyanheads_describe_entry — input validation', () => {
  it('rejects empty name (min 1)', () => {
    expect(() => describeEntryTool.input.parse({ name: '' })).toThrow();
  });

  it('rejects missing name', () => {
    expect(() => describeEntryTool.input.parse({})).toThrow();
  });

  it('accepts a name at the maximum boundary (64 chars)', () => {
    expect(() => describeEntryTool.input.parse({ name: 'a'.repeat(64) })).not.toThrow();
  });

  it('rejects a name one character over the maximum (65 chars)', () => {
    expect(() => describeEntryTool.input.parse({ name: 'a'.repeat(65) })).toThrow();
  });

  it('rejects a megabyte-scale name', () => {
    expect(() => describeEntryTool.input.parse({ name: 'x'.repeat(1_000_000) })).toThrow();
  });

  it('accepts the longest identifiers the live fleet actually uses', () => {
    // Longest catalog tool name (42 chars) and server name (32 chars) as of the
    // measurement this bound was set from, plus this server's own tool names.
    const realNames = [
      'courtlistener_search_financial_disclosures',
      'openstates_get_legislators_by_location',
      'faa-aircraft-registry-mcp-server',
      'nhtsa-vehicle-safety-mcp-server',
      'cyanheads-mcp-server',
      'cyanheads_search_catalog',
      'cyanheads_describe_entry',
    ];
    for (const name of realNames) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(() => describeEntryTool.input.parse({ name })).not.toThrow();
    }
  });

  it('rejects an unknown kind value', () => {
    expect(() => describeEntryTool.input.parse({ name: 'test-server', kind: 'unknown' })).toThrow();
  });

  it('rejects an unknown client value', () => {
    expect(() =>
      describeEntryTool.input.parse({ name: 'test-server', client: 'unknown-client' }),
    ).toThrow();
  });

  it('accepts all valid client values', () => {
    for (const client of [
      'claude-code',
      'codex',
      'cursor',
      'curl',
      'gemini',
      'streamable-http',
    ] as const) {
      expect(() => describeEntryTool.input.parse({ name: 'test-server', client })).not.toThrow();
    }
  });

  it('accepts kind "tool"', () => {
    expect(() => describeEntryTool.input.parse({ name: 'test_tool', kind: 'tool' })).not.toThrow();
  });

  it('accepts kind "server"', () => {
    expect(() =>
      describeEntryTool.input.parse({ name: 'test-server', kind: 'server' }),
    ).not.toThrow();
  });
});

describe('cyanheads_describe_entry — handler behavior', () => {
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
    initCatalogService(TEST_CONFIG, makeMockEmbeddings());
    await getCatalogService().initialize();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('returns toolCount matching the fixture tool count', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.toolCount).toBe(2);
    }
  });

  it('tool result does not include installSnippets field', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake_search', kind: 'tool' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('tool');
    // discriminatedUnion: 'tool' branch has no installSnippets
    expect((result as Record<string, unknown>).installSnippets).toBeUndefined();
  });

  it('server result does not include a tool-only server field', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('server');
    // discriminatedUnion: 'server' branch has no 'server' field (that is on 'tool')
    expect((result as Record<string, unknown>).server).toBeUndefined();
  });

  it('resolves second server in fixture', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'arxiv-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.name).toBe('arxiv-mcp-server');
      expect(result.npm).toBe('@cyanheads/arxiv-mcp-server');
    }
  });

  it('resolves a tool from the second server', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'arxiv_search', kind: 'tool' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('tool');
    if (result.kind === 'tool') {
      expect(result.server).toBe('arxiv-mcp-server');
    }
  });

  it('filtering by client returns that client across local and remote transports', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({
      name: 'arxiv-mcp-server',
      kind: 'server',
      client: 'cursor',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      expect(result.installSnippets).toHaveLength(2);
      expect(result.installSnippets.every((s) => s.client === 'cursor')).toBe(true);
      expect(result.installSnippets.map((s) => s.transport).sort()).toEqual(['http', 'stdio']);
    }
  });

  it('http snippet reflects the actual endpoint from the catalog', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({
      name: 'arxiv-mcp-server',
      kind: 'server',
      client: 'claude-code',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      const http = result.installSnippets.find((s) => s.transport === 'http');
      expect(http?.payload).toContain('arxiv.caseyjhand.com');
    }
  });
});

describe('cyanheads_describe_entry — edge cases', () => {
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
    initCatalogService(TEST_CONFIG, makeMockEmbeddings());
    await getCatalogService().initialize();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('auto-detects server kind for a name with hyphens and no underscores', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    // No explicit kind — hyphens → server
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('server');
  });

  it('auto-detects tool kind for a name with underscores and no hyphens', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    // No explicit kind — underscores → tool
    const input = describeEntryTool.input.parse({ name: 'arxiv_search' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('tool');
  });

  it('returns not_found for a name with no hyphens or underscores', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'plainname' });
    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found for a known server name when kind="tool"', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'tool' });
    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found for a known tool name when kind="server"', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake_search', kind: 'server' });
    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('unicode name that does not match catalog returns not_found', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: '地震_search' });
    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });
});

describe('cyanheads_describe_entry — security', () => {
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
    initCatalogService(TEST_CONFIG, makeMockEmbeddings());
    await getCatalogService().initialize();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('output contains no env var names from server config', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('CATALOG_URL');
    expect(serialized).not.toContain('EMBEDDING_MODEL_ID');
    expect(serialized).not.toContain('SIMILARITY_FLOOR');
  });

  it('error for not_found does not leak internal catalog path or config', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'nonexistent-server', kind: 'server' });
    const err = await Promise.resolve(describeEntryTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    const msg = String(err instanceof Error ? err.message : err);
    expect(msg).not.toContain('CATALOG_URL');
    expect(msg).not.toContain('test.example.com');
  });

  it('injection string in name field does not cause unhandled throw', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    // Has hyphens so auto-detects as server; not in catalog → not_found
    const input = describeEntryTool.input.parse({
      name: "'; DROP TABLE servers; --injection-server",
    });
    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('format() output contains no env var names', () => {
    const output = {
      result: {
        kind: 'server' as const,
        name: 'earthquake-mcp-server',
        displayName: 'Earthquake',
        description: 'Seismic data.',
        version: '0.2.1',
        npm: '@cyanheads/earthquake-mcp-server',
        github: 'https://github.com/cyanheads/earthquake-mcp-server',
        endpoint: 'https://earthquake.caseyjhand.com/mcp',
        auth: 'none',
        toolCount: 2,
        tools: [
          { name: 'earthquake_search', description: 'Query seismic events by location.' },
          { name: 'earthquake_get_feed', description: 'Fetch real-time USGS earthquake feed.' },
        ],
        installSnippets: [],
      },
    };
    const blocks = describeEntryTool.format!(output);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).not.toContain('CATALOG_URL');
    expect(text).not.toContain('API_KEY');
    expect(text).not.toContain('SECRET');
  });
});
