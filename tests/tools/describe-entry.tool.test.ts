/**
 * @fileoverview Tests for the cyanheads_describe_entry tool.
 * Mocks globalThis.fetch and injects a deterministic embeddings runtime — no
 * live network or model loading.
 * @module tests/tools/describe-entry.tool.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeEntryTool } from '@/mcp-server/tools/definitions/describe-entry.tool.js';
import { searchCatalogTool } from '@/mcp-server/tools/definitions/search-catalog.tool.js';
import { initCatalogService } from '@/services/catalog/catalog-service.js';
import type { IEmbeddingsRuntime } from '@/services/catalog/embeddings-runtime.js';
import {
  getCatalogService,
  resetCatalogServiceForTests,
} from '@/services/catalog/service-instance.js';
import type { CatalogRecord, FleetPayload } from '@/services/catalog/types.js';

/** Read independently of the self-record module, so a drift there is a test failure. */
const selfPkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
) as { description: string; version: string };

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
    {
      // Local-only server: no endpoint, requires an env var for the local install.
      name: 'mailchimp-mcp-server',
      displayName: 'Mailchimp',
      description: 'Manage Mailchimp audiences and campaigns.',
      category: 'utility',
      npm: '@cyanheads/mailchimp-mcp-server',
      github: 'https://github.com/cyanheads/mailchimp-mcp-server',
      version: '1.0.0',
      auth: 'none',
      requiredEnvVars: ['MAILCHIMP_API_KEY'],
      embedding: E1,
      tools: [
        {
          name: 'mailchimp_list_audiences',
          description: 'List Mailchimp audiences.',
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

describe('cyanheads_describe_entry', () => {
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

  it('resolves a hosted server by name', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);

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
      expect(result.tools).toEqual([
        {
          name: 'earthquake_search',
          description: 'Query seismic events by location and magnitude.',
        },
        { name: 'earthquake_get_feed', description: 'Fetch real-time USGS earthquake feed.' },
      ]);
      expect(result.toolCount).toBe(result.tools.length);
      // 5 local (stdio) + 6 remote (http)
      expect(result.installSnippets).toHaveLength(11);
    }
  });

  it('resolves a tool by name', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'earthquake_search', kind: 'tool' });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('tool');
    if (result.kind === 'tool') {
      expect(result.name).toBe('earthquake_search');
      expect(result.server).toBe('earthquake-mcp-server');
      expect(typeof result.description).toBe('string');
    }
  });

  it('auto-detects server kind from hyphenated name', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'wikipedia-mcp-server' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('server');
  });

  it('auto-detects tool kind from underscore name', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'wikipedia_search' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('tool');
  });

  it('filtering by client returns that client across both transports', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'claude-code',
    });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.installSnippets).toHaveLength(2);
      expect(result.installSnippets.every((s) => s.client === 'claude-code')).toBe(true);
      expect(result.installSnippets.map((s) => s.transport).sort()).toEqual(['http', 'stdio']);
    }
  });

  it('http snippets target the endpoint; no snippet emits the legacy SSE tag', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      for (const snippet of result.installSnippets) {
        expect(snippet.payload).not.toContain('sse');
        if (snippet.transport === 'http') {
          expect(snippet.payload).toContain('earthquake.caseyjhand.com');
        }
      }
    }
  });

  it('claude-code local snippet uses `claude mcp add --transport stdio <name> -- npx -y <pkg>`', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'claude-code',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      const stdio = result.installSnippets.find((s) => s.transport === 'stdio');
      expect(stdio?.payload).toBe(
        'claude mcp add --transport stdio earthquake-mcp-server -- npx -y @cyanheads/earthquake-mcp-server',
      );
    }
  });

  it('claude-code remote snippet uses `claude mcp add --transport http <name> <url>`', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'claude-code',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      const http = result.installSnippets.find((s) => s.transport === 'http');
      expect(http?.payload).toBe(
        'claude mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
      );
    }
  });

  it('codex remote snippet matches `codex mcp add <name> --url <url>`', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'codex',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      const http = result.installSnippets.find((s) => s.transport === 'http');
      expect(http?.payload).toBe(
        'codex mcp add earthquake-mcp-server --url https://earthquake.caseyjhand.com/mcp',
      );
    }
  });

  it('gemini remote snippet matches `gemini mcp add --transport http <name> <url>`', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'gemini',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      const http = result.installSnippets.find((s) => s.transport === 'http');
      expect(http?.payload).toBe(
        'gemini mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
      );
    }
  });

  it('cursor remote JSON omits the `type` field', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'cursor',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      const http = result.installSnippets.find((s) => s.transport === 'http')!;
      const parsed = JSON.parse(http.payload);
      expect(parsed.mcpServers['earthquake-mcp-server']).toEqual({
        url: 'https://earthquake.caseyjhand.com/mcp',
      });
    }
  });

  it('streamable-http remote JSON carries `type: "http"`', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'streamable-http',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      const http = result.installSnippets.find((s) => s.transport === 'http')!;
      const parsed = JSON.parse(http.payload);
      expect(parsed.mcpServers['earthquake-mcp-server']).toEqual({
        type: 'http',
        url: 'https://earthquake.caseyjhand.com/mcp',
      });
    }
  });

  it('curl snippet POSTs initialize with the MCP-Protocol-Version header', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'earthquake-mcp-server',
      kind: 'server',
      client: 'curl',
    });
    const { result } = await describeEntryTool.handler(input, ctx);
    if (result.kind === 'server') {
      // curl is HTTP-only — exactly one snippet.
      expect(result.installSnippets).toHaveLength(1);
      const payload = result.installSnippets[0]!.payload;
      expect(payload).toMatch(/^curl -X POST https:\/\/earthquake\.caseyjhand\.com\/mcp/);
      expect(payload).toContain('Content-Type: application/json');
      expect(payload).toContain('MCP-Protocol-Version: 2025-11-25');
      expect(payload).toContain('"method":"initialize"');
      expect(payload).toContain('"protocolVersion":"2025-11-25"');
    }
  });

  it('resolves a local-only server: endpoint absent, stdio-only snippets, env vars surfaced', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'mailchimp-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.endpoint).toBeUndefined();
      expect(result.requiredEnvVars).toEqual(['MAILCHIMP_API_KEY']);
      expect(result.tools).toEqual([
        { name: 'mailchimp_list_audiences', description: 'List Mailchimp audiences.' },
      ]);
      expect(result.installSnippets).toHaveLength(5);
      expect(result.installSnippets.every((s) => s.transport === 'stdio')).toBe(true);
      expect(result.installSnippets.some((s) => s.client === 'curl')).toBe(false);
    }
  });

  it('throws not_found for an unknown name', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'nonexistent-mcp-server', kind: 'server' });

    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when kind="tool" but the name only matches a server', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'tool' });

    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when kind="server" but the name only matches a tool', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake_search', kind: 'server' });

    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when the name contains neither hyphen nor underscore and no kind is given', async () => {
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'unstructuredname' });

    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('returns local + remote snippets for every client when client is omitted', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.installSnippets).toHaveLength(11);
      const stdio = result.installSnippets.filter((s) => s.transport === 'stdio');
      const http = result.installSnippets.filter((s) => s.transport === 'http');
      expect(stdio).toHaveLength(5);
      expect(http).toHaveLength(6);
    }
  });

  it('throws catalog_empty when the catalog has not been initialized', async () => {
    resetCatalogServiceForTests();
    const ctx = createMockContext({ errors: describeEntryTool.errors });
    const input = describeEntryTool.input.parse({ name: 'earthquake-mcp-server', kind: 'server' });

    await expect(describeEntryTool.handler(input, ctx)).rejects.toMatchObject({
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
    const blocks = describeEntryTool.format!(output);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('earthquake_search');
    expect(text).toContain('earthquake-mcp-server');
    expect(text).toContain('Query seismic events by location.');
    expect(text).toContain('tool');
  });

  it('renders Local and Remote sections in format() for a hosted server', () => {
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
        tools: [
          { name: 'earthquake_search', description: 'Query seismic events by location.' },
          { name: 'earthquake_get_feed', description: 'Fetch real-time USGS earthquake feed.' },
        ],
        installSnippets: [
          {
            client: 'claude-code' as const,
            transport: 'stdio' as const,
            label: 'Claude Code (CLI)',
            payload:
              'claude mcp add --transport stdio earthquake-mcp-server -- npx -y @cyanheads/earthquake-mcp-server',
          },
          {
            client: 'claude-code' as const,
            transport: 'http' as const,
            label: 'Claude Code (CLI)',
            payload:
              'claude mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
          },
        ],
      },
    };
    const blocks = describeEntryTool.format!(output);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('earthquake-mcp-server');
    expect(text).toContain('Earthquake');
    expect(text).toContain('Seismic data server.');
    expect(text).toContain('0.2.1');
    expect(text).toContain('@cyanheads/earthquake-mcp-server');
    expect(text).toContain('https://github.com/cyanheads/earthquake-mcp-server');
    expect(text).toContain('none');
    expect(text).toContain('## Tools');
    expect(text).toContain('earthquake_search');
    expect(text).toContain('Query seismic events by location.');
    expect(text).toContain('## Local install (stdio)');
    expect(text).toContain('--transport stdio');
    expect(text).toContain('## Remote install (HTTP)');
    expect(text).toContain('earthquake.caseyjhand.com');
  });

  it('describes this server itself, with both install transports', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'cyanheads-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.name).toBe('cyanheads-mcp-server');
      expect(result.displayName).toBe('cyanheads-mcp-server');
      expect(result.npm).toBe('@cyanheads/cyanheads-mcp-server');
      expect(result.github).toBe('https://github.com/cyanheads/cyanheads-mcp-server');
      expect(result.endpoint).toBe('https://cyanheads.caseyjhand.com/mcp');
      expect(result.auth).toBe('none');
      expect(result.version).toBe(selfPkg.version);
      expect(result.description).toBe(selfPkg.description);

      // Tool list mirrors the tools this build actually registers.
      expect(result.tools).toEqual([
        { name: searchCatalogTool.name, description: searchCatalogTool.description },
        { name: describeEntryTool.name, description: describeEntryTool.description },
      ]);
      expect(result.toolCount).toBe(2);

      // Hosted record → the full 5 stdio + 6 http snippet set.
      expect(result.installSnippets).toHaveLength(11);
      const stdio = result.installSnippets.find(
        (s) => s.transport === 'stdio' && s.client === 'claude-code',
      );
      expect(stdio?.payload).toBe(
        'claude mcp add --transport stdio cyanheads-mcp-server -- npx -y @cyanheads/cyanheads-mcp-server',
      );
      const http = result.installSnippets.find(
        (s) => s.transport === 'http' && s.client === 'claude-code',
      );
      expect(http?.payload).toBe(
        'claude mcp add --transport http cyanheads-mcp-server https://cyanheads.caseyjhand.com/mcp',
      );
    }
  });

  it('auto-detects the self record as a server without an explicit kind', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'cyanheads-mcp-server' });
    const { result } = await describeEntryTool.handler(input, ctx);
    expect(result.kind).toBe('server');
  });

  it('resolves this server’s own tools by name', async () => {
    const ctx = createMockContext();
    for (const definition of [searchCatalogTool, describeEntryTool]) {
      const input = describeEntryTool.input.parse({ name: definition.name, kind: 'tool' });
      const { result } = await describeEntryTool.handler(input, ctx);
      expect(result.kind).toBe('tool');
      if (result.kind === 'tool') {
        expect(result.name).toBe(definition.name);
        expect(result.server).toBe('cyanheads-mcp-server');
        expect(result.description).toBe(definition.description);
      }
    }
  });

  it('renders the self record through format() with both install sections', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'cyanheads-mcp-server', kind: 'server' });
    const output = await describeEntryTool.handler(input, ctx);
    const blocks = describeEntryTool.format!(output);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');

    expect(text).toContain('# Server: cyanheads-mcp-server');
    expect(text).toContain('@cyanheads/cyanheads-mcp-server');
    expect(text).toContain('## Tools');
    expect(text).toContain('cyanheads_search_catalog');
    expect(text).toContain('cyanheads_describe_entry');
    expect(text).toContain('## Local install (stdio)');
    expect(text).toContain('## Remote install (HTTP)');
    expect(text).toContain('https://cyanheads.caseyjhand.com/mcp');
  });

  it('renders the env-var note and no Remote section for a local-only server', () => {
    const output = {
      result: {
        kind: 'server' as const,
        name: 'mailchimp-mcp-server',
        displayName: 'Mailchimp',
        description: 'Manage Mailchimp audiences.',
        version: '1.0.0',
        npm: '@cyanheads/mailchimp-mcp-server',
        github: 'https://github.com/cyanheads/mailchimp-mcp-server',
        auth: 'none',
        requiredEnvVars: ['MAILCHIMP_API_KEY'],
        toolCount: 1,
        tools: [{ name: 'mailchimp_list_audiences', description: 'List Mailchimp audiences.' }],
        installSnippets: [
          {
            client: 'cursor' as const,
            transport: 'stdio' as const,
            label: 'Cursor (mcp.json)',
            payload: '{"mcpServers":{"mailchimp-mcp-server":{"command":"npx"}}}',
          },
        ],
      },
    };
    const blocks = describeEntryTool.format!(output);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
    expect(text).toContain('## Tools');
    expect(text).toContain('mailchimp_list_audiences');
    expect(text).toContain('## Local install (stdio)');
    expect(text).toContain('MAILCHIMP_API_KEY');
    expect(text).not.toContain('## Remote install (HTTP)');
  });
});

describe('cyanheads_describe_entry — self record superseded by the remote catalog', () => {
  /**
   * The self record exists only because the generated catalog omits this server.
   * If the generator ever starts emitting it, the remote entry must win outright —
   * no duplication, no stale local metadata masking the real record.
   */
  const REMOTE_SELF: CatalogRecord = {
    name: 'cyanheads-mcp-server',
    displayName: 'Cyanheads Discovery',
    description: 'Remote-catalog description that must win over the local fallback.',
    category: 'utility',
    endpoint: 'https://remote.example.com/mcp',
    npm: '@cyanheads/cyanheads-mcp-server',
    github: 'https://github.com/cyanheads/cyanheads-mcp-server',
    version: '99.0.0',
    auth: 'none',
    embedding: E0,
    tools: [
      { name: 'cyanheads_search_catalog', description: 'Remote description.', embedding: E0 },
    ],
  };

  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            ...FLEET_PAYLOAD,
            servers: [...FLEET_PAYLOAD.servers, REMOTE_SELF],
          } satisfies FleetPayload),
      }),
    );
    initCatalogService(TEST_CONFIG, makeMockEmbeddings());
    await getCatalogService().initialize();
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.restoreAllMocks();
  });

  it('returns the remote server entry, not the local fallback', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({ name: 'cyanheads-mcp-server', kind: 'server' });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('server');
    if (result.kind === 'server') {
      expect(result.displayName).toBe('Cyanheads Discovery');
      expect(result.version).toBe('99.0.0');
      expect(result.endpoint).toBe('https://remote.example.com/mcp');
      expect(result.toolCount).toBe(1);
    }
  });

  it('returns the remote tool entry, not the local fallback', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'cyanheads_search_catalog',
      kind: 'tool',
    });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('tool');
    if (result.kind === 'tool') {
      expect(result.description).toBe('Remote description.');
    }
  });

  it('still falls back for a tool the remote entry omits', async () => {
    const ctx = createMockContext();
    const input = describeEntryTool.input.parse({
      name: 'cyanheads_describe_entry',
      kind: 'tool',
    });
    const { result } = await describeEntryTool.handler(input, ctx);

    expect(result.kind).toBe('tool');
    if (result.kind === 'tool') {
      expect(result.description).toBe(describeEntryTool.description);
    }
  });
});
