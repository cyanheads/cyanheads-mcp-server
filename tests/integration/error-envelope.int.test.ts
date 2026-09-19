/**
 * @fileoverview Pins the dual-surface error envelope both tools emit through the
 * production rejection path.
 *
 * `runToolContract` rejects out-of-schema arguments via the same
 * `parseToolArguments` call `createToolHandler` makes, so the code, message, and
 * `content[0].text` asserted here are what a client receives — not a
 * direct-handler approximation of them. Assertions are containment, never byte
 * equality: the framework composes the trailer (`Recovery: …`, `(reason … )`)
 * around the authored message, and pinning the whole string would re-break on
 * every framework release that tunes that composition.
 *
 * @module tests/integration/error-envelope.int.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { describeEntryTool } from '@/mcp-server/tools/definitions/describe-entry.tool.js';
import { searchCatalogTool } from '@/mcp-server/tools/definitions/search-catalog.tool.js';
import { setCatalogService } from '@/services/catalog/service-instance.js';
import type { ICatalogService } from '@/services/catalog/types.js';
import { createCatalogServiceFake } from '../fixtures/catalog-service.js';

setCatalogService(createCatalogServiceFake());

/** The `structuredContent.error` half of the dual-surface envelope. */
function errorOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  const structured = result.structuredContent as
    | { error?: { code?: number; message?: string; data?: Record<string, unknown> } }
    | undefined;
  return structured?.error;
}

/** The `content[]` half — the surface clients that ignore structuredContent read. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  return (result.content ?? []).map((block) => ('text' in block ? block.text : '')).join('\n');
}

describe('argument rejection envelope', () => {
  it('classifies a constraint failure as InvalidParams, not ValidationError', async () => {
    const result = await runToolContract(searchCatalogTool, { query: '' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result)?.data?.reason).toBe('invalid_arguments');
  });

  it('names the offending field on both surfaces', async () => {
    const result = await runToolContract(searchCatalogTool, { query: '' });

    expect(errorOf(result)?.message).toContain('query');
    expect(errorOf(result)?.message).toContain('cyanheads_search_catalog');
    expect(textOf(result)).toContain('query');
  });

  it('closes content[] with the reason term a caller branches on', async () => {
    const result = await runToolContract(searchCatalogTool, { query: '' });

    expect(textOf(result)).toMatch(/^Error:/);
    expect(textOf(result)).toContain('(reason invalid_arguments');
  });

  /**
   * An unknown root key is dropped before parse only when it is undeclared and
   * unaliasable; `querie` resolves to nothing, so the call still fails — and the
   * synthesized hint names the keys the tool does accept.
   */
  it('forwards a schema-derived recovery hint naming the accepted keys', async () => {
    const result = await runToolContract(searchCatalogTool, { querie: 'seismic' } as never);

    expect(errorOf(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    const hint = (errorOf(result)?.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
    expect(hint).toContain('querie');
    expect(hint).toContain('query');
    expect(textOf(result)).toContain('Recovery:');
  });

  /**
   * The `Recovery:` line is suppressed when the trimmed message already carries
   * the hint verbatim — the shape a bare constraint rejection produces. The hint
   * still ships on `structuredContent`, so no surface loses it.
   */
  it('suppresses a duplicate Recovery line while keeping the hint structured', async () => {
    const result = await runToolContract(searchCatalogTool, { query: '' });

    expect(textOf(result)).not.toContain('Recovery:');
    expect((errorOf(result)?.data?.recovery as { hint?: string } | undefined)?.hint).toBeTruthy();
  });

  it('rejects a name over the declared bound on describe_entry', async () => {
    const result = await runToolContract(describeEntryTool, { name: 'a'.repeat(65) });

    expect(errorOf(result)?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result)?.data?.reason).toBe('invalid_arguments');
    expect(textOf(result)).toContain('name');
  });
});

describe('declared contract reasons', () => {
  it('carries not_found with its forwarded recovery hint on both surfaces', async () => {
    const result = await runToolContract(describeEntryTool, {
      name: 'missing-mcp-server',
      kind: 'server',
    });

    expect(errorOf(result)?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(errorOf(result)?.data?.reason).toBe('not_found');
    expect((errorOf(result)?.data?.recovery as { hint?: string } | undefined)?.hint).toContain(
      'cyanheads_search_catalog',
    );
    expect(textOf(result)).toContain('Recovery:');
    expect(textOf(result)).toContain('(reason not_found');
  });

  it('carries ambiguous_kind when a name resolves to both a tool and a server', async () => {
    const bothFake: ICatalogService = {
      ...createCatalogServiceFake(),
      getServer: () => ({
        name: 'collision',
        displayName: 'Collision',
        description: 'Resolves as both.',
        category: 'utility',
        npm: '@cyanheads/collision',
        github: 'https://github.com/cyanheads/collision',
        version: '1.0.0',
        auth: 'none',
        embedding: [1, 0],
        tools: [],
      }),
      getTool: () => ({
        name: 'collision',
        description: 'Resolves as both.',
        embedding: [1, 0],
        serverRecord: {
          name: 'collision',
          displayName: 'Collision',
          description: 'Resolves as both.',
          category: 'utility',
          npm: '@cyanheads/collision',
          github: 'https://github.com/cyanheads/collision',
          version: '1.0.0',
          auth: 'none',
          embedding: [1, 0],
          tools: [],
        },
      }),
    };
    setCatalogService(bothFake);
    try {
      const result = await runToolContract(describeEntryTool, { name: 'collision' });

      expect(errorOf(result)?.data?.reason).toBe('ambiguous_kind');
      expect((errorOf(result)?.data?.recovery as { hint?: string } | undefined)?.hint).toContain(
        'kind',
      );
      expect(textOf(result)).toContain('(reason ambiguous_kind');
    } finally {
      setCatalogService(createCatalogServiceFake());
    }
  });

  /**
   * `catalog_empty` is declared `thrownBy: 'service'` — no ctx.fail site names
   * it. The service throw must still put `retryable` on the error data, since
   * that is what renders the retryable term clients read off `content[]`.
   */
  it('renders catalog_empty as retryable on both surfaces', async () => {
    const emptyFake: ICatalogService = {
      ...createCatalogServiceFake(),
      async search() {
        throw serviceUnavailable('CatalogService not initialized', {
          reason: 'catalog_empty',
          retryable: true,
        });
      },
    };
    setCatalogService(emptyFake);
    try {
      const result = await runToolContract(searchCatalogTool, { query: 'seismic activity' });

      expect(errorOf(result)?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(errorOf(result)?.data?.reason).toBe('catalog_empty');
      expect(errorOf(result)?.data?.retryable).toBe(true);
      expect(textOf(result)).toContain('(reason catalog_empty');
      expect(textOf(result)).toContain('retryable');
      expect(textOf(result)).not.toContain('not retryable');
    } finally {
      setCatalogService(createCatalogServiceFake());
    }
  });
});
