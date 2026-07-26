/**
 * @fileoverview cyanheads_describe_entry — return connection URL and per-client install snippets
 * for a named tool or server.
 * Uses z.discriminatedUnion on 'kind' so the linter walks each branch independently
 * and format() can dispatch cleanly.
 * @module mcp-server/tools/definitions/describe-entry
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCatalogService } from '@/services/catalog/service-instance.js';
import { buildAllSnippets } from '@/services/catalog/snippets.js';

/**
 * Upper bound on the entry name. Fleet identifiers are bounded in practice —
 * the longest catalog tool name is 42 characters and the longest server name is
 * 32 — so 64 leaves ample headroom for fleet growth while keeping the field
 * from being effectively unbounded.
 */
const NAME_MAX_LENGTH = 64;

export const describeEntryTool = tool('cyanheads_describe_entry', {
  title: 'Describe Fleet Tool or Server',
  description:
    'Return the description and install snippets for a named tool or server. For tools: the ' +
    'description and the server it belongs to. For servers: local (stdio, via npx) install ' +
    'snippets for every published server, plus remote (HTTP) connection snippets when a hosted ' +
    'endpoint exists — for every supported client, or one client via the client parameter. ' +
    'Call cyanheads_search_catalog first to find valid names.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  auth: ['tool:cyanheads_describe_entry:read'],

  input: z.object({
    name: z
      .string()
      .min(1)
      .max(NAME_MAX_LENGTH)
      .describe(
        'Tool name (snake_case, e.g. "earthquake_search") or server name ' +
          '(kebab-case, e.g. "earthquake-mcp-server"). 1-' +
          `${NAME_MAX_LENGTH} characters. Use cyanheads_search_catalog to discover valid names.`,
      ),
    kind: z
      .enum(['tool', 'server'])
      .optional()
      .describe(
        'Whether name refers to a tool or server. Omit to auto-detect: names containing ' +
          'underscores are treated as tools; names containing hyphens are treated as servers.',
      ),
    client: z
      .enum(['claude-code', 'codex', 'cursor', 'curl', 'gemini', 'streamable-http'])
      .optional()
      .describe(
        'Return install snippets for this client only (both local and remote transports when ' +
          'available). Omit to return snippets for all supported clients.',
      ),
  }),

  output: z.object({
    result: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('tool').describe('Resolved as a tool entry.'),
            name: z.string().describe('Resolved name (as looked up).'),
            description: z.string().describe('Brief description of what the tool does.'),
            server: z.string().describe('Server package name that owns this tool.'),
          })
          .describe('A resolved tool entry — its description and the server that owns it.'),
        z
          .object({
            kind: z.literal('server').describe('Resolved as a server entry.'),
            name: z.string().describe('Resolved name (as looked up).'),
            displayName: z.string().describe('Human-readable server label.'),
            description: z.string().describe('Brief description of what the server does.'),
            version: z.string().describe('Published version captured at fleet-generation time.'),
            npm: z
              .string()
              .describe(
                'npm package name (e.g. "@cyanheads/arxiv-mcp-server"). Drives the local stdio snippets.',
              ),
            github: z.string().describe('GitHub repository URL.'),
            endpoint: z
              .string()
              .optional()
              .describe(
                'Streamable HTTP endpoint for the hosted deployment. Absent for local-only (stdio) servers.',
              ),
            auth: z
              .string()
              .describe('Auth requirement for the hosted deployment (currently always "none").'),
            requiredEnvVars: z
              .array(z.string())
              .optional()
              .describe(
                'Env var names the local (stdio) install requires (e.g. ["MAILCHIMP_API_KEY"]). Absent when none.',
              ),
            toolCount: z.number().describe('Number of tools exposed by this server.'),
            tools: z
              .array(
                z
                  .object({
                    name: z.string().describe('Tool name (snake_case, e.g. "earthquake_search").'),
                    description: z.string().describe('Brief description of what the tool does.'),
                  })
                  .describe('A single tool exposed by this server.'),
              )
              .describe(
                'Every tool this server exposes, each with its name and a brief description — ' +
                  'one describe call reveals the full surface without a second lookup.',
              ),
            installSnippets: z
              .array(
                z
                  .object({
                    client: z
                      .enum(['claude-code', 'codex', 'cursor', 'curl', 'gemini', 'streamable-http'])
                      .describe('MCP client this snippet targets.'),
                    transport: z
                      .enum(['stdio', 'http'])
                      .describe(
                        'Transport this snippet installs — stdio (local) or http (remote).',
                      ),
                    label: z.string().describe('Human-readable install method label.'),
                    payload: z.string().describe('Install payload (JSON fragment or CLI command).'),
                  })
                  .describe('A single install instruction entry.'),
              )
              .describe(
                'Install instructions: local (stdio) snippets for every server, plus remote (HTTP) ' +
                  'snippets when an endpoint exists. Filtered to one client when input.client is set.',
              ),
          })
          .describe(
            'A resolved server entry — metadata, optional hosted endpoint, and per-client install snippets.',
          ),
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
        'Use cyanheads_search_catalog to find the correct name, then call cyanheads_describe_entry again.',
    },
    {
      reason: 'ambiguous_kind',
      code: JsonRpcErrorCode.ValidationError,
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
          ...(serverEntry.endpoint ? { endpoint: serverEntry.endpoint } : {}),
          auth: serverEntry.auth,
          ...(serverEntry.requiredEnvVars?.length
            ? { requiredEnvVars: serverEntry.requiredEnvVars }
            : {}),
          toolCount: serverEntry.tools.length,
          tools: serverEntry.tools.map((t) => ({ name: t.name, description: t.description })),
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
      lines.push('');
      lines.push('## Description');
      lines.push(result.description);
      lines.push('');

      if (result.tools.length > 0) {
        lines.push('## Tools');
        for (const t of result.tools) {
          lines.push(`- \`${t.name}\` — ${t.description}`);
        }
        lines.push('');
      }

      const local = result.installSnippets.filter((s) => s.transport === 'stdio');
      const remote = result.installSnippets.filter((s) => s.transport === 'http');

      if (local.length > 0) {
        lines.push('## Local install (stdio)');
        lines.push(
          'Run locally via npx — available for every published server, no hosting required.',
        );
        if (result.requiredEnvVars?.length) {
          lines.push('');
          lines.push(
            `**Required env vars:** ${result.requiredEnvVars.join(', ')} — set these for the server to work.`,
          );
        }
        lines.push('');
        for (const snippet of local) {
          lines.push(`### ${snippet.label} (${snippet.client})`);
          lines.push('```');
          lines.push(snippet.payload);
          lines.push('```');
          lines.push('');
        }
      }

      if (result.endpoint) {
        lines.push('## Remote install (HTTP)');
        lines.push(`**Endpoint:** ${result.endpoint}`);
        lines.push('');
        for (const snippet of remote) {
          lines.push(`### ${snippet.label} (${snippet.client})`);
          lines.push('```');
          lines.push(snippet.payload);
          lines.push('```');
          lines.push('');
        }
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
