#!/usr/bin/env node
/**
 * @fileoverview cyanheads-mcp-server entry point — fleet discovery and passthrough gateway.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { describeEntryTool } from './mcp-server/tools/definitions/describe-entry.tool.js';
import { searchCatalogTool } from './mcp-server/tools/definitions/search-catalog.tool.js';
import { initCatalogService } from './services/catalog/catalog-service.js';
import { getCatalogService } from './services/catalog/service-instance.js';

await createApp({
  name: 'cyanheads-mcp-server',
  title: 'cyanheads-mcp-server',
  tools: [searchCatalogTool, describeEntryTool],
  resources: [],
  prompts: [],
  instructions:
    'This server is the discovery front door to the cyanheads MCP fleet. ' +
    'Use cyanheads_search_catalog to find tools or servers by describing what you want to do. ' +
    'Use cyanheads_describe_entry to get full schemas and per-client install snippets for any result. ' +
    'Scope "tools" (default) finds individual tools; scope "servers" finds which server owns a workflow. ' +
    'cyanheads_describe_entry also resolves this server itself, under the name "cyanheads-mcp-server".',

  async setup() {
    const config = getServerConfig();
    initCatalogService(config);
    await getCatalogService().initialize();
  },
});
