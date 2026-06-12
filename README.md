<div align="center">
  <h1>@cyanheads/cyanheads-mcp-server</h1>
  <p><b>Discover MCP servers via semantic search. One endpoint, 40+ hosted servers, per-client install snippets. STDIO or Streamable HTTP.</b>
  <div>2 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cyanheads-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cyanheads-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cyanheads-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-%3E=1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cyanheads-mcp-server/releases/latest/download/cyanheads-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cyanheads-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY3lhbmhlYWRzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cyanheads-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/cyanheads-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://cyanheads.caseyjhand.com/mcp](https://cyanheads.caseyjhand.com/mcp)

</div>

---

## Tools

Two tools, semantic ranking, hosted catalog. The catalog itself lives at [`caseyjhand.com/fleet.json`](https://caseyjhand.com/fleet.json) — a single JSON file with baked embeddings, regenerated when servers are added or updated. This server polls it hourly and serves search out of an in-memory vector index.

| Tool | Description |
|:---|:---|
| `cyanheads_search` | Search fleet tools and servers by natural-language query. Returns ranked matches with brief summaries and the owning server. |
| `cyanheads_describe` | Return the connection URL and per-client install snippets for a named tool or server. |

### `cyanheads_search`

Semantic search across the fleet. Embeds the query with [Snowflake Arctic Embed M v1.5](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5) (Matryoshka-truncated to 256 dimensions) and computes cosine similarity against the catalog's pre-computed document vectors.

- `scope: "tools"` (default) returns individual tool matches; `scope: "servers"` returns server-level matches
- `category` filter narrows to one of `research`, `government`, `public-data`, `utility`
- Configurable `limit` (1-20, default 5) and a server-side `SIMILARITY_FLOOR` threshold drop low-confidence hits
- Returns `score` (cosine similarity in [0, 1]) on every result for trust calibration
- `totalMatched` reports the count above the floor before the limit was applied

---

### `cyanheads_describe`

Resolve a name to its install instructions. Accepts either a tool name (snake_case, e.g. `earthquake_search`) or a server name (kebab-case, e.g. `earthquake-mcp-server`) — auto-detected from the format, or pinned via the `kind` parameter.

- For tools: returns the description and the owning server name
- For servers: returns description, version, npm package, GitHub URL, the full tool list (each tool's name and description), and per-client install snippets — **local (stdio, via `npx`) for every server, plus remote (Streamable HTTP) when a hosted endpoint exists**
- Each snippet carries a `transport` (`stdio` or `http`); env vars a local install needs are surfaced and scaffolded into the JSON configs
- `client` filter narrows snippets to one of `claude-code`, `codex`, `cursor`, `gemini`, `streamable-http`, `curl`; omit to return every client
- Discriminated output on `kind` — callers branch on data, not string parsing

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling with typed error contracts and recovery hints
- Pluggable auth (`none`, `jwt`, `oauth`)
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

Fleet-specific:

- Hourly background catalog refresh with atomic swap on `generatedAt` change — no restart needed when the fleet updates
- L2-normalized 256-dim Matryoshka-truncated vectors keep memory under 100KB for a 40-server fleet
- Per-client install snippet generation at describe-time, not catalog-generation time — both local (stdio `npx`) and remote (Streamable HTTP) transports, kept in sync with the deployed endpoint
- Discriminated `result.kind` and typed `installSnippets[].client` / `installSnippets[].transport` enums — agents can branch reliably

## What's in the fleet

40+ MCP servers spanning four categories. Each is open source and individually addressable — `cyanheads_describe` returns its direct connection URL alongside the install snippet.

| Category | Examples |
|:--|:--|
| **Research** | arXiv, bioRxiv, ORCID, Crossref, Wikipedia, Wikidata, OpenLibrary |
| **Government** | OpenStates, USAspending, CourtListener, NIST NVD, Library of Congress |
| **Public Data** | Earthquake (USGS), NOAA Weather, GBIF Biodiversity, World Bank, WHO, Eurostat |
| **Utility** | OpenStreetMap geocoding, Reference Data (constants, timezones, units), WSDOT |

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).

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

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Every variable has a sensible default — out of the box, the server points at the canonical cyanheads fleet.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_HOST` | HTTP server bind host | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `CATALOG_URL` | Remote fleet.json endpoint (schema v2 with baked embeddings). Override to front your own fleet. | `https://caseyjhand.com/fleet.json` |
| `CATALOG_FETCH_TIMEOUT_MS` | Per-request timeout for fleet.json fetches in ms | `10000` |
| `CATALOG_REFRESH_SECONDS` | Background poll interval for fleet.json refresh. `0` disables. | `3600` |
| `EMBEDDING_MODEL_ID` | Hugging Face model id for query embedding. Must match `fleet.json.embeddingModel`. | `Snowflake/snowflake-arctic-embed-m-v1.5` |
| `SIMILARITY_FLOOR` | Cosine similarity cutoff for `cyanheads_search` results (0-1) | `0.3` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

To point at a different catalog, change `CATALOG_URL` to your own hosted JSON file. See [`docs/design.md`](./docs/design.md) for the producer-side script and schema.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, runs MCP and packaging linters
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Two tools — `cyanheads_search` and `cyanheads_describe`. |
| `src/services/catalog` | Catalog service — remote fleet.json provider with atomic-swap refresh, vector index, snippet builders. |
| `src/services/embeddings` | Embedding runtime — query-time inference via `@huggingface/transformers`, with an injectable interface for deterministic tests. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |
| `docs/` | Design doc and schema reference. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `src/mcp-server/tools/definitions/index.ts`

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
