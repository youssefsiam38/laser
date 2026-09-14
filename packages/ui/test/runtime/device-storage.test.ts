/**
 * The device storage authority (RP-13, M18-T13 B).
 *
 * The questions here are the ones that decide whether a laptop that talks to
 * two environments can leak one into the other: is anything readable before
 * the environment is known, does the namespace really separate them, is a
 * purge that could not finish allowed to open the door anyway, and does the
 * environment's cache policy actually stop content from being written.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CACHE_POLICY, storageKey } from "@lasercode/protocol";

import {
  DEVICE_KEYS,
  MAX_SCANNED_KEYS,
  createDeviceStore,
  isLegacyDeviceKey,
  namespaceOf,
} from "../../src/runtime/device-storage.js";
import { OTHER_ENVIRONMENT_KEY, TEST_ENVIRONMENT_KEY, deviceKeyName, testDescriptor } from "./environment-fixture.js";

/** A `Storage` a test owns completely, so every key in it is one it put there. */
function fakeStorage(entries: Record<string, string> = {}): Storage & { map: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as unknown as Storage & { map: Map<string, string> };
}

let storage: Storage & { map: Map<string, string> };
let store: ReturnType<typeof createDeviceStore>;

beforeEach(() => {
  storage = fakeStorage();
  store = createDeviceStore(() => storage);
});
afterEach(() => store.deactivate());

describe("before the environment is known", () => {
  it("reads nothing, writes nothing, and says so", () => {
    storage.map.set(deviceKeyName(DEVICE_KEYS.archived), '["/already/here.jsonl"]');
    expect(store.status()).toEqual({ active: false, environmentKey: undefined, content: false, refusal: "inactive" });
    expect(store.read(DEVICE_KEYS.archived)).toBeUndefined();
    expect(store.readJson(DEVICE_KEYS.archived, (value) => value)).toBeUndefined();
    expect(store.readDraft("/s.jsonl")).toBeUndefined();

    store.write(DEVICE_KEYS.project, "/work");
    store.writeJson(DEVICE_KEYS.archived, ["/new.jsonl"]);
    store.writeDraft("/s.jsonl", "half a sentence");
    // Exactly what was there before, and nothing else.
    expect([...storage.map.keys()]).toEqual([deviceKeyName(DEVICE_KEYS.archived)]);
  });
});

describe("namespacing", () => {
  it("keeps each environment's paths to itself", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.archived, ["/one.jsonl"]);
    expect(storage.map.get(deviceKeyName(DEVICE_KEYS.archived))).toBe('["/one.jsonl"]');

    store.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY }));
    expect(store.readJson(DEVICE_KEYS.archived, (value) => value)).toBeUndefined();
    store.writeJson(DEVICE_KEYS.archived, ["/two.jsonl"]);
    expect(storage.map.get(deviceKeyName(DEVICE_KEYS.archived, OTHER_ENVIRONMENT_KEY))).toBe('["/two.jsonl"]');
  });

  it("purges the environment it left behind rather than keeping it around", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.archived, ["/one.jsonl"]);
    store.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY }));
    expect(storage.map.has(deviceKeyName(DEVICE_KEYS.archived))).toBe(false);
    expect([...storage.map.keys()].every((key) => namespaceOf(key) === OTHER_ENVIRONMENT_KEY)).toBe(true);
  });

  it("purges every pre-environment key, and never adopts one", () => {
    const legacy = {
      [storageKey("draft:/p/s.jsonl")]: '{"text":"unsent"}',
      [storageKey("activity-detail:/p/s.jsonl")]: "everything",
      [storageKey("archived")]: '["/p/s.jsonl"]',
      [storageKey("session")]: '{"/p":"/p/s.jsonl"}',
      [storageKey("project")]: "/p",
      [storageKey("session-tab-last")]: "{}",
      [storageKey("beam-session")]: "/beam/b.jsonl",
      [storageKey("session-groups")]: "[]",
      [storageKey("session-pins")]: "[]",
      [storageKey("session-folds")]: "{}",
      [storageKey("activity-disclosure-overrides")]: "[]",
      [storageKey("fleet-cleared")]: "2026-01-01T00:00:00.000Z",
      [storageKey("projects")]: '["/p"]',
    };
    const neutral = {
      [storageKey("panels")]: "{}",
      [storageKey("sessions-tab")]: "chat",
      [storageKey("setup-step")]: "provider",
      [storageKey("mobile-install-dismissed")]: "2026-01-01",
      [storageKey("mobile-insecure-dismissed:http://host")]: "2026-01-01",
      "something-else-entirely": "left alone",
    };
    storage = fakeStorage({ ...legacy, ...neutral });
    store = createDeviceStore(() => storage);
    expect(store.activate(testDescriptor()).ok).toBe(true);

    for (const key of Object.keys(legacy)) expect(storage.map.has(key), key).toBe(false);
    for (const key of Object.keys(neutral)) expect(storage.map.get(key), key).toBe(neutral[key as keyof typeof neutral]);
    // And nothing was quietly re-homed under the new environment.
    expect(store.read(DEVICE_KEYS.project)).toBeUndefined();
    expect(store.readDraft("/p/s.jsonl")).toBeUndefined();
  });

  it("classifies keys the way the purge does", () => {
    expect(isLegacyDeviceKey(storageKey("draft:/p/s.jsonl"))).toBe(true);
    expect(isLegacyDeviceKey(storageKey("archived"))).toBe(true);
    expect(isLegacyDeviceKey(storageKey("panels"))).toBe(false);
    expect(isLegacyDeviceKey(storageKey("mobile-insecure-dismissed:http://host"))).toBe(false);
    expect(namespaceOf(deviceKeyName(DEVICE_KEYS.archived))).toBe(TEST_ENVIRONMENT_KEY);
    expect(namespaceOf(storageKey("panels"))).toBeUndefined();
  });
});

describe("a purge that cannot finish", () => {
  it("leaves the store shut rather than opening a half-cleared device", () => {
    const crowded: Record<string, string> = {};
    for (let index = 0; index <= MAX_SCANNED_KEYS; index += 1) crowded[`unrelated-${index}`] = "x";
    crowded[storageKey("archived")] = '["/p/s.jsonl"]';
    storage = fakeStorage(crowded);
    store = createDeviceStore(() => storage);

    const outcome = store.activate(testDescriptor());
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/could not be cleared/);
    expect(store.status().active).toBe(false);
    expect(store.read(DEVICE_KEYS.archived)).toBeUndefined();
    // The legacy key is still there, which is the point: nothing pretended it
    // had been dealt with.
    expect(storage.map.has(storageKey("archived"))).toBe(true);
  });

  it("stays shut when removal itself fails", () => {
    const backing = fakeStorage({ [storageKey("archived")]: "[]" });
    const refusing = { ...backing, removeItem: () => { throw new DOMException("denied"); } } as unknown as Storage;
    const shut = createDeviceStore(() => refusing);
    expect(shut.activate(testDescriptor()).ok).toBe(false);
    expect(shut.status().active).toBe(false);
  });

  it("refuses an environment key or contract it cannot trust", () => {
    expect(store.activate(testDescriptor({ environmentKey: "not-a-key" })).ok).toBe(false);
    expect(store.activate(testDescriptor({ environmentKey: "e1.tooshort" })).ok).toBe(false);
    expect(store.activate(testDescriptor({ contract: "ep2" })).ok).toBe(false);
    expect(store.status().active).toBe(false);
  });
});

describe("a browser that refuses storage", () => {
  it("opens the environment and simply remembers nothing", () => {
    const denied = {
      get length(): number {
        throw new DOMException("denied");
      },
    } as unknown as Storage;
    const shut = createDeviceStore(() => denied);
    const outcome = shut.activate(testDescriptor());
    expect(outcome.ok).toBe(true);
    expect(shut.status()).toMatchObject({ active: true, content: false });
    expect(() => shut.writeJson(DEVICE_KEYS.archived, ["/a"])).not.toThrow();
    expect(shut.readJson(DEVICE_KEYS.archived, (value) => value)).toBeUndefined();
  });

  it("swallows a quota failure on write without losing the app", () => {
    const full = { ...fakeStorage(), setItem: () => { throw new DOMException("quota"); } } as unknown as Storage;
    const limited = createDeviceStore(() => full);
    expect(limited.activate(testDescriptor()).ok).toBe(true);
    expect(() => limited.writeJson(DEVICE_KEYS.archived, ["/a"])).not.toThrow();
    expect(() => limited.writeDraft("/s.jsonl", "text")).not.toThrow();
  });
});

describe("cache policy is the admission point for content", () => {
  const cases = [
    ["transcripts are disabled", { transcripts: "disabled" as const }, "policy"],
    ["the byte bound is zero", { maxBytes: 0 }, "bounds"],
    ["the session bound is zero", { maxSessions: 0 }, "bounds"],
    ["the entry bound is zero", { maxEntriesPerSession: 0 }, "bounds"],
    ["the age bound is zero", { maxAgeHours: 0 }, "bounds"],
    ["an encrypted store is required", { requireDeviceEncryption: true }, "encryption"],
  ] as const;

  for (const [name, cache, refusal] of cases) {
    it(`refuses drafts and purges the ones already here when ${name}`, () => {
      store.activate(testDescriptor());
      store.writeDraft("/p/s.jsonl", "something typed earlier");
      expect(store.readDraft("/p/s.jsonl")?.text).toBe("something typed earlier");

      store.activate(testDescriptor({ cache }));
      expect(store.status()).toMatchObject({ content: false, refusal });
      expect(store.readDraft("/p/s.jsonl")).toBeUndefined();
      expect(storage.map.has(deviceKeyName(DEVICE_KEYS.drafts))).toBe(false);
      store.writeDraft("/p/s.jsonl", "typed again");
      expect(storage.map.has(deviceKeyName(DEVICE_KEYS.drafts))).toBe(false);
    });
  }

  it("keeps non-content state when content is forbidden", () => {
    store.activate(testDescriptor({ cache: { transcripts: "disabled" } }));
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toEqual(["/p/s.jsonl"]);
  });
});

describe("draft bounds", () => {
  it("keeps the newest drafts within the environment's session bound", () => {
    store.activate(testDescriptor({ cache: { maxSessions: 3 } }));
    for (const index of [1, 2, 3, 4, 5]) store.writeDraft(`/p/s${index}.jsonl`, `draft ${index}`);
    expect(store.readDraft("/p/s1.jsonl")).toBeUndefined();
    expect(store.readDraft("/p/s2.jsonl")).toBeUndefined();
    expect(store.readDraft("/p/s5.jsonl")?.text).toBe("draft 5");
  });

  it("evicts the oldest until the whole family fits the byte bound", () => {
    store.activate(testDescriptor({ cache: { maxBytes: 200 } }));
    store.writeDraft("/p/old.jsonl", "o".repeat(80));
    store.writeDraft("/p/new.jsonl", "n".repeat(80));
    expect(store.readDraft("/p/new.jsonl")?.text).toHaveLength(80);
    expect(store.readDraft("/p/old.jsonl")).toBeUndefined();
    expect((storage.map.get(deviceKeyName(DEVICE_KEYS.drafts)) ?? "").length).toBeLessThanOrEqual(200);
  });

  it("forgets a draft older than the environment allows", () => {
    store.activate(testDescriptor({ cache: { maxAgeHours: 1 } }));
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    storage.map.set(deviceKeyName(DEVICE_KEYS.drafts), JSON.stringify({
      "/p/old.jsonl": { text: "yesterday's thought", at: old },
      "/p/fresh.jsonl": { text: "this morning", at: new Date().toISOString() },
    }));
    expect(store.readDraft("/p/old.jsonl")).toBeUndefined();
    expect(store.readDraft("/p/fresh.jsonl")?.text).toBe("this morning");
  });

  it("forgets one draft on request without touching the others", () => {
    store.activate(testDescriptor());
    store.writeDraft("/p/a.jsonl", "a");
    store.writeDraft("/p/b.jsonl", "b");
    store.writeDraft("/p/a.jsonl", undefined);
    expect(store.readDraft("/p/a.jsonl")).toBeUndefined();
    expect(store.readDraft("/p/b.jsonl")?.text).toBe("b");
  });
});

describe("a descriptor that takes something away", () => {
  it("clears the whole namespace when the contract generation changes", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    // A future generation: the same environment, a shape this build cannot
    // reconcile with what it wrote.
    storage.map.set(deviceKeyName(DEVICE_KEYS.descriptor), JSON.stringify({
      contract: "ep0",
      capabilities: testDescriptor().capabilities,
      cache: DEFAULT_CACHE_POLICY,
    }));
    const outcome = store.activate(testDescriptor());
    expect(outcome.invalidated).toBe("namespace");
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toBeUndefined();
  });

  it("clears the whole namespace when a capability is withdrawn", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    const outcome = store.activate(testDescriptor({ capabilities: { search: false } }));
    expect(outcome.invalidated).toBe("namespace");
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toBeUndefined();
  });

  it("clears only the content when the cache is tightened", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    store.writeDraft("/p/s.jsonl", "unsent");
    const outcome = store.activate(testDescriptor({ cache: { maxBytes: 1024 } }));
    expect(outcome.invalidated).toBe("content");
    expect(store.readDraft("/p/s.jsonl")).toBeUndefined();
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toEqual(["/p/s.jsonl"]);
  });

  it("leaves everything alone when the same environment comes back unchanged", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    store.writeDraft("/p/s.jsonl", "unsent");
    const outcome = store.activate(testDescriptor());
    expect(outcome).toMatchObject({ ok: true, changed: false, invalidated: "none", previous: TEST_ENVIRONMENT_KEY });
    expect(store.readDraft("/p/s.jsonl")?.text).toBe("unsent");
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toEqual(["/p/s.jsonl"]);
  });

  it("does not call the first environment of a page's life a switch", () => {
    expect(store.activate(testDescriptor())).toMatchObject({ previous: undefined, changed: true });
  });

  it("writes no path into what it remembers about the descriptor", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    const fingerprint = storage.map.get(deviceKeyName(DEVICE_KEYS.descriptor))!;
    expect(fingerprint).not.toContain("/p/");
    expect(fingerprint).not.toContain("actor");
    expect(fingerprint).not.toContain("l1.browser");
  });
});
