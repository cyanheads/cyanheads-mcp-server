# cyanheads-mcp-server

**One MCP endpoint. 40+ hosted servers. Semantic search over every tool.**

```
https://cyanheads.caseyjhand.com/mcp
```

Add that URL to your MCP client. Your agent gets two tools — `cyanheads_search` and `cyanheads_describe` — and uses them to discover and install any server in the cyanheads fleet without you maintaining a sprawling local config.

---

## Add it to your client

### Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` and merge into `mcpServers`:

```json
{
  "mcpServers": {
    "cyanheads": {
      "type": "sse",
      "url": "https://cyanheads.caseyjhand.com/mcp"
    }
  }
}
```

### Claude Code

```sh
claude mcp add --transport sse cyanheads https://cyanheads.caseyjhand.com/mcp
```

### Cursor

Merge into `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cyanheads": {
      "type": "sse",
      "url": "https://cyanheads.caseyjhand.com/mcp"
    }
  }
}
```

### Cline

Merge into Cline's MCP settings:

```json
{
  "cyanheads": {
    "type": "sse",
    "url": "https://cyanheads.caseyjhand.com/mcp",
    "disabled": false,
    "autoApprove": []
  }
}
```

---

## What you can ask

| You say | Agent finds |
|:--|:--|
| "search recent arxiv papers about quantum computing" | `arxiv_search` (arxiv-mcp-server), via semantic match on "research papers" |
| "look up earthquake activity in California" | `earthquake_search` (earthquake-mcp-server) |
| "what server handles federal spending data?" | `usaspending-mcp-server` (scope: servers) |
| "find a tool that resolves a place name to coordinates" | `openstreetmap_geocode` (openstreetmap-mcp-server) |
| "how do I add the bioRxiv server to Cursor?" | Install snippet via `cyanheads_describe` |

After each search match, the agent can ask `cyanheads_describe` to get the connection URL and per-client install snippet so you can add the underlying server directly if you want it always-on.

---

## What's in the fleet

40+ MCP servers spanning four domains. The catalog is regenerated on every portfolio deploy by walking each server's live endpoint — descriptions and tool names always match what the server actually exposes.

| Category | Examples |
|:--|:--|
| **Research** | arXiv, bioRxiv, ORCID, Crossref, Wikipedia, Wikidata, OpenLibrary |
| **Government** | OpenStates, USAspending, CourtListener, NIST NVD, Library of Congress |
| **Public Data** | Earthquake (USGS), NOAA Weather, GBIF Biodiversity, World Bank, WHO, Eurostat |
| **Utility** | OpenStreetMap geocoding, Reference Data (constants, timezones, units), WSDOT |

Each server is open source and individually addressable — `cyanheads_describe` returns the direct connection URL alongside the install snippet.

---

## How it works

Two tools, semantic ranking, hosted catalog.

- **`cyanheads_search`** embeds your natural-language query with [Snowflake Arctic Embed M v1.5](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5) (Matryoshka-truncated to 256 dimensions) and computes cosine similarity against the catalog's pre-computed document vectors. Returns the top-N matching tools or servers.
- **`cyanheads_describe`** returns the description, connection URL, and per-client install snippet for any tool or server name.

The catalog itself lives at [`caseyjhand.com/fleet.json`](https://caseyjhand.com/fleet.json) — a single JSON file with baked embeddings, regenerated when servers are added or updated. This server polls it hourly and serves search out of an in-memory vector index.

---

## Self-hosting

You probably don't need this — the hosted endpoint is the product. The source is open for reference and the rare case where you want to front your own fleet.

```sh
git clone https://github.com/cyanheads/cyanheads-mcp-server.git
cd cyanheads-mcp-server
bun install
bun run build
bun run start:http
```

Environment variables (all optional):

| Variable | Default | Description |
|:--|:--|:--|
| `CATALOG_URL` | `https://caseyjhand.com/fleet.json` | Remote fleet.json endpoint (must be schema v2 with baked embeddings). |
| `CATALOG_REFRESH_SECONDS` | `3600` | Background poll interval. 0 disables. |
| `EMBEDDING_MODEL_ID` | `Snowflake/snowflake-arctic-embed-m-v1.5` | Must match `fleet.json.embeddingModel`. |
| `SIMILARITY_FLOOR` | `0.3` | Cosine similarity threshold below which results are dropped. |
| `MCP_TRANSPORT_TYPE` | `stdio` | `stdio` or `http`. |
| `MCP_HTTP_PORT` | `3000` | HTTP port when transport is `http`. |

To point at a different catalog, change `CATALOG_URL` to your own hosted JSON file. See [the cyanheads-mcp-server design doc](./docs/design.md) for the producer-side script and schema.

---

## Built with

- [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) — TypeScript MCP server framework
- [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) — ONNX-based runtime for embeddings inference
- [Snowflake Arctic Embed M v1.5](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5) — embedding model (Apache 2.0)

## License

Apache 2.0. See [LICENSE](./LICENSE).
