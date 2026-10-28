<div align="center">
  <h1>@cyanheads/cyanheads-mcp-server</h1>
  <p><b>Fleet discovery for the cyanheads MCP ecosystem — semantic search + install snippets.</b>
  <div>2 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cyanheads-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cyanheads-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cyanheads-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cyanheads-mcp-server/releases/latest/download/cyanheads-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cyanheads-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY3lhbmhlYWRzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cyanheads-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcyanheads-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://cyanheads.caseyjhand.com/mcp](https://cyanheads.caseyjhand.com/mcp)

</div>

---

## Overview

Find the right MCP tool for the job across the cyanheads fleet. Describe a task in plain language to search every tool and server, then get a description, connection URL, and install snippet for your client.

### Tools

| Tool | Description |
|:---|:---|
| `cyanheads_search_catalog` | Search fleet tools and servers by natural-language query. Returns ranked matches with brief summaries and the owning server. |
| `cyanheads_describe_entry` | Return the description, connection URL, and per-client install snippet for a named tool or server. |

### Skills

| Skill | Description |
|:---|:---|
| [`cyanheads-guide`](./skills/cyanheads-guide/SKILL.md) | Find a fleet server for a task and hand over a working install: telling real matches from near misses, the category filter, hosted vs local installs, and env vars the snippets leave out. Served over MCP as `skill://cyanheads-guide/SKILL.md` and loaded by Claude Code and Codex plugin installs. |

## Capability reference

### `cyanheads_search_catalog` <sub>tool</sub>

- `query` 1–500 raw characters, with non-whitespace text required; surrounding whitespace is trimmed before embedding and echo. `scope` selects `tools` (default) or `servers`; optional `category`: `research`, `government`, `public-data`, `utility`; `limit` 1–1000 (default 5), served at most 20 per call: when a larger `limit` leaves matches past the page, the response adds `truncated`, `shown`, `cap`, and a `notice` naming the offset to continue from.
- Results carry cosine-similarity `score` (`[0, 1]`, comparable within one response). Tool searches include a `servers` roll-up with ten entries per page and `serversTotal`; an unloaded catalog returns retryable `catalog_empty`.
- Page results with `offset` and the tools-scope roll-up independently with `serversOffset` (both default to 0). Reuse the same query, scope, category, and limit with `nextOffset` / `nextServersOffset`; null means exhausted. Each call uses the current catalog, so a refresh between pages can change ordering. Servers scope requires `serversOffset: 0` and omits roll-up fields.
- `SIMILARITY_FLOOR` (default `0.3`) filters matches before the limit applies.
- An empty `category` string is treated as omitted; other unknown category values are rejected. Categories are catalog labels, not publisher types, and a wrong one drops the matching server without a notice unless nothing else matches.

---

### `cyanheads_describe_entry` <sub>tool</sub>

- `name` 1–64 characters accepts a tool or server name, auto-detected or pinned via `kind`. Exact names win, then unique case-insensitive names; output uses canonical names. `client` optionally selects `claude-code`, `cline`, `codex`, `cursor`, `gemini`, `streamable-http` (generic `mcpServers` JSON), or `curl`.
- `server` (optional, 1–64 characters) names the owning server: a search result's `name` + `server` describes exactly that row, in either scope. It is required when more than one server owns the tool name; with a server name, it must name the same server.
- Empty `kind`, `client`, and `server` strings are treated as omitted. Other unknown `kind` or `client` values are rejected.
- Both kinds return connection metadata and install snippets; server results also include the full tool inventory. Published servers get local snippets; hosted servers also get HTTP snippets. For local-only entries, `client: "curl"` returns successful metadata with an `installNotice` naming a stdio client to try. Required environment variables remain visible even without snippets; they list what the server's manifest marks required, so a key it leaves optional is absent.
- Descriptions are catalog text; obtain tool schemas from the connected server's `tools/list`.
- Failures return `not_found`, `ambiguous_kind` (set `kind`), `ambiguous_owner` (set `server`; the error lists the owners), or retryable `catalog_empty`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Catalog-specific:

- Hourly background catalog refresh (`CATALOG_REFRESH_SECONDS`, default `3600`) with an atomic index swap when `generatedAt` changes — no restart needed
- Empty catalogs, conflicting duplicate identities, and vectors that can't be normalized (wrong dimension, all zeros, or a non-finite component) fail before index replacement; refresh retains the last valid catalog. Identical duplicates collapse before indexing, with a bounded load-time warning; servers with no tools remain valid.
- Query embeddings are computed at request time via `@huggingface/transformers`; document embeddings are pre-computed, L2-normalized, and Matryoshka-truncated, shipped inside `fleet.json`. The server normalizes each document vector again at load, so scores stay cosine similarities even when a catalog's vectors drift from unit length, and a bounded warning names vectors more than `1e-4` off.
- The embedding model is warmed up during startup, before OpenTelemetry's HTTP instrumentation patches `fetch` — avoids a cold-cache model-load failure under OTEL
- Self-describing: `cyanheads_describe_entry` resolves this server's own name and tools from a static fallback record, consulted only when the remote catalog doesn't carry an entry for it
- `CATALOG_URL` can point at any endpoint serving the same schema, to front a custom fleet

Agent-friendly output:

- Search responses echo the effective query, report the total match count before the limit, include broadening guidance when nothing matches, and name the offset to continue from when a `limit` above 20 is cut to the per-call cap
- Discriminated `result.kind` (`tool` | `server`) on `cyanheads_describe_entry` lets callers branch on data, not string parsing
- Every search result carries a `score` field for trust calibration, plus a `servers` roll-up so agents can see which servers matched without a second call

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http cyanheads-mcp-server https://cyanheads.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add cyanheads-mcp-server -- npx -y @cyanheads/cyanheads-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "cyanheads-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/cyanheads-mcp-server"]
    }
  }
}
```

The Claude Desktop bundle (the install badge above) runs the embedding model on ONNX WebAssembly, so it needs no platform-specific native libraries; npm and Docker installs use native CPU inference. Either way, the first start downloads the embedding model and later starts reuse the model cache. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Every variable has a sensible default — out of the box, the server points at the canonical cyanheads fleet.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_HOST` | HTTP server bind host | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_SESSION_MODE` | HTTP session posture: `auto`, `stateful`, or `stateless`. `src/index.ts` declares `stateless`; set this only to override it. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `CATALOG_URL` | Remote fleet.json endpoint (schema v2 with baked embeddings). Must be an absolute URL. Override to front your own fleet. | `https://caseyjhand.com/fleet.json` |
| `CATALOG_FETCH_TIMEOUT_MS` | Per-request timeout for fleet.json fetches: integer milliseconds, `1`–`2147483647`. | `10000` |
| `CATALOG_REFRESH_SECONDS` | Background poll interval for fleet.json refresh. `0` disables; positive values up to `2147483.647` seconds use the runtime's millisecond timer resolution. | `3600` |
| `EMBEDDING_MODEL_ID` | Hugging Face model id for query embedding. Must match `fleet.json.embeddingModel`. | `Snowflake/snowflake-arctic-embed-m-v1.5` |
| `SIMILARITY_FLOOR` | Cosine similarity cutoff for `cyanheads_search_catalog` results. Must be within `[0, 1]`. | `0.3` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL for traces and metrics | Unset |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Explicit OTLP logs URL; requires the OTel log peers included in the default Docker build | Unset |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed arguments and results, redacted by key name. Secrets inside free-form values are not redacted. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | UTF-8 byte cap for each logged failure payload | `16384` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/cyanheads-mcp-server.git
  cd cyanheads-mcp-server && bun install
  cp .env.example .env   # every variable has a default; override as needed
  ```

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck  # Lints, formats, type-checks, runs MCP and packaging linters
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/cyanheads-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/cyanheads-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/cyanheads-mcp-server:latest"]`. To build locally, `docker build -t cyanheads-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Two tools — `cyanheads_search_catalog` and `cyanheads_describe_entry`. |
| `src/services/catalog` | Catalog service — remote fleet.json provider with atomic-swap refresh, vector index, snippet builders, the self-description fallback record, and the query-time embedding runtime (`@huggingface/transformers`, behind an injectable interface for deterministic tests). |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |
| `docs/` | Design doc and schema reference. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in the `tools` array passed to `createApp()` in `src/index.ts`
- Wrap external data: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
