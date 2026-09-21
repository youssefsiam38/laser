/**
 * The per-project research cache (`docs/research-phase.md`, "Sources and
 * adapters": bodies are fetched once, digested, bounded and cached; the
 * transcript keeps the digest, not the bytes).
 *
 * One entry per source, keyed by the digest of its canonical id, holding the
 * readable text and the digest of the bytes it came from. It is
 * size-bounded and evictable — oldest fetch first — and the quota is the
 * host's number, not this module's (the host owns research cache quotas;
 * `docs/leap/m21-research-plan.md`).
 *
 * Nothing secret is written here: authenticated responses are never cached,
 * and an entry is text a public source served.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_CACHE_DEFAULT_MAX_BYTES } from "@lasercode/protocol";

export interface ResearchCacheEntry {
  /** The canonical source id: a normalised URL, a registry coordinate, a path. */
  id: string;
  /** sha256 of the bytes that were fetched. Identity for the excerpt check. */
  digest: string;
  /** The readable text a `read_source` serves ranges from. */
  text: string;
  /** Bytes of that text. */
  bytes: number;
  /** Epoch milliseconds of the fetch. Eviction order. */
  fetchedAt: number;
  title?: string;
  canonical?: string;
  contentType?: string;
  /** What the source declares about reuse, when it declares anything. */
  licence?: string;
  /** The date the source declares it was published. */
  publishedAt?: string;
}

export interface ResearchCache {
  get(id: string): ResearchCacheEntry | undefined;
  put(entry: Omit<ResearchCacheEntry, "bytes" | "fetchedAt"> & { fetchedAt?: number }): ResearchCacheEntry;
  has(id: string): boolean;
  /** Every entry, newest fetch first. */
  entries(): ResearchCacheEntry[];
  bytes(): number;
  /** Evict oldest-first until the cache is under `maxBytes`. Returns bytes freed. */
  evictTo(maxBytes?: number): number;
  clear(): void;
  readonly maxBytes: number;
}

export function cacheKey(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

export function digestOf(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes as never).digest("hex");
}

function entryBytes(entry: ResearchCacheEntry): number {
  return Buffer.byteLength(entry.text, "utf8");
}

/** A cache that lives for one process. Used by tests and by a run with no state dir. */
export function memoryResearchCache(maxBytes = RESEARCH_CACHE_DEFAULT_MAX_BYTES): ResearchCache {
  const store = new Map<string, ResearchCacheEntry>();
  const cache: ResearchCache = {
    maxBytes,
    get: (id) => store.get(cacheKey(id)),
    has: (id) => store.has(cacheKey(id)),
    put(input) {
      const entry: ResearchCacheEntry = { ...input, fetchedAt: input.fetchedAt ?? Date.now(), bytes: 0 };
      entry.bytes = entryBytes(entry);
      store.set(cacheKey(entry.id), entry);
      cache.evictTo(maxBytes);
      return entry;
    },
    entries: () => [...store.values()].sort((left, right) => right.fetchedAt - left.fetchedAt),
    bytes: () => [...store.values()].reduce((total, entry) => total + entry.bytes, 0),
    evictTo(limit = maxBytes) {
      let freed = 0;
      const oldestFirst = [...store.entries()].sort((left, right) => left[1].fetchedAt - right[1].fetchedAt);
      let total = cache.bytes();
      for (const [key, entry] of oldestFirst) {
        if (total <= limit) break;
        store.delete(key);
        total -= entry.bytes;
        freed += entry.bytes;
      }
      return freed;
    },
    clear: () => store.clear(),
  };
  return cache;
}

export interface FileResearchCacheOptions {
  /** Laser's own state directory. */
  stateDir: string;
  /** Stable key for this project inside it. */
  projectKey: string;
  /** The quota the host gives this project. */
  maxBytes?: number;
}

/**
 * The real cache: one JSON file per entry under
 * `<stateDir>/research/<projectKey>/`. A file that cannot be parsed is
 * ignored and replaced, never thrown at the person.
 */
export function fileResearchCache(options: FileResearchCacheOptions): ResearchCache {
  const maxBytes = options.maxBytes ?? RESEARCH_CACHE_DEFAULT_MAX_BYTES;
  const directory = join(options.stateDir, "research", options.projectKey);

  const ensure = (): void => {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  };
  const fileFor = (id: string): string => join(directory, `${cacheKey(id)}.json`);
  const readFile = (path: string): ResearchCacheEntry | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ResearchCacheEntry>;
      if (typeof parsed.id !== "string" || typeof parsed.text !== "string" || typeof parsed.digest !== "string") return undefined;
      return {
        id: parsed.id,
        digest: parsed.digest,
        text: parsed.text,
        bytes: typeof parsed.bytes === "number" ? parsed.bytes : Buffer.byteLength(parsed.text, "utf8"),
        fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : statSync(path).mtimeMs,
        ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
        ...(typeof parsed.canonical === "string" ? { canonical: parsed.canonical } : {}),
        ...(typeof parsed.contentType === "string" ? { contentType: parsed.contentType } : {}),
        ...(typeof parsed.licence === "string" ? { licence: parsed.licence } : {}),
        ...(typeof parsed.publishedAt === "string" ? { publishedAt: parsed.publishedAt } : {}),
      };
    } catch {
      return undefined;
    }
  };
  const all = (): Array<{ path: string; entry: ResearchCacheEntry }> => {
    if (!existsSync(directory)) return [];
    const rows: Array<{ path: string; entry: ResearchCacheEntry }> = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(directory, name);
      const entry = readFile(path);
      if (entry) rows.push({ path, entry });
    }
    return rows;
  };

  const cache: ResearchCache = {
    maxBytes,
    get(id) {
      const path = fileFor(id);
      return existsSync(path) ? readFile(path) : undefined;
    },
    has(id) {
      return existsSync(fileFor(id));
    },
    put(input) {
      ensure();
      const entry: ResearchCacheEntry = { ...input, fetchedAt: input.fetchedAt ?? Date.now(), bytes: 0 };
      entry.bytes = entryBytes(entry);
      writeFileSync(fileFor(entry.id), JSON.stringify(entry), { mode: 0o600 });
      cache.evictTo(maxBytes);
      return entry;
    },
    entries: () => all().map((row) => row.entry).sort((left, right) => right.fetchedAt - left.fetchedAt),
    bytes: () => all().reduce((total, row) => total + row.entry.bytes, 0),
    evictTo(limit = maxBytes) {
      const rows = all().sort((left, right) => left.entry.fetchedAt - right.entry.fetchedAt);
      let total = rows.reduce((sum, row) => sum + row.entry.bytes, 0);
      let freed = 0;
      for (const row of rows) {
        if (total <= limit) break;
        try {
          rmSync(row.path, { force: true });
        } catch {
          continue;
        }
        total -= row.entry.bytes;
        freed += row.entry.bytes;
      }
      return freed;
    },
    clear() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return cache;
}
