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
  DRAFT_HARD_LIMITS,
  ENVIRONMENT_NAMESPACE,
  MAX_SCANNED_KEYS,
  clearBrowserStorage,
  createDeviceStore,
  deviceStore,
  isLegacyDeviceKey,
  namespaceOf,
} from "../../src/runtime/device-storage.js";
import { FULL_CAPABILITIES, OTHER_ENVIRONMENT_KEY, TEST_ENVIRONMENT_KEY, deviceKeyName, testDescriptor } from "./environment-fixture.js";

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
    expect(store.status()).toEqual({ active: false, environmentKey: undefined, persistent: false, content: false, refusal: "inactive" });
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
    expect(store.activate(testDescriptor()).kind).toBe("first");

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
    expect(outcome.kind).toBe("failure");
    expect(outcome.kind === "failure" && outcome.reason).toMatch(/could not be cleared/);
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
    expect(shut.activate(testDescriptor()).kind).toBe("failure");
    expect(shut.status().active).toBe(false);
  });

  it("refuses an environment key or contract it cannot trust", () => {
    expect(store.activate(testDescriptor({ environmentKey: "not-a-key" })).kind).toBe("failure");
    expect(store.activate(testDescriptor({ environmentKey: "e1.tooshort" })).kind).toBe("failure");
    expect(store.activate(testDescriptor({ contract: "ep2" })).kind).toBe("failure");
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
    expect(outcome.kind).toBe("first");
    expect(outcome.kind !== "failure" && outcome.persistent).toBe(false);
    expect(shut.status()).toMatchObject({ active: true, persistent: false, content: false, refusal: "unavailable" });
    expect(() => shut.writeJson(DEVICE_KEYS.archived, ["/a"])).not.toThrow();
    expect(shut.readJson(DEVICE_KEYS.archived, (value) => value)).toBeUndefined();
  });

  it("swallows a quota failure on write without losing the app", () => {
    const full = { ...fakeStorage(), setItem: () => { throw new DOMException("quota"); } } as unknown as Storage;
    const limited = createDeviceStore(() => full);
    // The fingerprint cannot be written either, so this device is honest about
    // keeping nothing rather than claiming a namespace it cannot vouch for.
    const outcome = limited.activate(testDescriptor());
    expect(outcome.kind !== "failure" && outcome.persistent).toBe(false);
    expect(limited.status().refusal).toBe("unavailable");
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
    expect(outcome.kind !== "failure" && outcome.invalidated).toBe("namespace");
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toBeUndefined();
  });

  it("clears the whole namespace when a capability is withdrawn", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    const outcome = store.activate(testDescriptor({ capabilities: { search: false } }));
    expect(outcome.kind !== "failure" && outcome.invalidated).toBe("namespace");
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toBeUndefined();
  });

  it("clears only the content when the cache is tightened", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    store.writeDraft("/p/s.jsonl", "unsent");
    const outcome = store.activate(testDescriptor({ cache: { maxBytes: 1024 } }));
    expect(outcome).toMatchObject({ kind: "narrowed", invalidated: "content" });
    expect(store.readDraft("/p/s.jsonl")).toBeUndefined();
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toEqual(["/p/s.jsonl"]);
  });

  it("leaves everything alone when the same environment comes back unchanged", () => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    store.writeDraft("/p/s.jsonl", "unsent");
    const outcome = store.activate(testDescriptor());
    expect(outcome).toMatchObject({ kind: "same", invalidated: "none", environmentKey: TEST_ENVIRONMENT_KEY, persistent: true });
    expect(store.readDraft("/p/s.jsonl")?.text).toBe("unsent");
    expect(store.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toEqual(["/p/s.jsonl"]);
  });

  it("does not call the first environment of a page's life a switch", () => {
    expect(store.activate(testDescriptor())).toMatchObject({ kind: "first" });
    expect(store.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY }))).toMatchObject({ kind: "switched" });
    expect(store.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY, cache: { maxBytes: 8 } }))).toMatchObject({ kind: "narrowed" });
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

describe("bounds are counted in bytes, not characters", () => {
  it("measures what a quota measures, so non-ASCII drafts cannot overrun it", () => {
    // Each of these characters is three UTF-8 bytes; a length check would let
    // three times the intended amount through.
    store.activate(testDescriptor({ cache: { maxBytes: 300 } }));
    store.writeDraft("/p/first.jsonl", "日".repeat(60));
    store.writeDraft("/p/second.jsonl", "日".repeat(60));
    const stored = storage.map.get(deviceKeyName(DEVICE_KEYS.drafts)) ?? "";
    expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(300);
    // The newest survives; the oldest paid for it.
    expect(store.readDraft("/p/second.jsonl")?.text).toHaveLength(60);
    expect(store.readDraft("/p/first.jsonl")).toBeUndefined();
  });

  it("keeps an emoji draft readable rather than mangling it at a byte edge", () => {
    store.activate(testDescriptor());
    store.writeDraft("/p/s.jsonl", "🚀 ship it");
    expect(store.readDraft("/p/s.jsonl")?.text).toBe("🚀 ship it");
  });

  it("stays linear when the hard entry limit is full", () => {
    store.activate(testDescriptor());
    for (let index = 0; index < DRAFT_HARD_LIMITS.entries * 3; index += 1) {
      store.writeDraft(`/p/s${index}.jsonl`, `draft ${index}`);
    }
    const stored = JSON.parse(storage.map.get(deviceKeyName(DEVICE_KEYS.drafts))!) as Record<string, unknown>;
    expect(Object.keys(stored).length).toBeLessThanOrEqual(DRAFT_HARD_LIMITS.entries);
  });
});

describe("a draft with a timestamp that cannot be believed", () => {
  const cases: Array<[string, string]> = [
    ["unparseable", "the day before yesterday"],
    ["empty", ""],
    ["far in the future", new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()],
  ];

  for (const [name, at] of cases) {
    it(`is corrupt rather than immortal when it is ${name}`, () => {
      store.activate(testDescriptor());
      storage.map.set(deviceKeyName(DEVICE_KEYS.drafts), JSON.stringify({ "/p/s.jsonl": { text: "kept forever?", at } }));
      expect(store.readDraft("/p/s.jsonl")).toBeUndefined();
      // And it does not survive the next write either.
      store.writeDraft("/p/other.jsonl", "fresh");
      expect(JSON.parse(storage.map.get(deviceKeyName(DEVICE_KEYS.drafts))!)).not.toHaveProperty("/p/s.jsonl");
    });
  }
});

describe("a fingerprint this build cannot trust", () => {
  const seedData = (): void => {
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);
    store.deactivate();
  };

  const cases: Array<[string, string | undefined]> = [
    ["missing", undefined],
    ["not JSON", "{not json"],
    ["partial", JSON.stringify({ contract: "ep1" })],
    ["missing its cache", JSON.stringify({ contract: "ep1", capabilities: FULL_CAPABILITIES })],
    ["carrying a field this build does not know", JSON.stringify({
      contract: "ep1",
      capabilities: { ...FULL_CAPABILITIES, teleport: true },
      cache: DEFAULT_CACHE_POLICY,
    })],
    ["carrying an extra top-level field", JSON.stringify({
      contract: "ep1",
      capabilities: FULL_CAPABILITIES,
      cache: DEFAULT_CACHE_POLICY,
      actor: "l1.browser",
    })],
  ];

  for (const [name, fingerprint] of cases) {
    it(`invalidates the namespace beside it when it is ${name}`, () => {
      seedData();
      if (fingerprint === undefined) storage.map.delete(deviceKeyName(DEVICE_KEYS.descriptor));
      else storage.map.set(deviceKeyName(DEVICE_KEYS.descriptor), fingerprint);
      // A fresh view of this device, as a reload would be.
      const reopened = createDeviceStore(() => storage);
      const outcome = reopened.activate(testDescriptor());
      expect(outcome).toMatchObject({ kind: "first", invalidated: "namespace" });
      expect(reopened.readJson(DEVICE_KEYS.sessionPins, (value) => value)).toBeUndefined();
      reopened.deactivate();
    });
  }

  it("leaves an empty namespace alone: there is nothing to be wrong about", () => {
    const reopened = createDeviceStore(() => storage);
    expect(reopened.activate(testDescriptor())).toMatchObject({ kind: "first", invalidated: "none" });
    reopened.deactivate();
  });
});

describe("a key that only looks namespaced", () => {
  it("is purged like any other thing with no environment behind it", () => {
    const malformed = {
      [`${ENVIRONMENT_NAMESPACE}::archived`]: '["/p/s.jsonl"]',
      [`${ENVIRONMENT_NAMESPACE}:not-a-key:archived`]: '["/p/s.jsonl"]',
      [`${ENVIRONMENT_NAMESPACE}:e1.short:archived`]: '["/p/s.jsonl"]',
      [`${ENVIRONMENT_NAMESPACE}:`]: "x",
    };
    storage = fakeStorage(malformed);
    store = createDeviceStore(() => storage);
    expect(store.activate(testDescriptor()).kind).toBe("first");
    for (const key of Object.keys(malformed)) expect(storage.map.has(key), key).toBe(false);
  });
});

describe("clearing this browser's data", () => {
  it("takes every key this app wrote, and closes the store", () => {
    storage = fakeStorage({
      [storageKey("panels")]: "{}",
      "lasercode.theme": '{"v":1}',
      "someone-elses-key": "left alone",
    });
    store = createDeviceStore(() => storage);
    store.activate(testDescriptor());
    store.writeJson(DEVICE_KEYS.sessionPins, ["/p/s.jsonl"]);

    clearBrowserStorage(storage);
    expect([...storage.map.keys()]).toEqual(["someone-elses-key"]);
    expect(deviceStore.status().active).toBe(false);
  });
});
