/**
 * A rename must not look like the app forgetting you (MX-T7, D-36).
 *
 * The rules with judgement in them: never overwrite what the current name
 * already has, never lose a value, and never throw — `localStorage` can throw
 * on *access* in a private window, and a boot step that cannot run must not
 * stop the app from opening.
 *
 * The former list is passed in rather than read from `FORMER_NAMES`, so these
 * still test the move on the day the product has no former names (today) and on
 * the day it has three.
 */
import { describe, expect, it } from "vitest";
import { STORAGE_PREFIX } from "@piorbit/protocol";
import { migrateStorageKeys } from "../../src/identity/storage-migration.js";

const OLD = [{ storagePrefix: "previous" }];

/** The smallest thing that satisfies `Storage`, backed by a Map. */
function fakeStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage;
}

describe("browser storage across a rename", () => {
  it("moves every key onto the current prefix, hyphenated and dotted alike", () => {
    const storage = fakeStorage({
      "previous-panels": "{}",
      "previous-draft:/a/b.jsonl": '{"text":"half a sentence"}',
      "previous.theme": '{"v":1}',
      "unrelated-key": "left alone",
    });
    const result = migrateStorageKeys(storage, OLD);
    expect(result.moved.sort()).toEqual(["previous-draft:/a/b.jsonl", "previous-panels", "previous.theme"]);
    expect(storage.getItem(`${STORAGE_PREFIX}-panels`)).toBe("{}");
    expect(storage.getItem(`${STORAGE_PREFIX}-draft:/a/b.jsonl`)).toBe('{"text":"half a sentence"}');
    expect(storage.getItem(`${STORAGE_PREFIX}.theme`)).toBe('{"v":1}');
    expect(storage.getItem("previous-panels")).toBeNull();
    expect(storage.getItem("unrelated-key")).toBe("left alone");
  });

  it("never overwrites what the current name already has", () => {
    const storage = fakeStorage({ "previous-panels": "old", [`${STORAGE_PREFIX}-panels`]: "current" });
    const result = migrateStorageKeys(storage, OLD);
    expect(result.moved).toEqual([]);
    expect(result.kept).toEqual(["previous-panels"]);
    expect(storage.getItem(`${STORAGE_PREFIX}-panels`)).toBe("current");
    expect(storage.getItem("previous-panels")).toBe("old");
  });

  it("does nothing at all with no former names, which is the usual case", () => {
    const storage = fakeStorage({ [`${STORAGE_PREFIX}-panels`]: "{}" });
    expect(migrateStorageKeys(storage, [])).toEqual({ moved: [], kept: [], caches: [] });
    expect(storage.getItem(`${STORAGE_PREFIX}-panels`)).toBe("{}");
  });

  it("survives a Storage that throws on access, which is what a private window does", () => {
    const hostile = {
      get length(): number {
        throw new DOMException("denied");
      },
    } as unknown as Storage;
    expect(() => migrateStorageKeys(hostile, OLD)).not.toThrow();
    expect(migrateStorageKeys(null, OLD)).toEqual({ moved: [], kept: [], caches: [] });
  });
});
