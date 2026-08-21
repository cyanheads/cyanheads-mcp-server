/**
 * @fileoverview Framework contract coverage for the server's tool definitions.
 * @module tests/integration/tool-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { describeEntryTool } from '@/mcp-server/tools/definitions/describe-entry.tool.js';
import { searchCatalogTool } from '@/mcp-server/tools/definitions/search-catalog.tool.js';
import { setCatalogService } from '@/services/catalog/service-instance.js';
import { createCatalogServiceFake } from '../fixtures/catalog-service.js';

setCatalogService(createCatalogServiceFake());

toolContractSuite(searchCatalogTool, {
  success: [
    { name: 'validates, invokes, and formats catalog search', input: { query: 'example' } },
  ],
});

toolContractSuite(describeEntryTool, {
  success: [
    {
      name: 'validates, invokes, and formats a server description',
      input: { name: 'example-mcp-server', kind: 'server' },
    },
  ],
  errors: [
    {
      name: 'returns the declared not-found envelope',
      input: { name: 'missing-mcp-server', kind: 'server' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'not_found',
    },
  ],
});
