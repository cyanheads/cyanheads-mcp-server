# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
