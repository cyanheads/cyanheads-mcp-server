# cyanheads-mcp-server — design rationale

## What it is

An MCP server that turns a fleet of other MCP servers into one discoverable surface. Exposes 2–3 tools depending on deployment:

- **`search`** — semantic search across every tool and server in the fleet
- **`describe`** — full schema, connection URL, and per-client install snippets (Claude Desktop, Claude Code, Cursor, Cline, Continue, Zed, …) for any tool or server
- **`invoke`** *(opt-in via config)* — passthrough dispatch to the right backend with input schema revalidation

One codebase, two deployment shapes via config flag:

| Deployment | Tools | Auth | Use case |
|:--|:--|:--|:--|
| Public discovery | `search`, `describe` | none | Browse and learn how to install fleet servers in your client |
| Passthrough gateway | `search`, `describe`, `invoke` | API key | One endpoint, no client-config sprawl for users with many servers |

## The problem

Two related problems show up as MCP server collections grow:

1. **LLM context degrades past a few dozen tools.** A flat catalog of 500+ tools (cyanheads's fleet at time of writing) doesn't fit any client's effective tool budget. Modern guidance is "tens, not hundreds." Aggregating N backends into one mega-catalog breaks at fleet scale.
2. **Client install instructions don't centralize.** A user who finds the right MCP server still needs the right config snippet for *their* client. Each server's README typically covers one or two clients. There's no single source of "what's the right server for X **and how do I install it in my client?**"

Semantic search → drill-down → optional invoke is the pattern that scales. It's how Claude Code's own deferred tool surface works.

## How it works

```
┌──────────────────────────────────────┐
│  MCP client (agent)                   │
│  sees 2 or 3 tools                    │
└─────────────────┬────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────┐
│  cyanheads-mcp-server                 │
│  ┌────────────────────────────────┐  │
│  │ search   → vector + KV catalog │  │
│  │ describe → schema + install     │  │
│  │            snippets             │  │
│  │ invoke   → schema revalidate    │  │
│  │            + MCP client dispatch│  │
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │ Catalog refresh (scheduled)    │  │
│  │  - walks each backend's        │  │
│  │    tools/list                  │  │
│  │  - re-embeds on schema change  │  │
│  └────────────────────────────────┘  │
└────────────────┬─────────────────────┘
                 │
                 ▼
       ┌──────────────────────┐
       │  N backend MCP svrs  │
       │  (no changes needed) │
       └──────────────────────┘
```

### Tool surfaces in detail

**`search`** — semantic search:

| Mode | Input | Output |
|:--|:--|:--|
| Tools (default) | `query`, optional `limit`, `category` filters | Ranked `[{ name, server, brief, snippet }]` |
| Servers | `query`, `scope: 'servers'` | Ranked server matches (for "what server handles X?") |

**`describe`** — `{ name, kind?: 'tool' \| 'server', client?: 'claude-desktop' \| 'claude-code' \| 'cursor' \| 'cline' \| 'continue' \| 'zed' }`:
- For tools: input/output JSON-Schema, parameter descriptions, the server it lives on
- For servers: connection URL + per-client install snippets (e.g. raw JSON to paste into Claude Desktop's config, `claude mcp add ...` for Claude Code, equivalent for each supported client)
- Omitting `client` returns all client variants

**`invoke`** *(opt-in)* — `{ tool_name, input }` → passthrough result. The service resolves the backend, revalidates `input` against the backend's published schema before dispatch, forwards via MCP client, returns the structured response. Backend errors surface with their original `McpError` envelope intact.

### Component choices

| Component | Tech | Why |
|:--|:--|:--|
| Vector index | Cloudflare Vectorize | Fits Workers stack; built-in similarity search |
| Embeddings | Workers AI `bge-base-en-v1.5` (Voyage / OpenAI as alternates) | Cheap, re-embed only on schema change |
| Catalog store | Cloudflare KV (per-tool record) | Fast read on every search |
| Analytics | Cloudflare D1 | SQL for usage reports |
| MCP client (service → backends) | `@modelcontextprotocol/sdk` Client | The service is an MCP server AND an MCP client to backends |
| Auth (passthrough deployment) | `X-API-Key` header → KV lookup | Minimum viable; OAuth/SSO later |
| Per-client install registry | Static lookup table in code | One-time effort, then forever-useful |

### Refresh model

A scheduled handler (daily; tunable) walks each backend's `tools/list`, diffs against the KV catalog, re-embeds new or changed descriptions, retires removed entries.

## Rollout

### Phase 1 — public discovery

- Tools: `search`, `describe`
- No auth, no billing
- Anyone configures this one server in their MCP client; the agent navigates the rest of the fleet via semantic search; users get exact install snippets for *their* client
- Strategic value (for any operator running a fleet): single front door, scales with the fleet

### Phase 2 — passthrough gateway

- Adds `invoke`
- API key auth, per-tenant quotas, optional billing integration
- Convenience layer for heavy users — one endpoint, no client-config sprawl

Same codebase, different config flag (`enableInvoke: true`).

## Why not just aggregate everything into one catalog

Aggregator-style gateways (front N backends behind one endpoint, merge their catalogs into one flat list) work for small fleets but break at scale:

- LLMs degrade well before 500+ tools fit in a session
- Tool-name collisions across servers force namespace prefixes that bloat the catalog further
- Refreshing a flat catalog requires every change to ripple through the whole agent context

Semantic search avoids all three: the catalog stays invisible until queried, and the agent sees a constant 2- or 3-tool surface regardless of fleet size.

## Security notes (for the passthrough deployment)

1. **Revalidate `invoke` input** against the backend's Zod schema before dispatch. Backend revalidates too, but rejecting garbage at the gateway saves a round trip.
2. **Prompt injection in tool descriptions** is a future concern if the catalog ever indexes third-party MCP servers. For an operator's own curated fleet, descriptions are trusted.
3. **Rate limit per (tenant, tool)** to prevent one customer abusing one expensive tool to starve others.
4. **Recursion guard** — `invoke` refuses to dispatch to itself or to another service that fronts this one.
5. **Public deployment abuse protection** — IP-based rate limits even without auth.

## Open questions

1. **Public subdomain naming** for the discovery deployment.
2. **Client install-instruction scope** for v0 — Claude Desktop + Claude Code minimum; Cursor + Cline likely; others as additions.
3. **Tool name format in `search` results** — qualified (`<server>.<tool>`) vs bare. Qualified is unambiguous; bare is shorter. Leaning qualified.
4. **Hosting** — Cloudflare Workers + Vectorize (recommended) vs VPS container with local pgvector.
5. **Phase 2 pricing model** — per-call, per-month tier, or per-tool category. Defer until Phase 1 telemetry exists.

## Non-goals

- **Replacing direct MCP server connections.** Users who already configure individual servers in their client keep doing that. This is an additive surface.
- **Acting as an MCP registry / marketplace.** Different surface (a registry catalogues servers anyone can deploy; this fronts a specific operator's fleet).
- **Mocking arbitrary I/O for tests.** Out of scope; tests live in each backend.
- **Multi-fleet aggregation in v0.** One operator's catalog. Cross-operator federation is a future concern.
