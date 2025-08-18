import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pdfParse from "pdf-parse";

// Tool name constants
const TOOL_GET_BY_DOI = "unpaywall_get_by_doi" as const;
const TOOL_SEARCH_TITLES = "unpaywall_search_titles" as const;
const TOOL_GET_FULLTEXT_LINKS = "unpaywall_get_fulltext_links" as const;
const TOOL_FETCH_PDF_TEXT = "unpaywall_fetch_pdf_text" as const;

type GetByDoiArgs = {
  doi: string;
  email?: string; // optional override; otherwise uses UNPAYWALL_EMAIL env var
};

type SearchTitlesArgs = {
  query: string;
  is_oa?: boolean;
  page?: number; // 1-based page index per Unpaywall docs (50 results per page)
  email?: string; // optional override
};

type FetchPdfTextArgs = {
  doi?: string; // if provided, we will resolve best OA PDF via Unpaywall
  pdf_url?: string; // optional direct PDF URL (takes precedence if provided)
  email?: string; // required if using DOI
  truncate_chars?: number; // optional truncation to avoid massive outputs (default 20000)
};

function normalizeDoi(input: string): string {
  let doi = input.trim();
  // Strip common DOI URL prefixes
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  // Strip leading 'doi:' prefix
  doi = doi.replace(/^doi:/i, "");
  return doi.trim();
}

async function fetchUnpaywallByDoi(doi: string, email: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
    const resp = await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json" } });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Unpaywall HTTP ${resp.status}: ${text.slice(0, 400)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadPdfAsBuffer(url: string, maxBytes = 30 * 1024 * 1024) {
  // Limit to 30MB by default to avoid extremely large downloads
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/pdf, application/octet-stream;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`PDF download HTTP ${resp.status}: ${text.slice(0, 400)}`);
    }
    const reader = resp.body?.getReader();
    if (!reader) return Buffer.from(await resp.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) throw new Error(`PDF exceeds size limit of ${maxBytes} bytes`);
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
  }
}

async function searchUnpaywallTitles(args: { query: string; email: string; is_oa?: boolean; page?: number }) {
  const { query, email, is_oa, page } = args;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const params = new URLSearchParams();
    params.set("query", query);
    if (typeof is_oa === "boolean") params.set("is_oa", String(is_oa));
    if (page && Number.isFinite(page) && page > 1) params.set("page", String(Math.floor(page)));
    params.set("email", email);
    const url = `https://api.unpaywall.org/v2/search?${params.toString()}`;
    const resp = await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json" } });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Unpaywall search HTTP ${resp.status}: ${text.slice(0, 400)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const server = new Server(
    {
      name: "unpaywall-mcp",
      version: "0.1.1",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: TOOL_GET_BY_DOI,
          description:
            "Fetch Unpaywall metadata for a DOI (accepts DOI, DOI URL, or 'doi:' prefix). Requires an email address via env UNPAYWALL_EMAIL or the optional 'email' argument.",
          inputSchema: {
            type: "object",
            properties: {
              doi: { type: "string", description: "DOI string or DOI URL, e.g. 10.1038/nphys1170 or https://doi.org/10.1038/nphys1170" },
              email: { type: "string", description: "Email to identify your requests to Unpaywall (optional override)" },
            },
            required: ["doi"],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_SEARCH_TITLES,
          description: "Search Unpaywall for article titles matching a query. Supports optional is_oa filter and pagination (50 results per page).",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Title search query (supports phrase, boolean operators per Unpaywall docs)" },
              is_oa: { type: "boolean", description: "If true, only return OA results; if false, only closed; omit for all" },
              page: { type: "integer", minimum: 1, description: "Page number (50 results per page)" },
              email: { type: "string", description: "Email to identify your requests to Unpaywall (optional override)" },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_GET_FULLTEXT_LINKS,
          description: "Given a DOI, return best open-access links (best PDF URL and open URL) plus Unpaywall locations metadata.",
          inputSchema: {
            type: "object",
            properties: {
              doi: { type: "string", description: "DOI string or DOI URL" },
              email: { type: "string", description: "Email to identify your requests to Unpaywall (optional override)" },
            },
            required: ["doi"],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_FETCH_PDF_TEXT,
          description: "Download and extract text from best OA PDF for a DOI, or from a provided PDF URL.",
          inputSchema: {
            type: "object",
            properties: {
              doi: { type: "string", description: "DOI string or DOI URL. Used if pdf_url is not provided." },
              pdf_url: { type: "string", description: "Direct PDF URL to download and parse (takes precedence over DOI)." },
              email: { type: "string", description: "Email to identify requests to Unpaywall (required when resolving via DOI)." },
              truncate_chars: { type: "integer", minimum: 1000, description: "Max characters of extracted text to return (default 20000)." },
            },
            required: [],
            additionalProperties: false,
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = req.params.name;
    try {
      if (tool === TOOL_GET_BY_DOI) {
        const args = (req.params.arguments ?? {}) as Partial<GetByDoiArgs>;
        const rawDoi = (args.doi ?? "").toString().trim();
        if (!rawDoi) {
          return {
            content: [
              { type: "text", text: "Missing required argument: 'doi'" },
            ],
            isError: true,
          };
        }

        const email = (args.email || process.env.UNPAYWALL_EMAIL || "").toString().trim();
        if (!email) {
          return {
            content: [
              {
                type: "text",
                text: "Unpaywall requires an email. Set UNPAYWALL_EMAIL env var for the server or pass 'email' in the tool arguments.",
              },
            ],
            isError: true,
          };
        }

        const doi = normalizeDoi(rawDoi);
        const data = await fetchUnpaywallByDoi(doi, email);
        return {
          content: [{ type: "json", json: data }],
        };
      }
      if (tool === TOOL_SEARCH_TITLES) {
        const args = (req.params.arguments ?? {}) as Partial<SearchTitlesArgs>;
        const query = (args.query ?? "").toString().trim();
        if (!query) {
          return { content: [{ type: "text", text: "Missing required argument: 'query'" }], isError: true };
        }
        const email = (args.email || process.env.UNPAYWALL_EMAIL || "").toString().trim();
        if (!email) {
          return { content: [{ type: "text", text: "Unpaywall requires an email. Set UNPAYWALL_EMAIL or pass 'email'." }], isError: true };
        }
        const page = args.page && Number.isFinite(args.page) ? Math.max(1, Math.floor(Number(args.page))) : undefined;
        const is_oa = typeof args.is_oa === "boolean" ? args.is_oa : undefined;
        const data = await searchUnpaywallTitles({ query, email, is_oa, page });
        return { content: [{ type: "json", json: data }] };
      }
      if (tool === TOOL_GET_FULLTEXT_LINKS) {
        const args = (req.params.arguments ?? {}) as Partial<GetByDoiArgs>;
        const rawDoi = (args.doi ?? "").toString().trim();
        if (!rawDoi) {
          return { content: [{ type: "text", text: "Missing required argument: 'doi'" }], isError: true };
        }
        const email = (args.email || process.env.UNPAYWALL_EMAIL || "").toString().trim();
        if (!email) {
          return { content: [{ type: "text", text: "Unpaywall requires an email. Set UNPAYWALL_EMAIL or pass 'email'." }], isError: true };
        }
        const doi = normalizeDoi(rawDoi);
        const obj = await fetchUnpaywallByDoi(doi, email);
        const best = obj?.best_oa_location ?? null;
        const locations: any[] = Array.isArray(obj?.oa_locations) ? obj.oa_locations : [];
        const pickPdfFrom = (locs: any[]) => locs.find(l => l?.url_for_pdf) || locs.find(l => l?.url);
        const bestPdfUrl = best?.url_for_pdf || best?.url || (pickPdfFrom(locations)?.url_for_pdf || pickPdfFrom(locations)?.url) || null;
        const bestOpenUrl = best?.url || (locations.find(l => l?.url)?.url) || null;
        const result = {
          doi: obj?.doi ?? doi,
          title: obj?.title ?? null,
          is_oa: obj?.is_oa ?? null,
          oa_status: obj?.oa_status ?? null,
          best_pdf_url: bestPdfUrl,
          best_open_url: bestOpenUrl,
          best_oa_location: best,
          oa_locations: locations,
        };
        return { content: [{ type: "json", json: result }] };
      }
      if (tool === TOOL_FETCH_PDF_TEXT) {
        const args = (req.params.arguments ?? {}) as Partial<FetchPdfTextArgs>;
        const truncate = args.truncate_chars && Number.isFinite(args.truncate_chars)
          ? Math.max(1000, Math.floor(Number(args.truncate_chars)))
          : 20000;

        let pdfUrl = (args.pdf_url ?? "").toString().trim();
        if (!pdfUrl) {
          const rawDoi = (args.doi ?? "").toString().trim();
          if (!rawDoi) {
            return { content: [{ type: "text", text: "Provide either 'pdf_url' or 'doi'" }], isError: true };
          }
          const email = (args.email || process.env.UNPAYWALL_EMAIL || "").toString().trim();
          if (!email) {
            return { content: [{ type: "text", text: "Unpaywall requires an email. Set UNPAYWALL_EMAIL or pass 'email'." }], isError: true };
          }
          const doi = normalizeDoi(rawDoi);
          const obj = await fetchUnpaywallByDoi(doi, email);
          const best = obj?.best_oa_location ?? null;
          const locations: any[] = Array.isArray(obj?.oa_locations) ? obj.oa_locations : [];
          const pickPdfFrom = (locs: any[]) => locs.find(l => l?.url_for_pdf) || locs.find(l => l?.url);
          pdfUrl = best?.url_for_pdf || (pickPdfFrom(locations)?.url_for_pdf || pickPdfFrom(locations)?.url) || "";
          if (!pdfUrl) {
            return { content: [{ type: "text", text: "No OA PDF URL found for the provided DOI." }], isError: true };
          }
        }

        // Download and parse PDF
        const pdfBuffer = await downloadPdfAsBuffer(pdfUrl);
        const parsed = await pdfParse(pdfBuffer);
        const text = parsed.text || "";
        const truncated = text.length > truncate;
        const output = {
          pdf_url: pdfUrl,
          length_chars: text.length,
          truncated,
          text: truncated ? text.slice(0, truncate) : text,
          metadata: {
            n_pages: parsed.numpages ?? undefined,
            info: parsed.info ?? undefined,
            metadata: parsed.metadata ?? undefined,
          },
        };
        return { content: [{ type: "json", json: output }] };
      }

      return {
        content: [
          { type: "text", text: `Unknown tool: ${tool}` },
        ],
        isError: true,
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error calling ${tool}: ${err?.message || String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error in Unpaywall MCP server:", err);
  process.exit(1);
});
