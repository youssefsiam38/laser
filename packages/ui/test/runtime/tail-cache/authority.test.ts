/**
 * One authority over what this device stores, proved from the source (RP-10).
 *
 * Two properties a unit test of behaviour cannot catch, because they are about
 * what *could* be written next:
 *
 * 1. Only the cache module opens a database. A second module with its own
 *    `indexedDB` call would be a second admission point for conversation
 *    content, and the environment policy would be enforced in one of them.
 * 2. No shipped file can reach the in-memory test store. Production stores
 *    durably or refuses; a fallback that evaporates on reload would make the
 *    settings screen's claim untrue.
 *
 * The same shape as `test/design-system.test.ts` and `test/preload.test.ts`:
 * read the tracked sources and assert on them.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../../../src", import.meta.url));

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) sources(full, found);
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const files = sources(SOURCE).map((path) => ({
  path: relative(SOURCE, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

describe("the device cache is the only thing that stores conversation content", () => {
  it("is the only module that touches a database", () => {
    const owners = files
      .filter((file) => /\bindexedDB\b/.test(file.text))
      .map((file) => file.path)
      .sort();
    expect(owners).toEqual(["identity/storage-migration.ts", "runtime/tail-cache/store.ts"]);
    // The migration only *deletes* a former name's database; it never opens one.
    const migration = files.find((file) => file.path === "identity/storage-migration.ts")!;
    expect(migration.text).toContain("deleteDatabase");
    expect(migration.text).not.toMatch(/indexedDB\.open|factory\.open/);
  });

  it("never reaches the ports the tests use, and takes no database dependency", () => {
    const offenders = files.filter((file) => /createTestStore|fake-indexeddb/.test(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
    // The milestone takes no new dependency: real IndexedDB semantics are
    // proved in browser acceptance, where there is a browser to prove them in.
    const manifest = readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8");
    expect(manifest).not.toContain("fake-indexeddb");
  });

  it("keeps no path, and nothing shaped like one, in what it stores", () => {
    const cache = files.filter((file) => file.path.startsWith("runtime/tail-cache/"));
    const row = files.find((file) => file.path === "runtime/tail-cache/store.ts")!;
    // The stored row's own declaration names no path field, and the store
    // indexes nothing: identity is the only way to a record.
    const declaration = /export interface TailRow \{([\s\S]*?)\n\}/.exec(row.text)?.[1] ?? "";
    expect(declaration).not.toMatch(/\bpath\b/);
    expect(row.text).not.toContain("createIndex");
    // And nothing under the cache reads a path off the released tail.
    for (const file of cache) {
      const code = file.text.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file.path).not.toMatch(/tail\.path|record\.path|row\.path/);
    }
  });

  it("never touches the draft key, so eviction cannot cost a person their draft", () => {
    const cache = files.filter((file) => file.path.startsWith("runtime/tail-cache/"));
    expect(cache.length).toBeGreaterThan(5);
    for (const file of cache) {
      // Comments may *mention* `localStorage` — the fail-closed rule is borrowed
      // from it — but no line of code may reach for it or for a draft.
      const code = file.text.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code).not.toMatch(/DEVICE_KEYS|localStorage|readDraft|writeDraft/);
    }
  });

  it("builds its database name from the product's own identity, never a literal", () => {
    const store = files.find((file) => file.path === "runtime/tail-cache/store.ts")!;
    expect(store.text).toContain('storageKey("tails")');
  });

  it("awaits the deletion at both places a conversation is deleted", () => {
    // A deletion that is not awaited is a deletion the caller cannot rely on,
    // and one keyed by a path would put a private locator in the cache. Both
    // call sites resolve the session's own opaque id from canonical state and
    // await the proof.
    const provider = files.find((file) => file.path === "runtime/LaserProvider.tsx")!;
    const calls = [...provider.text.matchAll(/tailCache\.forget\([^)]*\)/g)].map((match) => match[0]);
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toBe("tailCache.forget({ sessionId })");
    expect(provider.text.match(/await tailCache\.forget/g)?.length).toBe(2);
    expect(provider.text).not.toContain("tailCache.forget({ path");
  });
});
