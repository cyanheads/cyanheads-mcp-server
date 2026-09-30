/**
 * @fileoverview Catalog integrity, continuation, and install handoff regressions.
 * @module tests/integration/catalog-regressions.int.test
 */

import { execFileSync } from 'node:child_process';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeEntryTool } from '@/mcp-server/tools/definitions/describe-entry.tool.js';
import { searchCatalogTool } from '@/mcp-server/tools/definitions/search-catalog.tool.js';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import {
  resetCatalogServiceForTests,
  setCatalogService,
} from '@/services/catalog/service-instance.js';
import type { CatalogRecord, FleetPayload } from '@/services/catalog/types.js';

const config = {
  catalogUrl: 'https://example.test/fleet.json',
  catalogFetchTimeoutMs: 1000,
  catalogRefreshSeconds: 1,
  embeddingModelId: 'test/model',
  similarityFloor: 0.3,
};
const literal =
  'at://<handle-or-did>/<collection>/<rkey> &amp; **bold** [link](https://example.test)\n# injected\n```\n````\nend';

function server(i: number): CatalogRecord {
  const id = String(i).padStart(2, '0');
  return {
    name: `fixture-${id}`,
    displayName: `Fixture ${id}`,
    description: `Description ${id}`,
    category: 'utility',
    npm: `@cyanheads/fixture-${id}`,
    github: `https://example.test/${id}`,
    version: '1.0.0',
    auth: 'none',
    embedding: [1, 0],
    ...(i % 2
      ? { endpoint: `https://example.test/${id}/mcp` }
      : { requiredEnvVars: ['FIXTURE_KEY'] }),
    tools: [0, 1].map((j) => ({
      name: `fixture_${id}_${j}`,
      description: `Tool ${id} ${j}`,
      embedding: [1, 0],
    })),
  };
}

function fleet(): FleetPayload {
  return {
    version: '2',
    generatedAt: '2026-09-30T00:00:00Z',
    embeddingModel: config.embeddingModelId,
    embeddingDims: 2,
    embeddingQueryPrefix: 'Q: ',
    servers: Array.from({ length: 12 }, (_, i) => server(i)),
  };
}

function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
}

function html(markdown: string): string {
  return execFileSync(
    'bun',
    ['-e', 'process.stdout.write(Bun.markdown.html(await Bun.stdin.text()))'],
    { input: markdown, encoding: 'utf8' },
  );
}

function escaped(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

describe('catalog regression contracts', () => {
  let payload: FleetPayload;
  let service: CatalogService;
  const embedQuery = vi.fn(
    async (query: string) => new Float32Array(query === 'no match' ? [0, 1] : [1, 0]),
  );

  beforeEach(() => {
    vi.useFakeTimers();
    payload = fleet();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload))),
    );
    embedQuery.mockClear();
    service = new CatalogService(config, { modelId: config.embeddingModelId, embedQuery });
    setCatalogService(service);
  });

  afterEach(() => {
    resetCatalogServiceForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['   ', '\t\n', '\u2003\u00a0'])(
    'rejects blank query %j before embedding',
    async (query) => {
      await service.initialize();
      embedQuery.mockClear();
      const result = await runToolContract(searchCatalogTool, { query });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_arguments' } },
      });
      expect(text(result)).toContain('query');
      expect(embedQuery).not.toHaveBeenCalled();
    },
  );

  it('trims embedding and echo without loosening the raw ceiling', async () => {
    await service.initialize();
    const result = await runToolContract(searchCatalogTool, { query: ' \tfixture\n ' });
    expect(embedQuery).toHaveBeenLastCalledWith('fixture', 2, 'Q: ');
    expect(result.structuredContent).toMatchObject({ effectiveQuery: 'fixture' });
    expect(text(result)).toContain('Query: fixture');
    expect(searchCatalogTool.input.safeParse({ query: ` ${'a'.repeat(499)}` }).success).toBe(true);
    expect(searchCatalogTool.input.safeParse({ query: ` ${'a'.repeat(499)} ` }).success).toBe(
      false,
    );
  });

  it('pages tied results and roll-ups independently through partial and exhausted pages', async () => {
    await service.initialize();
    const call = (offset: number, serversOffset: number, limit = 20) =>
      runToolContract(searchCatalogTool, { query: 'fixture', offset, serversOffset, limit });
    const first = await call(0, 0);
    const second = await call(20, 10);
    expect(first.structuredContent).toMatchObject({
      offset: 0,
      nextOffset: 20,
      serversOffset: 0,
      nextServersOffset: 10,
    });
    expect(second.structuredContent).toMatchObject({
      offset: 20,
      nextOffset: null,
      serversOffset: 10,
      nextServersOffset: null,
      totalCount: 24,
      serversTotal: 12,
    });
    const a = searchCatalogTool.output.parse(first.structuredContent);
    const b = searchCatalogTool.output.parse(second.structuredContent);
    expect([...a.results, ...b.results].map((r) => r.name)).toEqual(
      payload.servers.flatMap((s) => s.tools.map((t) => t.name)),
    );
    expect([...(a.servers ?? []), ...(b.servers ?? [])].map((s) => s.name)).toEqual(
      payload.servers.map((s) => s.name),
    );
    expect(text(first)).toContain('nextOffset: 20');
    expect(text(first)).toContain('nextServersOffset: 10');
    expect(text(second)).toContain('nextOffset: null');
    const independent = searchCatalogTool.output.parse((await call(20, 0, 1)).structuredContent);
    expect(independent.servers).toEqual(a.servers);
    expect(searchCatalogTool.output.parse((await call(0, 10)).structuredContent).results).toEqual(
      a.results,
    );
    const past = await call(99, 99);
    expect(past.structuredContent).toMatchObject({
      results: [],
      servers: [],
      totalCount: 24,
      serversTotal: 12,
      nextOffset: null,
      nextServersOffset: null,
    });
    expect(text(past)).toContain('No results on this page');
    expect(text(past)).not.toContain('No results matched');
    for (const offset of [0, 5, 10, 99]) {
      const page = await runToolContract(searchCatalogTool, {
        query: 'fixture',
        scope: 'servers',
        offset,
        limit: 5,
      });
      expect(page.structuredContent).not.toHaveProperty('serversOffset');
      expect(page.structuredContent).not.toHaveProperty('nextServersOffset');
      expect(page.structuredContent).toMatchObject({
        offset,
        nextOffset: offset < 10 ? offset + 5 : null,
      });
    }
  });

  it.each([
    { offset: -1 },
    { offset: 0.5 },
    { serversOffset: -1 },
    { serversOffset: 0.5 },
    { scope: 'servers' as const, serversOffset: 1 },
  ])('rejects invalid pagination %j', async (args) => {
    await service.initialize();
    const result = await runToolContract(searchCatalogTool, { query: 'fixture', ...args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { recovery: { hint: expect.any(String) } } },
    });
  });

  it('normalizes nested identical duplicates consistently before indexing', async () => {
    const original = payload.servers[0]!;
    payload.servers[0] = { ...original, tools: [...original.tools, original.tools[0]!] };
    payload.servers.push(original);
    await service.initialize();
    expect(service.stats()).toMatchObject({ serverCount: 12, toolCount: 24 });
    const searched = await runToolContract(searchCatalogTool, { query: 'fixture', limit: 20 });
    expect(searched.structuredContent).toMatchObject({ totalCount: 24, serversTotal: 12 });
    const described = await runToolContract(describeEntryTool, { name: original.name });
    expect(described.structuredContent).toMatchObject({
      result: {
        toolCount: 2,
        tools: original.tools.map(({ name, description }) => ({ name, description })),
      },
    });
    const scores = await service.search({ query: 'fixture', scope: 'tools' });
    expect(scores).toHaveLength(24);
    expect(scores.every((s) => s.score === 1)).toBe(true);
    payload.generatedAt = 'next';
    await vi.advanceTimersByTimeAsync(1100);
    expect(service.stats()).toMatchObject({ serverCount: 12, toolCount: 24 });
  });

  it('keeps distinct later vectors aligned after nested duplicate normalization', async () => {
    const first = server(0);
    const later = {
      ...server(1),
      embedding: [0, 1],
      tools: [
        { name: 'later_match', description: 'Later matching row', embedding: [0, 1] },
        { name: 'later_nonmatch', description: 'Later nonmatching row', embedding: [1, 0] },
      ],
    };
    payload.servers = [{ ...first, tools: [...first.tools, first.tools[0]!] }, first, later];
    await service.initialize();
    expect(service.stats()).toMatchObject({ serverCount: 2, toolCount: 4 });
    const found = await runToolContract(searchCatalogTool, { query: 'no match' });
    expect(found.structuredContent).toMatchObject({
      totalCount: 1,
      results: [{ name: 'later_match', server: later.name, score: 1 }],
      serversTotal: 1,
      servers: [{ name: later.name, matchedTools: 1, topScore: 1 }],
    });
    expect(text(found)).toContain('later_match');
    expect(text(found)).not.toContain('later_nonmatch');
    const described = await runToolContract(describeEntryTool, { name: first.name });
    expect(described.structuredContent).toMatchObject({ result: { toolCount: 2 } });
    expect(await service.search({ query: 'no match', scope: 'servers' })).toEqual([
      {
        name: later.name,
        server: later.name,
        brief: later.description,
        category: 'utility',
        score: 1,
      },
    ]);
  });

  it('reports collapsed identities in a bounded load-time warning', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const record = payload.servers[0]!;
    payload.servers = Array.from({ length: 16 }, () => record);
    await service.initialize();
    expect(warning).toHaveBeenCalledOnce();
    const message = warning.mock.calls[0]![0];
    expect(message).toContain('Collapsed 15 identical catalog records');
    expect(message.match(/servers\/fixture-00/g)).toHaveLength(10);
    expect(service.stats()).toMatchObject({ serverCount: 1, toolCount: 2 });
  });

  it.each(['description', 'embedding', 'metadata', 'server'] as const)(
    'rejects conflicting %s duplicates and preserves the previous index',
    async (conflict) => {
      await service.initialize();
      const previous = service.stats();
      const rows = await service.search({ query: 'fixture', scope: 'tools' });
      const original = payload.servers[0]!;
      payload.generatedAt = 'bad';
      if (conflict === 'metadata' || conflict === 'server') {
        payload.servers.push({
          ...original,
          ...(conflict === 'metadata' ? { auth: 'different' } : { description: 'different' }),
        });
      } else {
        original.tools.push({
          ...original.tools[0]!,
          ...(conflict === 'description' ? { description: 'different' } : { embedding: [0, 1] }),
        });
      }
      await vi.advanceTimersByTimeAsync(1100);
      expect(service.stats()).toEqual(previous);
      expect(await service.search({ query: 'fixture', scope: 'tools' })).toEqual(rows);
      const startup = new CatalogService(
        { ...config, catalogRefreshSeconds: 0 },
        { modelId: config.embeddingModelId, embedQuery },
      );
      await expect(startup.initialize()).rejects.toThrow('Conflicting');
      payload = { ...fleet(), generatedAt: 'good', servers: [server(0)] };
      await vi.advanceTimersByTimeAsync(1100);
      expect(service.stats().serverCount).toBe(1);
    },
  );

  it('keeps same-spelling tools owned by unrelated servers in their own inventories', async () => {
    payload.servers[1]!.tools[0] = { ...payload.servers[0]!.tools[0]! };
    await service.initialize();
    expect(service.stats().toolCount).toBe(24);
    const rows = await service.search({ query: 'fixture', scope: 'tools' });
    expect(rows.filter((r) => r.name === 'fixture_00_0').map((r) => r.server)).toEqual([
      'fixture-00',
      'fixture-01',
    ]);
    expect(service.getServer('fixture-01')?.tools).toHaveLength(2);
  });

  it('rejects empty startup without warming and retains the full index across an empty refresh', async () => {
    payload.servers = [];
    await expect(service.initialize()).rejects.toThrow('servers');
    expect(embedQuery).not.toHaveBeenCalled();
    payload = fleet();
    await service.initialize();
    const previous = service.stats();
    const rows = await service.search({ query: 'fixture', scope: 'tools' });
    payload = { ...fleet(), generatedAt: 'empty', servers: [] };
    await vi.advanceTimersByTimeAsync(1100);
    expect(service.stats()).toEqual(previous);
    expect(await service.search({ query: 'fixture', scope: 'tools' })).toEqual(rows);
    payload = { ...fleet(), generatedAt: 'zero-tools', servers: [{ ...server(0), tools: [] }] };
    await vi.advanceTimersByTimeAsync(1100);
    expect(service.stats()).toMatchObject({ serverCount: 1, toolCount: 0 });
    const described = await runToolContract(describeEntryTool, { name: 'fixture-00' });
    expect(described.structuredContent).toMatchObject({ result: { toolCount: 0, tools: [] } });
    expect(text(described)).toContain('Tool count:** 0');
  });

  it('resolves unique case variants to canonical remote and self names with both kinds', async () => {
    await service.initialize();
    for (const [name, kind] of [
      ['fixture-01', 'server'],
      ['fixture_01_0', 'tool'],
      ['cyanheads-mcp-server', 'server'],
      ['cyanheads_search_catalog', 'tool'],
      ['cyanheads_describe_entry', 'tool'],
    ] as const) {
      for (const explicit of [true, false]) {
        const result = await runToolContract(describeEntryTool, {
          name: name.toUpperCase(),
          ...(explicit ? { kind } : {}),
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ result: { name, kind } });
        expect(text(result)).toContain(name);
      }
    }
  });

  it('keeps exact collision winners, refuses ambiguous folds, and rebuilds remote precedence on refresh', async () => {
    const lower = {
      ...server(0),
      name: 'cyanheads-mcp-server',
      tools: [{ name: 'cyanheads_search_catalog', description: 'remote lower', embedding: [1, 0] }],
    };
    const upper = {
      ...server(1),
      name: 'CYANHEADS-MCP-SERVER',
      tools: [{ name: 'CYANHEADS_SEARCH_CATALOG', description: 'remote upper', embedding: [1, 0] }],
    };
    payload.servers = [upper];
    await service.initialize();
    expect(service.getServer(lower.name)?.name).toBe(upper.name);
    expect(service.getTool('cyanheads_search_catalog')?.description).toBe('remote upper');
    payload = { ...payload, generatedAt: 'collision', servers: [upper, lower] };
    await vi.advanceTimersByTimeAsync(1100);
    expect(service.getServer(lower.name)?.name).toBe(lower.name);
    expect(service.getTool('cyanheads_search_catalog')?.description).toBe('remote lower');
    expect(service.getServer('Cyanheads-MCP-Server')).toBeNull();
    expect(service.getTool('Cyanheads_Search_Catalog')).toBeNull();
    const miss = await runToolContract(describeEntryTool, { name: 'Cyanheads_Search_Catalog' });
    expect(miss.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'not_found',
          recovery: { hint: expect.stringContaining('cyanheads_search_catalog') },
        },
      },
    });
    payload = { ...payload, generatedAt: 'removed', servers: [server(0)] };
    await vi.advanceTimersByTimeAsync(1100);
    expect(service.getTool('CYANHEADS_SEARCH_CATALOG')?.name).toBe('cyanheads_search_catalog');
  });

  it.each([undefined, 'codex', 'curl'] as const)(
    'provides matching tool/server connection handoff for client %s',
    async (client) => {
      await service.initialize();
      for (const [tool, owner] of [
        ['fixture_00_0', 'fixture-00'],
        ['fixture_01_0', 'fixture-01'],
        ['cyanheads_search_catalog', 'cyanheads-mcp-server'],
      ]) {
        const a = await runToolContract(describeEntryTool, {
          name: tool!,
          ...(client ? { client } : {}),
        });
        const b = await runToolContract(describeEntryTool, {
          name: owner!,
          ...(client ? { client } : {}),
        });
        expect(a.isError).not.toBe(true);
        const toolResult = describeEntryTool.output.parse(a.structuredContent).result;
        const serverResult = describeEntryTool.output.parse(b.structuredContent).result;
        for (const key of [
          'npm',
          'github',
          'endpoint',
          'auth',
          'requiredEnvVars',
          'installSnippets',
          'installNotice',
        ] as const) {
          expect(toolResult).toHaveProperty('npm');
          expect(toolResult[key]).toEqual(serverResult[key]);
        }
        if (client === 'curl' && owner === 'fixture-00') {
          expect(toolResult.installSnippets).toEqual([]);
          expect(toolResult.installNotice).toMatch(/curl.*HTTP.*codex/);
          for (const result of [a, b]) {
            expect(text(result)).toContain('FIXTURE_KEY');
            expect(text(result)).toContain(toolResult.installNotice!);
          }
        }
      }
    },
  );

  it('preserves literal catalog values and snippets after Markdown parsing on both tools', async () => {
    payload.servers = [
      {
        ...server(0),
        description: literal,
        displayName: literal,
        auth: literal,
        npm: literal,
        github: literal,
        endpoint: literal,
        version: literal,
        requiredEnvVars: [literal],
        tools: [{ name: 'fixture_`tool', description: literal, embedding: [1, 0] }],
      },
    ];
    await service.initialize();
    for (const name of ['fixture-00', 'fixture_`tool']) {
      const described = await runToolContract(describeEntryTool, { name });
      expect(described.isError).not.toBe(true);
      const output = describeEntryTool.output.parse(described.structuredContent).result;
      expect(output.description).toBe(literal);
      const rendered = html(text(described));
      expect(rendered).toContain(escaped(literal));
      expect(rendered).not.toMatch(
        /<h1>injected|<handle-or-did>|<strong>bold|<a href="https:\/\/example.test">link/,
      );
      expect(rendered).toContain('<h2>Description</h2>');
      for (const snippet of output.installSnippets)
        expect(rendered).toContain(escaped(snippet.payload));
      expect(rendered).toContain('<code>fixture_`tool</code>');
      const modified = {
        result: {
          ...output,
          name: literal,
          installSnippets: output.installSnippets.map((s) => ({ ...s, label: literal })),
        },
      };
      const labeled = html(
        describeEntryTool.format!(modified)
          .map((b) => ('text' in b ? b.text : ''))
          .join('\n'),
      );
      expect(labeled).not.toContain('<h1>injected');
      for (const snippet of output.installSnippets)
        expect(labeled).toContain(escaped(snippet.payload));
    }
    const searched = await runToolContract(searchCatalogTool, { query: 'fixture' });
    expect(searched.structuredContent).toMatchObject({
      results: [{ brief: literal }],
      servers: [{ brief: literal }],
    });
    const rendered = html(text(searched));
    expect(rendered.split(escaped(literal))).toHaveLength(3);
    expect(rendered).not.toContain('<h1>injected');
    const formatted = searchCatalogTool.output.parse(searched.structuredContent);
    formatted.results[0]!.name = literal;
    formatted.results[0]!.server = literal;
    formatted.servers![0]!.name = literal;
    const labeled = html(
      searchCatalogTool.format!(formatted)
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n'),
    );
    expect(labeled.split(escaped(literal))).toHaveLength(6);
    expect(labeled).not.toContain('<h1>injected');
  });

  it('characterizes full-match ranking, caps, transport choices, and zero-match success', async () => {
    await service.initialize();
    const found = await runToolContract(searchCatalogTool, { query: 'fixture', limit: 20 });
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent).toMatchObject({
      totalCount: 24,
      results: expect.any(Array),
      serversTotal: 12,
    });
    const output = searchCatalogTool.output.parse(found.structuredContent);
    expect(output.results).toHaveLength(20);
    expect(output.servers).toHaveLength(10);
    expect(output.servers?.map((s) => s.matchedTools)).toEqual(Array(10).fill(2));
    expect(output.results.map((r) => r.name)).toEqual(
      payload.servers.flatMap((s) => s.tools.map((t) => t.name)).slice(0, 20),
    );
    expect(text(found)).toContain('24 total');
    for (const name of ['fixture-00', 'fixture-01']) {
      const described = await runToolContract(describeEntryTool, { name, client: 'codex' });
      const result = describeEntryTool.output.parse(described.structuredContent).result;
      expect(result.kind).toBe('server');
      if (result.kind !== 'server') throw new Error('Expected server');
      expect(result.installSnippets.map((s) => s.transport)).toEqual(
        name === 'fixture-00' ? ['stdio'] : ['stdio', 'http'],
      );
      expect(text(described)).toContain('codex mcp add');
    }
    const empty = await runToolContract(searchCatalogTool, { query: 'no match' });
    expect(empty.isError).not.toBe(true);
    expect(empty.structuredContent).toMatchObject({
      results: [],
      totalCount: 0,
      notice: expect.stringContaining('broadening'),
    });
  });
});
