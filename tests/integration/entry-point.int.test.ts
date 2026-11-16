/**
 * @fileoverview Boots the built server (`node dist/index.js`) over stdio and reads
 * `tools/list`. Under Node the framework loads `.env` lazily inside `createApp()`,
 * so a `.env` setting reaches `clampLimitsEnabled()` only while the entry point
 * parses the server config inside `setup()`. Reads whatever `dist/` exists and
 * skips without one; it never builds.
 * @module tests/integration/entry-point.int.test
 */

import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import type { FleetPayload } from '@/services/catalog/types.js';

const ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const FAKE_TRANSFORMERS = new URL('../fixtures/fake-transformers.mjs', import.meta.url).href;

/**
 * The Node binary to boot the server with. Under `bun --bun` this process is
 * Bun and PATH leads with a `node` that links to Bun, so take the first `node`
 * on PATH that resolves elsewhere.
 */
function nodeBinary(): string | undefined {
  if (!process.versions.bun) return process.execPath;
  const bun = realpathSync(process.execPath);
  return (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, 'node'))
    .find((candidate) => existsSync(candidate) && realpathSync(candidate) !== bun);
}

const PAYLOAD: FleetPayload = {
  version: '2',
  generatedAt: '2026-11-01T00:00:00Z',
  embeddingModel: 'test/boot-model',
  embeddingDims: 2,
  embeddingQueryPrefix: 'Q: ',
  servers: [
    {
      name: 'boot-mcp-server',
      displayName: 'boot-mcp-server',
      description: 'Boot fixture.',
      category: 'utility',
      npm: '@cyanheads/boot-mcp-server',
      github: 'https://github.com/cyanheads/boot-mcp-server',
      version: '1.0.0',
      auth: 'none',
      embedding: [1, 0],
      tools: [{ name: 'boot_ping', description: 'Ping.', embedding: [1, 0] }],
    },
  ],
};

const ToolsListResponse = z.object({
  result: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        inputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }),
      }),
    ),
  }),
});

type Waiter = { resolve: (message: unknown) => void; reject: (error: Error) => void };

/** Newline-delimited JSON-RPC over the child's stdio. A request rejects if the server exits first. */
function connect(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, Waiter>();
  let stderr = '';
  let buffered = '';
  let ended: Error | undefined;
  const end = (error: Error) => {
    ended = error;
    for (const { reject } of pending.values()) reject(ended);
    pending.clear();
  };

  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffered += chunk;
    for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const message: unknown = JSON.parse(line);
      // Notifications and server-initiated requests carry `method`; only responses settle a request.
      if (typeof message !== 'object' || message === null || 'method' in message) continue;
      if (!('id' in message) || typeof message.id !== 'number') continue;
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
  child.once('error', (cause) => end(new Error('Spawning node failed.', { cause })));
  child.once('exit', (code, signal) =>
    end(new Error(`Server exited (code ${code}, signal ${signal}) before answering:\n${stderr}`)),
  );

  let nextId = 0;
  return {
    request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (ended) return Promise.reject(ended);
      const id = ++nextId;
      const answer = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return answer;
    },
    notify(method: string): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
  };
}

describe('built entry point (node dist/index.js over stdio)', () => {
  it('reads CATALOG_CLAMP_LIMITS=false from the working directory .env and advertises the limit maximum', async ({
    onTestFinished,
    skip,
  }) => {
    skip(
      !existsSync(ENTRY),
      'dist/index.js is absent: run `bun run build`, then rerun. This test boots the built server and never builds it.',
    );
    const node = nodeBinary();
    if (node === undefined) {
      return skip('No Node binary on PATH: this test boots the server under Node.');
    }

    const cwd = await mkdtemp(join(tmpdir(), 'cyanheads-entry-point-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, '.env'), 'CATALOG_CLAMP_LIMITS=false\n');

    const catalog = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(PAYLOAD));
    });
    catalog.listen(0, '127.0.0.1');
    await once(catalog, 'listening');
    onTestFinished(async () => {
      catalog.close();
      await once(catalog, 'close');
    });
    const address = catalog.address();
    assert(typeof address === 'object' && address !== null);

    const server = spawn(node, ['--import', FAKE_TRANSFORMERS, ENTRY], {
      cwd,
      // Nothing inherited: a CATALOG_CLAMP_LIMITS in the test's own environment would mask the .env read.
      env: {
        PATH: process.env.PATH,
        CATALOG_URL: `http://127.0.0.1:${address.port}/fleet.json`,
        CATALOG_REFRESH_SECONDS: '0',
        EMBEDDING_MODEL_ID: PAYLOAD.embeddingModel,
        LOGS_DIR: cwd,
      },
    });
    onTestFinished(async () => {
      const running = server.exitCode === null && server.signalCode === null;
      if (server.pid === undefined || !running) return;
      const exited = once(server, 'exit');
      process.kill(server.pid, 'SIGTERM');
      await exited;
    });

    const rpc = connect(server);
    await rpc.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'entry-point-test', version: '0.0.0' },
    });
    rpc.notify('notifications/initialized');
    const { result } = ToolsListResponse.parse(await rpc.request('tools/list'));
    const search = result.tools.find((t) => t.name === 'cyanheads_search_catalog');
    expect(search?.inputSchema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    });
  });
});
