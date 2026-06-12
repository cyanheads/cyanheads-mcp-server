#!/usr/bin/env node
/**
 * @fileoverview cyanheads-mcp-server entry point — fleet discovery and passthrough gateway.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { describeTool } from './mcp-server/tools/definitions/describe.tool.js';
import { searchTool } from './mcp-server/tools/definitions/search.tool.js';
import { getCatalogService, initCatalogService } from './services/catalog/catalog-service.js';

await createApp({
  name: 'cyanheads-mcp-server',
  title: 'cyanheads-mcp-server',
  tools: [searchTool, describeTool],
  resources: [],
  prompts: [],
  instructions:
    'This server is the discovery front door to the cyanheads MCP fleet. ' +
    'Use cyanheads_search to find tools or servers by describing what you want to do. ' +
    'Use cyanheads_describe to get full schemas and per-client install snippets for any result. ' +
    'Scope "tools" (default) finds individual tools; scope "servers" finds which server owns a workflow.',

  async setup() {
    const config = getServerConfig();
    initCatalogService(config);
    await getCatalogService().initialize();
  },
});
