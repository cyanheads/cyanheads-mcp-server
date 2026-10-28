---
name: cyanheads-guide
description: Find a cyanheads fleet MCP server for a task and hand the user a working install, using cyanheads_search_catalog and cyanheads_describe_entry. Use when the session lacks a capability, or the user asks which cyanheads server or tool does X, whether one is hosted, or how to add it to a client. Covers telling real matches from near misses, the category filter, hosted vs local installs, and env vars the snippets leave out.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

This server catalogs the cyanheads MCP fleet. It finds servers and tools and says how to connect them, but it does not run them: `tools/call` here reaches only `cyanheads_search_catalog` and `cyanheads_describe_entry`, and a fleet tool name sent to it fails as not found. A tool you find becomes callable only after the user adds its server to their client, so hand over the install instead of announcing the call.

Skip this server when the session already exposes tools with the target prefix (`openfda_*`, `orcid_*`). Call those directly.

The catalog lists hosted servers and local-only (stdio) servers, not every cyanheads repository. When a name doesn't resolve, report that the catalog lists no such server, not that none exists.

## Identifiers

| Identifier | Example | Comes from |
|:-----------|:--------|:-----------|
| Tool name | `openfda_get_drug_label` | `results[].name` (tools scope); `tools[].name` when describing a server |
| Server name | `openfda-mcp-server` | `results[].server`; `servers[].name` (roll-up); `results[].name` (servers scope) |
| npm package | `@cyanheads/openfda-mcp-server` | `npm` from `cyanheads_describe_entry` |

A server resolves only by its full package basename (case-insensitive). A display or short name (`arXiv`, `pubmed`) returns `not_found`, so search for the task and take the name from a result.

Copy `npm` exactly as returned, or use the snippet that embeds it. Packages are not all `@cyanheads/`-scoped (`obsidian-mcp-server` publishes unscoped), so a package name built from the server name can point at nothing.

## Gates

- **A result is not coverage.** Search returns everything above a low similarity floor, so an off-domain request still comes back with tools: a flight-booking query returns airport reference lookups, and a Slack query returns push-notification tools. Read each match's brief, or describe it, and claim coverage only when the description does the task. When nothing does, tell the user the fleet has no server for it instead of offering the nearest neighbor.
- **Leave `category` unset unless the user names one.** Categories are the catalog's own labels and don't follow who publishes the data: the openFDA, Census, and NWS servers are `public-data`, while SEC EDGAR is `government`. A wrong guess drops the right server, and the response returns the best of what is left, with no notice unless nothing is left.
- **Prefer the hosted install when `endpoint` is present.** The `http` snippets connect to a running server: nothing to install and no `env` block to fill. Hand over a `stdio` snippet when the server has no `endpoint` or the user asks for a local install.
- **Supply the env vars a CLI snippet leaves out.** `requiredEnvVars` names the variables the server's manifest marks required; without them a local install fails to start or its tools fail. JSON snippets scaffold them as empty `env` keys for the user to fill, but the `claude-code`, `codex`, and `gemini` CLI snippets omit them. Tell the user to set those variables, or add them to the command.
- **An absent `requiredEnvVars` does not mean keyless.** Manifests don't mark every key required: `census-mcp-server` lists none, yet its data-query tools need `CENSUS_API_KEY`. Before handing over a local install, check the README at `github`, or use the hosted endpoint.

## Client snippets

| User's client | `client` value | Use |
|:--------------|:---------------|:----|
| Claude Code, Codex, Gemini CLI | `claude-code`, `codex`, `gemini` | A shell command |
| Cursor, Cline | `cursor`, `cline` | A JSON fragment for the client's MCP config file |
| Claude Desktop, local | `streamable-http` | The `stdio` snippet, labeled "Claude Desktop / generic", for Claude Desktop's config file |
| Claude Desktop, hosted | none | The user adds the `endpoint` URL under Settings → Connectors; no snippet targets it |
| Any other client | `streamable-http` | The generic `mcpServers` JSON, `stdio` or `http` |

`curl` returns a connectivity probe for a hosted endpoint, not an install. A local-only server returns no `curl` snippet.
