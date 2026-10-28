/**
 * @fileoverview Regression tests for the `.mcpb` agent-doc matcher shared by
 * `scripts/clean-mcpb.ts` (strip) and `scripts/lint-packaging.ts` (check 8):
 * runtime `skills/` modules deep in a package ship, package-root agent docs
 * don't, and the two literals select the same entries.
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * `scripts/lint-packaging.ts` is loaded by URL at run time, not through a
 * static import: its repo-only fallback `import('../src/mcp-server/skills.js')`
 * resolves nowhere in this server, so letting `tsc` follow the module fails the
 * typecheck (mcp-ts-core#797).
 */
const lintPackagingUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const lintPackaging = (await import(lintPackagingUrl)) as {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], bundleLabel: string) => string[];
};

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.cjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.d.mts',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/dist/mcp-server/skills.js',
  'node_modules/some-pkg/lib/.claude/runtime.js',
  'node_modules/@scope/skills/dist/index.js',
  'node_modules/@scope/skills/package.json',
  'skills/catalog-search/SKILL.md',
  'dist/index.js',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/dotenv/skills/dotenvx/reference.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/some-pkg/.agents/skills/x/SKILL.md',
  'node_modules/@scope/pkg/skills/guide/SKILL.md',
  'node_modules/@scope/pkg/.claude/settings.local.json',
  'node_modules/a/node_modules/b/skills/doc.md',
  'node_modules/@s/a/node_modules/@t/b/.agents/notes.md',
  'node_modules/some-pkg/docs/deep/SKILL.md',
];

describe('bundle agent-doc matcher', () => {
  it('keeps runtime skills modules and non-agent paths', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
  });

  it('selects package-root agent docs and stray SKILL.md files', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
  });

  it('is the same literal in the cleaner and the packaging linter', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it('lets the packaging check pass a cleaned bundle holding SDK runtime skills', () => {
    expect(lintPackaging.checkBundleEntries(RUNTIME_ENTRIES, 'dist/x.mcpb')).toEqual([]);
  });

  it('fails the packaging check while a package-root agent doc remains', () => {
    const errors = lintPackaging.checkBundleEntries(
      [...RUNTIME_ENTRIES, 'node_modules/dotenv/skills/dotenv/SKILL.md'],
      'dist/x.mcpb',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('1 node_modules agent-doc entries');
    expect(errors[0]).toContain('node_modules/dotenv/skills/dotenv/SKILL.md');
  });
});
