/**
 * Where the index lives (`docs/design-phase.md`, "Storage").
 *
 * - `<project>/<PROJECT_DIR_NAME>/design/index.json` — the index, DTCG tokens
 *   inline, committed with the repository so a team shares one truth.
 * - `<project>/<PROJECT_DIR_NAME>/design/review.json` — the decisions and who
 *   made them.
 * - Laser state, per project — parse caches keyed by source digest. Never
 *   required: delete the whole directory and the next build is slower and
 *   identical.
 *
 * Two rules are enforced here rather than trusted:
 *
 * 1. **Nothing absolute, nothing secret.** Every path written into the
 *    project's own directory is project-relative; a document carrying an
 *    absolute path, a home-relative path or a `file://` URL is refused before
 *    it is written, because that file is committed and shared.
 * 2. **Validated on the way out and on the way in.** The document is the
 *    protocol's `designIndexSchema`; a file that no longer matches is reported
 *    as unreadable rather than half-loaded.
 */
import { PROJECT_DIR_NAME, designIndexSchema, type DesignIndex } from "@lasercode/protocol";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DesignFact, Gap } from "./facts.js";
import { emptyReview, type ReviewDocument } from "./review.js";

export const DESIGN_DIR = "design";
export const INDEX_FILE = "index.json";
export const REVIEW_FILE = "review.json";

/** `<project>/<PROJECT_DIR_NAME>/design`. */
export function designDirectory(projectCwd: string): string {
  return join(resolve(projectCwd), PROJECT_DIR_NAME, DESIGN_DIR);
}

export function indexPath(projectCwd: string): string {
  return join(designDirectory(projectCwd), INDEX_FILE);
}

export function reviewPath(projectCwd: string): string {
  return join(designDirectory(projectCwd), REVIEW_FILE);
}

export class DesignStorageRefused extends Error {
  readonly code: string;
  readonly next: string;
  constructor(code: string, message: string, next: string) {
    super(message);
    this.name = "DesignStorageRefused";
    this.code = code;
    this.next = next;
  }
}

/**
 * A path that belongs to *this machine* rather than to the project: a home
 * directory, a system root, a Windows drive, a `file://` URL.
 *
 * Deliberately not "anything starting with a slash": a route is `/pricing`
 * and an excerpt of a template is full of `/` URLs, and refusing those would
 * make the check useless by being unusable.
 */
const MACHINE_PATH =
  /(?:file:\/\/[^"'\s]*|~\/[^"'\s]*|[A-Za-z]:\\{1,2}[^"'\s]*|\/(?:home|Users|var|tmp|opt|mnt|srv|private|root|Applications|System|Library|usr|etc)\/[^"'\s]*)/;

/**
 * The paths that would leak a person's machine into a shared file. Checked on
 * the whole serialized document, because a path can hide in an excerpt as
 * easily as in a `sources[].path`.
 */
export function absolutePathIn(json: string): string | undefined {
  for (const line of json.split("\n")) {
    const match = MACHINE_PATH.exec(line);
    if (match) return match[0].slice(0, 200);
  }
  return undefined;
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8" });
  renameSync(temporary, path);
}

/** Write the index into the project's own directory. Refuses a leaky document. */
export function writeIndex(projectCwd: string, index: DesignIndex): string {
  // Validated on the way out: what is written is exactly what the protocol
  // says an index is, with unknown fields refused rather than stored.
  const parsed = designIndexSchema.safeParse(index);
  if (!parsed.success) {
    throw new DesignStorageRefused(
      "invalid_index",
      `This index does not match the shape a stored index has (${parsed.error.issues[0]?.message ?? "unknown reason"}), so nothing was written.`,
      "build the index again; if it keeps failing, report the message above",
    );
  }
  const json = `${JSON.stringify(parsed.data as DesignIndex, null, 2)}\n`;
  const leak = absolutePathIn(json);
  if (leak !== undefined) {
    throw new DesignStorageRefused(
      "absolute_path",
      `The index carries a path from this machine (${leak}). It is committed with the repository, so nothing was written.`,
      "build the index again from the project directory so every source path is relative to it",
    );
  }
  const path = indexPath(projectCwd);
  writeAtomic(path, json);
  return path;
}

/** The stored index, or undefined when there is none. Never throws on absence. */
export function readIndex(projectCwd: string): DesignIndex | undefined {
  let text: string;
  try {
    text = readFileSync(indexPath(projectCwd), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DesignStorageRefused(
      "unreadable_index",
      "The design index file in this project is not valid JSON, so it was not loaded.",
      "re-index this project to write a fresh one",
    );
  }
  const validated = designIndexSchema.safeParse(parsed);
  if (!validated.success) {
    throw new DesignStorageRefused(
      "unreadable_index",
      `The design index file in this project does not match what this version reads (${validated.error.issues[0]?.message ?? "unknown reason"}).`,
      "re-index this project to write a fresh one",
    );
  }
  // Zod's inferred optionals are `T | undefined`; the protocol's own type is
  // the narrower one, and the parse has just proved the value matches it.
  return validated.data as DesignIndex;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The review document, or an empty one. A damaged file is never a lost review. */
export function readReview(projectCwd: string): ReviewDocument {
  let text: string;
  try {
    text = readFileSync(reviewPath(projectCwd), "utf8");
  } catch {
    return emptyReview();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed["version"] !== 1) throw new Error("version");
    const entries = isRecord(parsed["entries"]) ? (parsed["entries"] as ReviewDocument["entries"]) : {};
    const eras = isRecord(parsed["eras"]) ? (parsed["eras"] as ReviewDocument["eras"]) : {};
    return { version: 1, entries, eras };
  } catch {
    throw new DesignStorageRefused(
      "unreadable_review",
      "The design review file in this project could not be read, so no review decisions were applied.",
      "open the Design tab to review the index again, or restore the file from version control",
    );
  }
}

export function writeReview(projectCwd: string, document: ReviewDocument): string {
  const json = `${JSON.stringify(document, null, 2)}\n`;
  const leak = absolutePathIn(json);
  if (leak !== undefined) {
    throw new DesignStorageRefused(
      "absolute_path",
      `The review carries a path from this machine (${leak}). It is committed with the repository, so nothing was written.`,
      "review the entry again without a path in the note",
    );
  }
  const path = reviewPath(projectCwd);
  writeAtomic(path, json);
  return path;
}

// ------------------------------------------------------------- parse cache

/**
 * The parse cache: facts and gaps for one file, keyed by the file's content
 * digest and its path.
 *
 * Content alone is not the key: a fact carries the path it was read from, so
 * two identical files at two paths are two cache entries. Deleting the cache
 * is always safe.
 */
export interface CachedParse {
  facts: DesignFact[];
  gaps: Gap[];
}

export interface ParseCache {
  get(digest: string, path: string): CachedParse | undefined;
  set(digest: string, path: string, parse: CachedParse): void;
  /** How many entries were served from the cache in this build. */
  hits(): number;
  /** Persist whatever is worth keeping. Never throws. */
  flush(): void;
}

/** A cache that keeps nothing: the build is correct, just not incremental. */
export function noParseCache(): ParseCache {
  return { get: () => undefined, set: () => {}, hits: () => 0, flush: () => {} };
}

const CACHE_VERSION = 2;
const CACHE_MAX_ENTRIES = 20_000;

function cacheKey(digest: string, path: string): string {
  return `${digest}:${path}`;
}

/** `<stateDir>/design-index/<projectKey>.json`. */
export function cachePath(stateDir: string, projectKey: string): string {
  return join(resolve(stateDir), "design-index", `${projectKey.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
}

/**
 * A file-backed cache in Laser's own state directory — never in the project,
 * because it is a machine's convenience and not a team's truth.
 */
export function fileParseCache(stateDir: string, projectKey: string): ParseCache {
  const path = cachePath(stateDir, projectKey);
  const entries = new Map<string, CachedParse>();
  let hits = 0;
  let dirty = false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed) && parsed["version"] === CACHE_VERSION && isRecord(parsed["entries"])) {
      for (const [key, value] of Object.entries(parsed["entries"])) {
        if (!isRecord(value)) continue;
        const facts = Array.isArray(value["facts"]) ? (value["facts"] as DesignFact[]) : [];
        const gaps = Array.isArray(value["gaps"]) ? (value["gaps"] as Gap[]) : [];
        entries.set(key, { facts, gaps });
      }
    }
  } catch {
    // An absent, stale or damaged cache is simply an empty one.
  }
  return {
    get(digest, filePath) {
      const found = entries.get(cacheKey(digest, filePath));
      if (found) hits += 1;
      return found;
    },
    set(digest, filePath, parse) {
      entries.set(cacheKey(digest, filePath), parse);
      dirty = true;
    },
    hits: () => hits,
    flush() {
      if (!dirty) return;
      try {
        const kept = [...entries].slice(-CACHE_MAX_ENTRIES);
        writeAtomic(path, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(kept) }));
      } catch {
        // A cache that cannot be written costs a slower next build, nothing more.
      }
    },
  };
}

/** Remove a project's parse cache. Used by "re-index from scratch". */
export function clearParseCache(stateDir: string, projectKey: string): void {
  try {
    rmSync(cachePath(stateDir, projectKey), { force: true });
  } catch {
    // Nothing to remove is the same outcome.
  }
}

/** How much space the caches take, for the person's own accounting. */
export function parseCacheBytes(stateDir: string): number {
  const directory = join(resolve(stateDir), "design-index");
  try {
    return readdirSync(directory).reduce((total, name) => {
      try {
        return total + statSync(join(directory, name)).size;
      } catch {
        return total;
      }
    }, 0);
  } catch {
    return 0;
  }
}
