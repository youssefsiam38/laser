import { Worker } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import type { WebSearchConnection, WebSearchProviderId } from "@lasercode/protocol";

export interface SearchAuthentication {
  apiKey: string;
  provider?: string;
  headers?: Record<string, string | null>;
  models?: Array<{ id: string; provider: string; api: string; baseUrl: string }>;
}
export interface SearchJob {
  provider: WebSearchProviderId;
  query: string;
  connection: WebSearchConnection;
  authentication?: SearchAuthentication | undefined;
  options: { numResults?: number; recencyFilter?: string; domainFilter?: string[] };
}
export const SEARCH_KEY_ENV: Partial<Record<WebSearchProviderId, string>> = {
  openai: "OPENAI_API_KEY", brave: "BRAVE_API_KEY", parallel: "PARALLEL_API_KEY", tinyfish: "TINYFISH_API_KEY", search1api: "SEARCH1API_KEY", searchinfinity: "SEARCHINFINITY_API_KEY", querit: "QUERIT_API_KEY", tavily: "TAVILY_API_KEY", firecrawl: "FIRECRAWL_API_KEY", jina: "JINA_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY", exa: "EXA_API_KEY", serpdive: "SERPDIVE_API_KEY", kagi: "KAGI_API_KEY", ollama: "OLLAMA_API_KEY", anysearch: "ANYSEARCH_API_KEY", xai: "XAI_API_KEY", mistral: "MISTRAL_API_KEY", brightdata: "BRIGHTDATA_API_KEY", serpbase: "SERPBASE_API_KEY", serper: "SERPER_API_KEY", valyu: "VALYU_API_KEY", bocha: "BOCHA_API_KEY", xcrawl: "XCRAWL_API_KEY",
};
let activeSearches = 0;

/** Fresh module caches + private env prevent ambient credentials and fallback.
 * Only non-secret endpoint configuration touches the temporary directory.
 * A thread (not another session worker) can be terminated even if upstream hangs.
 */
export async function runWebSearch(job: SearchJob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (activeSearches >= 4) throw new Error("Four searches are already running. Wait for one to finish, then retry.");
  activeSearches++;
  try { return await execute(job, signal); }
  finally { activeSearches--; }
}

async function execute(job: SearchJob, signal?: AbortSignal): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "web-search-"));
  let worker: Worker | undefined;
  try {
    const config: Record<string, unknown> = { searchProvider: job.provider, geminiWeb: { enabled: false }, autoOpenBrowser: false };
    if (job.connection.baseUrl) {
      config.searxngBaseUrl = job.connection.baseUrl;
      // Explicitly configured self-hosted instance, not a blanket private-net
      // exception. Upstream still validates redirects and DNS on each fetch.
      const addresses = await cancellableLookup(new URL(job.connection.baseUrl).hostname.replace(/^\[|\]$/g, ""), signal);
      config.ssrf = { allowRanges: addresses.map(({ address, family }) => `${address}/${family === 6 ? 128 : 32}`) };
    }
    if (job.connection.zone) config.brightdataSerpZone = job.connection.zone;
    await writeFile(join(directory, "web-search.json"), JSON.stringify(config), { mode: 0o600 });
    const environment: Record<string, string> = { HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: directory, PATH: "" };
    // Honor system certificate configuration, never provider/proxy credentials.
    for (const name of ["SYSTEMROOT", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
      if (process.env[name]) environment[name] = process.env[name]!;
    }
    const keyEnv = SEARCH_KEY_ENV[job.provider];
    if (keyEnv && job.authentication) environment[keyEnv] = job.authentication.apiKey;
    signal?.throwIfAborted();
    worker = new Worker(new URL("./web-search-runner.js", import.meta.url), { workerData: job, env: environment, stdout: true, stderr: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    // Do not forward upstream console output: errors can contain provider bodies.
    worker.stdout?.resume(); worker.stderr?.resume();
    return await new Promise<string>((resolve, reject) => {
      const abort = () => finish(new Error("Web search was cancelled."));
      const timeout = setTimeout(() => finish(new Error("Web search timed out. Try again or choose another provider.")), 90_000);
      let settled = false;
      const finish = (error?: Error, result?: string) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result!);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker!.once("message", (message: { result?: string; error?: string }) => {
        if (typeof message.result === "string" && message.result.length <= 262144) finish(undefined, message.result);
        else finish(new Error(message.error ?? "Web search returned too much content. Try a narrower query."));
      });
      worker!.once("error", () => finish(new Error("Web search could not start. Retry or update the app.")));
      worker!.once("exit", () => finish(new Error("Web search stopped before returning results. Try again.")));
    });
  } finally {
    await worker?.terminate();
    await rm(directory, { recursive: true, force: true });
  }
}

async function cancellableLookup(hostname: string, signal?: AbortSignal) {
  const deadline = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error(signal?.aborted ? "Web search was cancelled." : "Could not reach your search instance. Check its address and try again."));
        deadline.addEventListener("abort", abort, { once: true });
        if (deadline.aborted) abort();
      }),
    ]);
  } finally { if (abort) deadline.removeEventListener("abort", abort); }
}
