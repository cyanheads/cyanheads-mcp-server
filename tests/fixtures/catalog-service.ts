/**
 * @fileoverview Deterministic CatalogService fake shared by definition-level tests.
 * @module tests/fixtures/catalog-service
 */

import type {
  CatalogRecord,
  CatalogSearchResult,
  ICatalogService,
} from '@/services/catalog/types.js';

const TEST_SERVER: CatalogRecord = {
  name: 'example-mcp-server',
  // The producer sets displayName to the server name.
  displayName: 'example-mcp-server',
  description: 'Example catalog server for contract tests.',
  category: 'utility',
  endpoint: 'https://example.test/mcp',
  npm: '@cyanheads/example-mcp-server',
  github: 'https://github.com/cyanheads/example-mcp-server',
  version: '1.0.0',
  auth: 'none',
  // Entries pass through as published, so this one names no server the fake holds.
  composesWith: ['openstreetmap-mcp-server'],
  embedding: [1, 0],
  tools: [
    {
      name: 'example_search',
      description: 'Search example records.',
      embedding: [1, 0],
    },
  ],
};

const TEST_RESULT: CatalogSearchResult = {
  name: 'example_search',
  server: TEST_SERVER.name,
  brief: TEST_SERVER.tools[0]!.description,
  category: TEST_SERVER.category,
  score: 1,
  serverRecord: TEST_SERVER,
};

/** Create a deterministic catalog service for tool contract, smoke, and fuzz tests. */
export function createCatalogServiceFake(): ICatalogService {
  return {
    getServer: (name) => (name === TEST_SERVER.name ? TEST_SERVER : null),
    getTool: (name, server) =>
      name === TEST_SERVER.tools[0]!.name && (server === undefined || server === TEST_SERVER.name)
        ? [{ ...TEST_SERVER.tools[0]!, serverRecord: TEST_SERVER }]
        : [],
    async initialize() {},
    list: ({ scope, category }) => {
      if (category !== undefined && category !== TEST_SERVER.category) return [];
      const { name, server, brief } = TEST_RESULT;
      return scope === 'servers'
        ? [{ name: server, server, brief: TEST_SERVER.description, category: TEST_SERVER.category }]
        : [{ name, server, brief, category: TEST_SERVER.category }];
    },
    listCategories: () => [TEST_SERVER.category],
    async search({ query }) {
      return query.trim() ? [TEST_RESULT] : [];
    },
    shutdown() {},
    stats: () => ({
      toolCount: 1,
      serverCount: 1,
      initializedAt: '2026-08-21T00:00:00.000Z',
      embeddingModel: 'test/model',
    }),
  };
}
