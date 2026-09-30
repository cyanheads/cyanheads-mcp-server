/**
 * @fileoverview cyanheads_describe_entry — return connection URL and per-client install snippets
 * for a named tool or server.
 * Uses z.discriminatedUnion on 'kind' so the linter walks each branch independently
 * and format() can dispatch cleanly.
 * @module mcp-server/tools/definitions/describe-entry
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
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
    'description, owning server, and connection metadata. For either kind: local (stdio, via npx) install ' +
    'snippets for every published server, plus remote (HTTP) connection snippets when a hosted ' +
    'endpoint exists — for every supported client, or one client via the client parameter.',
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
          `${NAME_MAX_LENGTH} characters. Exact names win; unique case-insensitive names resolve to canonical names. Use cyanheads_search_catalog to discover valid names.`,
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
            name: z.string().describe('Canonical resolved tool name.'),
            description: z.string().describe('Brief description of what the tool does.'),
            server: z.string().describe('Server package name that owns this tool.'),
            npm: z.string().describe('Owning server npm package for local installation.'),
            github: z.string().describe('Owning server GitHub repository URL.'),
            endpoint: z
              .string()
              .optional()
              .describe('Owning server hosted HTTP endpoint, when available.'),
            auth: z.string().describe('Owning server hosted authentication requirement.'),
            requiredEnvVars: z
              .array(z.string())
              .optional()
              .describe('Environment variable names required for local installation.'),
            installNotice: z
              .string()
              .optional()
              .describe(
                'Actionable guidance when the requested client has no compatible installation snippet.',
              ),
            installSnippets: z
              .array(
                z
                  .object({
                    client: z
                      .enum(['claude-code', 'codex', 'cursor', 'curl', 'gemini', 'streamable-http'])
                      .describe('Target MCP client.'),
                    transport: z
                      .enum(['stdio', 'http'])
                      .describe('Local stdio or hosted HTTP transport.'),
                    label: z.string().describe('Install method label.'),
                    payload: z.string().describe('Install command or configuration.'),
                  })
                  .describe('An installation snippet for the owning server.'),
              )
              .describe('Owning server install snippets, filtered by client when supplied.'),
          })
          .describe('A resolved tool entry — its description and the server that owns it.'),
        z
          .object({
            kind: z.literal('server').describe('Resolved as a server entry.'),
            name: z.string().describe('Canonical resolved server name.'),
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
            installNotice: z
              .string()
              .optional()
              .describe(
                'Actionable guidance when the requested client has no compatible installation snippet.',
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
      // Raised below the handler: getCatalogService() and CatalogService's own
      // _assertInitialized() both throw serviceUnavailable with this reason, so
      // no ctx.fail site here names it.
      thrownBy: 'service',
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
        name: input.name,
      });
    }

    const owner = toolEntry?.serverRecord ?? serverEntry;
    if (!owner) {
      throw ctx.fail('not_found', `No tool or server named "${input.name}" in the catalog`, {
        name: input.name,
      });
    }
    const allSnippets = buildAllSnippets(owner);
    const snippets = input.client
      ? allSnippets.filter((s) => s.client === input.client)
      : allSnippets;
    const connection = {
      npm: owner.npm,
      github: owner.github,
      ...(owner.endpoint ? { endpoint: owner.endpoint } : {}),
      auth: owner.auth,
      ...(owner.requiredEnvVars?.length ? { requiredEnvVars: owner.requiredEnvVars } : {}),
      installSnippets: snippets,
      ...(input.client && snippets.length === 0
        ? {
            installNotice:
              'curl requires a hosted HTTP endpoint. This server supports local stdio installation; call cyanheads_describe_entry again with client "codex" for an install command.',
          }
        : {}),
    };

    if (toolEntry) {
      return {
        result: {
          kind: 'tool' as const,
          name: toolEntry.name,
          description: toolEntry.description,
          server: toolEntry.serverRecord.name,
          ...connection,
        },
      };
    }

    return {
      result: {
        kind: 'server' as const,
        name: owner.name,
        displayName: owner.displayName,
        description: owner.description,
        version: owner.version,
        ...connection,
        toolCount: owner.tools.length,
        tools: owner.tools.map((t) => ({ name: t.name, description: t.description })),
      },
    };
  },

  format: ({ result }) => {
    const md = markdown();
    const label = (value: string) =>
      /[\r\n]/u.test(value)
        ? `\n\n${markdown().codeBlock(value).build()}`
        : markdown().inlineCode(value).build();
    md.h1(`${result.kind === 'tool' ? 'Tool' : 'Server'}: ${label(result.name)}`).keyValue(
      'Kind',
      result.kind,
    );
    if (result.kind === 'tool') md.keyValue('Server', label(result.server));
    else {
      md.keyValue('Display name', label(result.displayName))
        .keyValue('Version', label(result.version))
        .keyValue('Tool count', result.toolCount);
    }
    md.keyValue('npm', label(result.npm))
      .keyValue('GitHub', label(result.github))
      .keyValue('Auth', label(result.auth))
      .h2('Description')
      .codeBlock(result.description);
    if (result.kind === 'server' && result.tools.length) {
      md.h2('Tools');
      for (const entry of result.tools) md.h3(label(entry.name)).codeBlock(entry.description);
    }
    if (result.requiredEnvVars?.length) {
      md.h2('Required env vars');
      for (const name of result.requiredEnvVars) md.codeBlock(name);
      md.paragraph('Set these environment variables before starting the local server.');
    }
    if (result.installNotice) md.paragraph(result.installNotice);
    const local = result.installSnippets.filter((s) => s.transport === 'stdio');
    const remote = result.installSnippets.filter((s) => s.transport === 'http');
    if (local.length) {
      md.h2('Local install (stdio)');
      for (const snippet of local)
        md.h3(label(snippet.label)).keyValue('Client', snippet.client).codeBlock(snippet.payload);
    }
    if (result.endpoint) {
      md.h2('Remote install (HTTP)').keyValue('Endpoint', label(result.endpoint));
      for (const snippet of remote)
        md.h3(label(snippet.label)).keyValue('Client', snippet.client).codeBlock(snippet.payload);
    }
    return [{ type: 'text', text: md.build() }];
  },
});
