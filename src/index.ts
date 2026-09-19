#!/usr/bin/env node
/**
 * @fileoverview cyanheads-mcp-server entry point — fleet discovery and install guidance.
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
  /**
   * No per-session state: the catalog index is process-wide and `ctx.state` is
   * tenant-scoped, so the session store and the per-session `McpServer` buy
   * nothing here and cost horizontal scalability. `MCP_SESSION_MODE` still wins
   * when a deployment sets it to a meaningful value; the Dockerfile's
   * `ENV MCP_SESSION_MODE="stateless"` now restates this rather than overriding
   * a different default. No tool calls `ctx.requestInput`, so `require` is not
   * declared — nothing here degrades under stateless.
   */
  sessionMode: 'stateless',
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

  /**
   * `setup()` arms a ref'd `setInterval` for the background catalog refresh.
   * Nothing else clears it, so without this hook a signal shutdown cuts the
   * timer rather than releasing it. Runs after the transport stops accepting
   * requests and before core services are disposed.
   */
  teardown() {
    getCatalogService().shutdown();
  },
});
