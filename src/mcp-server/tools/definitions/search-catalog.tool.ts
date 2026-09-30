/**
 * @fileoverview cyanheads_search_catalog — semantic search across fleet tools and servers.
 * Embeds the query at runtime and dot-products against in-memory L2-normalized
 * document vectors loaded from fleet.json.
 * @module mcp-server/tools/definitions/search-catalog
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { getCatalogService } from '@/services/catalog/service-instance.js';

/**
 * Upper bound on the query string. A natural-language capability description
 * runs one to a few sentences; 500 characters covers a generously long
 * multi-sentence query while keeping oversized input away from the embedding
 * model, which is the most expensive step in the request path.
 */
const QUERY_MAX_LENGTH = 500;

export const searchCatalogTool = tool('cyanheads_search_catalog', {
  title: 'Search Fleet Tools and Servers',
  description:
    'Search fleet tools and servers by natural-language description. Returns ranked matches with ' +
    'brief summaries and the server each tool belongs to. Use scope "servers" to find which ' +
    'server handles a workflow; use the default scope "tools" to find specific tools.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  auth: ['tool:cyanheads_search_catalog:read'],

  input: z.object({
    query: z
      .string()
      .min(1)
      .max(QUERY_MAX_LENGTH)
      .regex(/\S/u, 'Query must contain a non-whitespace character.')
      .describe(
        'Natural language search query. Describe what you want to accomplish, a workflow, or a ' +
          `capability area. 1-${QUERY_MAX_LENGTH} raw characters; surrounding whitespace is trimmed. Must contain non-whitespace text.`,
      ),
    scope: z
      .enum(['tools', 'servers'])
      .default('tools')
      .describe(
        'What to search. "tools" returns individual tool matches; "servers" returns server-level matches.',
      ),
    category: z
      .enum(['research', 'government', 'public-data', 'utility'])
      .optional()
      .describe('Filter by catalog category. Omit to search all categories.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('Maximum number of results to return (1-20). Default 5.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Result offset. Use nextOffset with the same query, scope, category, and limit; pages use the current catalog.',
      ),
    serversOffset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Independent server roll-up offset (10 per page). Use nextServersOffset; must be zero in servers scope.',
      ),
  }),

  output: z.object({
    offset: z.number().describe('Current ranked-result offset.'),
    nextOffset: z
      .number()
      .nullable()
      .describe('Next ranked-result offset, or null when exhausted.'),
    serversOffset: z
      .number()
      .optional()
      .describe('Current server roll-up offset; tools scope only.'),
    nextServersOffset: z
      .number()
      .nullable()
      .optional()
      .describe('Next server roll-up offset, or null when exhausted; tools scope only.'),
    results: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe('Tool name (snake_case) or server name (kebab-case) depending on scope.'),
            server: z
              .string()
              .describe(
                'Server package name that owns this tool (e.g. "arxiv-mcp-server"). Same as name when scope is "servers".',
              ),
            brief: z.string().describe('One-line summary of what this tool or server does.'),
            category: z
              .enum(['research', 'government', 'public-data', 'utility'])
              .describe('Catalog category for the owning server.'),
            score: z
              .number()
              .describe(
                'Cosine similarity between query and entry, in [0, 1]. Higher is better. Compare only within a single response.',
              ),
          })
          .describe('A single search result entry.'),
      )
      .describe('Ranked matches, best first.'),
    scope: z.enum(['tools', 'servers']).describe('Scope that was searched.'),
    servers: z
      .array(
        z
          .object({
            name: z.string().describe('Server package name (e.g. "cdc-health-mcp-server").'),
            brief: z.string().describe('One-line description of what the server does.'),
            category: z
              .enum(['research', 'government', 'public-data', 'utility'])
              .describe('Catalog category.'),
            matchedTools: z
              .number()
              .describe("Count of this server's tools in the full match set."),
            topScore: z
              .number()
              .describe(
                'Best cosine similarity among this server\'s matched tools. Drives ordering. Distinct from the score a server gets under scope "servers".',
              ),
          })
          .describe('A server roll-up entry.'),
      )
      .optional()
      .describe(
        'Server roll-up from the full match set, independent of result offset/limit. Tools scope only. Ordered by topScore desc (name-tiebroken); 10 per page starting at serversOffset. Use nextServersOffset to continue and serversTotal for the full distinct count.',
      ),
    serversTotal: z
      .number()
      .optional()
      .describe(
        'Total distinct servers in the full match set (before the cap of 10 is applied). Present only when servers is present.',
      ),
  }),

  // Agent-facing search context — query echo, total count, empty-result guidance.
  // Reaches both structuredContent and content[] trailer; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('The query that was searched.'),
    totalCount: z.number().describe('Total relevant matches before the limit was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for zero matches or an exhausted result page. Absent on nonempty result pages.',
      ),
  },

  errors: [
    {
      reason: 'invalid_servers_offset',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonzero serversOffset is supplied in servers scope.',
      recovery: 'Set serversOffset to zero in servers scope; use offset to page server results.',
    },
    {
      reason: 'catalog_empty',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Catalog has not finished loading.',
      recovery: 'Retry in a few seconds; the catalog is still loading.',
      retryable: true,
      // Raised below the handler: getCatalogService() and CatalogService's own
      // _assertInitialized() both throw serviceUnavailable with this reason, so
      // no ctx.fail site here names it.
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (input.scope === 'servers' && input.serversOffset !== 0) {
      throw ctx.fail('invalid_servers_offset');
    }
    const query = input.query.trim();
    ctx.log.info('Searching catalog', {
      query,
      scope: input.scope,
      limit: input.limit,
    });

    const catalog = getCatalogService();

    const allResults = await catalog.search({
      query,
      scope: input.scope,
      ...(input.category ? { category: input.category } : {}),
    });

    const totalMatched = allResults.length;

    ctx.enrich.echo(query);
    ctx.enrich.total(totalMatched);

    if (totalMatched === 0) {
      ctx.enrich.notice(
        `No ${input.scope} matched. Try broadening the query${input.category ? ', removing the category filter,' : ''} or switching to scope "${input.scope === 'tools' ? 'servers' : 'tools'}".`,
      );
    } else if (input.offset >= totalMatched) {
      ctx.enrich.notice(
        'No results on this page. Use offset 0 to return to the first result page.',
      );
    }

    const results = allResults.slice(input.offset, input.offset + input.limit);
    const page = {
      results,
      scope: input.scope,
      offset: input.offset,
      nextOffset:
        input.offset + results.length < totalMatched ? input.offset + results.length : null,
    };

    ctx.log.info('Search complete', { totalMatched, returned: results.length });

    if (input.scope === 'tools') {
      // Build server roll-up from the full match set (before limit slice)
      const SERVERS_CAP = 10;
      const serverMap = new Map<string, { matchedTools: number; topScore: number }>();
      for (const r of allResults) {
        const existing = serverMap.get(r.server);
        if (existing) {
          existing.matchedTools++;
          if (r.score > existing.topScore) existing.topScore = r.score;
        } else {
          serverMap.set(r.server, { matchedTools: 1, topScore: r.score });
        }
      }

      const serversTotal = serverMap.size;
      const servers = Array.from(serverMap.entries())
        .sort(([nameA, a], [nameB, b]) => b.topScore - a.topScore || nameA.localeCompare(nameB))
        .slice(input.serversOffset, input.serversOffset + SERVERS_CAP)
        .map(([name, agg]) => {
          const record = catalog.getServer(name);
          return {
            name,
            brief: record?.description ?? '',
            category: record?.category ?? ('utility' as const),
            matchedTools: agg.matchedTools,
            topScore: agg.topScore,
          };
        });

      return {
        ...page,
        servers,
        serversTotal,
        serversOffset: input.serversOffset,
        nextServersOffset:
          input.serversOffset + servers.length < serversTotal
            ? input.serversOffset + servers.length
            : null,
      };
    }

    return page;
  },

  format: (result) => {
    const label = (value: string) =>
      /[\r\n]/u.test(value)
        ? `\n\n${markdown().codeBlock(value).build()}`
        : markdown().inlineCode(value).build();
    const lines: string[] = [
      `**Scope:** ${result.scope}`,
      `offset: ${result.offset}; nextOffset: ${result.nextOffset}`,
      '',
    ];

    if (result.results.length === 0) {
      lines.push(result.offset > 0 ? 'No results on this page.' : 'No results matched.');
    } else {
      for (const item of result.results) {
        lines.push(`### ${label(item.name)}`);
        lines.push(
          `**Server:** ${label(item.server)}\n\n**Category:** ${item.category}  |  **Score:** ${item.score.toFixed(3)}`,
        );
        lines.push(markdown().codeBlock(item.brief).build());
        lines.push('');
      }
    }

    if (result.servers) {
      lines.push(
        `serversOffset: ${result.serversOffset}; nextServersOffset: ${result.nextServersOffset}`,
      );
      const cap = result.servers.length;
      const total = result.serversTotal ?? cap;
      const header = total > cap ? `## Servers (showing ${cap} of ${total})` : '## Servers';
      lines.push(header);
      lines.push('');
      for (const s of result.servers) {
        lines.push(
          `${label(s.name)}\n\n(${s.category}) — ${s.matchedTools} matched tool${s.matchedTools === 1 ? '' : 's'}, top score ${s.topScore.toFixed(3)}`,
        );
        lines.push(markdown().codeBlock(s.brief).build());
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
