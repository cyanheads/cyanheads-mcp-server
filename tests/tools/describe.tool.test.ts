/**
 * @fileoverview Tests for the cyanheads_describe tool.
 * Mocks globalThis.fetch and injects a deterministic embeddings runtime — no
 * live network or model loading.
 * @module tests/tools/describe.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeTool } from '@/mcp-server/tools/definitions/describe.tool.js';
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
      description: 'Search USGS and EMSC seismic data.',
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
          embedding: E0,
        },
      ],
    },
    {
      name: 'wikipedia-mcp-server',
      displayName: 'Wikipedia',
      description: 'Search Wikipedia and read article summaries.',
      category: 'research',
      endpoint: 'https://wikipedia.caseyjhand.com/mcp',
      npm: '@cyanheads/wikipedia-mcp-server',
      github: 'https://github.com/cyanheads/wikipedia-mcp-server',
      version: '1.0.3',
      auth: 'none',
      embedding: E1,
      tools: [
        {
          name: 'wikipedia_search',
          description: 'Search Wikipedia articles by keyword.',
          embedding: E1,
        },
      ],
    },
  ],
};

function makeMockEmbeddings(): IEmbeddingsRuntime {
  return {
    modelId: TEST_MODEL,
    async initialize() {},
    async embedQuery(_text: string, dims: number) {
      const out = new Float32Array(dims);
      out[0] = 1;
      return out;
    },
  };
}

describe('cyanheads_describe', () => {
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

  it('resolves a server by name', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.name).toBe('earthquake-mcp-server');
      expect(result.displayName).toBe('Earthquake');
      expect(result.version).toBe('0.2.1');
      expect(result.npm).toBe('@cyanheads/earthquake-mcp-server');
      expect(result.github).toBe('https://github.com/cyanheads/earthquake-mcp-server');
      expect(result.endpoint).toBe('https://earthquake.caseyjhand.com/mcp');
      expect(result.auth).toBe('none');
      expect(result.toolCount).toBe(2);
      expect(result.installSnippets.length).toBeGreaterThan(0);
    }
  });

  it('resolves a tool by name', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({ name: 'earthquake_search', kind: 'tool' });
    const { result } = await describeTool.handler(input, ctx);

    expect(result.kind).toBe('tool');
    if (result.kind === 'tool') {
      expect(result.name).toBe('earthquake_search');
      expect(result.server).toBe('earthquake-mcp-server');
      expect(typeof result.description).toBe('string');
    }
  });

  it('auto-detects server kind from hyphenated name', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({ name: 'wikipedia-mcp-server' });
    const { result } = await describeTool.handler(input, ctx);
    expect(result.kind).toBe('server');
  });

  it('auto-detects tool kind from underscore name', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({ name: 'wikipedia_search' });
    const { result } = await describeTool.handler(input, ctx);
    expect(result.kind).toBe('tool');
  });

  it('filters install snippets by client', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'claude-code',
    });
    const { result } = await describeTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.installSnippets).toHaveLength(1);
      expect(result.installSnippets[0].client).toBe('claude-code');
      expect(result.installSnippets[0].payload).toContain('claude mcp add');
    }
  });

  it('emits the Streamable HTTP transport tag, never the legacy SSE one', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      for (const snippet of result.installSnippets) {
        expect(snippet.payload).not.toContain('sse');
        expect(snippet.payload).toContain('earthquake.caseyjhand.com');
      }
    }
  });

  it('claude-code snippet matches `claude mcp add --transport http <name> <url>`', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'claude-code',
    });
    const { result } = await describeTool.handler(input, ctx);
    if (result.kind === 'server') {
      expect(result.installSnippets[0]?.payload).toBe(
        'claude mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
      );
    }
  });

  it('codex snippet matches `codex mcp add <name> --url <url>`', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'codex',
    });
    const { result } = await describeTool.handler(input, ctx);
    if (result.kind === 'server') {
      expect(result.installSnippets[0]?.payload).toBe(
        'codex mcp add earthquake-mcp-server --url https://earthquake.caseyjhand.com/mcp',
      );
    }
  });

  it('gemini snippet matches `gemini mcp add --transport http <name> <url>`', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'gemini',
    });
    const { result } = await describeTool.handler(input, ctx);
    if (result.kind === 'server') {
      expect(result.installSnippets[0]?.payload).toBe(
        'gemini mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
      );
    }
  });

  it('cursor JSON omits the `type` field', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'cursor',
    });
    const { result } = await describeTool.handler(input, ctx);
    if (result.kind === 'server') {
      const parsed = JSON.parse(result.installSnippets[0]!.payload);
      expect(parsed.mcpServers['earthquake-mcp-server']).toEqual({
        url: 'https://earthquake.caseyjhand.com/mcp',
      });
    }
  });

  it('streamable-http JSON carries `type: "http"`', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'streamable-http',
    });
    const { result } = await describeTool.handler(input, ctx);
    if (result.kind === 'server') {
      const parsed = JSON.parse(result.installSnippets[0]!.payload);
      expect(parsed.mcpServers['earthquake-mcp-server']).toEqual({
        type: 'http',
        url: 'https://earthquake.caseyjhand.com/mcp',
      });
    }
  });

  it('curl snippet POSTs initialize with the MCP-Protocol-Version header', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'curl',
    });
    const { result } = await describeTool.handler(input, ctx);
    if (result.kind === 'server') {
      const payload = result.installSnippets[0]!.payload;
      expect(payload).toMatch(/^curl -X POST https:\/\/earthquake\.caseyjhand\.com\/mcp/);
      expect(payload).toContain('Content-Type: application/json');
      expect(payload).toContain('MCP-Protocol-Version: 2025-11-25');
      expect(payload).toContain('"method":"initialize"');
      expect(payload).toContain('"protocolVersion":"2025-11-25"');
    }
  });

  it('throws not_found for an unknown name', async () => {
    const ctx = createMockContext({ errors: describeTool.errors });
    const input = describeTool.input.parse({ name: 'nonexistent-mcp-server', kind: 'server' });

    await expect(describeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when kind="tool" but the name only matches a server', async () => {
    const ctx = createMockContext({ errors: describeTool.errors });
    const input = describeTool.input.parse({ name: 'earthquake-mcp-server', kind: 'tool' });

    await expect(describeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when kind="server" but the name only matches a tool', async () => {
    const ctx = createMockContext({ errors: describeTool.errors });
    const input = describeTool.input.parse({ name: 'earthquake_search', kind: 'server' });

    await expect(describeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when the name contains neither hyphen nor underscore and no kind is given', async () => {
    const ctx = createMockContext({ errors: describeTool.errors });
    const input = describeTool.input.parse({ name: 'unstructuredname' });

    await expect(describeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('returns one snippet per supported client when client is omitted', async () => {
    const ctx = createMockContext();
    const input = describeTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.installSnippets).toHaveLength(6);
      const clients = result.installSnippets.map((s) => s.client).sort();
      expect(clients).toEqual([
        'claude-code',
        'codex',
        'curl',
        'cursor',
        'gemini',
        'streamable-http',
      ]);
    }
  });

  it('throws catalog_empty when the catalog has not been initialized', async () => {
    resetCatalogServiceForTests();
    const ctx = createMockContext({ errors: describeTool.errors });
    const input = describeTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });

    await expect(describeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'catalog_empty' },
    });
  });

  it('renders tool branch fields in format()', () => {
    const output = {
      result: {
        kind: 'tool' as const,
        name: 'earthquake_search',
        description: 'Query seismic events by location.',
        server: 'earthquake-mcp-server',
      },
    };
    const blocks = describeTool.format!(output);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('earthquake_search');
    expect(text).toContain('earthquake-mcp-server');
    expect(text).toContain('Query seismic events by location.');
    expect(text).toContain('tool');
  });

  it('renders server branch fields in format()', () => {
    const output = {
      result: {
        kind: 'server' as const,
        name: 'earthquake-mcp-server',
        displayName: 'Earthquake',
        description: 'Seismic data server.',
        version: '0.2.1',
        npm: '@cyanheads/earthquake-mcp-server',
        github: 'https://github.com/cyanheads/earthquake-mcp-server',
        endpoint: 'https://earthquake.caseyjhand.com/mcp',
        auth: 'none',
        toolCount: 2,
        installSnippets: [
          {
            client: 'claude-code',
            label: 'Claude Code (CLI)',
            payload:
              'claude mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
          },
        ],
      },
    };
    const blocks = describeTool.format!(output);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('earthquake-mcp-server');
    expect(text).toContain('Earthquake');
    expect(text).toContain('Seismic data server.');
    expect(text).toContain('0.2.1');
    expect(text).toContain('@cyanheads/earthquake-mcp-server');
    expect(text).toContain('https://github.com/cyanheads/earthquake-mcp-server');
    expect(text).toContain('none');
    expect(text).toContain('2');
    expect(text).toContain('earthquake.caseyjhand.com');
    expect(text).toContain('claude-code');
    expect(text).toContain('Claude Code (CLI)');
    expect(text).toContain('claude mcp add');
    expect(text).toContain('server');
  });
});
