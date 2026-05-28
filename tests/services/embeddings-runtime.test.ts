/**
 * @fileoverview Tests for TransformersEmbeddingsRuntime lazy-load semantics.
 * Mocks @huggingface/transformers's pipeline factory so the model is never
 * actually downloaded — the tests assert call counts and timing, not real
 * inference output.
 * @module tests/services/embeddings-runtime.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPipeline } = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '' },
  pipeline: mockPipeline,
}));

const { TransformersEmbeddingsRuntime } = await import('@/services/catalog/embeddings-runtime.js');

const TEST_MODEL = 'test/mock-embed-v1';

function fakeExtractor(rows: number[][] = [[1, 0, 0, 0]]) {
  return vi.fn().mockResolvedValue({
    tolist: () => rows,
  });
}

describe('TransformersEmbeddingsRuntime — lazy load', () => {
  beforeEach(() => {
    mockPipeline.mockReset();
  });

  it('does not load the pipeline when constructed', () => {
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    expect(runtime.modelId).toBe(TEST_MODEL);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('loads the pipeline on the first embedQuery call', async () => {
    mockPipeline.mockResolvedValue(fakeExtractor());
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);

    const vec = await runtime.embedQuery('hello', 4, 'Q: ');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(4);
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', TEST_MODEL);
  });

  it('reuses the warm pipeline on subsequent calls', async () => {
    mockPipeline.mockResolvedValue(fakeExtractor());
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);

    await runtime.embedQuery('one', 4, 'Q: ');
    await runtime.embedQuery('two', 4, 'Q: ');
    await runtime.embedQuery('three', 4, 'Q: ');

    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });

  it('shares the in-flight load across concurrent first callers', async () => {
    let resolvePipeline!: (v: unknown) => void;
    mockPipeline.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePipeline = resolve;
        }),
    );
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);

    const p1 = runtime.embedQuery('a', 4, 'Q: ');
    const p2 = runtime.embedQuery('b', 4, 'Q: ');
    const p3 = runtime.embedQuery('c', 4, 'Q: ');

    resolvePipeline(fakeExtractor());

    const [v1, v2, v3] = await Promise.all([p1, p2, p3]);
    expect(v1).toBeInstanceOf(Float32Array);
    expect(v2).toBeInstanceOf(Float32Array);
    expect(v3).toBeInstanceOf(Float32Array);
    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });

  it('clears the load promise on failure so the next call retries', async () => {
    mockPipeline.mockRejectedValueOnce(new Error('disk full'));
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);

    await expect(runtime.embedQuery('first', 4, 'Q: ')).rejects.toThrow(
      /Failed to load embedding model/,
    );
    expect(mockPipeline).toHaveBeenCalledTimes(1);

    mockPipeline.mockResolvedValueOnce(fakeExtractor());
    const vec = await runtime.embedQuery('second', 4, 'Q: ');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(mockPipeline).toHaveBeenCalledTimes(2);
  });
});
