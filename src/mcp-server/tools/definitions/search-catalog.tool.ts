/**
 * @fileoverview cyanheads_search_catalog — semantic search across fleet tools and servers.
 * Embeds the query at runtime and dot-products against in-memory L2-normalized
 * document vectors loaded from fleet.json; with the query omitted, lists the
 * catalog's entries in name order instead.
 * @module mcp-server/tools/definitions/search-catalog
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createCounter, markdown } from '@cyanheads/mcp-ts-core/utils';
import { clampLimitsEnabled } from '@/config/server-config.js';
import { getCatalogService } from '@/services/catalog/service-instance.js';
import type { CatalogEntry, CatalogRecord } from '@/services/catalog/types.js';

/**
 * Upper bound on the query string. A natural-language capability description
 * runs one to a few sentences; 500 characters covers a generously long
 * multi-sentence query while keeping oversized input away from the embedding
 * model, which is the most expensive step in the request path.
 */
const QUERY_MAX_LENGTH = 500;

/**
 * Most results one call returns. It bounds response size, not work: the full
 * match set is ranked in memory before the page is sliced, and a page this size
 * of the heaviest tool rows stays under about 1 MB per surface.
 */
const LIMIT_CAP = 1000;

/** Server roll-up rows per page. */
const SERVERS_CAP = 10;

/** The `limit` maximum: none while clamping, `LIMIT_CAP` when `CATALOG_CLAMP_LIMITS=false`. */
const strictLimitMax = () => (clampLimitsEnabled() ? undefined : LIMIT_CAP);

/** Calls whose `limit` exceeded `LIMIT_CAP` and were served at it. */
const limitClamps = createCounter(
  'mcp.input.count_clamped',
  'Calls whose count input exceeded the per-call cap and were served at it',
  '{calls}',
);

/** A blank from a form client is "unset", never a value to validate. */
const blankAsUnset = (value: unknown) => (value === '' ? undefined : value);

export const searchCatalogTool = tool('cyanheads_search_catalog', {
  title: 'Search Fleet Tools and Servers',
  description:
    'Search fleet tools and servers by natural-language description. Returns ranked matches with the full catalog description of each entry and the server each tool belongs to. Omit query to list every tool or server in name order instead, optionally filtered by category. Use scope "servers" to find which server handles a workflow; use the default scope "tools" to find specific tools.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  auth: ['tool:cyanheads_search_catalog:read'],

  input: z.object({
    query: z
      .preprocess(
        blankAsUnset,
        z
          .string()
          .min(1)
          .max(QUERY_MAX_LENGTH)
          .regex(/\S/u, 'Query must contain a non-whitespace character.')
          .optional(),
      )
      .describe(
        `Natural language search query. Describe what you want to accomplish, a workflow, or a capability area. 1-${QUERY_MAX_LENGTH} raw characters; surrounding whitespace is trimmed. Must contain non-whitespace text. Omit to list every entry in the scope in name order instead.`,
      ),
    scope: z
      .preprocess(blankAsUnset, z.enum(['tools', 'servers']).default('tools'))
      .describe(
        'What to search or list. "tools" returns individual tool matches; "servers" returns server-level matches.',
      ),
    category: z
      .preprocess(
        blankAsUnset,
        z.enum(['research', 'government', 'public-data', 'utility']).optional(),
      )
      .describe(
        'Filter by catalog category. Omit to include all categories. Categories are catalog labels, not publisher types (a federal agency API can be public-data), and a wrong guess silently drops the matching server, so set this only when the category is known.',
      ),
    /**
     * `.int()` would advertise and enforce the safe-integer maximum, so a larger
     * count could never reach the clamp. The whole-number check runs here with
     * the issue `.int()` raises, and the cap is enforced only with clamping off;
     * the getter advertises the same maximum the check enforces.
     */
    limit: z
      .number()
      .min(1)
      .check((ctx) => {
        if (!Number.isInteger(ctx.value)) {
          ctx.issues.push({ code: 'invalid_type', expected: 'int', input: ctx.value });
          return;
        }
        const maximum = strictLimitMax();
        if (maximum !== undefined && ctx.value > maximum) {
          ctx.issues.push({
            code: 'too_big',
            origin: 'number',
            maximum,
            inclusive: true,
            input: ctx.value,
          });
        }
      })
      .default(5)
      .meta({
        type: 'integer',
        get maximum() {
          return strictLimitMax();
        },
      })
      .describe(
        `Maximum number of results to return. Default 5; one call returns at most ${LIMIT_CAP}, with a notice naming the offset to continue from when more matches follow.`,
      ),
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
        'Independent server roll-up offset (10 per page). Use nextServersOffset; must be zero in servers scope and when query is omitted.',
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
      .describe('Current server roll-up offset; tools-scope searches only.'),
    nextServersOffset: z
      .number()
      .nullable()
      .optional()
      .describe('Next server roll-up offset, or null when exhausted; tools-scope searches only.'),
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
                'Server package name that owns this tool (e.g. "arxiv-mcp-server"). Same as name when scope is "servers". Pass name and server to cyanheads_describe_entry to describe exactly this row.',
              ),
            brief: z
              .string()
              .describe(
                "The tool's full catalog description, or the server's description in servers scope.",
              ),
            category: z
              .enum(['research', 'government', 'public-data', 'utility'])
              .describe('Catalog category for the owning server.'),
            score: z
              .number()
              .optional()
              .describe(
                'Cosine similarity between query and entry, in [0, 1]. Higher is better. Compare only within a single response. Absent when query is omitted.',
              ),
          })
          .describe('A single search result entry.'),
      )
      .describe(
        'Ranked matches, best first; with query omitted, every listed entry in name order.',
      ),
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
        'Server roll-up from the full match set, independent of result offset/limit. Tools-scope searches only. Ordered by topScore desc (name-tiebroken); 10 per page starting at serversOffset. Use nextServersOffset to continue and serversTotal for the full distinct count.',
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
    effectiveQuery: z
      .string()
      .optional()
      .describe('The query that was searched. Absent when query is omitted.'),
    totalCount: z
      .number()
      .describe(
        'Total relevant matches, or listed entries when query is omitted, before the limit was applied.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        `True when limit exceeded the ${LIMIT_CAP}-per-call cap and more matches follow this page.`,
      ),
    shown: z.number().optional().describe('Results returned on this capped page.'),
    cap: z.number().optional().describe('Per-call result cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        `Guidance for zero matches, an exhausted result page, or a page cut to the ${LIMIT_CAP}-per-call cap with more matches following (names the offset to continue from). Absent otherwise.`,
      ),
  },

  errors: [
    {
      reason: 'invalid_servers_offset',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonzero serversOffset is supplied in servers scope or with query omitted.',
      recovery:
        'Set serversOffset to zero in servers scope and when query is omitted; use offset to page results.',
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
    const query = input.query?.trim();
    // A listing has no roll-up to page, exactly like servers scope.
    if (input.serversOffset !== 0 && (input.scope === 'servers' || query === undefined)) {
      throw ctx.fail('invalid_servers_offset');
    }
    const servedLimit = Math.min(input.limit, LIMIT_CAP);
    ctx.log.info('Searching catalog', {
      query,
      scope: input.scope,
      limit: input.limit,
      servedLimit,
    });
    if (servedLimit < input.limit) {
      limitClamps.add(1, {
        'mcp.tool.name': 'cyanheads_search_catalog',
        'mcp.input.field': 'limit',
      });
    }

    const catalog = getCatalogService();
    const filter = { scope: input.scope, ...(input.category ? { category: input.category } : {}) };
    const ranked = query === undefined ? undefined : await catalog.search({ query, ...filter });
    const matches: readonly (CatalogEntry & { score?: number })[] = ranked ?? catalog.list(filter);
    const totalMatched = matches.length;

    if (query !== undefined) ctx.enrich.echo(query);
    ctx.enrich.total(totalMatched);

    /**
     * `ctx.enrich.notice()` is last-wins. These notices and the truncation
     * guidance below are exclusive: a cut page has a next offset, so it has
     * rows, and a page with rows is neither empty nor past the end.
     */
    const otherScope = input.scope === 'tools' ? 'servers' : 'tools';
    if (totalMatched === 0 && query === undefined) {
      /**
       * An empty listing means the filter selects nothing. With a category, the
       * other scope lists something only when that category's servers expose no
       * tools; a category with no servers is empty in both scopes.
       */
      const listHint = input.category
        ? `Remove the category filter${catalog.list({ ...filter, scope: otherScope }).length ? ` or switch to scope "${otherScope}"` : ''}.`
        : `Switch to scope "${otherScope}".`;
      ctx.enrich.notice(
        `No ${input.scope} ${input.category ? `in category "${input.category}"` : 'in the catalog'}. ${listHint}`,
      );
    } else if (totalMatched === 0) {
      ctx.enrich.notice(
        `No ${input.scope} matched. Try broadening the query${input.category ? ', removing the category filter,' : ''} or switching to scope "${otherScope}".`,
      );
    } else if (input.offset >= totalMatched) {
      ctx.enrich.notice(
        'No results on this page. Use offset 0 to return to the first result page.',
      );
    }

    const results = matches
      .slice(input.offset, input.offset + servedLimit)
      .map(({ name, server, brief, category, score }) => ({
        name,
        server,
        brief,
        category,
        ...(score === undefined ? {} : { score }),
      }));
    const nextOffset =
      input.offset + results.length < totalMatched ? input.offset + results.length : null;
    const page = { results, scope: input.scope, offset: input.offset, nextOffset };

    if (input.limit > LIMIT_CAP && nextOffset !== null) {
      const remaining = totalMatched - nextOffset;
      ctx.enrich.truncated({
        shown: results.length,
        cap: LIMIT_CAP,
        guidance: `limit ${input.limit} exceeds the per-call cap of ${LIMIT_CAP}; ${remaining} more ${remaining === 1 ? 'result follows' : 'results follow'}. Continue with offset ${nextOffset}.`,
      });
    }

    ctx.log.info('Search complete', { totalMatched, returned: results.length });

    if (ranked === undefined || input.scope === 'servers') return page;

    /**
     * Server roll-up from the full match set (before the page slice). Each
     * server's description and category come from the record that scored its
     * rows: a refresh during the query embedding can swap the catalog, and the
     * live one may no longer hold that server.
     */
    const serverMap = new Map<
      string,
      { record: CatalogRecord; matchedTools: number; topScore: number }
    >();
    for (const r of ranked) {
      const existing = serverMap.get(r.server);
      if (existing) {
        existing.matchedTools++;
        if (r.score > existing.topScore) existing.topScore = r.score;
      } else {
        serverMap.set(r.server, { record: r.serverRecord, matchedTools: 1, topScore: r.score });
      }
    }

    const serversTotal = serverMap.size;
    const servers = Array.from(serverMap.entries())
      .sort(([nameA, a], [nameB, b]) => b.topScore - a.topScore || nameA.localeCompare(nameB))
      .slice(input.serversOffset, input.serversOffset + SERVERS_CAP)
      .map(([name, agg]) => ({
        name,
        brief: agg.record.description,
        category: agg.record.category,
        matchedTools: agg.matchedTools,
        topScore: agg.topScore,
      }));

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
        const score = item.score === undefined ? '' : `  |  **Score:** ${item.score.toFixed(3)}`;
        lines.push(`### ${label(item.name)}`);
        lines.push(`**Server:** ${label(item.server)}\n\n**Category:** ${item.category}${score}`);
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
