/**
 * @fileoverview cyanheads_search — semantic search across fleet tools and servers.
 * Embeds the query at runtime and dot-products against in-memory L2-normalized
 * document vectors loaded from fleet.json.
 * @module mcp-server/tools/definitions/search
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCatalogService } from '@/services/catalog/catalog-service.js';

export const searchTool = tool('cyanheads_search', {
  title: 'Search Fleet Tools and Servers',
  description:
    'Search fleet tools and servers by natural-language description. Returns ranked matches with ' +
    'brief summaries and the server each tool belongs to. Use scope "servers" to find which ' +
    'server handles a workflow; use the default scope "tools" to find specific tools. ' +
    'Call cyanheads_describe on a result name to get install snippets and the connection URL.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  auth: ['tool:cyanheads_search:read'],

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Natural language search query. Describe what you want to accomplish, a workflow, or a capability area.',
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
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'Query produced no relevant matches.',
      recovery:
        'Broaden the query, remove the category filter, or try scope "servers" to find the right server first.',
    },
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
      throw ctx.fail('no_results', `No ${input.scope} matched "${input.query}"`, {
        ...ctx.recoveryFor('no_results'),
        query: input.query,
        scope: input.scope,
        category: input.category,
      });
    }

    const results = allResults.slice(0, input.limit);

    ctx.log.info('Search complete', { totalMatched, returned: results.length });

    return {
      results,
      scope: input.scope,
    };
  },

  format: (result) => {
    const lines: string[] = [`**Scope:** ${result.scope}`, ''];
    for (const item of result.results) {
      lines.push(`### ${item.name}`);
      lines.push(
        `**Server:** ${item.server}  |  **Category:** ${item.category}  |  **Score:** ${item.score.toFixed(3)}`,
      );
      lines.push(item.brief);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
