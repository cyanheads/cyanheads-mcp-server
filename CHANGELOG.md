# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-07-26 · ⚠️ Breaking

Breaking tool rename (cyanheads_search_catalog / cyanheads_describe_entry), input-length bounds, and a self-description fallback for the front door's own server entry

## [0.3.4](changelog/0.3.x/0.3.4.md) — 2026-07-26

Fix unbounded config env vars (#8); adopt @cyanheads/mcp-ts-core ^0.11.0 with a supply-chain install guard, floating-specifier and plugin-manifest lint checks, and native-binding bundle stripping.

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-06-11

Adopt @cyanheads/mcp-ts-core ^0.10.6 — server name/title identity, Docker HEALTHCHECK + version label, bundle cleaner, tsx → bun run script migration.

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-06-04

cyanheads_describe returns full tool list on server branch — name + description for every tool, format() renders ## Tools section

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core 0.9.21 — request-context fix, secret-stripping in fetchWithTimeout, fail-fast withRetry

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-06-02

cyanheads_describe: local (stdio) install snippets for every server, plus remote (HTTP) when a hosted endpoint exists

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-05-30

cyanheads_search servers roll-up (scope tools), structured-empty on zero matches, and .mcpbignore root-anchor fix

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-30

cyanheads_search enrichment — query echo, true total, and empty-result guidance in a typed enrichment block reaching both structuredContent and content[]; structuredContent keys totalMatched→totalCount and query→effectiveQuery

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-28

Await the embedding model warm-up at setup — the 0.1.7 fire-and-forget races with @opentelemetry/instrumentation-http installing its fetch wrap, leaving the cold-cache model download permanently broken; await keeps pipeline() inside the pre-OTEL window

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-28

Trigger the lazy model load from setup() instead of waiting for the first request — works around a transformers.js cold-cache failure when pipeline() runs inside an OTEL-instrumented request handler

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-28

Lazy-load the embedding model on first cyanheads_search call — startup no longer blocks on ~2 s pipeline warm-up; first query absorbs the cost once, steady-state inference unchanged

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-28 · ⚠️ Breaking

Rewrite install snippet builders — drop legacy SSE transport tag, emit correct per-client formats (claude-code/codex/cursor/curl/gemini/streamable-http) verified against the hosted endpoint

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-28

README rewrite to match pubmed gold standard, .mcpb bundle restored for Claude Desktop one-click install, embeddings cache dir fix unblocks Docker non-root user, server.json advertises hosted endpoint via remotes[]

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-28

Fix Dockerfile build to invoke Bun on the script directly so multi-arch image builds succeed

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-28

Trim description to fit the MCP Registry 100-character cap so 0.1.1's metadata can list there

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-28

First public release — cyanheads_search semantic discovery over the cyanheads MCP fleet, cyanheads_describe with per-client install snippets

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-28

Initial scaffold bootstrap from @cyanheads/mcp-ts-core init
