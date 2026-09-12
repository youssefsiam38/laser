import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { transformWithEsbuild } from "vite";
import { laserPwa, shellAssetSets } from "../../src/pwa/vite-plugin.js";

const bundle = {
  "assets/entry-12345678.js": { type: "chunk" as const, isEntry: true, imports: ["assets/shared-12345678.js"] },
  "assets/shared-12345678.js": { type: "chunk" as const, imports: [] },
  "assets/optional-12345678.js": { type: "chunk" as const, imports: [] },
  "assets/style-12345678.css": { type: "asset" as const },
  "assets/font-12345678.woff2": { type: "asset" as const },
};
const ORIGIN = "https://app.example";
const absolute = (input: string | Request) => new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
class WorkerRequest extends Request {
  constructor(input: string | Request, init?: RequestInit) { super(absolute(input), init); }
}
class MemoryCache {
  readonly entries = new Map<string, Response>();
  constructor(private readonly network: (request: Request) => Promise<Response>) {}
  async match(input: string | Request, options?: { ignoreSearch?: boolean }) {
    const key = absolute(input);
    const match = this.entries.get(key) ?? (options?.ignoreSearch ? [...this.entries].find(([url]) => new URL(url).pathname === new URL(key).pathname)?.[1] : undefined);
    return match?.clone();
  }
  async put(input: string | Request, response: Response) { this.entries.set(absolute(input), response.clone()); }
  async add(request: Request) { const response = await this.network(request); if (!response.ok) throw new Error("download failed"); await this.put(request, response); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
}
async function harness() {
  let output = "";
  const generate = laserPwa().generateBundle as (this: { emitFile(asset: { source: string }): void }, options: unknown, bundle: unknown) => Promise<void>;
  await generate.call({ emitFile: asset => { output = asset.source; } }, {}, bundle);
  const { code } = await transformWithEsbuild(output, "sw.js", { loader: "js", format: "iife" });
  const network: string[] = [];
  const failures = new Set<string>();
  let offline = false;
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    network.push(path);
    if (offline || failures.has(path)) throw new Error("offline");
    return new Response(path);
  };
  const stores = new Map<string, MemoryCache>();
  const caches = {
    keys: async () => [...stores.keys()],
    open: async (name: string) => { let cache = stores.get(name); if (!cache) { cache = new MemoryCache(fetch); stores.set(name, cache); } return cache; },
    delete: async (name: string) => stores.delete(name),
  };
  const listeners = new Map<string, (event: unknown) => void>();
  runInNewContext(code, { URL, Request: WorkerRequest, Response, caches, fetch, self: { location: { origin: ORIGIN }, clients: { claim: async () => {} }, addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) } });
  const lifecycle = async (name: string) => {
    let pending: Promise<unknown> | undefined;
    listeners.get(name)!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  };
  const request = async (path: string, navigate = false): Promise<Response | undefined> => {
    let response: Promise<Response> | undefined;
    const req = new WorkerRequest(path);
    if (navigate) Object.defineProperty(req, "mode", { value: "navigate" });
    listeners.get("fetch")!({ request: req, respondWith: (promise: Promise<Response>) => { response = promise; } });
    return response;
  };
  return { network, failures, stores, caches, lifecycle, request, offline: () => { offline = true; } };
}
it("installs only static shell dependencies and caches optional modules on first use", async () => {
  const { precache, assets } = shellAssetSets(bundle);
  expect(precache).toContain("/assets/shared-12345678.js");
  expect(precache).not.toContain("/assets/optional-12345678.js");
  expect(assets).toContain("/assets/optional-12345678.js");
  const h = await harness();
  h.failures.add("/assets/optional-12345678.js");
  await h.lifecycle("install");
  expect(new Set(h.network)).toEqual(new Set(precache));
  await h.lifecycle("activate");
  h.failures.clear();
  expect(await (await h.request("/assets/optional-12345678.js"))?.text()).toBe("/assets/optional-12345678.js");
  h.offline();
  expect(await (await h.request("/assets/optional-12345678.js"))?.text()).toBe("/assets/optional-12345678.js");
  expect(await (await h.request("/conversation", true))?.text()).toBe("/index.html");
  for (const path of ["/ws", "/healthz", "/private.json", "https://other.example/assets/optional-12345678.js"]) expect(await h.request(path)).toBeUndefined();
});
it("reuses only current hashed assets from owned generations, preserving used optional views across activation", async () => {
  const h = await harness();
  // The current cache prefix comes from the generated product identity.
  await h.lifecycle("install");
  const current = [...h.stores.keys()][0]!;
  const previous = await h.caches.open(`${current}-old`);
  await previous.put("/assets/shared-12345678.js", new Response("shared cached"));
  await previous.put("/assets/optional-12345678.js", new Response("optional cached"));
  await previous.put("/index.html", new Response("stale shell"));
  await previous.put("/private.json", new Response("must not copy"));
  h.stores.delete(current); h.network.length = 0;
  await h.lifecycle("install");
  expect(h.network).not.toContain("/assets/shared-12345678.js");
  expect(h.network).not.toContain("/assets/optional-12345678.js");
  expect(h.network).toContain("/index.html");
  await h.lifecycle("activate");
  expect(h.stores.has(`${current}-old`)).toBe(false);
  h.offline();
  expect(await (await h.request("/assets/optional-12345678.js"))?.text()).toBe("optional cached");
  expect(await h.stores.get(current)!.match("/private.json")).toBeUndefined();
  expect(await (await h.request("/conversation", true))?.text()).toBe("/index.html");
});
