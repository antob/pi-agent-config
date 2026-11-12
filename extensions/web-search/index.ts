import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

// wreq-js impersonates the browser TLS/HTTP2 fingerprint and sends that
// browser's own headers, so no User-Agent or Accept headers are set here.
const BROWSER = "chrome";
const BROWSER_OS = "windows";

const CATEGORIES = ["general", "it", "packages", "news"] as const;
const TIME_RANGES = ["day", "week", "month", "year"] as const;
type Category = (typeof CATEGORIES)[number];
type TimeRange = (typeof TIME_RANGES)[number];

const DEFAULT_SEARXNG_URL = "https://search.antob.net";
const SEARXNG_TIMEOUT_MS = 10_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchOutcome {
  backend: "searxng" | "duckduckgo";
  results: SearchResult[];
  infobox?: string;
  answers: string[];
  unresponsive: string[];
  notes: string[];
}

interface StructuredSearchArgs {
  query?: string;
  exactPhrases?: string[];
  excludeTerms?: string[];
  site?: string;
  count?: number;
  category?: Category;
  timeRange?: TimeRange;
  page?: number;
}

interface BuiltSearchQuery {
  query: string;
  baseQuery?: string;
  exactPhrases: string[];
  excludeTerms: string[];
  site?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// Single pass, so "&amp;lt;" decodes to "&lt;" and not "<".
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, dec, hex, name) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
      const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    },
  );
}

async function duckduckgoSearch(
  query: string,
  count: number,
  signal?: AbortSignal,
  timeRange?: TimeRange,
): Promise<SearchResult[]> {
  const num = Math.min(count, 10);
  const df = timeRange ? { day: "d", week: "w", month: "m", year: "y" }[timeRange] : "";
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${df ? `&df=${df}` : ""}`;

  // Loaded lazily so a missing native binding only breaks the fallback.
  const { fetch: wreqFetch } = await import("wreq-js");
  const resp = await wreqFetch(url, {
    signal,
    browser: BROWSER,
    os: BROWSER_OS,
  });
  if (!resp.ok) {
    throw new Error(`DuckDuckGo ${resp.status}: ${resp.statusText}`);
  }

  const html = await resp.text();

  // The bot check answers 202 or a challenge page, applied to the whole IP.
  if (
    resp.status === 202 ||
    html.includes("anomaly-modal") ||
    html.includes("challenge-form")
  ) {
    throw new Error(
      "DuckDuckGo bot check (rate limited). It applies to this IP for roughly 10 to 30 minutes. Wait, reduce the number of searches, or use web_fetch on a known URL instead.",
    );
  }

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
    const title = decodeEntities(m[2].replace(/<[^>]*>/g, "")).trim();
    const snippet = decodeEntities(m[3].replace(/<[^>]*>/g, "")).trim();
    results.push({ title, url, snippet });
  }

  if (results.length === 0 && !html.includes("no-results")) {
    throw new Error(
      "DuckDuckGo returned a page with no parseable results (markup may have changed or the request was blocked).",
    );
  }

  return results;
}

function searxngBaseUrl(): string {
  const raw = process.env.SEARXNG_URL?.trim() || DEFAULT_SEARXNG_URL;
  return raw.replace(/\/+$/, "");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code || cause?.message;
    return detail ? `${err.message} (${detail})` : err.message;
  }
  return String(err);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

async function searxngSearch(
  query: string,
  args: { count: number; category: Category; timeRange?: TimeRange; page?: number },
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const base = searxngBaseUrl();
  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: args.category,
  });
  if (args.timeRange) params.set("time_range", args.timeRange);
  if (args.page && args.page > 1) params.set("pageno", String(args.page));

  const timeout = AbortSignal.timeout(SEARXNG_TIMEOUT_MS);
  const resp = await fetch(`${base}/search?${params}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`SearXNG ${resp.status}: ${resp.statusText}`);
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new Error("SearXNG returned a non-JSON response");
  }

  const unresponsive: string[] = Array.isArray(data.unresponsive_engines)
    ? data.unresponsive_engines.map((e: unknown) =>
        Array.isArray(e) ? `${e[0]} (${e[1]})` : String(e),
      )
    : [];

  const results: SearchResult[] = (Array.isArray(data.results) ? data.results : [])
    .filter((r: any) => r?.url)
    .slice(0, Math.min(args.count, 10))
    .map((r: any) => {
      const date = r.publishedDate ? ` [${String(r.publishedDate).slice(0, 10)}]` : "";
      return {
        title: String(r.title ?? r.url).trim() + date,
        url: String(r.url),
        snippet: String(r.content ?? "").replace(/\s+/g, " ").trim(),
      };
    });

  if (results.length === 0 && unresponsive.length > 0) {
    throw new Error(`SearXNG returned no results; unresponsive engines: ${unresponsive.join(", ")}`);
  }

  let infobox: string | undefined;
  const ib = Array.isArray(data.infoboxes) ? data.infoboxes[0] : undefined;
  if (ib) {
    const link = Array.isArray(ib.urls) ? ib.urls.find((u: any) => u?.url)?.url : ib.id;
    infobox = [
      `${ib.infobox ?? "Infobox"}: ${truncate(String(ib.content ?? ""), 600)}`,
      typeof link === "string" && /^https?:/.test(link) ? link : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const answers: string[] = (Array.isArray(data.answers) ? data.answers : [])
    .map((a: any) => (typeof a === "string" ? a : a?.answer))
    .filter((a: unknown): a is string => typeof a === "string" && a.length > 0)
    .map((a: string) => truncate(a, 300))
    .filter((a: string) => !infobox || !infobox.includes(a.slice(0, 60)));

  return { backend: "searxng", results, infobox, answers, unresponsive, notes: [] };
}

// Bangs only mean something to SearXNG; DuckDuckGo would redirect on them.
function stripBangs(query: string): string {
  return query.replace(/(^|\s)![a-z0-9]+(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
}

async function runSearch(
  built: BuiltSearchQuery,
  args: { count: number; category: Category; timeRange?: TimeRange; page?: number },
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  try {
    return await searxngSearch(built.query, args, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    const reason = err instanceof Error && err.name === "TimeoutError"
      ? `timed out after ${SEARXNG_TIMEOUT_MS / 1000}s`
      : errorMessage(err);

    const ddgQuery = stripBangs(built.query);
    const ignored: string[] = [];
    if (args.category !== "general") ignored.push(`category=${args.category}`);
    if (args.page && args.page > 1) ignored.push(`page=${args.page}`);
    if (ddgQuery !== built.query) ignored.push("bangs");

    const notes = [`SearXNG at ${searxngBaseUrl()} failed: ${reason}.`];
    if (ignored.length) notes.push(`Ignored by the fallback: ${ignored.join(", ")}.`);

    let results: SearchResult[];
    try {
      results = await duckduckgoSearch(ddgQuery, args.count, signal, args.timeRange);
    } catch (ddgErr) {
      throw new Error(`${notes[0]} DuckDuckGo fallback also failed: ${errorMessage(ddgErr)}`);
    }
    return { backend: "duckduckgo", results, answers: [], unresponsive: [], notes };
  }
}

function formatOutcome(o: SearchOutcome, category: Category): string {
  const backend =
    o.backend === "searxng"
      ? `Backend: SearXNG (${searxngBaseUrl()}), category: ${category}`
      : "Backend: DuckDuckGo (fallback)";
  const out: string[] = [backend];
  for (const n of o.notes) out.push(`Note: ${n}`);
  if (o.unresponsive.length) {
    out.push(`Note: partial coverage, unresponsive engines: ${o.unresponsive.join(", ")}.`);
  }
  if (o.infobox) out.push(`Infobox\n${o.infobox}`);
  for (const a of o.answers) out.push(`Answer: ${a}`);
  out.push(
    o.results.length === 0
      ? "No results found."
      : o.results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n"),
  );
  return out.join("\n\n");
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
      "Search the web via a private SearXNG instance (falls back to DuckDuckGo scraping if it is unreachable). Build one search per call from a base query string, exact phrases, exclusions, and an optional site. Pick a category: general (default web search), it (Stack Overflow, NixOS Wiki, GitHub, Hacker News, MDN), packages (npm, crates.io, RubyGems, Docker Hub; name lookups only), news (recent events). Returns an optional infobox, then numbered title, URL, and snippet, plus which backend answered and any unresponsive engines.",
    promptSnippet:
      "Search the web via a query string plus optional exactPhrases, excludeTerms, site, category (general, it, packages, news), timeRange, and page. Use one tool call per search angle.",
    promptGuidelines: [
      "Use exactPhrases for exact phrase matching instead of embedding quote marks inside the main query string.",
      "Use one web_search tool call per search angle instead of batching multiple searches into one call.",
      "Use category 'it' for programming questions, docs, repos and Nix topics, 'packages' to find a package by name (not for concepts), 'news' with timeRange for recent events, and 'general' otherwise.",
      "A bang at the start of the query targets one engine regardless of category: !st (Stack Overflow), !nixw (NixOS Wiki), !gh (GitHub), !hn (Hacker News), !mdn, !npm, !crates, !rbg (RubyGems), !dh (Docker Hub), !wp (Wikipedia), !br (Brave), !bi (Bing), !ddg.",
      "Google, PyPI and the Arch Wiki are not search engines here. For them use category 'general' with site, e.g. site 'wiki.archlinux.org' or 'pypi.org'.",
      "If the output notes unresponsive engines or a DuckDuckGo fallback, coverage is partial. Retry with a different angle or use web_fetch on a known URL.",
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
      category: Type.Optional(
        Type.Union(
          CATEGORIES.map((c) => Type.Literal(c)),
          {
            description:
              "Search category (default: general). it: programming docs, Q&A, repos. packages: find a package by name on npm, crates.io, RubyGems, Docker Hub. news: recent events.",
          },
        ),
      ),
      timeRange: Type.Optional(
        Type.Union(
          TIME_RANGES.map((t) => Type.Literal(t)),
          { description: "Only return results from the last day, week, month, or year." },
        ),
      ),
      page: Type.Optional(
        Type.Number({
          description: "Result page, 1-based (default: 1). SearXNG only.",
          minimum: 1,
        }),
      ),
    }),

    async execute(_toolCallId, params: StructuredSearchArgs, signal) {
      const count = params.count ?? 5;
      const category: Category = CATEGORIES.includes(params.category as Category)
        ? (params.category as Category)
        : "general";
      const built = buildSearchQuery(params);
      const outcome = await runSearch(
        built,
        { count, category, timeRange: params.timeRange, page: params.page },
        signal,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: formatOutcome(outcome, category),
          },
        ],
        details: {
          backend: outcome.backend,
          category,
          timeRange: params.timeRange,
          page: params.page,
          composedQuery: built.query,
          query: built.baseQuery,
          exactPhrases: built.exactPhrases,
          excludeTerms: built.excludeTerms,
          site: built.site,
          resultCount: outcome.results.length,
          unresponsiveEngines: outcome.unresponsive,
        },
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const { count, category, timeRange, page, ...searchArgs } =
        args as StructuredSearchArgs;

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
        const opts = [
          category && category !== "general" ? `category: ${category}` : "",
          timeRange ? `time: ${timeRange}` : "",
          page && page > 1 ? `page: ${page}` : "",
          count && count !== 5 ? `count: ${count}` : "",
        ].filter(Boolean);
        if (opts.length) lines.push(theme.fg("dim", `  ${opts.join(", ")}`));
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
        backend?: string;
        unresponsiveEngines?: string[];
      };
      const fellBack = details?.backend === "duckduckgo";
      const partial = details?.unresponsiveEngines?.length;
      const status =
        theme.fg("success", `${details?.resultCount ?? 0} results`) +
        theme.fg(
          fellBack || partial ? "warning" : "dim",
          ` via ${fellBack ? "DuckDuckGo (fallback)" : "SearXNG"}${partial ? `, ${partial} engine(s) down` : ""}`,
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
