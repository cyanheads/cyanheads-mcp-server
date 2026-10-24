/**
 * @fileoverview Portable MCPB dependency routing regression tests.
 * @module tests/packaging/portable-bundle.test
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  includePortableDependency,
  routePortableEmbeddings,
} from '../../scripts/portable-bundle.js';

const root = new URL('../../', import.meta.url);

describe('MCPB embeddings routing', () => {
  it('keeps the native published implementation and CLS projection', async () => {
    const source = await readFile(
      new URL('src/services/catalog/embeddings-runtime.ts', root),
      'utf8',
    );
    expect(source).toContain("from '@huggingface/transformers'");
    expect(source).toContain("pooling: 'cls'");
    expect(source).toContain('normalize: false');
    expect(source).toContain('new Float32Array(dims)');
  });

  it('uses a project-owned portable packaging entry', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    expect(pkg.scripts.bundle).toBe('bun run build && bun run scripts/bundle-portable.ts');
  });

  it('routes only the embedding import and rejects a changed build seam', () => {
    const source =
      "import { env, pipeline } from '@huggingface/transformers';\nexport const native = false;";
    expect(routePortableEmbeddings(source)).toBe(
      "import { env, pipeline } from '../../portable/transformers.mjs';\nexport const native = false;",
    );
    expect(() => routePortableEmbeddings('')).toThrow('Expected exactly one Transformers import');
    expect(() => routePortableEmbeddings(`${source}\n${source}`)).toThrow(
      'Expected exactly one Transformers import',
    );
  });

  it.each([
    ['node_modules/sharp/lib/index.js', false],
    ['node_modules/@img/sharp-linux-x64/lib/sharp.node', false],
    ['node_modules/parent/node_modules/onnxruntime-node/dist/binding.js', false],
    ['node_modules/@duckdb/node-bindings-win32-x64/duckdb.dll', false],
    ['node_modules/other/lib/libtest.so.1', false],
    ['C:\\bundle\\node_modules\\@img\\sharp-win32-x64\\binding.node', false],
    ['dist/portable/ort-wasm-simd-threaded.wasm', true],
    ['dist/portable/ort-wasm-simd-threaded.mjs', true],
    ['dist/portable/transformers.mjs', true],
    ['node_modules/pino/lib/worker.js', true],
  ])('classifies the packaged runtime asset %s', (filename, portable) => {
    expect(includePortableDependency(filename)).toBe(portable);
  });

  it('pins the internal Transformers integration', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    expect(pkg.dependencies['@huggingface/transformers']).toBe('4.3.1');
    const backend = await readFile(
      new URL('node_modules/@huggingface/transformers/src/backends/onnx.js', root),
      'utf8',
    );
    expect(backend).toContain("const ORT_SYMBOL = Symbol.for('onnxruntime')");
    expect(backend).toContain('ONNX = globalThis[ORT_SYMBOL]');
  });

  it('executes the adapter with fp32 WASM inference and a persistent writable cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cyanheads-portable-test-'));
    try {
      await cp(new URL('scripts/portable-transformers.mjs', root), join(directory, 'adapter.mjs'));
      await writeFile(join(directory, 'ort.node.min.mjs'), 'export const env = { wasm: {} };');
      await writeFile(
        join(directory, 'ort-wasm-simd-threaded.wasm'),
        new Uint8Array([0, 97, 115, 109]),
      );
      await writeFile(
        join(directory, 'transformers.web.js'),
        'export const env = {}; export const pipeline = (task, model, options) => ({ task, model, options });',
      );
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(
        join(directory, 'verify.mjs'),
        `import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { env, pipeline } from './adapter.mjs';
const ort = globalThis[Symbol.for('onnxruntime')];
assert.equal(ort.env.wasm.numThreads, 1);
assert.deepEqual([...ort.env.wasm.wasmBinary], [0, 97, 115, 109]);
assert.equal(ort.env.wasm.wasmPaths.mjs, new URL('./ort-wasm-simd-threaded.mjs', import.meta.url).href);
assert.equal(ort.env.wasm.wasmPaths.wasm, new URL('./ort-wasm-simd-threaded.wasm', import.meta.url).href);
assert.deepEqual(pipeline('feature-extraction', 'test/model', { revision: 'main', dtype: 'q8', device: 'cpu' }), { task: 'feature-extraction', model: 'test/model', options: { revision: 'main', dtype: 'fp32', device: 'auto', session_options: { executionProviders: ['wasm'] } } });
assert.equal(env.allowLocalModels, false);
assert.equal(env.useCustomCache, true);
assert.equal(env.useBrowserCache, false);
assert.equal(env.useFSCache, false);
env.cacheDir = new URL('./model-cache', import.meta.url).pathname;
const key = 'https://models.example.test/model?revision=main';
assert.equal(await env.customCache.match(key), undefined);
await env.customCache.put(key, new Response(new Uint8Array([0, 255, 17])));
assert.deepEqual([...new Uint8Array(await (await env.customCache.match(key)).arrayBuffer())], [0, 255, 17]);
assert.equal((await readdir(env.cacheDir)).length, 1);
env.cacheDir = new URL('./second-cache', import.meta.url).pathname;
assert.equal(await env.customCache.match(key), undefined);
await mkdir(env.cacheDir);
await writeFile(env.cacheDir + '/blocked', 'file');
env.cacheDir += '/blocked';
await assert.rejects(env.customCache.match(key), { code: 'ENOTDIR' });
await assert.rejects(env.customCache.put(key, new Response('data')));
`,
      );
      expect(() =>
        execFileSync(process.execPath, [join(directory, 'verify.mjs')], {
          timeout: 10000,
          stdio: 'pipe',
        }),
      ).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
