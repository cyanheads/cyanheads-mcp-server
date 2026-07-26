/**
 * @fileoverview cyanheads_search_catalog — semantic search across fleet tools and servers.
 * Embeds the query at runtime and dot-products against in-memory L2-normalized
 * document vectors loaded from fleet.json.
 * @module mcp-server/tools/definitions/search-catalog
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
    'server handles a workflow; use the default scope "tools" to find specific tools. ' +
    'Call cyanheads_describe_entry on a result name to get install snippets and the connection URL.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  auth: ['tool:cyanheads_search_catalog:read'],

  input: z.object({
    query: z
      .string()
      .min(1)
      .max(QUERY_MAX_LENGTH)
      .describe(
        'Natural language search query. Describe what you want to accomplish, a workflow, or a ' +
          `capability area. 1-${QUERY_MAX_LENGTH} characters.`,
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
  }),

  output: z.object({
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
        'Roll-up of distinct servers across the full match set, before the limit slice. Present only for scope "tools". Ordered by topScore desc (name-tiebroken); capped at 10. Use serversTotal to see how many distinct servers matched in total.',
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
        'Guidance when no results matched — e.g. how to broaden the query or try a different scope. Absent on successful result pages.',
      ),
  },

  errors: [
    {
      reason: 'catalog_empty',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Catalog has not finished loading.',
      recovery: 'Retry in a few seconds; the catalog is still loading.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Searching catalog', {
      query: input.query,
      scope: input.scope,
      limit: input.limit,
    });

    const catalog = getCatalogService();

    const allResults = await catalog.search({
      query: input.query,
      scope: input.scope,
      ...(input.category ? { category: input.category } : {}),
    });

    const totalMatched = allResults.length;

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalMatched);

    if (totalMatched === 0) {
      ctx.enrich.notice(
        `No ${input.scope} matched "${input.query}". Try broadening the query${input.category ? ', removing the category filter,' : ''} or switching to scope "${input.scope === 'tools' ? 'servers' : 'tools'}".`,
      );
      return { results: [], scope: input.scope };
    }

    const results = allResults.slice(0, input.limit);

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
        .slice(0, SERVERS_CAP)
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

      return { results, scope: input.scope, servers, serversTotal };
    }

    return { results, scope: input.scope };
  },

  format: (result) => {
    const lines: string[] = [`**Scope:** ${result.scope}`, ''];

    if (result.results.length === 0) {
      lines.push('No results matched.');
    } else {
      for (const item of result.results) {
        lines.push(`### ${item.name}`);
        lines.push(
          `**Server:** ${item.server}  |  **Category:** ${item.category}  |  **Score:** ${item.score.toFixed(3)}`,
        );
        lines.push(item.brief);
        lines.push('');
      }
    }

    if (result.servers && result.servers.length > 0) {
      const cap = result.servers.length;
      const total = result.serversTotal ?? cap;
      const header = total > cap ? `## Servers (showing ${cap} of ${total})` : '## Servers';
      lines.push(header);
      lines.push('');
      for (const s of result.servers) {
        lines.push(
          `**${s.name}** (${s.category}) — ${s.matchedTools} matched tool${s.matchedTools === 1 ? '' : 's'}, top score ${s.topScore.toFixed(3)}`,
        );
        lines.push(s.brief);
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
