# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
