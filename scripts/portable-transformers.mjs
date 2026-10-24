/**
 * @fileoverview MCPB-only Transformers 4.3.1 adapter using local ONNX WASM assets.
 * @module scripts/portable-transformers
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as ort from './ort.node.min.mjs';

/** Transformers 4.3.1 reads this internal injection point before choosing Node's backend. */
globalThis[Symbol.for('onnxruntime')] = ort;
ort.env.wasm.wasmPaths = {
  mjs: new URL('./ort-wasm-simd-threaded.mjs', import.meta.url).href,
  wasm: new URL('./ort-wasm-simd-threaded.wasm', import.meta.url).href,
};
ort.env.wasm.wasmBinary = await readFile(new URL('./ort-wasm-simd-threaded.wasm', import.meta.url));
ort.env.wasm.numThreads = 1;

const web = await import('./transformers.web.js');
export const env = web.env;
env.allowLocalModels = false;
env.useCustomCache = true;
env.useBrowserCache = false;
env.useFSCache = false;
env.customCache = {
  async match(key) {
    const filename = path.join(
      env.cacheDir,
      createHash('sha256').update(String(key)).digest('hex'),
    );
    try {
      return new Response(await readFile(filename));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
  },
  async put(key, response) {
    await mkdir(env.cacheDir, { recursive: true });
    const filename = path.join(
      env.cacheDir,
      createHash('sha256').update(String(key)).digest('hex'),
    );
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  },
};

/** Preserve the CPU path's precision; WASM otherwise defaults to quantized q8. */
export const pipeline = (task, model, options = {}) =>
  web.pipeline(task, model, {
    ...options,
    device: 'auto',
    dtype: 'fp32',
    session_options: { executionProviders: ['wasm'] },
  });
