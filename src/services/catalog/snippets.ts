/**
 * @fileoverview Per-client install snippet factory registry.
 * A plain Record mapping ClientId to a factory function that produces an InstallSnippet
 * from a CatalogRecord. Snippets are derived at request time from the record's
 * { name, endpoint } fields — no precomputed snippet list lives in the catalog JSON.
 *
 * All fleet servers run Streamable HTTP — the legacy `sse` transport tag is not
 * emitted. Per-client formats:
 *   - claude-code / gemini: `<cli> mcp add --transport http <name> <url>`
 *   - codex:                `codex mcp add <name> --url <url>`
 *   - cursor:               `mcpServers.<name>.{url}` (no `type` field)
 *   - streamable-http:      `mcpServers.<name>.{type:"http", url}` (Claude Desktop, Cline, generic)
 *   - curl:                 `initialize` POST with `MCP-Protocol-Version` header
 * @module services/catalog/snippets
 */

import type { CatalogRecord, ClientId, InstallSnippet } from './types.js';

/** Factory signature: given a CatalogRecord, produce one InstallSnippet. */
type SnippetFactory = (record: CatalogRecord) => InstallSnippet;

/** MCP protocol version pinned in the curl `initialize` snippet. */
const CURL_MCP_PROTOCOL_VERSION = '2025-11-25';

/** Claude Code CLI install command. */
function claudeCodeSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'claude-code',
    label: 'Claude Code (CLI)',
    payload: `claude mcp add --transport http ${record.name} ${record.endpoint}`,
  };
}

/** OpenAI Codex CLI install command. */
function codexSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'codex',
    label: 'Codex (CLI)',
    payload: `codex mcp add ${record.name} --url ${record.endpoint}`,
  };
}

/** Cursor `.cursor/mcp.json` fragment (Cursor reads HTTP servers without a `type` field). */
function cursorSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'cursor',
    label: 'Cursor (mcp.json)',
    payload: JSON.stringify({ mcpServers: { [record.name]: { url: record.endpoint } } }, null, 2),
  };
}

/** curl `initialize` request — a connectivity probe, not an install. */
function curlSnippet(record: CatalogRecord): InstallSnippet {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: CURL_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'curl', version: '1.0.0' },
    },
  });
  return {
    client: 'curl',
    label: 'curl (initialize probe)',
    payload: [
      `curl -X POST ${record.endpoint} \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "MCP-Protocol-Version: ${CURL_MCP_PROTOCOL_VERSION}" \\`,
      `  -d '${body}'`,
    ].join('\n'),
  };
}

/** Gemini CLI install command. */
function geminiSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'gemini',
    label: 'Gemini (CLI)',
    payload: `gemini mcp add --transport http ${record.name} ${record.endpoint}`,
  };
}

/**
 * Generic Streamable HTTP `mcpServers` block. Works for Claude Desktop, Cline,
 * mcp-remote, and any other MCP client that consumes the standard config shape
 * with `type: "http"`.
 */
function streamableHttpSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'streamable-http',
    label: 'Streamable HTTP (Claude Desktop, Cline, generic)',
    payload: JSON.stringify(
      { mcpServers: { [record.name]: { type: 'http', url: record.endpoint } } },
      null,
      2,
    ),
  };
}

/** Registry of all supported clients. */
export const SNIPPET_REGISTRY: Record<ClientId, SnippetFactory> = {
  'claude-code': claudeCodeSnippet,
  codex: codexSnippet,
  cursor: cursorSnippet,
  curl: curlSnippet,
  gemini: geminiSnippet,
  'streamable-http': streamableHttpSnippet,
};

/** Generate install snippets for all supported clients for a given record. */
export function buildAllSnippets(record: CatalogRecord): InstallSnippet[] {
  return Object.values(SNIPPET_REGISTRY).map((factory) => factory(record));
}
