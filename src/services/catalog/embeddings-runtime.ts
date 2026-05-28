/**
 * @fileoverview Embeddings runtime — wraps @huggingface/transformers's
 * feature-extraction pipeline to embed query strings at search time.
 * Loaded once at startup, kept warm for the lifetime of the process.
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
  initialize(): Promise<void>;
  readonly modelId: string;
}

export class TransformersEmbeddingsRuntime implements IEmbeddingsRuntime {
  private _extractor: FeatureExtractionPipeline | null = null;

  constructor(public readonly modelId: string) {}

  async initialize(): Promise<void> {
    if (this._extractor) return;
    logger.info(`Loading embedding model: ${this.modelId}`);
    const startMs = Date.now();
    try {
      this._extractor = (await pipeline(
        'feature-extraction',
        this.modelId,
      )) as FeatureExtractionPipeline;
    } catch (err) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Failed to load embedding model ${this.modelId}: ${err instanceof Error ? err.message : String(err)}`,
        { modelId: this.modelId },
        { cause: err },
      );
    }
    logger.info(`Embedding model loaded in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
  }

  async embedQuery(text: string, dims: number, queryPrefix: string): Promise<Float32Array> {
    if (!this._extractor) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        'Embeddings runtime not initialized — call initialize() first.',
      );
    }
    const input = `${queryPrefix}${text}`;
    const tensor = await this._extractor([input], {
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
