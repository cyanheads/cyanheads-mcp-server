/**
 * @fileoverview Process-wide CatalogService accessor.
 *
 * Deliberately separate from `catalog-service.ts`: tool definitions need the
 * accessor, and the service needs the self record, which in turn derives its
 * tool list from those same definitions. Keeping the accessor in a leaf module
 * that depends on nothing but the service interface breaks what would otherwise
 * be an import cycle between the tools and the service that serves them.
 * @module services/catalog/service-instance
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { ICatalogService } from './types.js';

let _service: ICatalogService | undefined;

/** Install the process-wide instance. Called by `initCatalogService()`. */
export function setCatalogService(service: ICatalogService): void {
  _service = service;
}

export function getCatalogService(): ICatalogService {
  if (!_service) {
    throw serviceUnavailable(
      'CatalogService not initialized — call initCatalogService() in setup()',
      { reason: 'catalog_empty' },
    );
  }
  return _service;
}

/** Test-only reset. */
export function resetCatalogServiceForTests(): void {
  _service?.shutdown();
  _service = undefined;
}
