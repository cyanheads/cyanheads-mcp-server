# cyanheads-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `cyanheads_search` | Semantic (Phase 2) or full-text (Phase 1) search across fleet tools and servers. | `query`, `scope`, `category`, `limit` | `readOnlyHint: true`, `openWorldHint: false` |
| `cyanheads_describe` | Full schema, connection URL, and per-client install snippets for a named tool or server. | `name`, `kind`, `client` | `readOnlyHint: true`, `openWorldHint: false` |
| `cyanheads_invoke` | Passthrough dispatch to a fleet backend. Input is revalidated against the backend's published schema before forwarding. Enabled only when `ENABLE_INVOKE=true`. | `tool_name`, `input` | `destructiveHint: true`, `openWorldHint: true` |

### Resources

None — the catalog is reachable exclusively via tools. See "Resources" section for rationale.

### Prompts

None in Phase 1. No recurring interaction patterns identified.

---

## Overview

`cyanheads-mcp-server` is a meta-server that fronts a fleet of other MCP servers. An agent connecting to it sees 2 or 3 tools regardless of fleet size, and can discover, learn about, and (in the paid deployment) invoke any capability in the fleet via those tools.

**Consumers:** LLM agents running in any MCP client. Indirect consumers: developers choosing which fleet server to configure and which client format to use.

**Two deployment shapes, one codebase:**

| Deployment | Tools | Auth | Trigger |
|:-----------|:------|:-----|:--------|
| Public discovery | `search`, `describe` | `MCP_AUTH_MODE=none` | `ENABLE_INVOKE` unset or `false` |
| Passthrough gateway | `search`, `describe`, `invoke` | `MCP_AUTH_MODE=jwt` or `oauth` | `ENABLE_INVOKE=true` |

---

## Requirements

- Fleet catalog must be queryable without exposing per-tool schemas in the tool list itself.
- Phase 1 catalog is static — a TypeScript module with hand-curated records matching the KB frontmatter shape.
- Phase 1 search is full-text (no embeddings). Phase 2 migrates to Vectorize-backed semantic search.
- `describe` returns all client snippets when `client` is omitted; one snippet when a client is specified.
- `invoke` is absent from the tool list when `ENABLE_INVOKE` is falsy — the gateway deployment is the only consumer.
- Per-client snippet registry is a static lookup table in code; no runtime generation.
- No runtime dependencies on external services in Phase 1 (in-memory catalog, no KV, no Vectorize).
- Phase 2 targets Cloudflare Workers + KV + Vectorize. Phase 1 works in stdio and HTTP.

---

## Catalog Record Shape

Each entry in the catalog mirrors the fleet KB frontmatter, extended with a `tools` array containing per-tool entries and a `installSnippets` map.

```ts
/** Single tool entry inside a CatalogRecord. */
interface CatalogTool {
  /** Fully-qualified name: "<server_prefix>_<verb>_<noun>" (snake_case). */
  name: string;
  /** Human-readable description (matches the tool's registered description). */
  description: string;
  /** Brief (≤120 chars) summary for search results — derived from description if not set. */
  brief: string;
  /** Zod-derived JSON Schema for the tool's input (as plain object, not Zod instance). */
  inputSchema: Record<string, unknown>;
  /** Zod-derived JSON Schema for the tool's output. */
  outputSchema: Record<string, unknown>;
  /** Auth scopes required to call this tool, if any. */
  authScopes: string[];
  /** True if the tool mutates state. */
  destructive: boolean;
  /** True if the tool is marked as task: true. */
  isTask: boolean;
}

/** Per-client install snippet. */
interface InstallSnippet {
  /** MCP client identifier. */
  client: ClientId;
  /** Human-readable label for the install method. */
  label: string;
  /**
   * The install payload. Shape varies by client:
   * - claude-desktop: JSON fragment to merge into `mcpServers` block
   * - claude-code: CLI command string (e.g. `claude mcp add ...`)
   * - cursor: JSON fragment for `.cursor/mcp.json` `mcpServers` block
   * - cline: JSON fragment for Cline's MCP settings
   */
  payload: string;
}

/** One fleet server record. */
interface CatalogRecord {
  /** Package name without scope (e.g. "arxiv-mcp-server"). */
  name: string;
  /** One-line description of what this server does. */
  description: string;
  /** Latest published version. */
  version: string;
  /** Lifecycle state. */
  status: 'active' | 'deprecated' | 'experimental';
  /** Thematic grouping for filter facets. */
  category: string;
  /** Whether this server is hosted at a cyanheads subdomain. */
  hosted: boolean;
  /** Subdomain prefix when hosted (e.g. "arxiv" → https://arxiv.api.cyanheads.com). */
  subdomain?: string;
  /** Connection URL for hosted deployments (HTTP SSE). */
  connectionUrl?: string;
  /** npm package name (scoped, e.g. "@cyanheads/arxiv-mcp-server"). */
  npm: string;
  /** Auth requirement for the hosted deployment. */
  auth: 'none' | 'api-key' | 'jwt' | 'oauth';
  /** Tool entries (populated from the server's tools/list response or static data). */
  tools: CatalogTool[];
  /** Per-client install snippets. One entry per supported client. */
  installSnippets: InstallSnippet[];
  /** ISO 8601 creation date (YYYY-MM-DD). */
  created: string;
  /** ISO 8601 last-updated timestamp. Set on catalog refresh. */
  updatedAt: string;
}

/** Supported client identifiers. */
type ClientId =
  | 'claude-desktop'
  | 'claude-code'
  | 'cursor'
  | 'cline';
```

---

## Per-Client Install Snippet Registry

### Supported clients in v0

| Client | Mechanism | Format |
|:-------|:----------|:-------|
| `claude-desktop` | JSON merge into `~/Library/Application Support/Claude/claude_desktop_config.json` `mcpServers` block | JSON object |
| `claude-code` | `claude mcp add` CLI command | Shell command string |
| `cursor` | JSON merge into `.cursor/mcp.json` `mcpServers` block | JSON object |
| `cline` | JSON merge into Cline VS Code extension MCP settings | JSON object |

Clients not in this list (Continue, Zed, VS Code native, etc.) are deferred to Phase 2. Cutoff rationale: Claude Desktop and Claude Code are the primary consumers of the cyanheads fleet; Cursor and Cline have large installed bases that use npm-served MCP servers. Adding a client requires only a new entry in the static registry and a new `ClientId` union member — no handler changes.

### Registry location

`src/services/catalog/snippets.ts` — a plain `Record<ClientId, (record: CatalogRecord) => InstallSnippet>` factory map, evaluated at catalog-build time. No runtime generation.

### Snippet formats

```ts
// claude-desktop — JSON fragment for mcpServers block
{
  client: 'claude-desktop',
  label: 'Claude Desktop (JSON config)',
  payload: JSON.stringify({
    [record.name]: {
      command: 'npx',
      args: ['-y', record.npm],
    }
  }, null, 2),
}

// claude-code — CLI command
{
  client: 'claude-code',
  label: 'Claude Code (CLI)',
  payload: `claude mcp add ${record.name} -- npx -y ${record.npm}`,
}

// cursor — JSON fragment for .cursor/mcp.json
{
  client: 'cursor',
  label: 'Cursor (mcp.json)',
  payload: JSON.stringify({
    mcpServers: {
      [record.name]: {
        command: 'npx',
        args: ['-y', record.npm],
      }
    }
  }, null, 2),
}

// cline — JSON fragment for Cline MCP settings
{
  client: 'cline',
  label: 'Cline (VS Code)',
  payload: JSON.stringify({
    [record.name]: {
      command: 'npx',
      args: ['-y', record.npm],
      disabled: false,
      autoApprove: [],
    }
  }, null, 2),
}
```

Hosted servers substitute `command: 'npx'` / `args` with `type: 'sse'` / `url: record.connectionUrl` in the JSON payloads where the client supports SSE transport. Claude Code hosted variant: `claude mcp add --transport sse ${record.name} ${record.connectionUrl}`.

---

## Tool Specifications

### `cyanheads_search`

**Description:** Search fleet tools and servers by description. Returns ranked matches with brief summaries and the server each tool belongs to. Use `scope: 'servers'` to find which server handles a workflow; use the default `scope: 'tools'` to find specific tools.

**Input schema:**

```ts
z.object({
  query: z.string().min(1).describe(
    'Natural language search query. Describe what you want to accomplish, a workflow, or a capability area.'
  ),
  scope: z.enum(['tools', 'servers']).default('tools').describe(
    'What to search. "tools" returns individual tool matches; "servers" returns server-level matches.'
  ),
  category: z.string().optional().describe(
    'Filter by catalog category (e.g. "external-data", "local-workspace", "infrastructure"). ' +
    'Omit to search all categories.'
  ),
  limit: z.number().int().min(1).max(20).default(5).describe(
    'Maximum number of results to return (1–20). Default 5.'
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
      'Server package name that owns this tool (e.g. "arxiv-mcp-server"). ' +
      'Same as name when scope is "servers".'
    ),
    brief: z.string().describe('One-line summary of what this tool or server does.'),
    category: z.string().describe('Catalog category for the owning server.'),
    score: z.number().describe(
      'Relative match quality. Higher is better within a single response. ' +
      'The scale changes between Phase 1 (token overlap count) and Phase 2 ' +
      '(cosine similarity 0–1); see the phase field to interpret.'
    ),
  })).describe('Ranked matches, best first.'),
  totalMatched: z.number().describe('Total entries that matched before limit was applied.'),
  query: z.string().describe('The query that was searched.'),
  scope: z.enum(['tools', 'servers']).describe('Scope that was searched.'),
  phase: z.enum(['fulltext', 'semantic']).describe(
    'Search mode active for this response. "fulltext": Phase 1 token overlap, ' +
    'score is an integer count. "semantic": Phase 2 vector similarity, score is ' +
    'a float 0–1. Do not compare scores across responses with different phase values.'
  ),
})
```

**Error contract:**

```ts
errors: [
  {
    reason: 'no_results',
    code: JsonRpcErrorCode.NotFound,
    when: 'Query returns zero matches across the full catalog',
    recovery: 'Broaden the query, remove category filter, or try scope "servers" to find the right server first.',
  },
  {
    reason: 'catalog_empty',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Catalog has not been initialized (startup race or static data missing)',
    recovery: 'Retry in a few seconds; the catalog initializes asynchronously at server startup.',
    retryable: true,
  },
]
```

**`format()` (parity requirement):** Every field in `output` must appear in the rendered `content[]` text — the framework's `format-parity` lint enforces this. For `cyanheads_search`, each result item must render `name`, `server`, `brief`, `category`, and `score`. The `totalMatched`, `query`, `scope`, and `phase` fields must also appear (e.g., in a header line). Omitting any of these will fail `bun run devcheck`.

**Auth:** none (public deployment); `tool:cyanheads_search:read` on gateway deployment.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

**Example call:**

```json
{
  "tool_name": "cyanheads_search",
  "input": {
    "query": "fetch earthquake data and filter by magnitude",
    "scope": "tools",
    "limit": 5
  }
}
```

**Example response (Phase 1 fulltext):**

```json
{
  "results": [
    {
      "name": "earthquake_search",
      "server": "earthquake-mcp-server",
      "brief": "Query USGS/EMSC seismic events by location, magnitude, and time range.",
      "category": "external-data",
      "score": 4
    },
    {
      "name": "earthquake_get_feed",
      "server": "earthquake-mcp-server",
      "brief": "Fetch real-time USGS earthquake feed (CDN-cached, no quota cost).",
      "category": "external-data",
      "score": 3
    }
  ],
  "totalMatched": 2,
  "query": "fetch earthquake data and filter by magnitude",
  "scope": "tools",
  "phase": "fulltext"
}
```

---

### `cyanheads_describe`

**Description:** Return the full schema, connection URL, and per-client install snippets for a named tool or server. For tools: input/output JSON Schema, parameter descriptions, and the server it belongs to. For servers: connection URL and install snippets for every supported client (or one specific client when `client` is specified). Call `cyanheads_search` first to find valid names.

**Input schema:**

```ts
z.object({
  name: z.string().min(1).describe(
    'Tool name (snake_case, e.g. "earthquake_search") or server name ' +
    '(kebab-case, e.g. "earthquake-mcp-server").'
  ),
  kind: z.enum(['tool', 'server']).optional().describe(
    'Whether name refers to a tool or server. Omit to auto-detect: names containing ' +
    'underscores are treated as tools; names containing hyphens are treated as servers.'
  ),
  client: z.enum(['claude-desktop', 'claude-code', 'cursor', 'cline']).optional().describe(
    'Return the install snippet for this specific client only. ' +
    'Omit to return snippets for all supported clients.'
  ),
})
```

**Output schema:**

> [REVIEW]: The two optional branches (`tool` / `server`) create a `format-parity` problem at implementation time. `format()` is called once with a single runtime value, but the linter walks both `.optional()` branches and expects every field in each to appear in the rendered text. This will produce `format-parity` lint errors unless you use `z.discriminatedUnion` keyed on `kind`, which lets the linter walk each branch independently and `format()` dispatch on `result.kind`. Consider switching to the shape below before scaffolding. Left as `[REVIEW]` because it changes the Zod schema structure.

```ts
// Recommended: discriminated union so the linter walks each branch separately
// and format() can dispatch cleanly on result.kind.
z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool').describe('Resolved as a tool entry.'),
    name: z.string().describe('Resolved name (as looked up).'),
    description: z.string().describe('Full tool description.'),
    server: z.string().describe('Server that owns this tool.'),
    inputSchema: z.record(z.unknown()).describe('JSON Schema for the tool input object.'),
    outputSchema: z.record(z.unknown()).describe('JSON Schema for the tool output object.'),
    authScopes: z.array(z.string()).describe('Required auth scopes, if any.'),
    destructive: z.boolean().describe('True if the tool has destructiveHint: true.'),
    isTask: z.boolean().describe('True if the tool is a background task (task: true).'),
  }),
  z.object({
    kind: z.literal('server').describe('Resolved as a server entry.'),
    name: z.string().describe('Resolved name (as looked up).'),
    description: z.string().describe('Full server description.'),
    version: z.string().describe('Latest published version.'),
    npm: z.string().describe('npm package name (e.g. "@cyanheads/arxiv-mcp-server").'),
    connectionUrl: z.string().optional().describe(
      'HTTP SSE endpoint for hosted deployments. Absent for servers with no hosted instance.'
    ),
    auth: z.string().describe(
      'Auth requirement for the hosted deployment ("none", "api-key", etc.).'
    ),
    toolCount: z.number().describe('Number of tools exposed by this server.'),
    installSnippets: z.array(z.object({
      client: z.string().describe('Client identifier.'),
      label: z.string().describe('Human-readable install method label.'),
      payload: z.string().describe('Install payload (JSON or CLI command).'),
    })).describe('Install instructions, one per supported client (or filtered by input.client).'),
  }),
])
```

**Error contract:**

```ts
errors: [
  {
    reason: 'not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'No tool or server with the given name exists in the catalog',
    recovery: 'Use cyanheads_search to find the correct name, then call cyanheads_describe again.',
  },
  {
    reason: 'ambiguous_kind',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Name matches both a tool and a server (collision in catalog)',
    recovery: 'Set the kind parameter to "tool" or "server" to disambiguate.',
  },
  {
    reason: 'catalog_empty',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Catalog not yet initialized',
    recovery: 'Retry in a few seconds; the catalog initializes at server startup.',
    retryable: true,
  },
]
```

**`format()` (parity requirement):** With `z.discriminatedUnion`, the linter walks each branch independently. The `format()` function dispatches on `result.kind` and renders all fields in the matching branch. For the `'tool'` branch: `name`, `description`, `server`, `inputSchema`, `outputSchema`, `authScopes`, `destructive`, `isTask`. For the `'server'` branch: `name`, `description`, `version`, `npm`, `connectionUrl` (when present), `auth`, `toolCount`, each `installSnippets` entry's `client`, `label`, `payload`.

**Auth:** none (public deployment); `tool:cyanheads_describe:read` on gateway deployment.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

**Example call:**

```json
{
  "tool_name": "cyanheads_describe",
  "input": {
    "name": "earthquake-mcp-server",
    "kind": "server",
    "client": "claude-code"
  }
}
```

**Example response (truncated):**

```json
{
  "name": "earthquake-mcp-server",
  "kind": "server",
  "server": {
    "description": "Search USGS and EMSC seismic data — real-time feeds, event queries, and earthquake counts.",
    "version": "0.1.8",
    "npm": "@cyanheads/earthquake-mcp-server",
    "connectionUrl": "https://earthquake.api.cyanheads.com/mcp",
    "auth": "none",
    "toolCount": 4,
    "installSnippets": [
      {
        "client": "claude-code",
        "label": "Claude Code (CLI)",
        "payload": "claude mcp add earthquake-mcp-server -- npx -y @cyanheads/earthquake-mcp-server"
      }
    ]
  }
}
```

---

### `cyanheads_invoke`

**Description:** Dispatch a tool call to the fleet backend that owns the named tool. The input is validated against the backend's published input schema before forwarding. Backend errors are returned with their original error code and message. Only available when the server is running as a passthrough gateway (`ENABLE_INVOKE=true`). Use `cyanheads_search` to find a tool name, `cyanheads_describe` to inspect its input schema, then call `cyanheads_invoke` to execute it.

**Input schema:**

```ts
z.object({
  tool_name: z.string().min(1).describe(
    'Fully-qualified tool name as returned by cyanheads_search (e.g. "earthquake_search"). ' +
    'Must exist in the catalog.'
  ),
  input: z.record(z.unknown()).describe(
    'Arguments for the tool. Must conform to the tool\'s input schema — use cyanheads_describe ' +
    'to inspect required fields before calling.'
  ),
})
```

**Output schema:**

```ts
z.object({
  tool_name: z.string().describe('The tool that was invoked.'),
  server: z.string().describe('Server that handled the call.'),
  result: z.record(z.unknown()).describe(
    'Structured result as returned by the backend tool (structuredContent). ' +
    'Shape matches the tool\'s output schema.'
  ),
  content: z.array(z.object({
    type: z.string().describe('Content type ("text", "image", etc.).'),
    text: z.string().optional().describe('Text content when type is "text".'),
  })).describe('Formatted content from the backend tool (content[]).'),
  latencyMs: z.number().describe('Round-trip time to the backend in milliseconds.'),
})
```

**Error contract:**

```ts
errors: [
  {
    // NOTE: The correct code here depends on the resolution of Open Question 1.
    // If the tool is OMITTED from tools/list when disabled, this error never fires
    // and this entry can be dropped entirely.
    // If the tool IS in tools/list but returns an error when disabled,
    // MethodNotFound (-32601) is semantically wrong — the method exists on the server.
    // InvalidRequest (-32600) is the correct code for "this operation is not supported
    // in the current deployment configuration."
    reason: 'invoke_disabled',
    code: JsonRpcErrorCode.InvalidRequest,
    when: 'ENABLE_INVOKE is not set or is false',
    recovery: 'This deployment does not support invoke. Connect to the passthrough gateway endpoint instead.',
  },
  {
    reason: 'tool_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'tool_name does not exist in the catalog',
    recovery: 'Use cyanheads_search to find the correct tool name, then retry.',
  },
  {
    reason: 'input_invalid',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'input fails validation against the backend tool\'s published input schema',
    recovery: 'Use cyanheads_describe to inspect the required input schema for this tool, fix the input, and retry.',
  },
  {
    reason: 'backend_error',
    code: JsonRpcErrorCode.InternalError,
    when: 'Backend returned a non-success MCP error',
    recovery: 'The backend tool reported an error. Check the error message for tool-specific recovery guidance.',
  },
  {
    reason: 'backend_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Backend MCP server did not respond within the configured timeout',
    recovery: 'The backend server may be down. Try again in a few minutes or check the server\'s status.',
    retryable: true,
  },
  {
    reason: 'recursion_guard',
    code: JsonRpcErrorCode.InvalidRequest,
    when: 'tool_name routes back to cyanheads-mcp-server itself (loop prevention)',
    recovery: 'Do not invoke cyanheads tools via cyanheads_invoke — call them directly.',
  },
]
```

**`format()` (parity requirement):** The `format()` function must render all output fields: `tool_name`, `server`, `latencyMs`, and the `content[]` items from the backend. The `result` field is `z.record(z.unknown())` with no declared subfields, so it's exempt from sentinel parity — but the field itself must still appear (e.g., rendered as a JSON block). The `content` array's inner fields (`type`, `text`) must also appear in `format()` output for any response path that includes them.

**Auth:** `tool:cyanheads_invoke:execute` (gateway deployment only; `MCP_AUTH_MODE=jwt` or `oauth`).

**Annotations:** `destructiveHint: true`, `openWorldHint: true`

**Example call:**

```json
{
  "tool_name": "cyanheads_invoke",
  "input": {
    "tool_name": "earthquake_get_feed",
    "input": { "period": "day", "min_magnitude": 4.5 }
  }
}
```

---

## Resources

No resources are defined. Rationale: the catalog data has no stable addressable URI that a client would bookmark or inject as context — the primary access pattern is interactive search, not direct URI lookup. A hypothetical `fleet://catalog` dump would be unscoped and too large to be useful as injected context. All catalog data is reachable via tools.

---

## Service Layer

### CatalogService

Owns the in-memory catalog. Phase 1: seeded from a static TypeScript module at startup. Phase 2: populated from Cloudflare KV, refreshed by a scheduled handler.

```ts
/** Phase 1 in-memory, Phase 2 KV-backed. */
interface ICatalogService {
  /** Initialize from static data (Phase 1) or KV + Vectorize (Phase 2). */
  initialize(): Promise<void>;

  /** Full-text search across tool and server descriptions (Phase 1). */
  searchFullText(params: {
    query: string;
    scope: 'tools' | 'servers';
    category?: string;
    limit: number;
  }): Promise<CatalogSearchResult[]>;

  /**
   * Semantic vector search (Phase 2).
   * Throws UnsupportedOperation in Phase 1.
   */
  searchSemantic(params: {
    queryEmbedding: number[];
    scope: 'tools' | 'servers';
    category?: string;
    limit: number;
  }): Promise<CatalogSearchResult[]>;

  /** Look up a tool by exact name. Returns null if not found. */
  getTool(name: string): CatalogTool & { serverRecord: CatalogRecord } | null;

  /** Look up a server by exact name. Returns null if not found. */
  getServer(name: string): CatalogRecord | null;

  /** List all category strings present in the catalog. */
  listCategories(): string[];

  /** Total number of tools and servers in the catalog. */
  stats(): { toolCount: number; serverCount: number; initializedAt: string };
}

interface CatalogSearchResult {
  name: string;
  server: string;
  brief: string;
  category: string;
  /** Phase 1: integer token overlap. Phase 2: float cosine similarity. */
  score: number;
}
```

### EmbeddingsProvider (Phase 2 only)

```ts
/** Deferred to Phase 2. */
interface IEmbeddingsProvider {
  /** Embed a string to a float32 vector. */
  embed(text: string): Promise<number[]>;
  /** Embed a batch of strings. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Model identifier (e.g. "@cf/baai/bge-base-en-v1.5"). */
  readonly modelId: string;
}
```

### McpClientPool (Phase 2 only)

Manages MCP client connections to fleet backends for `invoke` dispatch.

```ts
/** Deferred to Phase 2. */
interface IMcpClientPool {
  /** Acquire (or reuse) a client connection for a server. */
  acquire(serverName: string): Promise<McpClientHandle>;
  /** Release a client back to the pool. */
  release(handle: McpClientHandle): void;
  /** Call a tool on a backend server. */
  callTool(params: {
    serverName: string;
    toolName: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ result: Record<string, unknown>; content: ContentItem[]; latencyMs: number }>;
}

interface McpClientHandle {
  readonly serverName: string;
  readonly connectionUrl: string;
}
```

---

## Static Catalog Module (Phase 1)

`src/services/catalog/static-catalog.ts` — a hand-curated array of `CatalogRecord` objects, one entry per active fleet server. Each entry is authored against the KB frontmatter (matching `name`, `description`, `version`, `category`, `subdomain`, `npm`, `auth`) plus the `tools`, `installSnippets`, `created`, and `updatedAt` fields.

The static module is the Phase 1 source of truth. Updating the fleet adds an entry here. Phase 2 migrates to KV-backed auto-refresh from `tools/list`.

Initial seed: every server with `status: active` in `kb/fleet/servers/` that has at least one tool.

---

## Config / Env Vars

`src/config/server-config.ts`:

```ts
const ServerConfigSchema = z.object({
  /**
   * Enables the `invoke` tool and MCP client pool.
   * Public deployment: unset or "false".
   * Gateway deployment: "true".
   */
  enableInvoke: z.coerce.boolean().default(false),

  /**
   * Cloudflare Vectorize index name (Phase 2).
   * Required when enableInvoke is true and running on Workers.
   */
  vectorizeIndex: z.string().optional(),

  /**
   * Cloudflare Workers AI model for embeddings (Phase 2).
   * Default: "@cf/baai/bge-base-en-v1.5".
   */
  embeddingModel: z.string().default('@cf/baai/bge-base-en-v1.5'),

  /**
   * Timeout in milliseconds for backend invoke calls (Phase 2).
   * Default: 30000 (30s).
   */
  invokeTimeoutMs: z.coerce.number().default(30000),
});

export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    enableInvoke: 'ENABLE_INVOKE',
    vectorizeIndex: 'VECTORIZE_INDEX',
    embeddingModel: 'EMBEDDING_MODEL',
    invokeTimeoutMs: 'INVOKE_TIMEOUT_MS',
  });
  return _config;
}
```

**Complete env var table:**

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `ENABLE_INVOKE` | No | `false` | Enables `invoke` tool and MCP client pool. Set to `true` for gateway deployment. |
| `VECTORIZE_INDEX` | Phase 2 only | — | Cloudflare Vectorize index name for semantic search. |
| `EMBEDDING_MODEL` | No | `@cf/baai/bge-base-en-v1.5` | Workers AI model for embedding generation. |
| `INVOKE_TIMEOUT_MS` | No | `30000` | Per-call timeout for backend dispatch (ms). |
| `MCP_AUTH_MODE` | No | `none` | `none` for public deployment; `jwt` or `oauth` for gateway. |
| `MCP_AUTH_SECRET_KEY` | When `MCP_AUTH_MODE=jwt` | — | JWT signing secret. |

Framework env vars (`MCP_TRANSPORT_TYPE`, `MCP_HTTP_PORT`, etc.) are managed by `@cyanheads/mcp-ts-core` and not duplicated here.

---

## Auth Model

| Deployment | `MCP_AUTH_MODE` | Tool scope checks |
|:-----------|:----------------|:------------------|
| Public discovery | `none` | Scopes not enforced; `auth` field on tool definitions is present but `MCP_AUTH_DISABLE_SCOPE_CHECKS=true` effectively applies. |
| Gateway | `jwt` or `oauth` | Scopes enforced: `tool:cyanheads_search:read`, `tool:cyanheads_describe:read`, `tool:cyanheads_invoke:execute` |

Scope naming follows the framework convention: `tool:<snake_tool_name>:<verb>`.

For the gateway deployment, per-tenant quotas (Phase 2) are enforced in `CatalogService` / `McpClientPool` using `ctx.tenantId` from the JWT `tid` claim. Tenant ID resolution follows framework defaults (stdio → `'default'`; HTTP + auth → JWT `tid` claim).

---

## Storage and Infrastructure

### Phase 1

| Layer | Tech | Notes |
|:------|:-----|:------|
| Catalog | In-memory (static TS module) | No runtime dependencies. Works in stdio and HTTP. |
| Search | Full-text token overlap | Pure TS, no external deps. |
| Persistence | None | No `ctx.state` usage in Phase 1. |

### Phase 2

| Layer | Tech | Notes |
|:------|:-----|:------|
| Catalog records | Cloudflare KV | Per-tool record keyed by `tool:<name>`. Per-server record keyed by `server:<name>`. |
| Vector index | Cloudflare Vectorize | One namespace, indexed by tool name. Re-embed on description change only. |
| Embeddings | Workers AI `bge-base-en-v1.5` | Fallback: Voyage AI or OpenAI. |
| Analytics | Cloudflare D1 | Search query log, invoke call log, per-tenant quota tracking. |
| MCP clients | `@modelcontextprotocol/sdk` `Client` | Pooled connections per backend server. |
| Catalog refresh | Cloudflare Cron Trigger | Daily by default; configurable. Walks each backend's `tools/list`, diffs, re-embeds changed tools. |

Phase 1 ships with no KV/Vectorize/D1 bindings. Phase 2 adds `wrangler.toml` bindings and the `createWorkerHandler` path.

---

## Phasing

### Phase 1 — Public Discovery

**What ships:**
- `cyanheads_search` (full-text)
- `cyanheads_describe`
- Static catalog seeded from KB fleet entries
- In-memory `CatalogService`
- Per-client snippet registry (4 clients: claude-desktop, claude-code, cursor, cline)
- `MCP_AUTH_MODE=none`
- Works in stdio and HTTP

**What is deferred:**
- `cyanheads_invoke` (conditionally present but guarded — returns `invoke_disabled` unless `ENABLE_INVOKE=true`)
- Cloudflare Workers deployment
- KV catalog, Vectorize semantic search, D1 analytics
- Embeddings provider
- MCP client pool
- Catalog refresh scheduler
- Per-tenant quotas and billing

### Phase 2 — Passthrough Gateway

**What activates:**
- `ENABLE_INVOKE=true` → `cyanheads_invoke` becomes callable
- Cloudflare Workers + KV + Vectorize deployment
- Scheduled catalog refresh (daily cron)
- Semantic search replaces full-text
- `MCP_AUTH_MODE=jwt` or `oauth` with per-tenant quotas
- D1 analytics schema and logging
- `MCP_CLIENT_POOL_MAX_SIZE` and `INVOKE_TIMEOUT_MS` tuning — `MCP_CLIENT_POOL_MAX_SIZE` must be added to `ServerConfigSchema` and the env var table before Phase 2 scaffold

---

## Implementation Order

1. `src/config/server-config.ts` — Zod schema, `parseEnvConfig` wiring
2. `src/services/catalog/static-catalog.ts` — seed data for ~5 fleet servers as a validation set
3. `src/services/catalog/snippets.ts` — per-client snippet factory map
4. `src/services/catalog/catalog-service.ts` — `ICatalogService` implementation (in-memory, fulltext)
5. `src/mcp-server/tools/definitions/search.tool.ts` — `cyanheads_search`
6. `src/mcp-server/tools/definitions/describe.tool.ts` — `cyanheads_describe`
7. `src/mcp-server/tools/definitions/invoke.tool.ts` — `cyanheads_invoke` (guarded by `enableInvoke`, returns `invoke_disabled` if false)
8. `src/index.ts` — wire all three tools into `createApp()`
9. Tests — `createMockContext()` for all three tools
10. `bun run devcheck`

---

## Decisions Log

- **Phase 1 search is full-text, not semantic.** Vectorize requires Workers runtime. Phase 1 must run in stdio/HTTP without cloud binding dependencies. Full-text (token overlap over description strings) is sufficient for a curated fleet of ~30 servers with well-written descriptions. The `phase` field in search output signals to callers which mode is active — no API change required when Phase 2 lands.

- **`score` field uses different semantics per phase.** Documenting `phase` in the output avoids a breaking change when the score type changes (integer count → float similarity). Callers are warned in the field description not to compare across phase transitions.

- **`invoke` is always present in the codebase but guarded at runtime.** Rather than `createApp()` conditionally omitting the tool, the handler returns `invoke_disabled` immediately when `enableInvoke` is false. This keeps the tool definition unconditional and avoids conditional registration logic that could mask the tool from tool-only agents in gateway deployments. The tool is simply not useful until the flag is set.

  _Devil's advocate:_ Conditionally omitting the tool from `tools/list` is cleaner — clients never see it in discovery deployment. Counter: a tool in the list with a clear error beats a tool that silently doesn't exist when `ENABLE_INVOKE` is accidentally false in a gateway deployment. Operator misconfiguration is the more likely failure. Revised: omit from `tools/list` in the public deployment (hide via `createApp` opts or a guard in the tool array), surface it in gateway. This needs resolution before build — see Open Questions.

- **No `fleet://catalog` resource.** A resource dump of the full catalog is not a useful agent-injectable context unit — too large, no stable per-record URI, no query semantics. The search tool is the right access path.

- **Static catalog in Phase 1, not auto-populated from `tools/list`.** Auto-population requires: live connection to each backend at startup, error handling for unavailable backends, schema extraction, brief generation. For Phase 1, the manual effort of maintaining a static file is acceptable and eliminates runtime dependencies. The static module is the forcing function for writing good `brief` text, which full-text search depends on.

- **4-client v0 snippet registry, not 6+.** Claude Desktop, Claude Code, Cursor, and Cline cover the primary user base for the cyanheads fleet. Continue and Zed are adding MCP support but have smaller installed bases and evolving config formats. Adding a client is a one-line registry addition — no design change needed.

- **`describe` auto-detects `kind` from name format.** Tool names use underscores; server names use hyphens. This convention is enforced across the entire fleet. Auto-detection avoids requiring callers to specify `kind` in the common case. The assumption that no fleet server will ever use underscores in its package name is a structural dependency — see Open Question 8.

- **`invoke` carries `destructiveHint: true`.** The tool dispatches to arbitrary fleet backends, some of which have `destructiveHint: true` themselves. The gateway can't know the downstream annotation at dispatch time without inspecting the catalog. Marking `invoke` itself destructive is the safe default — clients that gate on this flag will prompt before calling it.

---

## Open Questions

1. **`invoke` visibility in public deployment.** Design log entry above surfaced a real tension: should `invoke` appear in `tools/list` in the public (non-gateway) deployment at all? Two options: (a) omit from the tool array when `enableInvoke` is false (cleanest for clients); (b) include and return `invoke_disabled` error (better misconfiguration signal). Resolution needed before Phase 1 scaffold.

2. **Hosted connection URL scheme.** The catalog records use `subdomain` to construct `connectionUrl` (e.g. `https://${subdomain}.api.cyanheads.com/mcp`). The actual domain and path conventions for hosted deployments are not yet confirmed. The static catalog module should leave `connectionUrl` optional/undefined for Phase 1 and populate it when hosting is confirmed.

3. **Full-text search ranking.** Token overlap is naive — "earthquake earthquake earthquake" scores higher than "earthquake magnitude filter". Phase 1 is fine with this for a curated catalog, but if the fleet grows significantly before Phase 2 ships, a simple TF-IDF or BM25 implementation may be worth adding without the Vectorize migration.

4. **`brief` field authoring.** The static catalog requires a `brief` (≤120 chars) per tool entry. This can be derived from the first sentence of the tool description, but some descriptions don't follow a one-sentence-first pattern. Decision needed: auto-derive with a 120-char truncation, or require explicit `brief` in the static data.

5. **Snippet format for hosted SSE vs npx.** The snippet registry section documents both a `command: npx` variant and an `url: connectionUrl` SSE variant. For servers without a `connectionUrl`, the npx variant is always used. For hosted servers, the question is which variant to emit by default — or both. Needs a decision before snippet registry implementation.

6. **Phase 2 pricing model.** Deferred per `idea.md`. No design work needed until Phase 1 telemetry is live.

7. **Browse/list surface gap.** There is no tool for listing all servers without a query, or for listing valid category strings. `ICatalogService.listCategories()` exists at the service layer but has no corresponding tool. Agents that want to browse the full catalog or discover valid `category` filter values must issue a broad search or guess category strings. Flagged for the author to decide: add `cyanheads_list` or similar, or accept the gap for Phase 1.

8. **`describe` auto-detection relies on a fleet naming invariant.** The heuristic "underscore → tool, hyphen → server" is documented as a consequence of fleet naming conventions, but it is not enforced by the catalog schema. A fleet server whose package name uses underscores (e.g., a hypothetical `pubmed_mcp_server`) would break the heuristic silently — `cyanheads_describe` would treat it as a tool. The static catalog's `CatalogRecord.name` field should be validated on load to assert hyphen-only names, or the heuristic should be documented as fleet-invariant with a load-time assertion in `CatalogService.initialize()`.

9. **`cyanheads_invoke` in Phase 1.** The Phase 1 "What is deferred" list says `cyanheads_invoke` is "conditionally present but guarded." If the tool appears in `tools/list` in the public deployment, it is visible to every agent connecting to this server, including those that don't know about gateways. This is likely confusing. Resolution tied to Open Question 1 — decide before scaffold.

---

## Review Notes

Changes made during review pass (reviewer had no access to `docs/idea.md`):

1. **`cyanheads_describe` output schema — flagged** (`[REVIEW]` blockquote): The two `.optional()` branches (`tool` / `server`) produce `format-parity` lint failures at scaffold time because the linter walks both branches and expects every field to appear in `format()`. Replaced with `z.discriminatedUnion('kind', [...])` in the design spec — each branch is walked independently, `format()` dispatches on `result.kind`. Author must confirm this structural change before scaffolding.

2. **`invoke_disabled` error code — edited**: Changed from `JsonRpcErrorCode.MethodNotFound` (-32601) to `JsonRpcErrorCode.InvalidRequest` (-32600). `MethodNotFound` means the JSON-RPC method doesn't exist on the server — incorrect when the tool IS registered. `InvalidRequest` is the right code for "this operation is not supported in the current configuration." The inline comment in the error contract notes this is contingent on Open Question 1 resolution.

3. **`format()` parity notes added** to all three tool specs. The design doc had no mention of `format()` for any tool, but the framework's `format-parity` lint rule requires every output field to appear in `content[]` text. Added a parity requirement note under each tool's spec calling out the specific fields that must be rendered.

4. **`MCP_CLIENT_POOL_MAX_SIZE` missing from config table — flagged inline**: The Phase 2 section references this var but it is absent from `ServerConfigSchema` and the env var table. Added an inline note to the Phase 2 activation list.

5. **Surface coverage gap — added as Open Question 7**: No tool exists to list all servers or enumerate valid `category` values without performing a search. `ICatalogService.listCategories()` exists at the service layer but has no tool exposure. Flagged for author decision — not designed.

6. **`describe` auto-detection invariant — added as Open Question 8**: The underscore/hyphen heuristic is a structural dependency on a fleet naming constraint that is not enforced by the catalog schema or at load time. Added the invariant note to both the Decisions Log entry and the Open Questions list.

7. **`score` field description — edited**: Removed "do not compare across Phase transitions" from the `score.describe()` text (that was internal implementation guidance, not caller-facing semantics) and clarified the `phase` field description to carry the interpretation guidance instead. The field still accurately describes how to read the score.

8. **Open Question 9 added**: Calls out the contradiction between the Phase 1 "deferred" list (which says `invoke` is guarded) and the Decisions Log entry (which says the tool is always registered). These two positions need reconciliation before scaffold — linked back to Open Question 1.
