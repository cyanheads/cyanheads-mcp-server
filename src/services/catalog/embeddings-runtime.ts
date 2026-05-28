/**
 * @fileoverview Embeddings runtime — wraps @huggingface/transformers's
 * feature-extraction pipeline to embed query strings at search time.
 * Lazy-loads the model on the first embedQuery() call; subsequent calls reuse
 * the warm pipeline for the lifetime of the process. Concurrent first-callers
 * share a single load promise so the model is fetched exactly once. On load
 * failure the promise is cleared so the next call retries from scratch.
 * Applies the asymmetric query prefix declared in the catalog payload and
 * Matryoshka-truncates + L2-normalizes the output to match document vectors.
 * @module services/catalog/embeddings-runtime
 */

import os from 'node:os';
import path from 'node:path';

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { env, type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers';

/**
 * Redirect the model cache out of the package's `node_modules/.cache` default
 * (unwritable in containers that install deps as root then drop to a non-root
 * runtime user). HF_HOME / TRANSFORMERS_CACHE honored when set; otherwise fall
 * back to a writable per-OS temp directory.
 */
env.cacheDir =
  process.env.HF_HOME ??
  process.env.TRANSFORMERS_CACHE ??
  path.join(os.tmpdir(), 'cyanheads-mcp-server', 'hf-cache');

export interface IEmbeddingsRuntime {
  embedQuery(text: string, dims: number, queryPrefix: string): Promise<Float32Array>;
  readonly modelId: string;
}

export class TransformersEmbeddingsRuntime implements IEmbeddingsRuntime {
  private _extractor: FeatureExtractionPipeline | null = null;
  private _loadPromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(public readonly modelId: string) {}

  private _ensureLoaded(): Promise<FeatureExtractionPipeline> {
    if (this._extractor) return Promise.resolve(this._extractor);
    if (!this._loadPromise) {
      logger.info(`Lazy-loading embedding model: ${this.modelId}`);
      const startMs = Date.now();
      this._loadPromise = (async () => {
        try {
          const extractor = (await pipeline(
            'feature-extraction',
            this.modelId,
          )) as FeatureExtractionPipeline;
          this._extractor = extractor;
          logger.info(`Embedding model loaded in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
          return extractor;
        } catch (err) {
          this._loadPromise = null;
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            `Failed to load embedding model ${this.modelId}: ${err instanceof Error ? err.message : String(err)}`,
            { modelId: this.modelId },
            { cause: err },
          );
        }
      })();
    }
    return this._loadPromise;
  }

  async embedQuery(text: string, dims: number, queryPrefix: string): Promise<Float32Array> {
    const extractor = await this._ensureLoaded();
    const input = `${queryPrefix}${text}`;
    const tensor = await extractor([input], {
      pooling: 'cls',
      normalize: false,
    });
    const rows = tensor.tolist() as number[][];
    const fullVec = rows[0];
    if (!fullVec || fullVec.length < dims) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Embedding pipeline returned a vector of length ${fullVec?.length ?? 0}; expected at least ${dims}.`,
      );
    }

    const out = new Float32Array(dims);
    let sumSq = 0;
    for (let i = 0; i < dims; i++) {
      // biome-ignore lint/style/noNonNullAssertion: length checked above
      const v = fullVec[i]!;
      out[i] = v;
      sumSq += v * v;
    }
    if (sumSq === 0) return out;
    const norm = Math.sqrt(sumSq);
    // biome-ignore lint/style/noNonNullAssertion: Float32Array allocated with exact dims
    for (let i = 0; i < dims; i++) out[i] = out[i]! / norm;
    return out;
  }
}
