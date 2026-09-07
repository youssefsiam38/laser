import { parentPort, workerData } from "node:worker_threads";
import type { SearchJob } from "./web-search-execution.js";

const job = workerData as SearchJob;
// Built from the exact pinned upstream API. It intentionally has no public
// package entrypoint, so build-search.mjs compiles its search module separately.
const modulePath = "./web-search-upstream.js";
const upstream = await import(modulePath) as { search(query: string, options: Record<string, unknown>): Promise<unknown> };
const auth = job.authentication;
const provider = auth?.provider ?? (job.provider === "kimi" ? "kimi-coding" : job.provider);
const models = auth?.models ?? (job.provider === "kimi" ? [{ id: "kimi-for-coding", provider }] : []);
// A narrow compatibility adapter for upstream's documented legacy ModelRegistry
// reads. It can resolve ONLY the one credential the person granted for this job.
const context = auth && models.length ? { model: models[0], modelRegistry: {
  getAll: () => models,
  find: (requested: string, id: string) => models.find((model) => model.provider === requested && model.id === id),
  getApiKeyAndHeaders: async (requested: { provider: string }) => requested.provider === provider
    ? { ok: true, apiKey: auth.apiKey, headers: auth.headers ?? {} }
    : { ok: false },
} } : undefined;
try {
  const response = await upstream.search(job.query, { ...job.options, provider: job.provider, ...(context ? { extensionContext: context } : {}) });
  let result = JSON.stringify(response);
  for (const secret of [auth?.apiKey, ...Object.values(auth?.headers ?? {})]) {
    if (secret) result = result.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]").split(secret).join("[redacted]");
  }
  parentPort!.postMessage(result.length <= 262144 ? { result } : { error: "Web search returned too much content. Try a narrower query." });
} catch (error) {
  const kind = error && typeof error === "object" && "kind" in error ? error.kind : undefined;
  const hint = kind === "auth" || kind === "credential" ? "Check the selected connection in Web search settings."
    : kind === "quota" ? "Check your provider's allowance or choose another provider."
      : "Try again, or check the selected connection in Web search settings.";
  parentPort!.postMessage({ error: `Web search failed. ${hint}` });
}
