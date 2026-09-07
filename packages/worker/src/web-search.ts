import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { WEB_SEARCH_PROVIDERS, type WebSearchChange, type WebSearchConnection, type WebSearchProviderId, type WebSearchStatus } from "@lasercode/protocol";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rename, chmod, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { runWebSearch, type SearchAuthentication } from "./web-search-execution.js";

interface SearchSettings {
  selectedProvider: WebSearchProviderId;
  connections: Partial<Record<WebSearchProviderId, WebSearchConnection>>;
  keys: Partial<Record<WebSearchProviderId, string>>;
}
const empty = (): SearchSettings => ({ selectedProvider: "duckduckgo", connections: {}, keys: {} });
const decode = (raw: string | undefined): SearchSettings => ({ ...empty(), ...(raw ? JSON.parse(raw) as Partial<SearchSettings> : {}) });
const definition = (id: WebSearchProviderId) => {
  const provider = WEB_SEARCH_PROVIDERS.find((entry) => entry.id === id);
  if (!provider) throw new Error("Choose a supported web search provider.");
  return provider;
};

/** Locked storage is shared by project workers; keys never enter preferences. */
export class WebSearchService {
  private readonly path: string;
  constructor(private readonly agentDir = getAgentDir()) {
    this.path = join(agentDir, "search-connections.json");
  }
  private async readSettings(): Promise<SearchSettings> {
    try { return decode(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw new Error("Could not read search connections. Check access to app data and retry."); }
  }
  private async updateSettings(update: (settings: SearchSettings) => void) {
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    // Lock the stable path, not the inode replaced by the atomic write.
    const release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const settings = await this.readSettings();
      update(settings);
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally { await unlink(temporary).catch(() => {}); await release(); }
  }
  private async models() {
    return ModelRuntime.create({ authPath: join(this.agentDir, "auth.json"), modelsPath: join(this.agentDir, "models.json"), allowModelNetwork: false });
  }
  async status(): Promise<WebSearchStatus> {
    const settings = await this.readSettings();
    const runtime = await this.models().catch(() => undefined);
    return {
      selectedProvider: settings.selectedProvider,
      ...(!runtime ? { sharedConnectionWarning: "Model connections could not be read. Check Models and dictation; search-only connections are still available." } : {}),
      providers: WEB_SEARCH_PROVIDERS.map((provider) => {
        const connection = settings.connections[provider.id] ?? { source: "none" as const };
        const hasKey = !!settings.keys[provider.id];
        const configured = connection.source === "shared"
          ? !!connection.sharedProvider && provider.sharedProviders.includes(connection.sharedProvider) && !!runtime?.getProviderAuthStatus(connection.sharedProvider).configured
          : connection.source === "dedicated" ? hasKey
            : provider.key !== "required";
        return { id: provider.id, ...connection, hasKey, configured: configured && (!provider.endpoint || !!connection.baseUrl) && (!provider.zone || !!connection.zone) };
      }),
    };
  }
  async configure(change: WebSearchChange): Promise<WebSearchStatus> {
    const provider = definition(change.provider);
    if (change.action === "configure") {
      const { connection, apiKey } = change;
      if (connection.source === "shared" && (!connection.sharedProvider || !provider.sharedProviders.includes(connection.sharedProvider))) {
        throw new Error("This model connection cannot be used by that search provider.");
      }
      if (connection.source !== "shared" && connection.sharedProvider) throw new Error("Grant shared connection permission before choosing a model connection.");
      if (apiKey && connection.source !== "dedicated") throw new Error("Choose a search-only connection before saving a key.");
      if (connection.baseUrl) {
        let url: URL;
        try { url = new URL(connection.baseUrl); } catch { throw new Error("Enter a complete SearXNG address."); }
        if (!provider.endpoint || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error("Use an HTTP(S) SearXNG address without credentials, query parameters or a fragment.");
        }
      }
      if (connection.zone && (!provider.zone || !/^[a-zA-Z0-9_-]+$/.test(connection.zone))) throw new Error("Enter the SERP zone name using letters, digits, underscores or hyphens.");
      if (apiKey && (!apiKey.trim() || /[\x00-\x1f\x7f]/.test(apiKey) || apiKey.length > 16384)) throw new Error("Enter a valid API key.");
    }
    await this.updateSettings((settings) => {
      if (change.action === "select") settings.selectedProvider = change.provider;
      else {
        settings.connections[change.provider] = change.connection;
        if (change.apiKey === null) delete settings.keys[change.provider];
        else if (change.apiKey !== undefined) settings.keys[change.provider] = change.apiKey.trim();
      }
    });
    return this.status();
  }
  async search(query: string, signal?: AbortSignal, options: { numResults?: number; recencyFilter?: "day" | "week" | "month" | "year"; domainFilter?: string[] } = {}) {
    signal?.throwIfAborted();
    const settings = await this.readSettings();
    const provider = definition(settings.selectedProvider);
    const connection = settings.connections[provider.id] ?? { source: "none" };
    let authentication: SearchAuthentication | undefined;
    if (connection.source === "shared") {
      if (!connection.sharedProvider || !provider.sharedProviders.includes(connection.sharedProvider)) throw new Error("Allow a compatible model connection in Web search settings.");
      const runtime = await this.models();
      const models = runtime.getModels(connection.sharedProvider);
      const resolved = await runtime.getAuth(connection.sharedProvider, { ...(signal ? { signal } : {}) }).catch(() => undefined);
      if (!resolved?.auth.apiKey) throw new Error("Reconnect the selected provider in Providers and models, then try again.");
      authentication = { apiKey: resolved.auth.apiKey, headers: resolved.auth.headers ?? {}, provider: connection.sharedProvider, models: models.map(({ id, provider, api, baseUrl }) => ({ id, provider, api, baseUrl })) };
    } else if (connection.source === "dedicated") {
      const key = settings.keys[provider.id];
      if (key) authentication = { apiKey: key };
    }
    if (provider.key === "required" && !authentication) throw new Error(`Connect ${provider.name} in Settings → Providers and models → Web search.`);
    if (provider.endpoint && !connection.baseUrl) throw new Error("Add your SearXNG instance address in Web search settings.");
    if (provider.zone && !connection.zone) throw new Error("Add your Bright Data SERP zone in Web search settings.");
    return runWebSearch({ provider: provider.id, query, connection, authentication, options }, signal);
  }
}
