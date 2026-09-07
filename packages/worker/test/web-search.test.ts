import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WEB_SEARCH_PROVIDER_IDS, WEB_SEARCH_PROVIDERS } from "@lasercode/protocol";
import { WebSearchService } from "../src/web-search.js";
// The production entrypoint and bundled upstream must work without a TS loader.
import { runWebSearch } from "../dist/web-search-execution.js";
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "search-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("web search connections", () => {
  it("includes every provider in the exact-pinned upstream registry", async () => {
    const source = await readFile(new URL("../node_modules/pi-web-access/gemini-search.ts", import.meta.url), "utf8");
    const values = JSON.parse(source.match(/RESOLVED_SEARCH_PROVIDERS = (\[[^;]+\]) as const/)![1]!);
    expect(WEB_SEARCH_PROVIDER_IDS).toEqual(values);
    const status = await new WebSearchService(directory).status();
    expect(status.selectedProvider).toBe("duckduckgo");
    expect(status.providers).toHaveLength(WEB_SEARCH_PROVIDERS.length);
    expect(status.providers.find((p) => p.id === "openai")).toMatchObject({ configured: false, source: "none" });
    expect(status.providers.find((p) => p.id === "anysearch")).toMatchObject({ configured: true });
  });
  it("keeps literal keys private and preserves unrelated concurrent connections", async () => {
    const one = new WebSearchService(directory), two = new WebSearchService(directory);
    const secret = "!do-not-execute-this-literal";
    await Promise.all([
      one.configure({ action: "configure", provider: "brave", connection: { source: "dedicated" }, apiKey: secret }),
      two.configure({ action: "configure", provider: "tavily", connection: { source: "dedicated" }, apiKey: "tavily-test-key" }),
    ]);
    const status = await one.status();
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(status.providers.filter((p) => p.hasKey).map((p) => p.id)).toEqual(["brave", "tavily"]);
    expect((await stat(join(directory, "search-connections.json"))).mode & 0o777).toBe(0o600);
    await two.configure({ action: "configure", provider: "brave", connection: { source: "none" } });
    expect((await one.status()).providers.find((p) => p.id === "brave")).toMatchObject({ hasKey: true, configured: false });
    await two.configure({ action: "configure", provider: "brave", connection: { source: "none" }, apiKey: null });
    expect(await readFile(join(directory, "search-connections.json"), "utf8")).not.toContain(secret);
  });
  it("does not grant search access merely because a model provider is connected", async () => {
    await writeFile(join(directory, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "shared-test-key" } }));
    const service = new WebSearchService(directory);
    expect((await service.status()).providers.find((p) => p.id === "openai")).toMatchObject({ source: "none", configured: false });
    await service.configure({ action: "configure", provider: "openai", connection: { source: "shared", sharedProvider: "openai" } });
    expect((await service.status()).providers.find((p) => p.id === "openai")).toMatchObject({ source: "shared", configured: true, hasKey: false });
    expect(await readFile(join(directory, "search-connections.json"), "utf8")).not.toContain("shared-test-key");
    await service.configure({ action: "configure", provider: "openai", connection: { source: "none" } });
    expect(await readFile(join(directory, "auth.json"), "utf8")).toContain("shared-test-key");
  });
  it("rejects incompatible sharing and credential-bearing endpoints", async () => {
    const service = new WebSearchService(directory);
    await expect(service.configure({ action: "configure", provider: "brave", connection: { source: "shared", sharedProvider: "openai" } })).rejects.toThrow(/cannot be used/);
    await expect(service.configure({ action: "configure", provider: "searxng", connection: { source: "none", baseUrl: "https://user:secret@example.com" } })).rejects.toThrow(/without credentials/);
    await expect(service.configure({ action: "configure", provider: "openai", connection: { source: "shared", sharedProvider: "openai" }, apiKey: "key" })).rejects.toThrow(/search-only/);
  });
});

describe("bundled search execution", () => {
  it("executes a real upstream SearXNG search with isolated credentials and preserves source links", async () => {
    const requests: URL[] = [];
    const server = createServer((req, res) => {
      requests.push(new URL(req.url!, "http://localhost"));
      expect(req.headers.authorization).toBeUndefined();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [{ title: "Documentation", url: "https://example.com/reference", content: "Verified source text" }] }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const result = await runWebSearch({ provider: "searxng", query: "package APIs", connection: { source: "none", baseUrl }, options: { numResults: 3, recencyFilter: "week" } });
      expect(result).toContain("https://example.com/reference");
      expect(result).toContain("Verified source text");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.searchParams.get("q")).toBe("package APIs");
      expect(requests[0]!.searchParams.get("format")).toBe("json");
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it("cancels an upstream request without leaving a search thread running", async () => {
    const server = createServer(() => {}).listen(0, "127.0.0.1");
    await once(server, "listening");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      await expect(runWebSearch({ provider: "searxng", query: "cancel", connection: { source: "none", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, options: {} }, controller.signal)).rejects.toThrow(/cancelled|abort/i);
    } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
});
