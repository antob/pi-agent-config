import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface StructuredSearchArgs {
  query?: string;
  exactPhrases?: string[];
  excludeTerms?: string[];
  site?: string;
  count?: number;
}

interface BuiltSearchQuery {
  query: string;
  baseQuery?: string;
  exactPhrases: string[];
  excludeTerms: string[];
  site?: string;
}

async function duckduckgoSearch(
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const num = Math.min(count, 10);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const resp = await fetch(url, {
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!resp.ok) {
    throw new Error(`DuckDuckGo ${resp.status}: ${resp.statusText}`);
  }

  const html = await resp.text();

  const results: SearchResult[] = [];
  const blockRe =
    /<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && results.length < num) {
    const rawUrl = m[1]
      .replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "")
      .replace(/&amp;rut=.*$/, "")
      .replace(/&rut=.*$/, "");
    let url = rawUrl;
    try {
      url = decodeURIComponent(rawUrl);
    } catch {}
    const title = m[2].replace(/<[^>]*>/g, "").trim();
    const snippet = m[3].replace(/<[^>]*>/g, "").trim();
    results.push({ title, url, snippet });
  }

  return results;
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

function stripWrappingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).trim()
    : value;
}

function cleanItems(values?: string[]): string[] {
  if (!values) return [];
  return values
    .map((value) => stripWrappingQuotes(value.trim().replace(/\s+/g, " ")))
    .filter(Boolean);
}

function cleanQuery(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned || undefined;
}

function normalizeSite(site?: string): string | undefined {
  if (typeof site !== "string") return undefined;

  let value = site
    .trim()
    .replace(/^site:/i, "")
    .trim();
  if (!value) return undefined;

  try {
    const candidate = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    if (url.hostname) value = url.hostname;
  } catch {}

  return value.replace(/\/+$/, "") || undefined;
}

function quoteForSearch(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(args: StructuredSearchArgs): BuiltSearchQuery {
  const baseQuery = cleanQuery(args.query);
  const exactPhrases = cleanItems(args.exactPhrases);
  const excludeTerms = cleanItems(args.excludeTerms);
  const site = normalizeSite(args.site);

  if (!baseQuery && exactPhrases.length === 0) {
    throw new Error("At least one of 'query' or 'exactPhrases' is required.");
  }

  const parts: string[] = [];
  if (baseQuery) parts.push(baseQuery);
  for (const phrase of exactPhrases) {
    parts.push(quoteForSearch(phrase));
  }
  for (const term of excludeTerms) {
    parts.push(`-${term.includes(" ") ? quoteForSearch(term) : term}`);
  }
  if (site) {
    parts.push(`site:${site}`);
  }

  return {
    query: parts.join(" "),
    baseQuery,
    exactPhrases,
    excludeTerms,
    site,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via DuckDuckGo. Build one search per call from a base query string, exact phrases, exclusions, and an optional site. Returns title, URL, and snippet.",
    promptSnippet:
      "Search the web via a query string plus optional exactPhrases, excludeTerms, and site. Use one tool call per search angle.",
    promptGuidelines: [
      "Use exactPhrases for exact phrase matching instead of embedding quote marks inside the main query string.",
      "Use one web_search tool call per search angle instead of batching multiple searches into one call.",
    ],

    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Base search query as a normal string. Prefer this for the main search wording.",
        }),
      ),
      exactPhrases: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Exact phrases to match. Each item becomes a quoted phrase in the final search query.",
        }),
      ),
      excludeTerms: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Terms or phrases to exclude. Multi-word items are excluded as exact phrases.",
        }),
      ),
      site: Type.Optional(
        Type.String({
          description:
            "Optional site/domain restriction, such as example.com or a full URL.",
        }),
      ),
      count: Type.Optional(
        Type.Number({
          description: "Number of results to return (default: 5, max: 10)",
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),

    async execute(_toolCallId, params: StructuredSearchArgs, signal) {
      const count = params.count ?? 5;
      const built = buildSearchQuery(params);
      const results = await duckduckgoSearch(built.query, count, signal);

      return {
        content: [
          {
            type: "text" as const,
            text: formatResults(results),
          },
        ],
        details: {
          composedQuery: built.query,
          query: built.baseQuery,
          exactPhrases: built.exactPhrases,
          excludeTerms: built.excludeTerms,
          site: built.site,
          resultCount: results.length,
        },
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const { count, ...searchArgs } = args as StructuredSearchArgs;

      try {
        const built = buildSearchQuery(searchArgs);
        const display =
          built.query.length > 70
            ? built.query.slice(0, 67) + "..."
            : built.query;
        const lines = [
          theme.fg("toolTitle", theme.bold("search ")) +
            theme.fg("accent", `"${display}"`),
        ];
        if (count && count !== 5) {
          lines.push(theme.fg("dim", `  count: ${count}`));
        }
        text.setText(lines.join("\n"));
        return text;
      } catch {
        text.setText(
          theme.fg("toolTitle", theme.bold("search ")) +
            theme.fg("error", "(invalid query)"),
        );
        return text;
      }
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      if (isPartial) {
        text.setText(theme.fg("warning", "Searching…"));
        return text;
      }

      if (context.isError) {
        const msg =
          result.content.find((c) => c.type === "text")?.text || "Error";
        text.setText(theme.fg("error", msg));
        return text;
      }

      const details = result.details as {
        composedQuery?: string;
        resultCount?: number;
      };
      const status = theme.fg(
        "success",
        `${details?.resultCount ?? 0} results`,
      );
      if (!expanded) {
        text.setText(status);
        return text;
      }

      const content = result.content.find((c) => c.type === "text")?.text || "";
      const preview =
        content.length > 500 ? content.slice(0, 500) + "..." : content;
      const queryLine = details?.composedQuery
        ? theme.fg("dim", `query: ${details.composedQuery}`)
        : "";
      text.setText(
        [status, queryLine, theme.fg("dim", preview)]
          .filter(Boolean)
          .join("\n"),
      );
      return text;
    },
  });
}
