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

  it("never reaches the in-memory store the tests use", () => {
    const offenders = files.filter((file) => /MemoryTailStore|memory-store/.test(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
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
});
