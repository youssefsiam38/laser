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
import { STORAGE_PREFIX } from "@lasercode/protocol";
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
      "previous.theme": '{"v":1}',
      "unrelated-key": "left alone",
    });
    const result = migrateStorageKeys(storage, OLD);
    expect(result.moved.sort()).toEqual(["previous-panels", "previous.theme"]);
    expect(storage.getItem(`${STORAGE_PREFIX}-panels`)).toBe("{}");
    expect(storage.getItem(`${STORAGE_PREFIX}.theme`)).toBe('{"v":1}');
    expect(storage.getItem("previous-panels")).toBeNull();
    expect(storage.getItem("unrelated-key")).toBe("left alone");
  });

  it("drops what it cannot prove belongs to this environment, instead of adopting it", () => {
    // A draft and a session path from before environments existed, and a
    // namespace from another one: none of them can be shown to belong to the
    // environment this build will connect to (RP-13), so a rename removes them
    // rather than handing them to whoever connects first.
    const storage = fakeStorage({
      "previous-draft:/a/b.jsonl": '{"text":"half a sentence"}',
      "previous-archived": '["/a/b.jsonl"]',
      "previous-projects": '["/work"]',
      "previous-env:e1.AAAAAAAAAAAAAAAAAAAAAA:archived": '["/a/b.jsonl"]',
      "previous-panels": "{}",
    });
    const result = migrateStorageKeys(storage, OLD);
    expect(result.moved).toEqual(["previous-panels"]);
    expect(result.dropped.sort()).toEqual([
      "previous-archived",
      "previous-draft:/a/b.jsonl",
      "previous-env:e1.AAAAAAAAAAAAAAAAAAAAAA:archived",
      "previous-projects",
    ]);
    for (const gone of ["previous-draft:/a/b.jsonl", "previous-archived", "previous-projects", "previous-env:e1.AAAAAAAAAAAAAAAAAAAAAA:archived"]) {
      expect(storage.getItem(gone), gone).toBeNull();
    }
    expect(storage.getItem(`${STORAGE_PREFIX}-draft:/a/b.jsonl`)).toBeNull();
    expect(storage.getItem(`${STORAGE_PREFIX}-archived`)).toBeNull();
    expect(storage.getItem(`${STORAGE_PREFIX}-panels`)).toBe("{}");
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
    expect(migrateStorageKeys(storage, [])).toEqual({ moved: [], kept: [], dropped: [], caches: [] });
    expect(storage.getItem(`${STORAGE_PREFIX}-panels`)).toBe("{}");
  });

  it("survives a Storage that throws on access, which is what a private window does", () => {
    const hostile = {
      get length(): number {
        throw new DOMException("denied");
      },
    } as unknown as Storage;
    expect(() => migrateStorageKeys(hostile, OLD)).not.toThrow();
    expect(migrateStorageKeys(null, OLD)).toEqual({ moved: [], kept: [], dropped: [], caches: [] });
  });
});
