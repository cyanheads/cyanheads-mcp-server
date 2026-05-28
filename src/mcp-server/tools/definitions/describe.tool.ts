/**
 * @fileoverview cyanheads_describe — return connection URL and per-client install snippets
 * for a named tool or server.
 * Uses z.discriminatedUnion on 'kind' so the linter walks each branch independently
 * and format() can dispatch cleanly.
 * @module mcp-server/tools/definitions/describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCatalogService } from '@/services/catalog/catalog-service.js';
import { buildAllSnippets } from '@/services/catalog/snippets.js';

export const describeTool = tool('cyanheads_describe', {
  title: 'Describe Fleet Tool or Server',
  description:
    'Return the description, connection URL, and per-client install snippets for a named tool or ' +
    'server. For tools: the description and the server it belongs to. ' +
    'For servers: connection URL and install snippets for every supported client (or one specific ' +
    'client when the client parameter is specified). Call cyanheads_search first to find valid names.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  auth: ['tool:cyanheads_describe:read'],

  input: z.object({
    name: z
      .string()
      .min(1)
      .describe(
        'Tool name (snake_case, e.g. "earthquake_search") or server name ' +
          '(kebab-case, e.g. "earthquake-mcp-server"). Use cyanheads_search to discover valid names.',
      ),
    kind: z
      .enum(['tool', 'server'])
      .optional()
      .describe(
        'Whether name refers to a tool or server. Omit to auto-detect: names containing ' +
          'underscores are treated as tools; names containing hyphens are treated as servers.',
      ),
    client: z
      .enum(['claude-desktop', 'claude-code', 'cursor', 'cline'])
      .optional()
      .describe(
        'Return the install snippet for this specific client only. ' +
          'Omit to return snippets for all supported clients.',
      ),
  }),

  output: z.object({
    result: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('tool').describe('Resolved as a tool entry.'),
          name: z.string().describe('Resolved name (as looked up).'),
          description: z.string().describe('Brief description of what the tool does.'),
          server: z.string().describe('Server package name that owns this tool.'),
        }),
        z.object({
          kind: z.literal('server').describe('Resolved as a server entry.'),
          name: z.string().describe('Resolved name (as looked up).'),
          displayName: z.string().describe('Human-readable server label.'),
          description: z.string().describe('Brief description of what the server does.'),
          version: z.string().describe('Published version captured at fleet-generation time.'),
          npm: z.string().describe('npm package name (e.g. "@cyanheads/arxiv-mcp-server").'),
          github: z.string().describe('GitHub repository URL.'),
          endpoint: z.string().describe('HTTP SSE endpoint for the hosted deployment.'),
          auth: z
            .string()
            .describe('Auth requirement for the hosted deployment (currently always "none").'),
          toolCount: z.number().describe('Number of tools exposed by this server.'),
          installSnippets: z
            .array(
              z
                .object({
                  client: z
                    .enum(['claude-desktop', 'claude-code', 'cursor', 'cline'])
                    .describe('MCP client this snippet targets.'),
                  label: z.string().describe('Human-readable install method label.'),
                  payload: z.string().describe('Install payload (JSON fragment or CLI command).'),
                })
                .describe('A single install instruction entry.'),
            )
            .describe(
              'Install instructions, one per supported client (or filtered by input.client).',
            ),
        }),
      ])
      .describe(
        'The resolved entry — either a tool detail or a server detail depending on the resolved kind.',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No tool or server with the given name exists in the catalog.',
      recovery:
        'Use cyanheads_search to find the correct name, then call cyanheads_describe again.',
    },
    {
      reason: 'ambiguous_kind',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Name matches both a tool and a server (collision in catalog).',
      recovery: 'Set the kind parameter to "tool" or "server" to disambiguate.',
    },
    {
      reason: 'catalog_empty',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Catalog has not finished loading.',
      recovery: 'Retry in a few seconds; the catalog is still loading.',
      retryable: true,
    },
  ],

  // biome-ignore lint/suspicious/useAwait: handler has no I/O but must return a Promise for the framework
  async handler(input, ctx) {
    ctx.log.info('Describing catalog entry', { name: input.name, kind: input.kind });

    const catalog = getCatalogService();

    // Resolve kind: explicit > auto-detect from name format.
    let resolvedKind = input.kind;
    if (!resolvedKind) {
      // Fleet invariant: tool names use underscores, server names use hyphens.
      if (input.name.includes('_')) {
        resolvedKind = 'tool';
      } else if (input.name.includes('-')) {
        resolvedKind = 'server';
      }
    }

    const toolEntry = resolvedKind !== 'server' ? catalog.getTool(input.name) : null;
    const serverEntry = resolvedKind !== 'tool' ? catalog.getServer(input.name) : null;

    // Ambiguity check (can happen if resolvedKind is undefined and name has neither _ nor -).
    if (toolEntry && serverEntry) {
      throw ctx.fail('ambiguous_kind', `"${input.name}" matches both a tool and a server`, {
        ...ctx.recoveryFor('ambiguous_kind'),
        name: input.name,
      });
    }

    if (toolEntry) {
      return {
        result: {
          kind: 'tool' as const,
          name: input.name,
          description: toolEntry.description,
          server: toolEntry.serverRecord.name,
        },
      };
    }

    if (serverEntry) {
      const allSnippets = buildAllSnippets(serverEntry);
      const snippets = input.client
        ? allSnippets.filter((s) => s.client === input.client)
        : allSnippets;

      return {
        result: {
          kind: 'server' as const,
          name: input.name,
          displayName: serverEntry.displayName,
          description: serverEntry.description,
          version: serverEntry.version,
          npm: serverEntry.npm,
          github: serverEntry.github,
          endpoint: serverEntry.endpoint,
          auth: serverEntry.auth,
          toolCount: serverEntry.tools.length,
          installSnippets: snippets,
        },
      };
    }

    throw ctx.fail('not_found', `No tool or server named "${input.name}" in the catalog`, {
      ...ctx.recoveryFor('not_found'),
      name: input.name,
    });
  },

  format: ({ result }) => {
    const lines: string[] = [];

    if (result.kind === 'tool') {
      lines.push(`# Tool: ${result.name}`);
      lines.push(`**Server:** ${result.server}`);
      lines.push('');
      lines.push(`**Kind:** tool`);
      lines.push('');
      lines.push(`## Description`);
      lines.push(result.description);
    } else {
      lines.push(`# Server: ${result.name}`);
      lines.push(`**Kind:** server`);
      lines.push(`**Display name:** ${result.displayName}`);
      lines.push(`**Version:** ${result.version}`);
      lines.push(`**npm:** ${result.npm}`);
      lines.push(`**GitHub:** ${result.github}`);
      lines.push(`**Auth:** ${result.auth}`);
      lines.push(`**Tool count:** ${result.toolCount}`);
      lines.push(`**Endpoint:** ${result.endpoint}`);
      lines.push('');
      lines.push('## Description');
      lines.push(result.description);
      lines.push('');
      lines.push('## Install Snippets');
      for (const snippet of result.installSnippets) {
        lines.push(`### ${snippet.label} (${snippet.client})`);
        lines.push('```');
        lines.push(snippet.payload);
        lines.push('```');
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
