# cyanheads-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `cyanheads_search` | Semantic search across fleet tools and servers. Returns ranked matches with brief summaries and the server each tool belongs to. | `query`, `scope`, `category`, `limit` | `readOnlyHint: true`, `openWorldHint: false` |
| `cyanheads_describe` | Description, connection URL, and per-client install snippets for a named tool or server. | `name`, `kind`, `client` | `readOnlyHint: true`, `openWorldHint: false` |
| `cyanheads_invoke` *(Phase 2)* | Passthrough dispatch to a fleet backend. Deferred. | — | — |

### Resources

None. See "Resources" section for rationale.

### Prompts

None.

---

## Overview

`cyanheads-mcp-server` is a meta-server that fronts the cyanheads hosted MCP fleet. An agent connecting to one endpoint (`https://cyanheads.caseyjhand.com/mcp`) sees two tools — search and describe — and uses them to discover and learn how to install any of the ~40 hosted servers in their own client.

**Primary use case.** A user adds `cyanheads.caseyjhand.com/mcp` to their MCP client. From then on, their agent can answer "what server handles X?" via semantic search, and "how do I add that server to my client?" via per-client install snippets — without the user maintaining a sprawling local MCP config.

**Audience.**

| Surface | Who it's for | What they need |
|:--|:--|:--|
| The hosted endpoint | Users of MCP clients (Claude Desktop, Claude Code, Cursor, Cline) | One URL to add. Marketing-style README, not a developer scaffolding guide. |
| The source repo | The operator (cyanheads) and the rare cloner | Architecture, model choice, deploy notes — kept at the bottom of the README, expanded in this doc. |

The repo is open source but the hosted endpoint is the product. README positioning reflects that.

---

## Requirements

- Two tools only in Phase 1: `cyanheads_search` (semantic), `cyanheads_describe`.
- Semantic search is P0 — float cosine similarity, not token overlap.
- Catalog is fetched at startup from `https://caseyjhand.com/fleet.json`. The portfolio owns and produces this file; the server is a consumer.
- Document embeddings are baked into `fleet.json` at portfolio build time. The server never embeds documents — only queries.
- Document and query embeddings must use the same model. The fleet payload declares its model id; the server refuses to load if its runtime model id doesn't match.
- Query embedding happens once per `cyanheads_search` call on the VPS. Cosine sim against the in-memory vector set is the hot path.
- `cyanheads_describe` returns all client snippets when `client` is omitted; one snippet when a client is specified.
- Phase 1 runs on the VPS (stdio + HTTP). No Cloudflare Workers / Vectorize / KV / D1 dependencies.
- The catalog refreshes by polling `fleet.json` on a configurable interval (default 1 hour). Document embeddings come along for free since they live in the same file.

---

## Embedding Architecture

The single most important property: **document embeddings are produced once, at portfolio build time, and shipped inside `fleet.json`. The server only embeds the user's query at runtime.** No vector database, no separate embeddings file, no webhook between portfolio and server.

### Model

| Field | Value |
|:--|:--|
| Model | `Snowflake/snowflake-arctic-embed-m-v1.5` |
| Params | 110M |
| Architecture | BERT (`feature-extraction` pipeline) |
| Native dims | 768 |
| Stored dims (Matryoshka truncated) | **256** |
| Query prefix | `"Represent this sentence for searching relevant passages: "` |
| License | Apache 2.0 |
| Runtime | `@huggingface/transformers` v4+ (ONNX via WebGPU/CPU) |
| Source | [Snowflake/snowflake-arctic-embed-m-v1.5 on HF](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5) |

Matryoshka truncation to 256 dims preserves ~99% of full-768 quality per Snowflake's published evaluation, while keeping the inlined fleet.json size in the ~400KB range (367 docs × 256 floats × ~6 chars per number).

### Build-time pipeline (portfolio)

```
caseyjhand-portfolio/scripts/build-fleet-json.ts
  1. Load MCP_SERVERS list from src/data/mcp-servers.ts
  2. For each server (concurrent pool of 8):
     - GET /mcp → server.{name, version, description}, auth.mode
     - POST tools/list → [{ name, description }, ...]
  3. Load embedding model (cached on subsequent builds)
  4. For each tool and server:
     - Embed `{name}: {description}` at 768 dims
     - Truncate to first 256 dims (Matryoshka)
     - Normalize to unit length (precomputed for cosine via dot product)
  5. Write public/fleet.json with:
     - Top-level: version "2", generatedAt, embeddingModel, embeddingDims, embeddingQueryPrefix
     - Per-server: existing metadata + embedding: number[256]
     - Per-tool: existing metadata + embedding: number[256]
```

Build cost: ~30-60s for ~367 documents on CPU including model load. Acceptable for a build that ships once per portfolio deploy.

### Runtime pipeline (server)

```
cyanheads-mcp-server startup:
  1. Fetch fleet.json from CATALOG_URL
  2. Validate top-level schema (Zod). Verify embeddingModel matches expected. Refuse to load on mismatch.
  3. Pack vectors as a single Float32Array of length (numDocs × 256) for cache locality
  4. Build index: tool name → row offset; server name → row offset; row offset → metadata
  5. Load @huggingface/transformers with the same model id
  6. Start poll timer: every CATALOG_REFRESH_SECONDS, re-fetch; if generatedAt changed, swap in new vectors atomically

cyanheads_search handler:
  1. Prepend query prefix → embed query → truncate to 256 → normalize
  2. Dot product against every row in the packed Float32Array (1 µs per row, ~0.4ms total for 367 rows)
  3. Filter by category if requested
  4. Sort descending, take top N
  5. Return with score = cosine similarity (0-1 range)
```

### Refresh cadence

The catalog changes only when Casey edits `caseyjhand-portfolio/src/data/mcp-servers.ts` and pushes — at most weekly, often less. The server polls hourly by default (`CATALOG_REFRESH_SECONDS=3600`). The freshness floor is "fleet.json change → up to 1 hour later, served on VPS." If we ever need faster propagation, a manual restart pulls immediately or a Cloudflare Pages deploy hook → VPS endpoint can push.

No vector DB. No webhook required for v0. The fleet.json itself is the contract.

---

## Catalog Record Shape

```ts
/** Top-level fleet.json payload. Version "2" introduces baked embeddings. */
interface FleetPayload {
  version: '2';
  generatedAt: string;                  // ISO 8601 UTC
  embeddingModel: string;               // e.g. "Snowflake/snowflake-arctic-embed-m-v1.5"
  embeddingDims: number;                // e.g. 256
  embeddingQueryPrefix: string;         // applied to query at runtime, never to docs
  servers: CatalogRecord[];
}

/** A single tool entry, with its embedding inlined. */
interface CatalogTool {
  name: string;                         // snake_case (e.g. "earthquake_search")
  description: string;
  embedding: number[];                  // length === FleetPayload.embeddingDims, L2-normalized
}

/** A single fleet server record, with its embedding inlined. */
interface CatalogRecord {
  name: string;                         // github basename ("arxiv-mcp-server")
  displayName: string;                  // "arXiv"
  description: string;                  // from server.description on GET /mcp
  category: 'research' | 'government' | 'public-data' | 'utility';
  endpoint: string;                     // hosted URL, always present
  npm: string;                          // "@cyanheads/arxiv-mcp-server"
  github: string;
  version: string;                      // captured at generation time
  auth: string;                         // open string; currently "none"
  embedding: number[];                  // length === FleetPayload.embeddingDims, L2-normalized
  tools: CatalogTool[];
}

/** Install snippet — generated at describe-time from CatalogRecord, never stored in fleet.json. */
interface InstallSnippet {
  client: ClientId;
  label: string;
  payload: string;
}

type ClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'cline';
```

Embeddings are L2-normalized at build time so the runtime cosine similarity collapses to a dot product.

---

## Per-Client Install Snippet Registry

### Supported clients in v0

| Client | Mechanism | Format |
|:-------|:----------|:-------|
| `claude-desktop` | JSON merge into `~/Library/Application Support/Claude/claude_desktop_config.json` `mcpServers` block | JSON object |
| `claude-code` | `claude mcp add` CLI command | Shell command string |
| `cursor` | JSON merge into `.cursor/mcp.json` `mcpServers` block | JSON object |
| `cline` | JSON merge into Cline VS Code extension MCP settings | JSON object |

Adding a client = one entry in the static registry + one `ClientId` union member. No handler changes.

### Registry location

`src/services/catalog/snippets.ts` — `Record<ClientId, (record: CatalogRecord) => InstallSnippet>`.

### Snippet formats

All hosted servers use SSE transport.

```ts
// claude-desktop
{ client: 'claude-desktop', label: 'Claude Desktop (JSON config)',
  payload: JSON.stringify({ [record.name]: { type: 'sse', url: record.endpoint } }, null, 2) }

// claude-code
{ client: 'claude-code', label: 'Claude Code (CLI)',
  payload: `claude mcp add --transport sse ${record.name} ${record.endpoint}` }

// cursor
{ client: 'cursor', label: 'Cursor (mcp.json)',
  payload: JSON.stringify({ mcpServers: { [record.name]: { type: 'sse', url: record.endpoint } } }, null, 2) }

// cline
{ client: 'cline', label: 'Cline (VS Code)',
  payload: JSON.stringify({ [record.name]: { type: 'sse', url: record.endpoint, disabled: false, autoApprove: [] } }, null, 2) }
```

---

## Tool Specifications

### `cyanheads_search`

**Description:** Search fleet tools and servers by natural-language description. Returns ranked matches with brief summaries and the server each tool belongs to. Use `scope: 'servers'` to find which server handles a workflow; default `scope: 'tools'` to find specific tools.

**Input schema:**

```ts
z.object({
  query: z.string().min(1).describe(
    'Natural language search query. Describe what you want to accomplish, a workflow, or a capability area.'
  ),
  scope: z.enum(['tools', 'servers']).default('tools').describe(
    'What to search. "tools" returns individual tool matches; "servers" returns server-level matches.'
  ),
  category: z.enum(['research', 'government', 'public-data', 'utility']).optional().describe(
    'Filter by catalog category. Omit to search all categories.'
  ),
  limit: z.number().int().min(1).max(20).default(5).describe(
    'Maximum number of results to return (1-20). Default 5.'
  ),
})
```

**Output schema:**

```ts
z.object({
  results: z.array(z.object({
    name: z.string().describe(
      'Tool name (snake_case) or server name (kebab-case) depending on scope.'
    ),
    server: z.string().describe(
      'Server package name that owns this tool. Same as name when scope is "servers".'
    ),
    brief: z.string().describe('One-line summary of what this tool or server does.'),
    category: z.enum(['research', 'government', 'public-data', 'utility']).describe(
      'Catalog category for the owning server.'
    ),
    score: z.number().describe(
      'Cosine similarity between query and entry, 0-1. Higher is better. Compare only within a single response.'
    ),
  })).describe('Ranked matches, best first.'),
  totalMatched: z.number().describe('Total relevant matches before the limit was applied.'),
  query: z.string().describe('The query that was searched.'),
  scope: z.enum(['tools', 'servers']).describe('Scope that was searched.'),
})
```

**Notes:**
- No `phase` field. Output shape is stable; score is always cosine similarity.
- `totalMatched` reflects post-threshold count. A configurable minimum similarity (default `SIMILARITY_FLOOR=0.3`) suppresses noise from cold queries; results below the floor don't appear in `results` or `totalMatched`.

**Error contract:**

```ts
errors: [
  { reason: 'no_results', code: JsonRpcErrorCode.NotFound,
    when: 'Query produced no relevant matches.',
    recovery: 'Broaden the query, remove the category filter, or try scope "servers" to find the right server first.' },
  { reason: 'catalog_empty', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Catalog has not finished loading.',
    recovery: 'Retry in a few seconds; the catalog is still loading.',
    retryable: true },
]
```

**`format()` parity:** renders `query`, `scope`, `totalMatched`, and each result's `name`, `server`, `brief`, `category`, `score`. Lint-enforced.

**Auth:** none in v0. Scope `tool:cyanheads_search:read` if/when auth is enabled.

### `cyanheads_describe`

**Description:** Return the description, connection URL, and per-client install snippets for a named tool or server. For tools: the description and the server it belongs to. For servers: connection URL and install snippets for every supported client (or one specific client when `client` is specified). Call `cyanheads_search` first to find valid names.

**Input schema:**

```ts
z.object({
  name: z.string().min(1).describe(
    'Tool name (snake_case, e.g. "earthquake_search") or server name (kebab-case, e.g. "earthquake-mcp-server").'
  ),
  kind: z.enum(['tool', 'server']).optional().describe(
    'Whether name refers to a tool or server. Omit to auto-detect: underscores → tools, hyphens → servers.'
  ),
  client: z.enum(['claude-desktop', 'claude-code', 'cursor', 'cline']).optional().describe(
    'Return the install snippet for this specific client only. Omit for all supported clients.'
  ),
})
```

**Output schema** — `z.object({ result: z.discriminatedUnion('kind', [...]) })`. The framework's `tool()` requires a top-level `ZodObject`; the discriminated union is wrapped in `result` so `format()` can dispatch on `result.kind`. Branches as documented in `describe.tool.ts`.

**Error contract:** `not_found`, `ambiguous_kind`, `catalog_empty`. See `describe.tool.ts` for full text.

---

## Resources

None. The catalog has no stable per-record URI worth bookmarking, and a `fleet://catalog` dump would be too large and unscoped to be useful injected context. All catalog data is reachable via the two tools above.

---

## Service Layer

### `CatalogService`

Owns the in-memory catalog and search.

```ts
interface ICatalogService {
  /** Fetch fleet.json, validate, build vector index, load embedding model. */
  initialize(): Promise<void>;

  /** Semantic search. Embeds query, dot products against in-memory vectors. */
  search(params: {
    query: string;
    scope: 'tools' | 'servers';
    category?: CatalogCategory;
    limit: number;
  }): Promise<CatalogSearchResult[]>;

  /** Exact lookup. */
  getTool(name: string): CatalogTool & { serverRecord: CatalogRecord } | null;
  getServer(name: string): CatalogRecord | null;

  /** List all categories present in the catalog. */
  listCategories(): CatalogCategory[];

  /** Catalog metadata for diagnostics. */
  stats(): { toolCount: number; serverCount: number; initializedAt: string; embeddingModel: string };
}

type CatalogCategory = 'research' | 'government' | 'public-data' | 'utility';

interface CatalogSearchResult {
  name: string;
  server: string;
  brief: string;
  category: CatalogCategory;
  score: number;   // cosine similarity 0-1
}
```

### `EmbeddingsRuntime`

Wraps `@huggingface/transformers`'s `feature-extraction` pipeline. Single instance, loaded once at startup, kept warm.

```ts
interface IEmbeddingsRuntime {
  /** Model id this runtime is loaded with. Must match FleetPayload.embeddingModel. */
  readonly modelId: string;

  /** Embed a query string. Applies the query prefix and Matryoshka truncation. Returns an L2-normalized vector. */
  embedQuery(text: string, dims: number, queryPrefix: string): Promise<Float32Array>;
}
```

The runtime is shared between the catalog initialization sanity-check (verifies model loads) and the search hot path.

### `RemoteJsonCatalogProvider`

Unchanged from the pre-pivot version — fetches `CATALOG_URL`, validates with Zod, returns the payload. The Zod schema now requires the v2 fields (`embeddingModel`, `embeddingDims`, `embeddingQueryPrefix`, per-record `embedding`).

---

## Config / Env Vars

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `CATALOG_URL` | No | `https://caseyjhand.com/fleet.json` | Remote fleet.json endpoint. Must return a valid `FleetPayload` (version "2"). |
| `CATALOG_FETCH_TIMEOUT_MS` | No | `10000` | HTTP fetch timeout. |
| `CATALOG_REFRESH_SECONDS` | No | `3600` | Background poll interval. Server re-fetches and swaps if `generatedAt` changed. |
| `EMBEDDING_MODEL_ID` | No | `Snowflake/snowflake-arctic-embed-m-v1.5` | Must match `FleetPayload.embeddingModel`; mismatch is a startup error. |
| `SIMILARITY_FLOOR` | No | `0.3` | Minimum cosine similarity for a result to appear in `cyanheads_search` output. |
| `MCP_AUTH_MODE` | No | `none` | Framework default for v0 public discovery. |

Framework env vars (`MCP_TRANSPORT_TYPE`, `MCP_HTTP_PORT`, …) are owned by `@cyanheads/mcp-ts-core`.

---

## Auth Model

v0 ships as `MCP_AUTH_MODE=none`. The hosted endpoint is a public discovery surface — no JWT, no scope checks, no per-tenant state. Tool definitions still carry `auth: ['tool:cyanheads_search:read']` etc. so a future gateway deployment can toggle JWT/oauth and have scope enforcement work without code changes.

---

## Storage and Infrastructure

| Layer | Tech | Notes |
|:------|:-----|:------|
| Catalog source | `https://caseyjhand.com/fleet.json` on Cloudflare Pages | Static asset, regenerated by `caseyjhand-portfolio/scripts/build-fleet-json.ts` on every portfolio deploy. |
| Embedding production | Portfolio build script, `@huggingface/transformers` | Document vectors baked into fleet.json. Build container is CPU; model weights cached between builds where possible. |
| Catalog in server | In-memory Float32Array (packed) + Maps for name lookup | One fetch at startup, polled every hour. Atomic swap on change. |
| Query embedding | `@huggingface/transformers` loaded once at startup | CPU inference, ~30-50ms per query on the VPS. |
| Search | In-memory dot product over ~367 normalized vectors | Sub-millisecond for the full sweep. |
| Persistence | None | No `ctx.state`. Stateless aside from the cached catalog. |

No Cloudflare Workers, Vectorize, KV, D1, or Durable Objects. The server runs on the same VPS as the rest of the cyanheads fleet.

---

## README Positioning

The README serves the hosted endpoint, not the source tree. Order from top to bottom:

1. **Headline:** what the endpoint does, the URL to add. Below the title before any other content.
2. **Add it to your client:** the four install snippets (Claude Desktop, Claude Code, Cursor, Cline) presented as copy-paste blocks.
3. **What's in the fleet:** category counts, sample queries, a visual or table.
4. **How it works (one paragraph):** semantic search over a hosted catalog of MCP servers; agents ask "what handles X?" and get an install snippet for their client.
5. **Self-hosting (collapsed or short):** for the rare cloner. Setup, env vars, build steps.

Tone: landing page, not developer scaffold. The audience is engineers evaluating whether to plug in the endpoint — they want to know what it does, how to add it, what they get. Not how to fork it.

---

## Phasing

### Phase 1 (this design)

- `cyanheads_search` (semantic, cosine similarity)
- `cyanheads_describe`
- Remote fleet.json with baked embeddings, in-memory vector index
- `@huggingface/transformers` query runtime
- VPS deployment (stdio + HTTP)
- Marketing-style README
- Public, unauthenticated

### Phase 2 (deferred)

- `cyanheads_invoke` passthrough dispatch (gateway shape)
- `MCP_AUTH_MODE=jwt` or `oauth` with per-tenant scope enforcement
- Per-tenant quotas and optional billing integration
- MCP client pool for backend dispatch
- Recursion guard, per-(tenant, tool) rate limiting

Phase 2 is the only place `invoke` lands. Phase 1 does not register it.

---

## Implementation Order

1. Update `src/services/catalog/types.ts` — v2 schema with embeddings.
2. Update `src/services/catalog/remote-catalog-provider.ts` — new Zod schema, model-id check.
3. Replace token-overlap logic in `src/services/catalog/catalog-service.ts` with packed Float32Array + cosine search; add startup model load + background poll.
4. Add `src/services/catalog/embeddings-runtime.ts` — query embed pipeline.
5. Update `src/mcp-server/tools/definitions/search.tool.ts` — drop `phase`, drop fulltext path, score becomes float.
6. `src/mcp-server/tools/definitions/describe.tool.ts` — no structural change.
7. Update `src/config/server-config.ts` — add `EMBEDDING_MODEL_ID`, `SIMILARITY_FLOOR`, `CATALOG_REFRESH_SECONDS`; drop unused vars.
8. Update tests in `tests/services/catalog.service.test.ts` and `tests/tools/search.tool.test.ts` to use embedding fixtures.
9. Rewrite README in marketing-style positioning.
10. `bun run devcheck`.

Portfolio side:

1. `bun add @huggingface/transformers` in caseyjhand-portfolio.
2. Update `scripts/build-fleet-json.ts` — model load, per-record embedding, Matryoshka truncation, L2 normalization, v2 payload.
3. Run a local build to validate the output.
4. Commit and push so the deployed fleet.json carries embeddings before the server attempts to load it.

---

## Decisions Log

- **Semantic search is P0, not Phase 2.** Token overlap was sufficient as a "honest stub" but the hosted endpoint is the product. Shipping with fulltext degrades the experience that justifies the endpoint existing. Semantic at v0 closes the gap.

- **Snowflake/snowflake-arctic-embed-m-v1.5 over bge-small.** Arctic-embed-m-v1.5 is the direct size successor to bge-small in the retrieval-tuned class — better MTEB retrieval (~55 NDCG@10 vs bge-small's ~52), Matryoshka-enabled, Apache 2.0, ONNX weights published, `@huggingface/transformers` compatible. The size jump (110M vs 33M) is moderate and the VPS handles it comfortably.

- **Matryoshka 256 dims, not 768.** Snowflake's v1.5 training was designed for compressible truncation; published evaluation shows ~99% of full-dim retrieval quality at 256. The storage win is ~3x on the fleet.json side. Upgrade to 768 is a single constant change in the build script if quality ever bottlenecks.

- **Embeddings live in fleet.json, not in a vector DB.** For 367 documents, an in-memory dot product sweep is sub-millisecond. A separate vector DB introduces a moving part (provisioning, refresh latency, schema sync) for no measurable benefit. The fleet.json is already the canonical catalog artifact; piggybacking embeddings onto it makes them version-controlled with the metadata and eliminates any race between catalog updates and vector updates.

- **Document embeddings produced at portfolio build time, query embeddings at runtime.** Documents change rarely (per portfolio deploy) and are known at build time. Queries change every request and must be live. The split puts each inference at the right layer.

- **Query prefix shipped in the payload, not hardcoded.** Snowflake's asymmetric pattern requires queries to be prefixed; documents don't. Shipping the prefix in `embeddingQueryPrefix` means swapping models (in the portfolio build) is a one-side change — the server reads whatever prefix the catalog declares.

- **L2 normalize at build time.** Pre-normalizing document vectors lets the runtime cosine similarity collapse to a dot product. Saves one division per row per query.

- **Background poll, not webhook.** Catalog changes maybe weekly. An hourly poll is good enough for v0, requires zero new infrastructure, and is restartable to force fresh state. A Cloudflare Pages deploy hook → VPS endpoint is a clean upgrade path if propagation latency ever matters.

- **`cyanheads_invoke` excluded from Phase 1.** The gateway shape is real Phase 2 work — auth, quotas, MCP client pool, recursion guard, dispatch validation. Shipping it half-finished or stubbed in v0 dilutes the surface. Phase 1 = discovery only.

- **README is marketing-shaped.** The hosted endpoint is the product. The README's job is to convince an evaluator the endpoint is worth one line in their client config. Self-hosting docs collapse to a bottom section.

- **Catalog is hosted-only.** All entries in fleet.json come from the live `GET /mcp` + `tools/list` calls during the portfolio build. Non-hosted servers (npm-only utilities) are excluded from v0. Including them requires a parallel data source and is deferred.

- **`describe` auto-detects `kind` from name format.** Tool names use underscores; server names use hyphens. `CatalogService.initialize()` validates server names at load time and rejects entries with underscores so the heuristic stays reliable.

---

## Open Questions

1. **Cold-load latency on the VPS.** First request after restart pays the model-load cost (~2-5s for arctic-embed-m on CPU). Acceptable for an MCP server but worth measuring. If it's bad, we can warm-load during `initialize()` or expose a `/ready` probe.

2. **Build cache for the embedding model on Cloudflare Pages.** First portfolio build after `bun install` downloads the ONNX weights (~140MB quantized, ~440MB full). Whether Pages caches `~/.cache/huggingface/` across builds determines whether this is a one-time cost or a per-build penalty. Worth a single test build to find out.

3. **Similarity floor calibration.** Default `0.3` is a guess. After a few real query patterns are observed, tune up or down based on the false-positive vs false-negative tradeoff.

4. **Adding npm-only servers later.** Roughly 25 servers in the wider cyanheads collection are npm-only (git, obsidian, clipboard, etc.). Including them needs `endpoint` to become optional, a separate ingestion path, and a UX decision about how `describe` returns "no hosted endpoint, run via npx." Deferred to a follow-up.

---

## Review Notes

This doc replaces the pre-pivot version. The earlier draft assumed Cloudflare Workers / Vectorize / KV / D1 for Phase 2 and token-overlap fulltext for Phase 1. Both assumptions were wrong: the server runs on the VPS like the rest of the fleet, and the hosted endpoint is the product so semantic must ship in v0.

`cyanheads_invoke`, gateway auth, quotas, and MCP client pooling remain in Phase 2 but with no Cloudflare-specific commitments — they will run on the same VPS architecture.
