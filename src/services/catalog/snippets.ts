/**
 * @fileoverview Per-client install snippet factories.
 * Snippets are derived at request time from a CatalogRecord — no precomputed snippet
 * list lives in the catalog JSON. Two transports per server:
 *   - stdio (local): built from `record.npm` via `npx -y <pkg>`. Available for every
 *     published server. The `curl` probe has no stdio analog, so it is HTTP-only.
 *   - http (remote): built from `record.endpoint`. Emitted only when the record has an
 *     endpoint (hosted servers).
 *
 * Required env vars (`record.requiredEnvVars`) are scaffolded into the JSON config
 * snippets as empty-valued `env` keys so the caller knows what to set; the CLI snippets
 * stay bare and runnable. All hosted servers run Streamable HTTP — the legacy `sse`
 * transport tag is never emitted.
 * @module services/catalog/snippets
 */

import type { CatalogRecord, InstallSnippet } from './types.js';

/** Factory for a local (stdio) snippet — needs only `record.npm`. */
type StdioFactory = (record: CatalogRecord) => InstallSnippet;

/** Factory for a remote (HTTP) snippet — needs the resolved hosted endpoint. */
type HttpFactory = (record: CatalogRecord, endpoint: string) => InstallSnippet;

/**
 * Protocol version in the curl probe's legacy `initialize` body: the latest
 * revision that opens with `initialize`. The probe sends no `MCP-Protocol-Version`
 * header — the spec requires it only after initialization, and a 2026-era header
 * on an `initialize` is rejected as a header/body mismatch.
 */
const CURL_INITIALIZE_PROTOCOL_VERSION = '2025-11-25';

/**
 * `env` block for a JSON config snippet — one empty-valued key per required var.
 * Returns nothing to spread when the server needs no configuration, so the `env`
 * block is omitted entirely rather than emitted empty.
 */
function envBlock(record: CatalogRecord): { env?: Record<string, string> } {
  const vars = record.requiredEnvVars;
  if (!vars || vars.length === 0) return {};
  return { env: Object.fromEntries(vars.map((name) => [name, ''])) };
}

// ---------------------------------------------------------------------------
// Local (stdio) factories — built from record.npm via `npx -y <pkg>`
// ---------------------------------------------------------------------------

/** `mcpServers` JSON with an explicit `type: 'stdio'` — the local shape Cline and Claude Desktop both load. */
function typedStdioConfig(record: CatalogRecord): string {
  return JSON.stringify(
    {
      mcpServers: {
        [record.name]: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', record.npm],
          ...envBlock(record),
        },
      },
    },
    null,
    2,
  );
}

function claudeCodeStdio(record: CatalogRecord): InstallSnippet {
  return {
    client: 'claude-code',
    transport: 'stdio',
    label: 'Claude Code (CLI)',
    payload: `claude mcp add --transport stdio ${record.name} -- npx -y ${record.npm}`,
  };
}

function clineStdio(record: CatalogRecord): InstallSnippet {
  return {
    client: 'cline',
    transport: 'stdio',
    label: 'Cline (cline_mcp_settings.json)',
    payload: typedStdioConfig(record),
  };
}

function codexStdio(record: CatalogRecord): InstallSnippet {
  return {
    client: 'codex',
    transport: 'stdio',
    label: 'Codex (CLI)',
    payload: `codex mcp add ${record.name} -- npx -y ${record.npm}`,
  };
}

function cursorStdio(record: CatalogRecord): InstallSnippet {
  return {
    client: 'cursor',
    transport: 'stdio',
    label: 'Cursor (mcp.json)',
    payload: JSON.stringify(
      {
        mcpServers: {
          [record.name]: { command: 'npx', args: ['-y', record.npm], ...envBlock(record) },
        },
      },
      null,
      2,
    ),
  };
}

function geminiStdio(record: CatalogRecord): InstallSnippet {
  return {
    client: 'gemini',
    transport: 'stdio',
    label: 'Gemini (CLI)',
    payload: `gemini mcp add ${record.name} npx -y ${record.npm}`,
  };
}

/** Generic `mcpServers` JSON (stdio) for Claude Desktop and other MCP clients. */
function genericStdio(record: CatalogRecord): InstallSnippet {
  return {
    client: 'streamable-http',
    transport: 'stdio',
    label: 'Claude Desktop / generic',
    payload: typedStdioConfig(record),
  };
}

// ---------------------------------------------------------------------------
// Remote (HTTP) factories — built from the hosted endpoint
// ---------------------------------------------------------------------------

function claudeCodeHttp(record: CatalogRecord, endpoint: string): InstallSnippet {
  return {
    client: 'claude-code',
    transport: 'http',
    label: 'Claude Code (CLI)',
    payload: `claude mcp add --transport http ${record.name} ${endpoint}`,
  };
}

/** Cline reads Streamable HTTP only under `type: 'streamableHttp'`; a URL entry with no `type` falls back to SSE. */
function clineHttp(record: CatalogRecord, endpoint: string): InstallSnippet {
  return {
    client: 'cline',
    transport: 'http',
    label: 'Cline (cline_mcp_settings.json)',
    payload: JSON.stringify(
      { mcpServers: { [record.name]: { type: 'streamableHttp', url: endpoint } } },
      null,
      2,
    ),
  };
}

function codexHttp(record: CatalogRecord, endpoint: string): InstallSnippet {
  return {
    client: 'codex',
    transport: 'http',
    label: 'Codex (CLI)',
    payload: `codex mcp add ${record.name} --url ${endpoint}`,
  };
}

function cursorHttp(record: CatalogRecord, endpoint: string): InstallSnippet {
  return {
    client: 'cursor',
    transport: 'http',
    label: 'Cursor (mcp.json)',
    payload: JSON.stringify({ mcpServers: { [record.name]: { url: endpoint } } }, null, 2),
  };
}

function curlHttp(_record: CatalogRecord, endpoint: string): InstallSnippet {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: CURL_INITIALIZE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'curl', version: '1.0.0' },
    },
  });
  return {
    client: 'curl',
    transport: 'http',
    label: 'curl (initialize probe)',
    payload: [
      `curl -X POST ${endpoint} \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "Accept: application/json, text/event-stream" \\`,
      `  -d '${body}'`,
    ].join('\n'),
  };
}

function geminiHttp(record: CatalogRecord, endpoint: string): InstallSnippet {
  return {
    client: 'gemini',
    transport: 'http',
    label: 'Gemini (CLI)',
    payload: `gemini mcp add --transport http ${record.name} ${endpoint}`,
  };
}

/**
 * Generic `mcpServers` JSON (Streamable HTTP, `type: 'http'`). Its label names no
 * client: Claude Desktop adds remote servers through its Connectors settings rather
 * than this file, and Cline needs the `streamableHttp` type its own snippet carries.
 */
function genericHttp(record: CatalogRecord, endpoint: string): InstallSnippet {
  return {
    client: 'streamable-http',
    transport: 'http',
    label: 'Generic (mcpServers JSON)',
    payload: JSON.stringify(
      { mcpServers: { [record.name]: { type: 'http', url: endpoint } } },
      null,
      2,
    ),
  };
}

/** Local (stdio) factories, in render order. One per client that supports a local install. */
const STDIO_FACTORIES: StdioFactory[] = [
  claudeCodeStdio,
  clineStdio,
  codexStdio,
  cursorStdio,
  geminiStdio,
  genericStdio,
];

/** Remote (HTTP) factories, in render order. Emitted only when the record has an endpoint. */
const HTTP_FACTORIES: HttpFactory[] = [
  claudeCodeHttp,
  clineHttp,
  codexHttp,
  cursorHttp,
  curlHttp,
  geminiHttp,
  genericHttp,
];

/**
 * Generate every install snippet for a record: local (stdio) snippets always, plus
 * remote (HTTP) snippets when the record has a hosted endpoint. Local snippets come
 * first so a flat consumer reads "install locally, or connect remotely" top to bottom.
 */
export function buildAllSnippets(record: CatalogRecord): InstallSnippet[] {
  const snippets = STDIO_FACTORIES.map((factory) => factory(record));
  if (record.endpoint) {
    const endpoint = record.endpoint;
    for (const factory of HTTP_FACTORIES) snippets.push(factory(record, endpoint));
  }
  return snippets;
}
