/**
 * @fileoverview Property-based fuzz coverage for the server's tool definitions.
 * @module tests/fuzz/tools.fuzz.test
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { expect, it } from 'vitest';
import { describeEntryTool } from '@/mcp-server/tools/definitions/describe-entry.tool.js';
import { searchCatalogTool } from '@/mcp-server/tools/definitions/search-catalog.tool.js';
import { setCatalogService } from '@/services/catalog/service-instance.js';
import { createCatalogServiceFake } from '../fixtures/catalog-service.js';

setCatalogService(createCatalogServiceFake());

for (const definition of [searchCatalogTool, describeEntryTool]) {
  it(`keeps ${definition.name} safe across generated and adversarial inputs`, async () => {
    const report = await fuzzTool(definition, {
      numRuns: 50,
      numAdversarial: 30,
      seed: 20_260_821,
    });

    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(0);
    expect(report.prototypePollution).toBe(false);
  });
}
