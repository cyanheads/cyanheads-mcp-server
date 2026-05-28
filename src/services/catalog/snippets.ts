/**
 * @fileoverview Per-client install snippet factory registry.
 * A plain Record mapping ClientId to a factory function that produces an InstallSnippet
 * from a CatalogRecord. Snippets are derived at request time from the record's
 * { name, npm, endpoint } fields — no precomputed snippet list lives in the catalog JSON.
 * @module services/catalog/snippets
 */

import type { CatalogRecord, ClientId, InstallSnippet } from './types.js';

/** Factory signature: given a CatalogRecord, produce one InstallSnippet. */
type SnippetFactory = (record: CatalogRecord) => InstallSnippet;

/** Build the Claude Desktop JSON fragment. All catalog servers have a hosted endpoint. */
function claudeDesktopSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'claude-desktop',
    label: 'Claude Desktop (JSON config)',
    payload: JSON.stringify({ [record.name]: { type: 'sse', url: record.endpoint } }, null, 2),
  };
}

/** Build the Claude Code CLI command. */
function claudeCodeSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'claude-code',
    label: 'Claude Code (CLI)',
    payload: `claude mcp add --transport sse ${record.name} ${record.endpoint}`,
  };
}

/** Build the Cursor .cursor/mcp.json fragment. */
function cursorSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'cursor',
    label: 'Cursor (mcp.json)',
    payload: JSON.stringify(
      { mcpServers: { [record.name]: { type: 'sse', url: record.endpoint } } },
      null,
      2,
    ),
  };
}

/** Build the Cline VS Code extension MCP settings fragment. */
function clineSnippet(record: CatalogRecord): InstallSnippet {
  return {
    client: 'cline',
    label: 'Cline (VS Code)',
    payload: JSON.stringify(
      { [record.name]: { type: 'sse', url: record.endpoint, disabled: false, autoApprove: [] } },
      null,
      2,
    ),
  };
}

/** Registry of all supported clients. */
export const SNIPPET_REGISTRY: Record<ClientId, SnippetFactory> = {
  'claude-desktop': claudeDesktopSnippet,
  'claude-code': claudeCodeSnippet,
  cursor: cursorSnippet,
  cline: clineSnippet,
};

/** Generate install snippets for all supported clients for a given record. */
export function buildAllSnippets(record: CatalogRecord): InstallSnippet[] {
  return Object.values(SNIPPET_REGISTRY).map((factory) => factory(record));
}
