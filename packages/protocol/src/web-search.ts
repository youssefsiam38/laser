/** Search connection policy is separate from feature enablement. No secrets in status. */
export const WEB_SEARCH_PROVIDER_IDS = ["openai", "brave", "parallel", "parallel-mcp", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "firecrawl", "jina", "searxng", "duckduckgo", "perplexity", "gemini", "kimi", "exa", "serpdive", "kagi", "ollama", "anysearch", "xai", "mistral", "brightdata", "serpbase", "serper", "valyu", "bocha", "xcrawl"] as const;
export type WebSearchProviderId = typeof WEB_SEARCH_PROVIDER_IDS[number];
export interface WebSearchProvider {
  id: WebSearchProviderId;
  name: string;
  key: "required" | "optional" | "none";
  sharedProviders: string[];
  endpoint?: boolean;
  zone?: boolean;
  note?: string;
}
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = WEB_SEARCH_PROVIDER_IDS.map((id) => ({
  id,
  name: ({ openai: "OpenAI", brave: "Brave", parallel: "Parallel", "parallel-mcp": "Parallel MCP", tinyfish: "TinyFish", search1api: "Search1API", searchinfinity: "Searchinfinity", querit: "Querit", tavily: "Tavily", firecrawl: "Firecrawl", jina: "Jina", searxng: "SearXNG", duckduckgo: "DuckDuckGo", perplexity: "Perplexity", gemini: "Google Gemini", kimi: "Kimi", exa: "Exa", serpdive: "SerpDive", kagi: "Kagi", ollama: "Ollama", anysearch: "AnySearch", xai: "xAI", mistral: "Mistral", brightdata: "Bright Data", serpbase: "SerpBase", serper: "Serper", valyu: "Valyu", bocha: "Bocha", xcrawl: "XCrawl" })[id],
  key: (["parallel-mcp", "duckduckgo", "searxng"].includes(id) ? "none" : ["exa", "anysearch"].includes(id) ? "optional" : "required") as WebSearchProvider["key"],
  sharedProviders: ({ openai: ["openai", "openai-codex"], gemini: ["google"], kimi: ["kimi-coding"], xai: ["xai"], mistral: ["mistral"] } as Record<string, string[]>)[id] ?? [],
  ...(id === "searxng" ? { endpoint: true, note: "Your SearXNG instance must enable JSON search. Local network access is limited to the instance you configure." } : {}),
  ...(id === "brightdata" ? { zone: true, note: "Uses a SERP API zone in your Bright Data account." } : {}),
  ...(id === "kimi" ? { note: "Requires a Kimi Coding connection or Coding Plan key, not a Moonshot API key." } : {}),
  ...(id === "gemini" ? { note: "Uses the Gemini API. Browser cookies and automatic Google account discovery are not used." } : {}),
  ...(["exa", "anysearch", "parallel-mcp", "duckduckgo"].includes(id) ? { note: "Keyless access is subject to the provider's availability and rate limits." } : {}),
}));
export interface WebSearchConnection {
  source: "none" | "dedicated" | "shared";
  sharedProvider?: string;
  baseUrl?: string;
  zone?: string;
}
export interface WebSearchProviderStatus extends WebSearchConnection {
  id: WebSearchProviderId;
  configured: boolean;
  hasKey: boolean;
}
export interface WebSearchStatus {
  selectedProvider: WebSearchProviderId;
  providers: WebSearchProviderStatus[];
  sharedConnectionWarning?: string;
}
export type WebSearchChange =
  | { action: "select"; provider: WebSearchProviderId }
  | { action: "configure"; provider: WebSearchProviderId; connection: WebSearchConnection; apiKey?: string | null };

declare module "./messages.js" {
  interface ClientRequests {
    "web-search/status": { params: { cwd: string }; result: WebSearchStatus };
    "web-search/configure": { params: { cwd: string; change: WebSearchChange }; result: WebSearchStatus };
  }
}
