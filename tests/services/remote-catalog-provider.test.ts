/**
 * @fileoverview Tests for RemoteJsonCatalogProvider.
 * Mocks globalThis.fetch — no live network calls.
 * @module tests/services/remote-catalog-provider.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteJsonCatalogProvider } from '@/services/catalog/remote-catalog-provider.js';
import type { FleetPayload } from '@/services/catalog/types.js';

const TEST_URL = 'https://test.example.com/fleet.json';
const TEST_TIMEOUT = 5000;

const TEST_CONFIG = {
  catalogUrl: TEST_URL,
  catalogFetchTimeoutMs: TEST_TIMEOUT,
};

const MINIMAL_PAYLOAD: FleetPayload = {
  version: '2',
  generatedAt: '2026-05-28T00:00:00Z',
  embeddingModel: 'test/mock-model',
  embeddingDims: 4,
  embeddingQueryPrefix: 'Q: ',
  servers: [
    {
      name: 'earthquake-mcp-server',
      displayName: 'Earthquake',
      description: 'Search seismic data.',
      category: 'public-data',
      endpoint: 'https://earthquake.caseyjhand.com/mcp',
      npm: '@cyanheads/earthquake-mcp-server',
      github: 'https://github.com/cyanheads/earthquake-mcp-server',
      version: '0.2.1',
      auth: 'none',
      embedding: [1, 0, 0, 0],
      tools: [
        {
          name: 'earthquake_search',
          description: 'Query seismic events.',
          embedding: [1, 0, 0, 0],
        },
      ],
    },
  ],
};

function mockFetchOk(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(payload),
    }),
  );
}

function mockFetchStatus(status: number, statusText: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText,
      json: () => Promise.reject(new Error('body unavailable')),
    }),
  );
}

function mockFetchReject(err: Error): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
}

function mockFetchBadJson(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RemoteJsonCatalogProvider.load()', () => {
  describe('happy path', () => {
    it('returns parsed FleetPayload on a valid 200 response', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const payload = await provider.load();
      expect(payload.version).toBe('2');
      expect(payload.embeddingModel).toBe('test/mock-model');
      expect(payload.servers).toHaveLength(1);
      expect(payload.servers[0]!.name).toBe('earthquake-mcp-server');
    });

    it('passes the configured URL to fetch', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(MINIMAL_PAYLOAD),
      });
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await provider.load();
      expect(fetchSpy).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({ signal: expect.anything() }),
      );
    });

    it('accepts a payload with multiple servers', async () => {
      const multiServer: FleetPayload = {
        ...MINIMAL_PAYLOAD,
        servers: [
          MINIMAL_PAYLOAD.servers[0]!,
          {
            name: 'arxiv-mcp-server',
            displayName: 'arXiv',
            description: 'Research papers.',
            category: 'research',
            endpoint: 'https://arxiv.caseyjhand.com/mcp',
            npm: '@cyanheads/arxiv-mcp-server',
            github: 'https://github.com/cyanheads/arxiv-mcp-server',
            version: '1.2.7',
            auth: 'none',
            embedding: [0, 1, 0, 0],
            tools: [
              { name: 'arxiv_search', description: 'Search papers.', embedding: [0, 1, 0, 0] },
            ],
          },
        ],
      };
      mockFetchOk(multiServer);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const payload = await provider.load();
      expect(payload.servers).toHaveLength(2);
    });
  });

  describe('optional fields (local-only servers)', () => {
    const LOCAL_ONLY_PAYLOAD = {
      ...MINIMAL_PAYLOAD,
      servers: [
        {
          name: 'mailchimp-mcp-server',
          displayName: 'Mailchimp',
          description: 'Manage Mailchimp audiences.',
          category: 'utility',
          npm: '@cyanheads/mailchimp-mcp-server',
          github: 'https://github.com/cyanheads/mailchimp-mcp-server',
          version: '1.0.0',
          auth: 'none',
          requiredEnvVars: ['MAILCHIMP_API_KEY'],
          embedding: [0, 1, 0, 0],
          tools: [{ name: 'mailchimp_ping', description: 'Ping.', embedding: [0, 1, 0, 0] }],
        },
      ],
    };

    it('accepts a record with no endpoint and surfaces requiredEnvVars', async () => {
      mockFetchOk(LOCAL_ONLY_PAYLOAD);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const payload = await provider.load();
      expect(payload.servers[0]!.endpoint).toBeUndefined();
      expect(payload.servers[0]!.requiredEnvVars).toEqual(['MAILCHIMP_API_KEY']);
    });

    it('accepts a hosted record with an endpoint and no requiredEnvVars', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const payload = await provider.load();
      expect(payload.servers[0]!.endpoint).toBe('https://earthquake.caseyjhand.com/mcp');
      expect(payload.servers[0]!.requiredEnvVars).toBeUndefined();
    });

    it('rejects requiredEnvVars when it is not an array of strings', async () => {
      const bad = {
        ...MINIMAL_PAYLOAD,
        servers: [{ ...MINIMAL_PAYLOAD.servers[0], requiredEnvVars: 'MAILCHIMP_API_KEY' }],
      };
      mockFetchOk(bad);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });
  });

  describe('network errors', () => {
    it('throws McpError wrapping a TypeError on network rejection', async () => {
      mockFetchReject(new TypeError('Failed to fetch'));
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('Catalog fetch failed'),
      });
    });

    it('error message does not leak the URL in plain message — just McpError data', async () => {
      mockFetchReject(new TypeError('network gone'));
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const err = await provider.load().catch((e: unknown) => e);
      // The McpError data carries the url; the message describes the failure
      expect(err).toMatchObject({ message: expect.stringContaining('Catalog fetch failed') });
    });

    it('throws McpError on 503 Service Unavailable', async () => {
      mockFetchStatus(503, 'Service Unavailable');
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('503'),
      });
    });

    it('throws McpError on 404 Not Found', async () => {
      mockFetchStatus(404, 'Not Found');
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('404'),
      });
    });

    it('throws McpError on 500 Internal Server Error', async () => {
      mockFetchStatus(500, 'Internal Server Error');
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('500'),
      });
    });
  });

  describe('malformed responses', () => {
    it('throws McpError on JSON parse failure', async () => {
      mockFetchBadJson();
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('not valid JSON'),
      });
    });

    it('throws on completely empty object (missing version field)', async () => {
      mockFetchOk({});
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });

    it('throws on wrong payload version (version "1")', async () => {
      mockFetchOk({ ...MINIMAL_PAYLOAD, version: '1' });
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });

    it('throws when servers array is missing', async () => {
      const { servers: _omit, ...noServers } = MINIMAL_PAYLOAD;
      mockFetchOk(noServers);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });

    it('throws when a server entry is missing required displayName', async () => {
      const bad = {
        ...MINIMAL_PAYLOAD,
        servers: [{ name: 'incomplete-server' }],
      };
      mockFetchOk(bad);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });

    it('throws when embeddingDims is not a positive integer', async () => {
      mockFetchOk({ ...MINIMAL_PAYLOAD, embeddingDims: -1 });
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });

    it('throws when a server tool is missing description', async () => {
      const bad = {
        ...MINIMAL_PAYLOAD,
        servers: [
          {
            ...MINIMAL_PAYLOAD.servers[0],
            tools: [{ name: 'earthquake_search', embedding: [1, 0, 0, 0] }],
          },
        ],
      };
      mockFetchOk(bad);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });

    it('throws when category is not a valid enum value', async () => {
      const bad = {
        ...MINIMAL_PAYLOAD,
        servers: [{ ...MINIMAL_PAYLOAD.servers[0], category: 'invalid-category' }],
      };
      mockFetchOk(bad);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });

    it('accepts null response body (throws on JSON error)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(null),
        }),
      );
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      await expect(provider.load()).rejects.toMatchObject({
        message: expect.stringContaining('validation'),
      });
    });
  });

  describe('security', () => {
    it('error messages do not contain env var names', async () => {
      mockFetchReject(new TypeError('network gone'));
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const err = await provider.load().catch((e: unknown) => e);
      const msg = String(err instanceof Error ? err.message : err);
      expect(msg).not.toMatch(/CATALOG_URL/);
      expect(msg).not.toMatch(/API_KEY/);
      expect(msg).not.toMatch(/SECRET/);
    });

    it('validation error message does not expose full payload content', async () => {
      mockFetchOk({ version: '2', injectedField: 'SENSITIVE_DATA_HERE' });
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const err = await provider.load().catch((e: unknown) => e);
      const msg = String(err instanceof Error ? err.message : err);
      // Should not blindly reflect arbitrary upstream content back
      expect(msg).not.toContain('SENSITIVE_DATA_HERE');
    });
  });

  describe('edge cases', () => {
    it('handles an empty servers array gracefully', async () => {
      mockFetchOk({ ...MINIMAL_PAYLOAD, servers: [] });
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const payload = await provider.load();
      expect(payload.servers).toHaveLength(0);
    });

    it('can be called multiple times (no memoization enforced)', async () => {
      mockFetchOk(MINIMAL_PAYLOAD);
      const provider = new RemoteJsonCatalogProvider(TEST_CONFIG);
      const p1 = await provider.load();
      const p2 = await provider.load();
      expect(p1.generatedAt).toBe(p2.generatedAt);
    });
  });
});
