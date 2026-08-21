/**
 * @fileoverview Smoke coverage for every tool definition shipped by the server.
 * @module tests/smoke/definitions.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { describeEntryTool } from '@/mcp-server/tools/definitions/describe-entry.tool.js';
import { searchCatalogTool } from '@/mcp-server/tools/definitions/search-catalog.tool.js';
import { setCatalogService } from '@/services/catalog/service-instance.js';
import { createCatalogServiceFake } from '../fixtures/catalog-service.js';

setCatalogService(createCatalogServiceFake());

describe('definition smoke tests', () => {
  it('executes both shipped tool definitions', async () => {
    const searchResult = await searchCatalogTool.handler(
      searchCatalogTool.input.parse({ query: 'example search' }),
      createMockContext({ errors: searchCatalogTool.errors }),
    );
    const describeResult = await describeEntryTool.handler(
      describeEntryTool.input.parse({ name: 'example-mcp-server', kind: 'server' }),
      createMockContext({ errors: describeEntryTool.errors }),
    );

    expect(searchResult).toEqual(expect.schemaMatching(searchCatalogTool.output));
    expect(describeResult).toEqual(expect.schemaMatching(describeEntryTool.output));
  });
});
