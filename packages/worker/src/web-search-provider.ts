import { WEB_SEARCH_PROVIDERS } from "@lasercode/protocol";
import type { SearchJob } from "./web-search-execution.js";

/** Upstream's explicit-provider path throws raw errors, unlike its routing
 * path. Classify locally, but never return provider bodies, keys or headers. */
export function searchFailure(job: SearchJob, error: unknown): string {
  const label = job.authentication?.provider === "openai-codex" ? "OpenAI (Codex)" : WEB_SEARCH_PROVIDERS.find((p) => p.id === job.provider)!.name;
  const message = error instanceof Error ? error.message : "";
  const status = Number(message.match(/\b(?:error|status|http)\s+(\d{3})\b/i)?.[1]) || undefined;
  const prefix = `${label} search failed${status ? ` (HTTP ${status})` : ""}.`;
  const suffix = " No other provider was used.";
  let hint: string;
  if (/challenge|captcha|bot verification/i.test(message)) hint = "The provider requires browser verification. Wait before retrying or explicitly select another provider in Web search settings.";
  else if (status === 429 || status === 402 || /quota|rate.limit|too many requests|credits/i.test(message)) hint = "The provider's rate or usage limit was reached. Wait or check its allowance before retrying.";
  else if (status === 401 || /api.key.*(?:missing|not found)|authentication|credential/i.test(message)) hint = "Check or reconnect this provider in Web search settings.";
  else if (status === 403) hint = "The provider denied this search. Check search permissions or network restrictions; reconnecting may not help.";
  else if (/abort|timed? ?out|timeout/i.test(message)) hint = "The request timed out or was cancelled. Try again.";
  else if (status === 400 || status === 422 || /unsupported|not supported/i.test(message)) hint = "The provider rejected this search request or does not support web search with this connection.";
  else if (/no parseable|invalid.response|empty response|no web_search_call|no answer or sources/i.test(message)) hint = "The provider returned an unusable response. Retry later or explicitly select another provider in Web search settings.";
  else if (/fetch failed|network|econn|enotfound|socket/i.test(message)) hint = "Could not reach the provider. Check your network and retry.";
  else hint = "The provider could not complete the request. Try again.";
  return `${prefix} ${hint}${suffix}`;
}

export async function searchWithProvider(job: SearchJob): Promise<string> {
  const modulePath = "./web-search-upstream.js";
  const upstream = await import(modulePath) as { search(query: string, options: Record<string, unknown>): Promise<unknown> };
  const auth = job.authentication;
  const provider = auth?.provider ?? (job.provider === "kimi" ? "kimi-coding" : job.provider);
  const models = auth?.models ?? (job.provider === "kimi" ? [{ id: "kimi-for-coding", provider }] : []);
  const context = auth && models.length ? { model: models[0], modelRegistry: {
    getAll: () => models,
    find: (requested: string, id: string) => models.find((model) => model.provider === requested && model.id === id),
    getApiKeyAndHeaders: async (requested: { provider: string }) => requested.provider === provider
      ? { ok: true, apiKey: auth.apiKey, headers: auth.headers ?? {} } : { ok: false },
  } } : undefined;
  const response = await upstream.search(job.query, { ...job.options, provider: job.provider, ...(context ? { extensionContext: context } : {}) });
  if (!response || typeof response !== "object" || !("provider" in response) || response.provider !== job.provider) {
    throw new Error("Invalid response from selected search provider");
  }
  let result = JSON.stringify(response);
  for (const secret of [auth?.apiKey, ...Object.values(auth?.headers ?? {})]) {
    if (secret) result = result.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]").split(secret).join("[redacted]");
  }
  return result;
}
