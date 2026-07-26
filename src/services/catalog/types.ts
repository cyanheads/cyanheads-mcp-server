/**
 * @fileoverview Shared types for the catalog service — CatalogRecord, CatalogTool,
 * FleetPayload (v2 with baked embeddings), InstallSnippet, ClientId,
 * and the service interface.
 * @module services/catalog/types
 */

/** Supported MCP client identifiers for install snippets. */
export type ClientId = 'claude-code' | 'codex' | 'cursor' | 'curl' | 'gemini' | 'streamable-http';

/** Catalog category for a fleet server. */
export type CatalogCategory = 'research' | 'government' | 'public-data' | 'utility';

/** Single tool entry inside a CatalogRecord. */
export interface CatalogTool {
  /** Human-readable description. */
  description: string;
  /**
   * L2-normalized, Matryoshka-truncated embedding vector.
   * Length matches FleetPayload.embeddingDims.
   */
  embedding: number[];
  /** Fully-qualified name: snake_case (e.g. "earthquake_search"). */
  name: string;
}

/** Per-client install snippet for one transport. */
export interface InstallSnippet {
  /** MCP client identifier. */
  client: ClientId;
  /** Human-readable label for the install method. */
  label: string;
  /**
   * The install payload. Shape varies by client and transport:
   * - claude-code: CLI — stdio `claude mcp add --transport stdio <name> -- npx -y <pkg>`; http `claude mcp add --transport http <name> <url>`
   * - codex: CLI — stdio `codex mcp add <name> -- npx -y <pkg>`; http `codex mcp add <name> --url <url>`
   * - cursor: `mcpServers` JSON, no `type` field — stdio `{ command, args }`; http `{ url }`
   * - gemini: CLI — stdio `gemini mcp add <name> npx -y <pkg>`; http `gemini mcp add --transport http <name> <url>`
   * - streamable-http: generic `mcpServers` JSON with `type` — stdio `{ type: 'stdio', command, args }`; http `{ type: 'http', url }`
   * - curl: http only — `initialize` connectivity probe against the endpoint
   */
  payload: string;
  /**
   * Transport this snippet installs.
   * - `stdio`: local install via `npx -y <pkg>` — available for every published server.
   * - `http`: remote connection to the hosted endpoint — present only when the record has an `endpoint`.
   */
  transport: 'stdio' | 'http';
}

/** One fleet server record, mirroring the fleet.json servers[] entry. */
export interface CatalogRecord {
  /**
   * Auth requirement for the hosted deployment.
   * Open string for forward-compatibility — currently always "none".
   */
  auth: string;
  /** Thematic grouping for filter facets. */
  category: CatalogCategory;
  /** One-line description of what this server does. */
  description: string;
  /** Human label (e.g. "arXiv"). */
  displayName: string;
  /**
   * L2-normalized, Matryoshka-truncated embedding vector of
   * `${displayName}\n${description}`. Length matches FleetPayload.embeddingDims.
   */
  embedding: number[];
  /**
   * Streamable HTTP endpoint for the hosted deployment. Optional: present for hosted
   * servers (drives the remote/HTTP snippets), absent for local-only (stdio) servers.
   */
  endpoint?: string;
  /** GitHub repository URL. */
  github: string;
  /** Package name without scope (e.g. "arxiv-mcp-server"). */
  name: string;
  /** npm package name (scoped, e.g. "@cyanheads/arxiv-mcp-server"). Drives the local stdio snippets. */
  npm: string;
  /**
   * Env var names the local (stdio) install requires (e.g. ["MAILCHIMP_API_KEY"]).
   * Surfaced in the local-install snippets so the caller knows what to set. Optional —
   * absent or empty when the server needs no configuration.
   */
  requiredEnvVars?: string[];
  /** Tool entries for this server, each with its own embedding. */
  tools: CatalogTool[];
  /** Published version captured at fleet-generation time (e.g. "1.2.7"). */
  version: string;
}

/** Top-level payload returned from the remote fleet.json URL. */
export interface FleetPayload {
  /** Dimensionality of every embedding in the payload. */
  embeddingDims: number;
  /** Hugging Face model id used to produce the embeddings. */
  embeddingModel: string;
  /**
   * Prefix that must be prepended to query text before embedding at runtime.
   * Documents are embedded without this prefix; only queries get it.
   */
  embeddingQueryPrefix: string;
  /** ISO 8601 UTC timestamp when the payload was generated. */
  generatedAt: string;
  /** Fleet server records. */
  servers: CatalogRecord[];
  /** Schema version. Currently "2". */
  version: '2';
}

/** Result row returned from catalog searches. */
export interface CatalogSearchResult {
  /** Brief description for display. */
  brief: string;
  /** Catalog category for the owning server. */
  category: CatalogCategory;
  /** Tool or server name, depending on scope. */
  name: string;
  /** Cosine similarity in [0, 1]. Higher is better. */
  score: number;
  /** Server that owns this result. */
  server: string;
}

/** Service interface. */
export interface ICatalogService {
  /** Look up a server by exact name. Returns null if not found. */
  getServer(name: string): CatalogRecord | null;

  /** Look up a tool by exact name. Returns null if not found. */
  getTool(name: string): (CatalogTool & { serverRecord: CatalogRecord }) | null;

  /**
   * Fetch fleet.json, validate, build the vector index, and load the embedding model.
   * Starts the background refresh timer if configured.
   */
  initialize(): Promise<void>;

  /** List all category strings present in the catalog. */
  listCategories(): CatalogCategory[];

  /**
   * Semantic search. Embeds the query, computes cosine similarity against
   * every catalog entry within the requested scope, filters by category and
   * by the configured similarity floor, sorts descending, and returns the
   * top `limit` (or every match when `limit` is omitted).
   */
  search(params: {
    query: string;
    scope: 'tools' | 'servers';
    category?: CatalogCategory;
    limit?: number;
  }): Promise<CatalogSearchResult[]>;

  /** Stop the background refresh timer. */
  shutdown(): void;

  /** Catalog summary for diagnostics. */
  stats(): {
    toolCount: number;
    serverCount: number;
    initializedAt: string;
    embeddingModel: string;
  };
}
