/**
 * @fileoverview Catalog integrity, continuation, and install handoff regressions.
 * @module tests/integration/catalog-regressions.int.test
 */

import { execFileSync } from 'node:child_process';
import type { z } from '@cyanheads/mcp-ts-core';
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
    // The trailer renders the echo as a code span, so the trimmed value reads back verbatim.
    expect(text(result)).toContain('Query: `fixture`\n');
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

  describe('the 1000-row per-call cap', () => {
    /**
     * Two rows past the cap under distinct zero-padded names, so name order is
     * payload order: every row ties at score 1, and ties break by name.
     */
    function bulkFleet(): FleetPayload {
      const servers = Array.from({ length: 6 }, (_, s) => ({
        ...server(s),
        name: `bulk-${s}`,
        tools: Array.from({ length: 167 }, (_, t) => ({
          name: `bulk_${s}_${String(t).padStart(3, '0')}`,
          description: `Bulk ${s} ${t}`,
          embedding: [1, 0],
        })),
      }));
      return { ...fleet(), servers };
    }

    // `limit` as a client sends it: a numeric string is repaired by the framework.
    type Args = { query?: string; limit: number | string; offset?: number; scope?: 'servers' };
    const call = ({ query = 'fixture', ...args }: Args) =>
      runToolContract(searchCatalogTool, { query, ...args } as z.input<
        typeof searchCatalogTool.input
      >);
    const list = (args: Omit<Args, 'query'>) =>
      runToolContract(searchCatalogTool, args as z.input<typeof searchCatalogTool.input>);
    const names = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      searchCatalogTool.output.parse(result.structuredContent).results.map((r) => r.name);
    const truncationKeys = ['truncated', 'shown', 'cap', 'notice'];
    const quiet = (result: Awaited<ReturnType<typeof runToolContract>>) => {
      expect(result.isError).not.toBe(true);
      for (const key of truncationKeys) expect(result.structuredContent).not.toHaveProperty(key);
      expect(text(result)).not.toContain('per-call cap');
    };
    let all: string[];

    beforeEach(async () => {
      payload = bulkFleet();
      await service.initialize();
      all = payload.servers.flatMap((s) => s.tools.map((t) => t.name));
      expect(all).toHaveLength(1002);
    });

    it('serves a limit at or under the cap whole, with nothing disclosed', async () => {
      const hundred = await call({ limit: 100 });
      quiet(hundred);
      expect(hundred.structuredContent).toMatchObject({ totalCount: 1002, nextOffset: 100 });
      expect(names(hundred)).toEqual(all.slice(0, 100));
      const atCap = await call({ limit: 1000 });
      quiet(atCap);
      expect(atCap.structuredContent).toMatchObject({ nextOffset: 1000, serversTotal: 6 });
      expect(names(atCap)).toEqual(all.slice(0, 1000));
    });

    it.each([1001, 1e6, 1e20, '1500'])(
      'serves limit %j as 1000 rows and names the remainder on both surfaces',
      async (limit) => {
        const atCap = await call({ limit: 1000 });
        const clamped = await call({ limit });
        const notice = `limit ${Number(limit)} exceeds the per-call cap of 1000; 2 more results follow. Continue with offset 1000.`;
        expect(clamped.structuredContent).toEqual({
          ...atCap.structuredContent!,
          truncated: true,
          shown: 1000,
          cap: 1000,
          notice,
        });
        const lines = text(clamped).split('\n');
        for (const line of [
          `> ${notice}`,
          '**truncated:** true',
          '**shown:** 1000',
          '**cap:** 1000',
        ])
          expect(lines).toContain(line);
        expect(lines).toContain('### `bulk_5_164`');
        expect(lines).not.toContain('### `bulk_5_165`');
      },
    );

    it('names the singular remainder mid-list and serves the exact remainder after it', async () => {
      const mid = await call({ limit: 1001, offset: 1 });
      expect(mid.structuredContent).toMatchObject({
        offset: 1,
        nextOffset: 1001,
        shown: 1000,
        cap: 1000,
        notice:
          'limit 1001 exceeds the per-call cap of 1000; 1 more result follows. Continue with offset 1001.',
      });
      expect(names(mid)).toEqual(all.slice(1, 1001));

      const rest = await call({ limit: 1001, offset: 1000 });
      quiet(rest);
      expect(rest.structuredContent).toMatchObject({ offset: 1000, nextOffset: null });
      expect(names(rest)).toEqual(['bulk_5_165', 'bulk_5_166']);
      const lines = text(rest).split('\n');
      expect(lines).toContain('### `bulk_5_165`');
      expect(lines).toContain('### `bulk_5_166`');
    });

    it('keeps the past-end and zero-match notices whole when a clamp lands on them', async () => {
      const pastEnd = 'No results on this page. Use offset 0 to return to the first result page.';
      const zero = 'No tools matched. Try broadening the query or switching to scope "servers".';
      for (const [result, notice] of [
        [await call({ limit: 5000, offset: 2000 }), pastEnd],
        [await call({ query: 'no match', limit: 5000 }), zero],
      ] as const) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ results: [], nextOffset: null, notice });
        for (const key of ['truncated', 'shown', 'cap'])
          expect(result.structuredContent).not.toHaveProperty(key);
        expect(text(result).split('\n')).toContain(`> ${notice}`);
        expect(text(result)).not.toContain('per-call cap');
      }
    });

    it('returns every server at limit 5000 in servers scope with no truncation fields', async () => {
      const servers = await call({ limit: 5000, scope: 'servers' });
      quiet(servers);
      expect(servers.structuredContent).toMatchObject({ totalCount: 6, nextOffset: null });
      expect(names(servers)).toEqual(payload.servers.map((s) => s.name));
    });

    it.each([
      {
        limit: '1001',
        pages: [
          [0, 1000, true],
          [1000, null, undefined],
        ],
      },
      {
        limit: 300,
        pages: [
          [0, 300, undefined],
          [300, 600, undefined],
          [600, 900, undefined],
          [900, null, undefined],
        ],
      },
    ] as const)('walks every match exactly once at limit $limit', async ({ limit, pages }) => {
      for (const run of [call, list]) {
        const walked: string[] = [];
        const seen: unknown[] = [];
        let offset: number | null = 0;
        for (let page = 0; page < pages.length && offset !== null; page++) {
          const result = await run({ limit, offset });
          expect(result.isError).not.toBe(true);
          const content = result.structuredContent as Record<string, unknown>;
          seen.push([content.offset, content.nextOffset, content.truncated]);
          walked.push(...names(result));
          offset = content.nextOffset as number | null;
        }
        expect(seen).toEqual(pages);
        expect(walked).toEqual(all);
      }
    });

    it('pages a listing under the same cap, by name', async () => {
      // Drop initialize()'s warm-up embed: a listing embeds nothing at all.
      embedQuery.mockClear();
      const first = await list({ limit: 5000 });
      expect(first.structuredContent).toMatchObject({
        totalCount: 1002,
        nextOffset: 1000,
        truncated: true,
        shown: 1000,
        cap: 1000,
        notice:
          'limit 5000 exceeds the per-call cap of 1000; 2 more results follow. Continue with offset 1000.',
      });
      expect(first.structuredContent).not.toHaveProperty('effectiveQuery');
      expect(first.structuredContent).not.toHaveProperty('servers');
      expect(names(first)).toEqual(all.slice(0, 1000));
      expect(embedQuery).not.toHaveBeenCalled();
    });
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
        serverRecord: service.getServer(later.name),
      },
    ]);
  });

  it('scores scaled and float32-overflow vectors as finite cosines through the search tool', async () => {
    payload.servers[3]!.tools[0]!.embedding = [10, 0];
    payload.servers[4]!.tools[1]!.embedding = [0.1, 0];
    payload.servers[5]!.tools[0]!.embedding = [1e39, 0];
    payload.servers[6]!.embedding = [1e39, 1];
    // Squared, these leave float64 range; each still has a finite, nonzero norm.
    payload.servers[7]!.tools[0]!.embedding = [1e200, 0];
    payload.servers[8]!.embedding = [1e-200, 0];
    await service.initialize();
    const tools = await runToolContract(searchCatalogTool, { query: 'fixture', limit: 20 });
    expect(tools.isError).not.toBe(true);
    expect(tools.structuredContent).toMatchObject({ totalCount: 24, serversTotal: 12 });
    const page = searchCatalogTool.output.parse(tools.structuredContent);
    expect(page.results.map((r) => r.score)).toEqual(Array(20).fill(1));
    expect(page.servers?.map((s) => s.topScore)).toEqual(Array(10).fill(1));
    expect(page.results.map((r) => r.name)).toEqual(
      payload.servers.flatMap((s) => s.tools.map((t) => t.name)).slice(0, 20),
    );
    const servers = await runToolContract(searchCatalogTool, {
      query: 'fixture',
      scope: 'servers',
      limit: 20,
    });
    expect(servers.isError).not.toBe(true);
    expect(
      searchCatalogTool.output.parse(servers.structuredContent).results.map((r) => r.score),
    ).toEqual(Array(12).fill(1));
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

  it.each(['description', 'embedding', 'metadata', 'server', 'composesWith'] as const)(
    'rejects conflicting %s duplicates and preserves the previous index',
    async (conflict) => {
      await service.initialize();
      const previous = service.stats();
      const rows = await service.search({ query: 'fixture', scope: 'tools' });
      const original = payload.servers[0]!;
      payload.generatedAt = 'bad';
      if (conflict === 'composesWith') {
        payload.servers.push({ ...original, composesWith: ['fixture-01-mcp-server'] });
      } else if (conflict === 'metadata' || conflict === 'server') {
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

  it('collapses identical duplicates that carry composesWith and keeps the list', async () => {
    const composesWith = ['fixture-01', 'not-in-catalog-mcp-server'];
    payload.servers[0] = { ...payload.servers[0]!, composesWith };
    payload.servers.push({ ...payload.servers[0]!, composesWith: [...composesWith] });
    await service.initialize();
    expect(service.stats()).toMatchObject({ serverCount: 12, toolCount: 24 });
    const described = await runToolContract(describeEntryTool, { name: 'fixture-00' });
    expect(described.structuredContent).toMatchObject({ result: { composesWith } });
  });

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
    expect(service.getServer('cyanheads')?.name).toBe(upper.name);
    expect(service.getTool('cyanheads_search_catalog').map((t) => t.description)).toEqual([
      'remote upper',
    ]);
    payload = { ...payload, generatedAt: 'collision', servers: [upper, lower] };
    await vi.advanceTimersByTimeAsync(1100);
    expect(service.getServer(lower.name)?.name).toBe(lower.name);
    expect(service.getServer('cyanheads')?.name).toBe(lower.name);
    expect(service.getTool('cyanheads_search_catalog').map((t) => t.description)).toEqual([
      'remote lower',
    ]);
    // The ambiguous fold stays unresolved, full name and stem alike; neither reaches the self record.
    expect(service.getServer('Cyanheads-MCP-Server')).toBeNull();
    expect(service.getServer('Cyanheads')).toBeNull();
    expect(service.getTool('Cyanheads_Search_Catalog')).toEqual([]);
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
    expect(service.getTool('CYANHEADS_SEARCH_CATALOG').map((t) => t.name)).toEqual([
      'cyanheads_search_catalog',
    ]);
    expect(service.getServer('Cyanheads')?.endpoint).toBe('https://cyanheads.caseyjhand.com/mcp');
  });

  it.each(['later', 'earlier'] as const)(
    'describes each same-spelling row by name + server and refuses the bare name (copy %s)',
    async (order) => {
      const shared = payload.servers[0]!.tools[0]!;
      const copy = { ...shared, description: 'shadow copy' };
      const owner = payload.servers[order === 'later' ? 5 : 0]!;
      const other = payload.servers[order === 'later' ? 0 : 5]!;
      if (order === 'earlier') {
        // Original moves to fixture-05; the copy sits on fixture-00, earlier in payload order.
        other.tools.push({ ...shared });
        owner.tools[0] = copy;
      } else {
        owner.tools.push(copy);
      }
      const original = order === 'later' ? payload.servers[0]! : other;
      const owners = payload.servers
        .filter((s) => s.tools.some((t) => t.name === shared.name))
        .map((s) => s.name);
      await service.initialize();
      const rows = await service.search({ query: 'fixture', scope: 'tools' });
      expect(rows.filter((r) => r.name === shared.name).map((r) => r.server)).toEqual(owners);
      for (const row of rows.filter((r) => r.name === shared.name)) {
        for (const kind of [undefined, 'tool'] as const) {
          const result = await runToolContract(describeEntryTool, {
            name: row.name,
            server: row.server,
            ...(kind ? { kind } : {}),
          });
          expect(result.isError).not.toBe(true);
          const described = describeEntryTool.output.parse(result.structuredContent).result;
          expect(described).toMatchObject({
            kind: 'tool',
            server: row.server,
            description: row.brief,
          });
          const serverResult = describeEntryTool.output.parse(
            (await runToolContract(describeEntryTool, { name: row.server })).structuredContent,
          ).result;
          expect(described.npm).toBe(serverResult.npm);
          expect(described.installSnippets).toEqual(serverResult.installSnippets);
        }
      }
      expect(rows.find((r) => r.server === original.name && r.name === shared.name)?.brief).toBe(
        shared.description,
      );
      for (const name of [shared.name, shared.name.toUpperCase()]) {
        const refused = await runToolContract(describeEntryTool, { name });
        expect(refused.structuredContent).toMatchObject({
          error: { data: { reason: 'ambiguous_owner', owners } },
        });
        expect(text(refused)).toContain(`Tool "${shared.name}" has 2 owners: ${owners.join(', ')}`);
      }
    },
  );

  it.each([undefined, 'cline', 'codex', 'curl'] as const)(
    'provides matching tool/server connection handoff for client %s',
    async (client) => {
      payload.servers[1]!.composesWith = ['fixture-00', 'not-in-catalog-mcp-server'];
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
          'composesWith',
          'installSnippets',
          'installNotice',
        ] as const) {
          expect(toolResult).toHaveProperty('npm');
          expect(toolResult[key]).toEqual(serverResult[key]);
        }
        expect(toolResult.composesWith).toEqual(
          owner === 'fixture-01' ? ['fixture-00', 'not-in-catalog-mcp-server'] : undefined,
        );
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
        composesWith: [literal, 'fixture-`companion'],
        tools: [{ name: 'fixture_`tool', description: literal, embedding: [1, 0] }],
      },
    ];
    await service.initialize();
    for (const name of ['fixture-00', 'fixture_`tool']) {
      const described = await runToolContract(describeEntryTool, { name });
      expect(described.isError).not.toBe(true);
      const output = describeEntryTool.output.parse(described.structuredContent).result;
      expect(output.description).toBe(literal);
      expect(output.composesWith).toEqual([literal, 'fixture-`companion']);
      const rendered = html(text(described));
      expect(rendered).toContain(escaped(literal));
      expect(rendered).not.toMatch(
        /<h1>injected|<handle-or-did>|<strong>bold|<a href="https:\/\/example.test">link/,
      );
      expect(rendered).toContain('<h2>Description</h2>');
      for (const snippet of output.installSnippets)
        expect(rendered).toContain(escaped(snippet.payload));
      expect(rendered).toContain('<code>fixture_`tool</code>');
      expect(rendered).toContain('<h2>Composes with</h2>');
      expect(rendered).toContain('<code>fixture-`companion</code>');
      // The composesWith entry adds exactly one intact copy of the literal to the parsed text.
      const copies = (result: typeof output) =>
        html(
          describeEntryTool.format!({ result })
            .map((b) => ('text' in b ? b.text : ''))
            .join('\n'),
        ).split(escaped(literal)).length;
      expect(copies(output) - copies({ ...output, composesWith: [] })).toBe(1);
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
