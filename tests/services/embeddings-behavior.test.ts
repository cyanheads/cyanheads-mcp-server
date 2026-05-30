/**
 * @fileoverview Tests for TransformersEmbeddingsRuntime output behavior —
 * prefix prepending, L2 normalization, Matryoshka truncation, and error paths.
 * Mocks @huggingface/transformers so no model is downloaded.
 * @module tests/services/embeddings-behavior.test
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

/**
 * Build a fake pipeline extractor that captures the last call input
 * and returns a configurable output row.
 */
function fakeExtractor(rows: number[][] = [[1, 2, 0, 0]], captureRef?: { lastInput: string[] }) {
  return vi.fn().mockImplementation(async (inputs: string[]) => {
    if (captureRef) captureRef.lastInput = inputs;
    return { tolist: () => rows };
  });
}

describe('TransformersEmbeddingsRuntime — prefix behavior', () => {
  beforeEach(() => {
    mockPipeline.mockReset();
  });

  it('prepends the query prefix to the input text', async () => {
    const captured: { lastInput: string[] } = { lastInput: [] };
    mockPipeline.mockResolvedValue(fakeExtractor([[1, 0, 0, 0]], captured));

    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    await runtime.embedQuery('hello world', 4, 'search_query: ');

    expect(captured.lastInput).toHaveLength(1);
    expect(captured.lastInput[0]).toBe('search_query: hello world');
  });

  it('uses an empty prefix when passed an empty string', async () => {
    const captured: { lastInput: string[] } = { lastInput: [] };
    mockPipeline.mockResolvedValue(fakeExtractor([[1, 0, 0, 0]], captured));

    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    await runtime.embedQuery('my query', 4, '');

    expect(captured.lastInput[0]).toBe('my query');
  });
});

describe('TransformersEmbeddingsRuntime — L2 normalization', () => {
  beforeEach(() => {
    mockPipeline.mockReset();
  });

  it('normalizes a non-unit vector to approximately unit length', async () => {
    // Output row [3, 4, 0, 0] — magnitude 5 before normalization
    mockPipeline.mockResolvedValue(fakeExtractor([[3, 4, 0, 0]]));
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    const vec = await runtime.embedQuery('query', 4, 'Q: ');

    // L2 norm should be ≈ 1
    let sumSq = 0;
    for (const v of vec) sumSq += v * v;
    expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 5);

    // Components: 3/5 and 4/5
    expect(vec[0]).toBeCloseTo(0.6, 5);
    expect(vec[1]).toBeCloseTo(0.8, 5);
  });

  it('returns a zero vector unchanged when magnitude is zero', async () => {
    mockPipeline.mockResolvedValue(fakeExtractor([[0, 0, 0, 0]]));
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    const vec = await runtime.embedQuery('zero', 4, 'Q: ');

    for (const v of vec) expect(v).toBe(0);
  });

  it('already-normalized vector remains stable after re-normalization', async () => {
    const norm = 1 / Math.sqrt(2);
    mockPipeline.mockResolvedValue(fakeExtractor([[norm, norm, 0, 0]]));
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    const vec = await runtime.embedQuery('unit', 4, 'Q: ');

    let sumSq = 0;
    for (const v of vec) sumSq += v * v;
    expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 5);
  });
});

describe('TransformersEmbeddingsRuntime — Matryoshka truncation', () => {
  beforeEach(() => {
    mockPipeline.mockReset();
  });

  it('truncates a longer vector to the requested dims', async () => {
    // Return 8-dim vector; request 4 dims
    mockPipeline.mockResolvedValue(fakeExtractor([[1, 0, 0, 0, 9, 9, 9, 9]]));
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    const vec = await runtime.embedQuery('query', 4, 'Q: ');

    expect(vec.length).toBe(4);
    // The trailing dimensions should not appear
    for (const v of Array.from(vec)) {
      expect(v).not.toBe(9);
    }
  });

  it('returns a Float32Array of exactly the requested dims', async () => {
    mockPipeline.mockResolvedValue(fakeExtractor([[1, 0, 0, 0, 0, 0, 0, 0]]));
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    const vec = await runtime.embedQuery('query', 4, 'Q: ');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(4);
  });
});

describe('TransformersEmbeddingsRuntime — error paths', () => {
  beforeEach(() => {
    mockPipeline.mockReset();
  });

  it('throws McpError when the pipeline returns a vector shorter than dims', async () => {
    // Only 2 elements — requesting 4 dims
    mockPipeline.mockResolvedValue(fakeExtractor([[1, 0]]));
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    await expect(runtime.embedQuery('query', 4, 'Q: ')).rejects.toMatchObject({
      message: expect.stringContaining('length'),
    });
  });

  it('throws a descriptive error when pipeline load fails', async () => {
    mockPipeline.mockRejectedValueOnce(new Error('model file not found'));
    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);
    await expect(runtime.embedQuery('query', 4, 'Q: ')).rejects.toMatchObject({
      message: expect.stringContaining('Failed to load embedding model'),
    });
  });

  it('error message includes the model id when loading fails', async () => {
    mockPipeline.mockRejectedValueOnce(new Error('download failed'));
    const runtime = new TransformersEmbeddingsRuntime('my-special-model');
    const err = await runtime.embedQuery('query', 4, 'Q: ').catch((e: unknown) => e);
    const msg = String(err instanceof Error ? err.message : err);
    expect(msg).toContain('my-special-model');
  });

  it('retries load after a failure', async () => {
    mockPipeline.mockRejectedValueOnce(new Error('first failure'));
    mockPipeline.mockResolvedValueOnce(fakeExtractor([[1, 0, 0, 0]]));

    const runtime = new TransformersEmbeddingsRuntime(TEST_MODEL);

    // First call fails
    await expect(runtime.embedQuery('a', 4, 'Q: ')).rejects.toThrow();

    // Second call should succeed (retry)
    const vec = await runtime.embedQuery('b', 4, 'Q: ');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(mockPipeline).toHaveBeenCalledTimes(2);
  });
});
