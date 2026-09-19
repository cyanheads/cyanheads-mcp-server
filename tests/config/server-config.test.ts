/**
 * @fileoverview Tests for the server config schema's documented bounds.
 * Exercises getServerConfig() against a stubbed process.env — no live I/O.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

/**
 * The literal text an unsubstituted `$\{VAR}` interpolation leaves behind — what
 * a compose file or shell template writes when the variable is unset. Built from
 * parts rather than written as a plain string so it reads as the deliberate
 * payload it is, not a template literal someone forgot to backtick.
 */
function unsubstituted(name: string): string {
  return `\${${name}}`;
}

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

    it.each(['not-a-url', '/fleet.json'])('rejects %s', (value) => {
      expect(() => parseWith('CATALOG_URL', value)).toThrow(/CATALOG_URL/);
    });

    /**
     * An empty string and a whole-value unsubstituted `${…}` placeholder read as
     * unset, so a defaulted field takes its default instead of failing the URL
     * format check. This is what a compose file interpolating an unset variable
     * produces, and the server must still boot against the canonical fleet.
     */
    it.each(['', unsubstituted('CATALOG_URL')])(
      'reads %s as unset and takes the default',
      (value) => {
        expect(parseWith('CATALOG_URL', value).catalogUrl).toBe(
          'https://caseyjhand.com/fleet.json',
        );
      },
    );

    /**
     * Only a whole-value placeholder reads as unset. One embedded in a larger
     * value is kept verbatim, so an interpolation that failed mid-string
     * surfaces as the literal it is rather than silently taking the default.
     */
    it('keeps a value that merely contains a placeholder', () => {
      const embedded = `https://${unsubstituted('HOST')}/fleet.json`;
      expect(parseWith('CATALOG_URL', embedded).catalogUrl).toBe(embedded);
    });
  });

  describe('EMBEDDING_MODEL_ID', () => {
    it('accepts a model id', () => {
      expect(parseWith('EMBEDDING_MODEL_ID', 'test/mock-model').embeddingModelId).toBe(
        'test/mock-model',
      );
    });

    it.each(['', unsubstituted('EMBEDDING_MODEL_ID')])(
      'reads %s as unset and takes the default',
      (value) => {
        expect(parseWith('EMBEDDING_MODEL_ID', value).embeddingModelId).toBe(
          'Snowflake/snowflake-arctic-embed-m-v1.5',
        );
      },
    );
  });
});
