/**
 * @fileoverview Unit tests for the snippet factories (snippets.ts).
 * Pure functions — no I/O, no mocks needed. Covers both transports: local (stdio,
 * from `npm`) for every server, and remote (http, from `endpoint`) for hosted servers.
 * @module tests/services/snippets.test
 */

import { describe, expect, it } from 'vitest';
import { buildAllSnippets } from '@/services/catalog/snippets.js';
import type { CatalogRecord } from '@/services/catalog/types.js';

/** Hosted server — has an endpoint, so it gets both stdio and http snippets. */
const HOSTED: CatalogRecord = {
  name: 'earthquake-mcp-server',
  displayName: 'Earthquake',
  description: 'Search USGS seismic data.',
  category: 'public-data',
  endpoint: 'https://earthquake.caseyjhand.com/mcp',
  npm: '@cyanheads/earthquake-mcp-server',
  github: 'https://github.com/cyanheads/earthquake-mcp-server',
  version: '0.2.1',
  auth: 'none',
  embedding: [1, 0, 0, 0],
  tools: [],
};

/** Local-only server — no endpoint, requires an env var. Gets stdio snippets only. */
const { endpoint: _noEndpoint, ...HOSTED_WITHOUT_ENDPOINT } = HOSTED;
const LOCAL_ONLY: CatalogRecord = {
  ...HOSTED_WITHOUT_ENDPOINT,
  name: 'mailchimp-mcp-server',
  npm: '@cyanheads/mailchimp-mcp-server',
  github: 'https://github.com/cyanheads/mailchimp-mcp-server',
  requiredEnvVars: ['MAILCHIMP_API_KEY'],
};

const stdioFor = (record: CatalogRecord, client: string) =>
  buildAllSnippets(record).find((s) => s.transport === 'stdio' && s.client === client);
const httpFor = (record: CatalogRecord, client: string) =>
  buildAllSnippets(record).find((s) => s.transport === 'http' && s.client === client);

describe('buildAllSnippets — hosted server (endpoint present)', () => {
  it('returns 5 local (stdio) + 6 remote (http) = 11 snippets', () => {
    expect(buildAllSnippets(HOSTED)).toHaveLength(11);
  });

  it('emits all local snippets before any remote snippet', () => {
    const snippets = buildAllSnippets(HOSTED);
    const firstHttp = snippets.findIndex((s) => s.transport === 'http');
    const lastStdio = snippets.map((s) => s.transport).lastIndexOf('stdio');
    expect(lastStdio).toBeLessThan(firstHttp);
  });

  it('local snippets cover the five non-curl clients', () => {
    const clients = buildAllSnippets(HOSTED)
      .filter((s) => s.transport === 'stdio')
      .map((s) => s.client)
      .sort();
    expect(clients).toEqual(['claude-code', 'codex', 'cursor', 'gemini', 'streamable-http']);
  });

  it('remote snippets cover all six clients including curl', () => {
    const clients = buildAllSnippets(HOSTED)
      .filter((s) => s.transport === 'http')
      .map((s) => s.client)
      .sort();
    expect(clients).toEqual([
      'claude-code',
      'codex',
      'curl',
      'cursor',
      'gemini',
      'streamable-http',
    ]);
  });

  it('every snippet carries transport, client, label, and a non-empty payload', () => {
    for (const s of buildAllSnippets(HOSTED)) {
      expect(['stdio', 'http']).toContain(s.transport);
      expect(s.client.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.payload.length).toBeGreaterThan(0);
    }
  });

  it('never emits the legacy SSE transport tag', () => {
    for (const s of buildAllSnippets(HOSTED)) expect(s.payload).not.toContain('sse');
  });
});

describe('local (stdio) snippet payloads', () => {
  it('claude-code uses `claude mcp add --transport stdio <name> -- npx -y <pkg>`', () => {
    expect(stdioFor(HOSTED, 'claude-code')?.payload).toBe(
      'claude mcp add --transport stdio earthquake-mcp-server -- npx -y @cyanheads/earthquake-mcp-server',
    );
  });

  it('codex uses `codex mcp add <name> -- npx -y <pkg>`', () => {
    expect(stdioFor(HOSTED, 'codex')?.payload).toBe(
      'codex mcp add earthquake-mcp-server -- npx -y @cyanheads/earthquake-mcp-server',
    );
  });

  it('gemini uses `gemini mcp add <name> npx -y <pkg>`', () => {
    expect(stdioFor(HOSTED, 'gemini')?.payload).toBe(
      'gemini mcp add earthquake-mcp-server npx -y @cyanheads/earthquake-mcp-server',
    );
  });

  it('cursor JSON carries command/args, no type and no url', () => {
    const parsed = JSON.parse(stdioFor(HOSTED, 'cursor')!.payload);
    expect(parsed.mcpServers['earthquake-mcp-server']).toEqual({
      command: 'npx',
      args: ['-y', '@cyanheads/earthquake-mcp-server'],
    });
  });

  it('generic (streamable-http) JSON carries type "stdio" + command/args', () => {
    const parsed = JSON.parse(stdioFor(HOSTED, 'streamable-http')!.payload);
    expect(parsed.mcpServers['earthquake-mcp-server']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@cyanheads/earthquake-mcp-server'],
    });
  });

  it('no stdio payload references the hosted endpoint', () => {
    for (const s of buildAllSnippets(HOSTED).filter((s) => s.transport === 'stdio')) {
      expect(s.payload).not.toContain('earthquake.caseyjhand.com');
    }
  });
});

describe('remote (http) snippet payloads', () => {
  it('claude-code uses `claude mcp add --transport http <name> <url>`', () => {
    expect(httpFor(HOSTED, 'claude-code')?.payload).toBe(
      'claude mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
    );
  });

  it('codex uses `codex mcp add <name> --url <url>`', () => {
    expect(httpFor(HOSTED, 'codex')?.payload).toBe(
      'codex mcp add earthquake-mcp-server --url https://earthquake.caseyjhand.com/mcp',
    );
  });

  it('gemini uses `gemini mcp add --transport http <name> <url>`', () => {
    expect(httpFor(HOSTED, 'gemini')?.payload).toBe(
      'gemini mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
    );
  });

  it('cursor JSON carries url and no type field', () => {
    const parsed = JSON.parse(httpFor(HOSTED, 'cursor')!.payload);
    expect(parsed.mcpServers['earthquake-mcp-server']).toEqual({
      url: 'https://earthquake.caseyjhand.com/mcp',
    });
  });

  it('generic (streamable-http) JSON carries type "http" + url', () => {
    const parsed = JSON.parse(httpFor(HOSTED, 'streamable-http')!.payload);
    expect(parsed.mcpServers['earthquake-mcp-server']).toEqual({
      type: 'http',
      url: 'https://earthquake.caseyjhand.com/mcp',
    });
  });

  it('curl POSTs initialize with the MCP-Protocol-Version header', () => {
    const payload = httpFor(HOSTED, 'curl')!.payload;
    expect(payload).toMatch(/^curl -X POST https:\/\/earthquake\.caseyjhand\.com\/mcp/);
    expect(payload).toContain('Content-Type: application/json');
    expect(payload).toContain('MCP-Protocol-Version: 2026-07-28');
    expect(payload).toContain('"method":"initialize"');
    expect(payload).toContain('"protocolVersion":"2026-07-28"');
  });
});

describe('buildAllSnippets — local-only server (no endpoint)', () => {
  it('returns only the five stdio snippets — no http, no curl', () => {
    const snippets = buildAllSnippets(LOCAL_ONLY);
    expect(snippets).toHaveLength(5);
    expect(snippets.every((s) => s.transport === 'stdio')).toBe(true);
    expect(snippets.some((s) => s.client === 'curl')).toBe(false);
  });

  it('scaffolds required env vars as empty-valued keys in the JSON configs', () => {
    const cursor = JSON.parse(stdioFor(LOCAL_ONLY, 'cursor')!.payload);
    expect(cursor.mcpServers['mailchimp-mcp-server'].env).toEqual({ MAILCHIMP_API_KEY: '' });
    const generic = JSON.parse(stdioFor(LOCAL_ONLY, 'streamable-http')!.payload);
    expect(generic.mcpServers['mailchimp-mcp-server'].env).toEqual({ MAILCHIMP_API_KEY: '' });
  });

  it('keeps CLI snippets bare — no env inlined into the command', () => {
    expect(stdioFor(LOCAL_ONLY, 'claude-code')?.payload).toBe(
      'claude mcp add --transport stdio mailchimp-mcp-server -- npx -y @cyanheads/mailchimp-mcp-server',
    );
  });

  it('omits the env block entirely when no env vars are required', () => {
    const { requiredEnvVars: _drop, ...noEnv } = LOCAL_ONLY;
    const cursor = JSON.parse(stdioFor(noEnv, 'cursor')!.payload);
    expect(cursor.mcpServers['mailchimp-mcp-server'].env).toBeUndefined();
  });
});

describe('buildAllSnippets — content safety', () => {
  it('reflects the record name and npm package, not a stale one', () => {
    const custom: CatalogRecord = {
      ...HOSTED,
      name: 'pubmed-mcp-server',
      npm: '@cyanheads/pubmed-mcp-server',
      endpoint: 'https://pubmed.caseyjhand.com/mcp',
    };
    for (const s of buildAllSnippets(custom)) {
      expect(s.payload).toContain('pubmed');
      expect(s.payload).not.toContain('earthquake');
    }
  });

  it('no snippet leaks the record description or embedding', () => {
    for (const s of buildAllSnippets(HOSTED)) {
      expect(s.payload).not.toContain(HOSTED.description);
      expect(s.payload).not.toContain('[1,0,0,0]');
    }
  });

  it("never leaks the server's own config vars, and env scaffold values are always empty", () => {
    // A fleet record's required env var NAMES may appear as empty-valued JSON keys —
    // that is the point. What must never appear: a secret VALUE, or the server's own
    // config variables (CATALOG_URL, EMBEDDING_MODEL_ID, SIMILARITY_FLOOR).
    for (const s of buildAllSnippets(LOCAL_ONLY)) {
      expect(s.payload).not.toMatch(/CATALOG_URL/i);
      expect(s.payload).not.toMatch(/EMBEDDING_MODEL/i);
      expect(s.payload).not.toMatch(/SIMILARITY_FLOOR/i);
      const valued = s.payload.match(/"MAILCHIMP_API_KEY":\s*"([^"]*)"/);
      if (valued) expect(valued[1]).toBe('');
    }
  });
});
