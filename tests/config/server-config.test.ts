/**
 * @fileoverview Tests for the server config schema's documented bounds.
 * Exercises getServerConfig() against a stubbed process.env — no live I/O.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

/** Parse the config with a single env var set, isolated from the process env. */
function parseWith(key: string, value: string) {
  resetServerConfig();
  process.env[key] = value;
  try {
    return getServerConfig();
  } finally {
    delete process.env[key];
  }
}

afterEach(() => {
  resetServerConfig();
});

describe('server config bounds', () => {
  it('applies documented defaults when nothing is set', () => {
    resetServerConfig();
    const config = getServerConfig();
    expect(config).toMatchObject({
      catalogUrl: 'https://caseyjhand.com/fleet.json',
      catalogFetchTimeoutMs: 10000,
      catalogRefreshSeconds: 3600,
      embeddingModelId: 'Snowflake/snowflake-arctic-embed-m-v1.5',
      similarityFloor: 0.3,
    });
  });

  describe('SIMILARITY_FLOOR', () => {
    it.each(['0', '0.5', '1'])('accepts %s (inside [0, 1])', (value) => {
      expect(parseWith('SIMILARITY_FLOOR', value).similarityFloor).toBe(Number(value));
    });

    it.each(['-1', '-0.01', '1.01', '2'])('rejects %s (outside [0, 1])', (value) => {
      expect(() => parseWith('SIMILARITY_FLOOR', value)).toThrow(/SIMILARITY_FLOOR/);
    });

    it('rejects a non-numeric value', () => {
      expect(() => parseWith('SIMILARITY_FLOOR', 'high')).toThrow(/SIMILARITY_FLOOR/);
    });
  });

  describe('CATALOG_FETCH_TIMEOUT_MS', () => {
    it.each(['1', '500', '60000'])('accepts %s', (value) => {
      expect(parseWith('CATALOG_FETCH_TIMEOUT_MS', value).catalogFetchTimeoutMs).toBe(
        Number(value),
      );
    });

    it.each(['0', '-1', '-5000'])('rejects %s (must be positive)', (value) => {
      expect(() => parseWith('CATALOG_FETCH_TIMEOUT_MS', value)).toThrow(
        /CATALOG_FETCH_TIMEOUT_MS/,
      );
    });

    it.each(['Infinity', 'soon'])('rejects %s (must be a finite number)', (value) => {
      expect(() => parseWith('CATALOG_FETCH_TIMEOUT_MS', value)).toThrow(
        /CATALOG_FETCH_TIMEOUT_MS/,
      );
    });
  });

  describe('CATALOG_REFRESH_SECONDS', () => {
    it('accepts 0 to disable background refresh', () => {
      expect(parseWith('CATALOG_REFRESH_SECONDS', '0').catalogRefreshSeconds).toBe(0);
    });

    it.each(['1', '3600'])('accepts %s', (value) => {
      expect(parseWith('CATALOG_REFRESH_SECONDS', value).catalogRefreshSeconds).toBe(Number(value));
    });

    it.each(['-1', '-5'])('rejects %s (must be 0 or positive)', (value) => {
      expect(() => parseWith('CATALOG_REFRESH_SECONDS', value)).toThrow(/CATALOG_REFRESH_SECONDS/);
    });

    it.each(['Infinity', 'hourly'])('rejects %s (must be a finite number)', (value) => {
      expect(() => parseWith('CATALOG_REFRESH_SECONDS', value)).toThrow(/CATALOG_REFRESH_SECONDS/);
    });
  });

  describe('CATALOG_URL', () => {
    it('accepts an absolute URL', () => {
      expect(parseWith('CATALOG_URL', 'https://example.test/fleet.json').catalogUrl).toBe(
        'https://example.test/fleet.json',
      );
    });

    it.each(['', 'not-a-url', '/fleet.json'])('rejects %s', (value) => {
      expect(() => parseWith('CATALOG_URL', value)).toThrow(/CATALOG_URL/);
    });
  });

  describe('EMBEDDING_MODEL_ID', () => {
    it('accepts a model id', () => {
      expect(parseWith('EMBEDDING_MODEL_ID', 'test/mock-model').embeddingModelId).toBe(
        'test/mock-model',
      );
    });

    it('rejects an empty value', () => {
      expect(() => parseWith('EMBEDDING_MODEL_ID', '')).toThrow(/EMBEDDING_MODEL_ID/);
    });
  });
});
