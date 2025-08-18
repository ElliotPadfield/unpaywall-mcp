# Unpaywall MCP Server
[![npm version](https://img.shields.io/npm/v/unpaywall-mcp.svg)](https://www.npmjs.com/package/unpaywall-mcp)
[![CI](https://github.com/ElliotPadfield/unpaywall-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ElliotPadfield/unpaywall-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/unpaywall-mcp.svg)](LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#requirements)

An MCP (Model Context Protocol) server exposing Unpaywall tools so AI clients can:

- Fetch metadata by DOI
- Search article titles
- Retrieve best OA fulltext links
- Download and extract text from OA PDFs

## Quickstart (npx)

Add this to your MCP client config (Claude Desktop example):

```jsonc
{
  "mcpServers": {
    "unpaywall": {
      "command": "npx",
      "args": ["-y", "unpaywall-mcp"],
      "env": { "UNPAYWALL_EMAIL": "you@example.com" }
    }
  }
}
```

Then try the tools: `unpaywall_search_titles`, `unpaywall_get_fulltext_links`, `unpaywall_fetch_pdf_text`.

## Requirements

- Node.js 18+
- An email address for Unpaywall requests (they require it for polite usage).

## Setup

```bash
# Install deps
npm install

# Build
npm run build

# Run (stdio transport, as required by MCP clients)
UNPAYWALL_EMAIL=you@example.com npm start
```

For development with hot-run (no build step):

```bash
UNPAYWALL_EMAIL=you@example.com npm run dev
```

## Tools

### unpaywall_get_by_doi

- Description: Fetch Unpaywall metadata for a DOI
- Input schema:
  - `doi` (string, required): e.g. `10.1038/nphys1170`
  - `email` (string, optional): overrides `UNPAYWALL_EMAIL` if provided
- Output: JSON response from Unpaywall

### unpaywall_search_titles

- Description: Search Unpaywall for article titles matching a query (50 results/page)
- Input schema:
  - `query` (string, required): title query
  - `is_oa` (boolean, optional): if true, only OA results; if false, only closed; omit for all
  - `page` (integer >= 1, optional): page number
  - `email` (string, optional): overrides `UNPAYWALL_EMAIL`
- Output: JSON search results from `GET https://api.unpaywall.org/v2/search`

### unpaywall_get_fulltext_links

- Description: Return the best OA PDF URL and Open URL for a DOI, plus all OA locations
- Input schema:
  - `doi` (string, required)
  - `email` (string, optional): overrides `UNPAYWALL_EMAIL`
- Output: JSON with fields: `best_pdf_url`, `best_open_url`, `best_oa_location`, `oa_locations`, and select metadata

### unpaywall_fetch_pdf_text

- Description: Download and extract text from the best OA PDF for a DOI, or from a provided `pdf_url`
- Input schema:
  - `pdf_url` (string, optional): direct PDF URL (takes precedence)
  - `doi` (string, optional): used to resolve best OA PDF if `pdf_url` not provided
  - `email` (string, optional): required if using `doi` and no `UNPAYWALL_EMAIL` env var
  - `truncate_chars` (integer >= 1000, optional): max characters of extracted text to return (default 20000)
- Output: JSON with `text` (possibly truncated), `length_chars`, `truncated`, `pdf_url`, and PDF metadata

## LLM prompting tips (MCP)

When using this server from an MCP-enabled LLM client, ask the model to:

- __Search then fetch__: Use `unpaywall_search_titles` with a concise title phrase; select a result; then call `unpaywall_get_fulltext_links` or `unpaywall_fetch_pdf_text` on the chosen DOI.
- __Prefer OA__: Pass `is_oa: true` in searches when you only want open-access.
- __Control size__: Set `truncate_chars` in `unpaywall_fetch_pdf_text` (default 20000) and summarize long texts before proceeding.
- __Be resilient__: If the best PDF URL is missing, fall back to `best_open_url` and extract content from the landing page (outside this server).
- __Respect rate limits__: Space requests if making many calls; reuse earlier responses instead of repeating the same call.

Good user instructions to the LLM:

- "Find 3 OA papers about 'foundation models in biomedicine', then extract and summarize the introduction of the best one."
- "Search for 'Graph Neural Networks survey 2024', filter to OA if possible, then fetch the PDF text and produce a 10-bullet summary."

## Example tool call payloads

Depending on your MCP client, the structure differs; the core payloads are:

```jsonc
// Search titles
{
  "name": "unpaywall_search_titles",
  "arguments": {
    "query": "graph neural networks survey",
    "is_oa": true,
    "page": 1
  }
}
```

```jsonc
// Get best OA links for a DOI
{
  "name": "unpaywall_get_fulltext_links",
  "arguments": {
    "doi": "10.48550/arXiv.1812.08434"
  }
}
```

```jsonc
// Fetch and extract PDF text (by DOI)
{
  "name": "unpaywall_fetch_pdf_text",
  "arguments": {
    "doi": "10.48550/arXiv.1812.08434",
    "truncate_chars": 20000
  }
}
```

## Configure in an MCP client

Recommended (no-build) config for Claude Desktop using npm/npx:

```jsonc
{
  "mcpServers": {
    "unpaywall": {
      "command": "npx",
      "args": ["-y", "unpaywall-mcp"],
      "env": {
        "UNPAYWALL_EMAIL": "you@example.com"
      }
    }
  }
}
```

Alternative (local repo) config using the compiled dist:

```jsonc
{
  "mcpServers": {
    "unpaywall": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "UNPAYWALL_EMAIL": "you@example.com"
      }
    }
  }
}
```

After adding, ask your client to list tools and try:

- `unpaywall_search_titles` with a `query`
- `unpaywall_get_fulltext_links` with a `doi`
- `unpaywall_fetch_pdf_text` with a `doi` (or `pdf_url`)

## Notes

- Respect Unpaywall's rate limits and usage guidelines: https://unpaywall.org/products/api
- The server uses stdio transport and `@modelcontextprotocol/sdk`.
- Set `UNPAYWALL_EMAIL` or pass `email` per call so Unpaywall can contact you about usage.

## Maintainers: publish to npm

```bash
# 1) Build the project (also runs automatically on publish)
npm run build

# 2) Bump version (choose patch/minor/major)
npm version patch

# 3) Publish (ensure you are logged in: npm login)
npm publish --access public

# 4) Tag a release on GitHub (optional, recommended)
```

Users can then configure their MCP client with `npx -y unpaywall-mcp` as shown above. No clone or build required.
