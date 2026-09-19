<div align="center">
  <h1>@cyanheads/cyanheads-mcp-server</h1>
  <p><b>Fleet discovery for the cyanheads MCP ecosystem — semantic search + install snippets.</b>
  <div>2 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cyanheads-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cyanheads-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cyanheads-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-%3E=1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cyanheads-mcp-server/releases/latest/download/cyanheads-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cyanheads-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY3lhbmhlYWRzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cyanheads-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/cyanheads-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://cyanheads.caseyjhand.com/mcp](https://cyanheads.caseyjhand.com/mcp)

</div>

---

## Overview

Fleet discovery for the cyanheads MCP ecosystem, built on a hosted `fleet.json` catalog of pre-computed tool and server embeddings. Search the catalog by natural-language query, or resolve a known tool or server name to its description, connection URL, and per-client install snippet. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `cyanheads_search_catalog` | Search fleet tools and servers by natural-language query. Returns ranked matches with brief summaries and the owning server. |
| `cyanheads_describe_entry` | Return the description, connection URL, and per-client install snippet for a named tool or server. |

## Capability reference

### `cyanheads_search_catalog` <sub>tool</sub>

- `query` 1–500 characters; `scope` selects `tools` (default) or `servers` result granularity
- Optional `category` filter: `research`, `government`, `public-data`, `utility`
- `limit` 1–20 (default 5); results below the `SIMILARITY_FLOOR` (default `0.3`) are dropped before the limit applies
- Every result carries `score` (cosine similarity, `[0, 1]`), comparable only within one response
- For scope `tools`, a `servers` roll-up (top 10 by best-matching tool, `serversTotal` for the full count) summarizes which servers matched
- Throws retryable `catalog_empty` while the catalog is still loading

---

### `cyanheads_describe_entry` <sub>tool</sub>

- `name` 1–64 characters; accepts a snake_case tool name or kebab-case server name, auto-detected or pinned via `kind`
- Tool lookups return the description and owning server; server lookups return version, npm package, GitHub URL, the full tool list, and per-client install snippets
- `client` filters snippets to one of `claude-code`, `codex`, `cursor`, `gemini`, `streamable-http`, `curl`; omit for every client
- Local (stdio, via `npx`) snippets are returned for every published server; remote (Streamable HTTP) snippets are added only when a hosted endpoint exists
- Discriminated on `kind` (`tool` | `server`) so callers branch on data, not string parsing
- Throws `not_found` (unknown name), `ambiguous_kind` (name matches both a tool and a server — pass `kind` to disambiguate), or retryable `catalog_empty`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Catalog-specific:

- Hourly background catalog refresh (`CATALOG_REFRESH_SECONDS`, default `3600`) with an atomic index swap when `generatedAt` changes — no restart needed
- Query embeddings are computed at request time via `@huggingface/transformers`; document embeddings are pre-computed, L2-normalized, and Matryoshka-truncated, shipped inside `fleet.json`
- The embedding model is warmed up during startup, before OpenTelemetry's HTTP instrumentation patches `fetch` — avoids a cold-cache model-load failure under OTEL
- Self-describing: `cyanheads_describe_entry` resolves this server's own name and tools from a static fallback record, consulted only when the remote catalog doesn't carry an entry for it
- `CATALOG_URL` can point at any endpoint serving the same schema, to front a custom fleet

Agent-friendly output:

- Search responses echo the effective query, report the total match count before the limit, and include broadening guidance when nothing matches
- Discriminated `result.kind` (`tool` | `server`) on `cyanheads_describe_entry` lets callers branch on data, not string parsing
- Every search result carries a `score` field for trust calibration, plus a `servers` roll-up so agents can see which servers matched without a second call

## Getting started

### Public Hosted Instance

A public instance is available at `https://cyanheads.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "cyanheads-mcp-server": {
      "type": "streamable-http",
      "url": "https://cyanheads.caseyjhand.com/mcp"
    }
  }
}
```

For Claude Code:

```sh
claude mcp add --transport http cyanheads https://cyanheads.caseyjhand.com/mcp
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "cyanheads-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/cyanheads-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "cyanheads-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/cyanheads-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "cyanheads-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/cyanheads-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/cyanheads-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd cyanheads-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env to override any defaults
```

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
| `CATALOG_FETCH_TIMEOUT_MS` | Per-request timeout for fleet.json fetches in ms. Must be > 0. | `10000` |
| `CATALOG_REFRESH_SECONDS` | Background poll interval for fleet.json refresh. `0` disables; otherwise must be > 0. | `3600` |
| `EMBEDDING_MODEL_ID` | Hugging Face model id for query embedding. Must match `fleet.json.embeddingModel`. | `Snowflake/snowflake-arctic-embed-m-v1.5` |
| `SIMILARITY_FLOOR` | Cosine similarity cutoff for `cyanheads_search_catalog` results. Must be within `[0, 1]`. | `0.3` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
docker build -t cyanheads-mcp-server .
docker run --rm -p 3010:3010 cyanheads-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/cyanheads-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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
