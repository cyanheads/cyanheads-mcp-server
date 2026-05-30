/**
 * @fileoverview Unit tests for the snippet factory registry (snippets.ts).
 * Pure functions — no I/O, no mocks needed.
 * @module tests/services/snippets.test
 */

import { describe, expect, it } from 'vitest';
import { buildAllSnippets, SNIPPET_REGISTRY } from '@/services/catalog/snippets.js';
import type { CatalogRecord } from '@/services/catalog/types.js';

const RECORD: CatalogRecord = {
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

describe('SNIPPET_REGISTRY', () => {
  it('contains exactly the six supported client keys', () => {
    const keys = Object.keys(SNIPPET_REGISTRY).sort();
    expect(keys).toEqual(['claude-code', 'codex', 'curl', 'cursor', 'gemini', 'streamable-http']);
  });

  describe('claude-code', () => {
    it('produces the correct CLI command', () => {
      const snippet = SNIPPET_REGISTRY['claude-code']!(RECORD);
      expect(snippet.client).toBe('claude-code');
      expect(snippet.label).toBe('Claude Code (CLI)');
      expect(snippet.payload).toBe(
        'claude mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
      );
    });

    it('uses --transport http (not sse or stdio)', () => {
      const snippet = SNIPPET_REGISTRY['claude-code']!(RECORD);
      expect(snippet.payload).toContain('--transport http');
      expect(snippet.payload).not.toContain('sse');
    });

    it('embeds the server name and endpoint into the command', () => {
      const custom: CatalogRecord = {
        ...RECORD,
        name: 'wikipedia-mcp-server',
        endpoint: 'https://wikipedia.caseyjhand.com/mcp',
      };
      const snippet = SNIPPET_REGISTRY['claude-code']!(custom);
      expect(snippet.payload).toContain('wikipedia-mcp-server');
      expect(snippet.payload).toContain('https://wikipedia.caseyjhand.com/mcp');
    });
  });

  describe('codex', () => {
    it('produces the correct CLI command', () => {
      const snippet = SNIPPET_REGISTRY['codex']!(RECORD);
      expect(snippet.client).toBe('codex');
      expect(snippet.label).toBe('Codex (CLI)');
      expect(snippet.payload).toBe(
        'codex mcp add earthquake-mcp-server --url https://earthquake.caseyjhand.com/mcp',
      );
    });

    it('puts name before --url', () => {
      const snippet = SNIPPET_REGISTRY['codex']!(RECORD);
      const nameIdx = snippet.payload.indexOf('earthquake-mcp-server');
      const urlIdx = snippet.payload.indexOf('--url');
      expect(nameIdx).toBeLessThan(urlIdx);
    });
  });

  describe('cursor', () => {
    it('produces valid JSON', () => {
      const snippet = SNIPPET_REGISTRY['cursor']!(RECORD);
      expect(snippet.client).toBe('cursor');
      expect(() => JSON.parse(snippet.payload)).not.toThrow();
    });

    it('has mcpServers.<name>.url but no type field', () => {
      const snippet = SNIPPET_REGISTRY['cursor']!(RECORD);
      const parsed = JSON.parse(snippet.payload);
      const server = parsed.mcpServers['earthquake-mcp-server'];
      expect(server).toEqual({ url: 'https://earthquake.caseyjhand.com/mcp' });
      expect(server.type).toBeUndefined();
    });
  });

  describe('streamable-http', () => {
    it('produces valid JSON with type "http"', () => {
      const snippet = SNIPPET_REGISTRY['streamable-http']!(RECORD);
      expect(snippet.client).toBe('streamable-http');
      expect(() => JSON.parse(snippet.payload)).not.toThrow();
      const parsed = JSON.parse(snippet.payload);
      const server = parsed.mcpServers['earthquake-mcp-server'];
      expect(server).toEqual({ type: 'http', url: 'https://earthquake.caseyjhand.com/mcp' });
    });

    it('label mentions Claude Desktop', () => {
      const snippet = SNIPPET_REGISTRY['streamable-http']!(RECORD);
      expect(snippet.label).toContain('Claude Desktop');
    });
  });

  describe('curl', () => {
    it('starts with curl -X POST <endpoint>', () => {
      const snippet = SNIPPET_REGISTRY['curl']!(RECORD);
      expect(snippet.client).toBe('curl');
      expect(snippet.payload).toMatch(/^curl -X POST https:\/\/earthquake\.caseyjhand\.com\/mcp/);
    });

    it('includes the MCP-Protocol-Version header', () => {
      const snippet = SNIPPET_REGISTRY['curl']!(RECORD);
      expect(snippet.payload).toContain('MCP-Protocol-Version: 2025-11-25');
    });

    it('includes Content-Type application/json', () => {
      const snippet = SNIPPET_REGISTRY['curl']!(RECORD);
      expect(snippet.payload).toContain('Content-Type: application/json');
    });

    it('body contains an initialize method', () => {
      const snippet = SNIPPET_REGISTRY['curl']!(RECORD);
      expect(snippet.payload).toContain('"method":"initialize"');
    });

    it('body protocolVersion matches the header version', () => {
      const snippet = SNIPPET_REGISTRY['curl']!(RECORD);
      expect(snippet.payload).toContain('"protocolVersion":"2025-11-25"');
    });

    it('never emits the legacy SSE transport tag', () => {
      const snippet = SNIPPET_REGISTRY['curl']!(RECORD);
      expect(snippet.payload).not.toContain('sse');
    });
  });

  describe('gemini', () => {
    it('produces the correct CLI command', () => {
      const snippet = SNIPPET_REGISTRY['gemini']!(RECORD);
      expect(snippet.client).toBe('gemini');
      expect(snippet.payload).toBe(
        'gemini mcp add --transport http earthquake-mcp-server https://earthquake.caseyjhand.com/mcp',
      );
    });
  });
});

describe('buildAllSnippets', () => {
  it('returns exactly six snippets', () => {
    const snippets = buildAllSnippets(RECORD);
    expect(snippets).toHaveLength(6);
  });

  it('covers all supported client IDs', () => {
    const snippets = buildAllSnippets(RECORD);
    const clients = snippets.map((s) => s.client).sort();
    expect(clients).toEqual([
      'claude-code',
      'codex',
      'curl',
      'cursor',
      'gemini',
      'streamable-http',
    ]);
  });

  it('every snippet has a non-empty payload', () => {
    const snippets = buildAllSnippets(RECORD);
    for (const s of snippets) {
      expect(s.payload.length).toBeGreaterThan(0);
    }
  });

  it('every snippet has a non-empty label', () => {
    const snippets = buildAllSnippets(RECORD);
    for (const s of snippets) {
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('no snippet leaks the record description or embedding', () => {
    const snippets = buildAllSnippets(RECORD);
    for (const s of snippets) {
      expect(s.payload).not.toContain(RECORD.description);
      // Embeddings are numeric arrays; ensure no [1,0,0,0] literal leaks
      expect(s.payload).not.toContain('[1,0,0,0]');
    }
  });

  it('reflects updated name and endpoint when record differs', () => {
    const custom: CatalogRecord = {
      ...RECORD,
      name: 'pubmed-mcp-server',
      endpoint: 'https://pubmed.caseyjhand.com/mcp',
    };
    const snippets = buildAllSnippets(custom);
    for (const s of snippets) {
      expect(s.payload).toContain('pubmed.caseyjhand.com');
      expect(s.payload).not.toContain('earthquake.caseyjhand.com');
    }
  });
});

describe('security: no secrets in snippet output', () => {
  it('no env var names appear in payloads', () => {
    const snippets = buildAllSnippets(RECORD);
    const sensitivePatterns = [
      /API_KEY/i,
      /SECRET/i,
      /TOKEN/i,
      /PASSWORD/i,
      /CATALOG_URL/i,
      /EMBEDDING_MODEL/i,
    ];
    for (const s of snippets) {
      for (const pattern of sensitivePatterns) {
        expect(s.payload).not.toMatch(pattern);
      }
    }
  });
});
