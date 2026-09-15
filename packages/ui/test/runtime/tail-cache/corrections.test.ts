/**
 * The properties a source review found missing, each pinned against a real
 * database (RP-10, M18-T10 review batch).
 *
 * `fake-indexeddb` is used here and nowhere near `src/`: happy-dom has no
 * database, and these are exactly the behaviours a hand-written fake would
 * have been free to get wrong — a transaction that does not commit, a delete
 * that has to be proved, an open that succeeds after its own timeout, and a
 * multibyte body whose declared size is a lie.
 */
import { DEFAULT_CACHE_POLICY, PRODUCT_VERSION, type CachePolicy, type EnvironmentDescriptor } from "@lasercode/protocol";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTailCache, type TailCache } from "../../../src/runtime/tail-cache/cache.js";
import { TAIL_RECORD_SCHEMA, TAIL_SCAN_LIMITS } from "../../../src/runtime/tail-cache/bounds.js";
import { bodyText, bodyTextBytes, checksumOf } from "../../../src/runtime/tail-cache/record.js";
import {
  TAIL_DATABASE_NAME,
  TAIL_STORE_NAME,
  destroyTailDatabase,
  openTailStore,
  rowStoredBytes,
  type TailRow,
  type TailStore,
} from "../../../src/runtime/tail-cache/store.js";
import { NULL_VAULT } from "../../../src/runtime/tail-cache/vault.js";
import { VIEW_TAIL_SCHEMA, type ViewTailDto } from "../../../src/runtime/view-tail.js";

const ENV_A = "e1.AAAAAAAAAAAAAAAAAAAAAA";
const REVISION = "r1.abcdefgh.AAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A fresh database per test: `fake-indexeddb` is happy to be replaced. */
let factory: IDBFactory;
/** One clock for the cache and the store it opens, as production has one. */
const clockNow = { now: 1_700_000_000_000 };

beforeEach(() => {
  factory = new IDBFactory();
  clockNow.now = 1_700_000_000_000;
  // The store's own `IDBKeyRange` use goes through the global.
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function descriptor(cache: Partial<CachePolicy> = {}): EnvironmentDescriptor {
  return {
    contract: "ep1",
    version: PRODUCT_VERSION,
    environmentKey: ENV_A,
    deployment: "local",
    actor: { class: "local_browser", id: "actor" },
    capabilities: { revisions: true, deltas: true, snapshots: true, durableReads: true, search: true, diagnostics: true, logs: true, push: false },
    cache: { ...DEFAULT_CACHE_POLICY, ...cache },
    scopes: [],
    localOnly: [],
  };
}

const entry = (id: string, text: string) => ({
  id,
  parentId: null,
  json: JSON.stringify({ id, parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text }] } }),
});

function tail(overrides: Partial<ViewTailDto> = {}): ViewTailDto {
  return Object.freeze({
    schema: VIEW_TAIL_SCHEMA,
    path: "/p/a.jsonl",
    sessionId: "session-a",
    environmentKey: ENV_A,
    revision: REVISION,
    epoch: "epoch-1",
    seq: 7,
    leafId: "e1",
    capturedAt: new Date(1_700_000_000_000).toISOString(),
    entries: Object.freeze([entry("e1", "hello")]),
    truncated: false,
    bytes: 100,
    ...overrides,
  }) as ViewTailDto;
}

function rowFor(overrides: Partial<TailRow> = {}, text = bodyText({ entries: [entry("e1", "hello")], attachments: [] })): TailRow {
  return {
    schema: TAIL_RECORD_SCHEMA,
    appVersion: PRODUCT_VERSION,
    environmentKey: ENV_A,
    sessionId: "session-a",
    path: "/p/a.jsonl",
    revision: REVISION,
    leafId: "e1",
    epoch: "epoch-1",
    seq: 3,
    truncated: false,
    attachments: [],
    attachmentsOmitted: 0,
    bytes: bodyTextBytes(text),
    capturedAt: new Date(1_699_999_000_000).toISOString(),
    lastUsedAt: new Date(1_699_999_000_000).toISOString(),
    checksum: checksumOf(text),
    body: { kind: "plain", text },
    ...overrides,
  };
}

/** Put rows straight into the database, the way a hostile profile would hold them. */
async function seed(rows: readonly TailRow[]): Promise<void> {
  const store = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
  expect(store).toBeDefined();
  for (const row of rows) expect(await store!.put(row)).toBe(true);
  store!.close();
}

interface Harness {
  cache: TailCache;
  clock: { now: number };
  flush(): Promise<void>;
}

function harness(options: { store?: () => Promise<TailStore | undefined>; destroy?: () => Promise<"deleted" | "absent" | "blocked" | "failed"> } = {}): Harness {
  const clock = clockNow;
  const tasks: Array<() => void> = [];
  const cache = createTailCache({
    openStore: options.store ?? (() => openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now })),
    resolveVault: () => Promise.resolve(NULL_VAULT),
    destroy: options.destroy ?? (() => destroyTailDatabase(factory as unknown as IDBFactory)),
    appVersion: PRODUCT_VERSION,
    now: () => clock.now,
    defer: (task) => tasks.push(task),
  });
  return {
    cache,
    clock,
    async flush() {
      for (let round = 0; round < 4; round += 1) {
        for (const task of tasks.splice(0, tasks.length)) task();
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

/** Everything the database holds, read without the cache. */
async function storedRows(): Promise<TailRow[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(TAIL_DATABASE_NAME);
    request.onsuccess = () => resolve(request.result as unknown as IDBDatabase);
    request.onerror = () => reject(new Error("open failed"));
  });
  if (!database.objectStoreNames.contains(TAIL_STORE_NAME)) {
    database.close();
    return [];
  }
  const rows = await new Promise<TailRow[]>((resolve) => {
    const request = database.transaction(TAIL_STORE_NAME, "readonly").objectStore(TAIL_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as TailRow[]);
  });
  database.close();
  return rows;
}

describe("exact bytes, against a row that lies about itself", () => {
  it("measures a multibyte body the way a quota does, and stores that number", async () => {
    const view = harness();
    await view.cache.prepare(descriptor());
    // Japanese, an emoji with a surrogate pair, and a quote that JSON escapes:
    // every one of them is wider in bytes than in code units.
    view.cache.release(tail({ entries: [entry("e1", 'これは日本語です 🌋 "quoted"')] }));
    await view.flush();
    const [stored] = await storedRows();
    expect(stored).toBeDefined();
    const text = stored!.body.kind === "plain" ? stored!.body.text : "";
    const exact = new TextEncoder().encode(text).length;
    expect(stored!.bytes).toBe(exact);
    // The ids, the wrappers and the escaping are inside the number, not left out.
    expect(stored!.bytes).toBeGreaterThan(new TextEncoder().encode(stored!.body.kind === "plain" ? "" : "").length);
    expect(stored!.bytes).toBeGreaterThan(text.length);
    expect(view.cache.counters().bytes).toBe(exact);
    expect(view.cache.peek("/p/a.jsonl")?.bytes).toBe(exact);
  });

  it("counts a stored row's real size, never its UTF-16 length", () => {
    const text = "あ".repeat(10);
    const row = rowFor({}, text);
    // Three bytes each, not two code units each.
    expect(rowStoredBytes(row)).toBeGreaterThanOrEqual(30);
  });

  it("refuses to warm a row that claims to be tiny and carries a huge body", async () => {
    const huge = bodyText({ entries: [entry("e1", "あ".repeat(200_000))], attachments: [] });
    await seed([rowFor({ bytes: 12, checksum: checksumOf(huge) }, huge)]);
    const view = harness();
    const state = await view.cache.prepare(descriptor());
    // Over the per-record bound as measured, whatever it claimed: discarded
    // before anything of it is parsed, and never a warm record.
    expect(state.kind).toBe("open");
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters().discarded.oversize).toBe(1);
    expect(await storedRows()).toEqual([]);
  });

  it("discards a row whose declared bytes disagree with its body", async () => {
    const text = bodyText({ entries: [entry("e1", "hello")], attachments: [] });
    await seed([rowFor({ bytes: bodyTextBytes(text) - 3 }, text)]);
    const view = harness();
    const state = await view.cache.prepare(descriptor());
    expect(state.kind).toBe("open");
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters().discarded.corrupt).toBe(1);
  });
});

describe("a record is readable only once its own write has committed", () => {
  it("serves nothing from memory while the write is still in flight", async () => {
    const view = harness();
    await view.cache.prepare(descriptor());
    view.cache.release(tail());
    // The release has been accepted; the transaction has not run yet.
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters().records).toBe(0);
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toBeDefined();
    expect(view.cache.counters().records).toBe(1);
  });

  it("leaves no hot record behind when the transaction never commits", async () => {
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    const refusing: TailStore = { ...real!, put: () => Promise.resolve(false) };
    const view = harness({ store: () => Promise.resolve(refusing) });
    await view.cache.prepare(descriptor());
    view.cache.release(tail());
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters()).toMatchObject({ records: 0, hotRecords: 0, bytes: 0 });
    expect(view.cache.counters().writesRefused).toBeGreaterThan(0);
    expect(await storedRows()).toEqual([]);
    real!.close();
  });

  it("leaves no hot record behind when the body cannot be sealed", async () => {
    const clock = clockNow;
    const tasks: Array<() => void> = [];
    const cache = createTailCache({
      openStore: () => openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now }),
      resolveVault: () => Promise.resolve({ ...NULL_VAULT, encrypted: true, encryption: { kind: "os-backed", store: "the system keyring" }, seal: () => Promise.resolve(undefined) }),
      destroy: () => destroyTailDatabase(factory as unknown as IDBFactory),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => tasks.push(task),
    });
    await cache.prepare(descriptor());
    cache.release(tail());
    for (const task of tasks.splice(0, tasks.length)) task();
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    expect(cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(cache.counters()).toMatchObject({ records: 0, hotRecords: 0, writesRefused: 1 });
    expect(await storedRows()).toEqual([]);
  });

  it("leaves no hot record behind when the environment goes away mid-write", async () => {
    const view = harness();
    await view.cache.prepare(descriptor());
    view.cache.release(tail());
    view.cache.deactivate();
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(await storedRows()).toEqual([]);
  });

  it("keeps peek allocation-free once the record is committed", async () => {
    const view = harness();
    await view.cache.prepare(descriptor());
    view.cache.release(tail());
    await view.flush();
    const first = view.cache.peek("/p/a.jsonl");
    expect(first).toBe(view.cache.peek("/p/a.jsonl"));
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("a partial pass is never treated as a whole one", () => {
  const many = (count: number): TailRow[] =>
    Array.from({ length: count }, (_, index) => rowFor({ sessionId: `session-${index}`, path: `/p/${index}.jsonl` }));

  it("promotes nothing from a scan that stopped at a ceiling", async () => {
    await seed(many(12));
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    const view = harness({ store: () => Promise.resolve(real!) });
    await view.cache.prepare(descriptor());
    // A later pass that cannot finish: `prime` must not warm a prefix of it.
    const partial: TailStore = { ...real!, scan: () => Promise.resolve({ outcome: "over-rows", rowsSeen: 1, bytesSeen: 1 }) };
    const limited = harness({ store: () => Promise.resolve(partial) });
    await limited.cache.prepare(descriptor());
    await limited.cache.prime(["/p/3.jsonl"]);
    expect(limited.cache.peek("/p/3.jsonl")).toBeUndefined();
    real!.close();
  });

  it("refuses an explicit clear whose scan could not finish, and deletes no prefix", async () => {
    await seed(many(5));
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    let calls = 0;
    const flaky: TailStore = {
      ...real!,
      scan: (options, visit) => {
        calls += 1;
        // The preparation pass sees everything; the clear sees a prefix.
        if (calls === 1) return real!.scan(options, visit);
        return Promise.resolve({ outcome: "over-time", rowsSeen: 2, bytesSeen: 2 });
      },
    };
    const view = harness({ store: () => Promise.resolve(flaky) });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    expect(await view.cache.clear("environment")).toBe(false);
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
    expect((await storedRows()).length).toBe(5);
    real!.close();
  });

  it("refuses an explicit clear whose deletion could not be proved", async () => {
    await seed(many(3));
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    const silent: TailStore = { ...real!, remove: () => Promise.resolve(false) };
    const view = harness({ store: () => Promise.resolve(silent) });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    expect(await view.cache.clear("environment")).toBe(false);
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
    real!.close();
  });

  it("stays shut when a row it could not open also could not be removed", async () => {
    const text = bodyText({ entries: [entry("e1", "hello")], attachments: [] });
    await seed([rowFor({ checksum: "deadbeef-1" }, text)]);
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    const silent: TailStore = { ...real!, remove: () => Promise.resolve(false) };
    const view = harness({ store: () => Promise.resolve(silent) });
    const state = await view.cache.prepare(descriptor());
    expect(state).toMatchObject({ kind: "refused", reason: "purge" });
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    real!.close();
  });

  it("refuses more deletions than one pass may make", async () => {
    const store = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    const keys = Array.from({ length: TAIL_SCAN_LIMITS.deleteRows + 1 }, (_, index) => [ENV_A, `session-${index}`] as const);
    expect(await store!.remove(keys, TAIL_SCAN_LIMITS.batchRows)).toBe(false);
    store!.close();
  });

  it("refuses a deletion that runs past its deadline", async () => {
    await seed(many(3));
    const store = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    const keys = (await storedRows()).map((row) => [row.environmentKey, row.sessionId] as const);
    expect(await store!.remove(keys, 1, { deadline: clockNow.now - 1 })).toBe(false);
    store!.close();
  });
});

describe("a timed-out open never becomes a cache", () => {
  it("closes a connection that succeeds after its own timeout", async () => {
    let settle: ((database: unknown) => void) | undefined;
    const closed: string[] = [];
    const late = {
      open() {
        const request: Record<string, unknown> = { result: undefined };
        settle = (database) => {
          request["result"] = database;
          (request["onsuccess"] as (() => void) | undefined)?.();
        };
        return request;
      },
    } as unknown as IDBFactory;
    const store = await openTailStore(late, { blockedMs: 5 });
    expect(store).toBeUndefined();
    // The open completes a moment later: its database is closed, not adopted.
    settle?.({
      objectStoreNames: { contains: () => true },
      close: () => closed.push("closed"),
      transaction: () => {
        throw new Error("a refused connection must never be used");
      },
    });
    expect(closed).toEqual(["closed"]);
  });

  it("refuses the cache when the database cannot be opened in time", async () => {
    const view = harness({ store: () => Promise.resolve(undefined) });
    expect(await view.cache.prepare(descriptor())).toMatchObject({ kind: "refused", reason: "storage" });
    expect(view.cache.counters()).toMatchObject({ durable: false, records: 0 });
  });
});

describe("a preparation the connection stopped waiting for cannot come back", () => {
  it("publishes nothing and holds nothing after the wait was cancelled", async () => {
    await seed([rowFor()]);
    let release: (() => void) | undefined;
    const view = harness({
      store: () => new Promise((resolve) => {
        release = () => void openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now }).then(resolve);
      }),
    });
    const preparing = view.cache.prepare(descriptor());
    // What the client does when the budget expires or the socket is replaced.
    view.cache.deactivate();
    expect(view.cache.state()).toEqual({ kind: "closed" });

    release?.();
    await preparing;
    // The late completion neither opens nor refuses: nobody is in that state.
    expect(view.cache.state()).toEqual({ kind: "closed" });
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters()).toMatchObject({ status: "closed", records: 0, hotRecords: 0 });
  });

  it("does not publish a refusal for a pass the page has moved past", async () => {
    let release: (() => void) | undefined;
    const view = harness({
      store: () => new Promise((resolve) => {
        release = () => resolve(undefined);
      }),
    });
    const preparing = view.cache.prepare(descriptor());
    view.cache.deactivate();
    release?.();
    await preparing;
    expect(view.cache.state()).toEqual({ kind: "closed" });
  });
});

describe("the bound is on the body that is actually written", () => {
  /** A tail whose entries fit one by one but whose canonical body would not. */
  const nearLimit = (bytesPerSession: number) => {
    // Long ids and parent ids, non-Latin text and characters JSON escapes:
    // everything the old per-entry sum left out of the number.
    const longId = (index: number) => `entry-${"x".repeat(180)}-${index}`;
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: longId(index),
      parentId: index === 0 ? null : longId(index - 1),
      json: JSON.stringify({
        id: longId(index),
        parentId: index === 0 ? null : longId(index - 1),
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `"引用" ${"日本語テキスト".repeat(Math.ceil(bytesPerSession / 400))}` }] },
      }),
    }));
    return tail({ entries: Object.freeze(rows) });
  };

  it("never writes a record over the per-record bound, and a reload keeps it", async () => {
    const bytesPerSession = 8_192;
    const view = harness();
    await view.cache.prepare(descriptor({ maxBytes: bytesPerSession }));
    const limits = view.cache.counters().bounds!;
    expect(limits.bytesPerSession).toBe(bytesPerSession);

    view.cache.release(nearLimit(bytesPerSession));
    await view.flush();
    const record = view.cache.peek("/p/a.jsonl");
    expect(record).toBeDefined();
    expect(record!.bytes).toBeLessThanOrEqual(limits.bytesPerSession);
    expect(record!.truncated).toBe(true);
    // The number is the body's own exact size, ids and escaping included.
    const [stored] = await storedRows();
    const text = stored!.body.kind === "plain" ? stored!.body.text : "";
    expect(new TextEncoder().encode(text).length).toBe(record!.bytes);

    // And the next start keeps it rather than purging what was just written.
    const again = harness();
    expect((await again.cache.prepare(descriptor({ maxBytes: bytesPerSession }))).kind).toBe("open");
    expect(again.cache.peek("/p/a.jsonl")?.bytes).toBe(record!.bytes);
    expect(again.cache.counters().discarded.oversize).toBe(0);
  });

  it("refuses a single entry that cannot fit the bound on its own", async () => {
    const view = harness();
    await view.cache.prepare(descriptor({ maxBytes: 512 }));
    view.cache.release(tail({ entries: Object.freeze([entry("e1", "あ".repeat(2_000))]) }));
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(await storedRows()).toEqual([]);
    expect(view.cache.counters().writesRefused).toBe(1);
  });
});

describe("a preparation that rejects late publishes nothing either", () => {
  it("keeps the cache closed when the vault rejects after the wait was cancelled", async () => {
    let fail: (() => void) | undefined;
    const clock = clockNow;
    const cache = createTailCache({
      openStore: () => openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now }),
      resolveVault: () => new Promise((_resolve, reject) => {
        fail = () => reject(new Error("the keychain went away"));
      }),
      destroy: () => destroyTailDatabase(factory as unknown as IDBFactory),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    const preparing = cache.prepare(descriptor());
    cache.deactivate();
    fail?.();
    await preparing;
    expect(cache.state()).toEqual({ kind: "closed" });
    expect(cache.counters().status).toBe("closed");
  });
});

describe("promotion cleans up what it cannot read", () => {
  const poison = async (): Promise<void> => {
    const text = bodyText({ entries: [entry("e1", "hello")], attachments: [] });
    await seed([
      rowFor(),
      rowFor({ sessionId: "bad", path: "/p/bad.jsonl", checksum: "deadbeef-1" }, text),
    ]);
  };

  it("deletes a row it could not open rather than leaving it to poison every pass", async () => {
    await poison();
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    // Warm only the good row, so the bad one is met by `prime` and not by the
    // preparation pass.
    let hideBad = true;
    const scoped: TailStore = {
      ...real!,
      scan: (options, visit) => real!.scan(options, (row) => (hideBad && row.sessionId === "bad" ? undefined : visit(row))),
    };
    const view = harness({ store: () => Promise.resolve(scoped) });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    expect((await storedRows()).some((row) => row.sessionId === "bad")).toBe(true);
    hideBad = false;

    await view.cache.prime(["/p/bad.jsonl"]);
    expect(view.cache.peek("/p/bad.jsonl")).toBeUndefined();
    expect(view.cache.state().kind).toBe("open");
    expect((await storedRows()).some((row) => row.sessionId === "bad")).toBe(false);
    expect(view.cache.counters().discarded.corrupt).toBe(1);
    real!.close();
  });

  it("closes the cache when that row cannot be proved gone", async () => {
    await poison();
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    let allowRemove = true;
    let hideBad = true;
    const stubborn: TailStore = {
      ...real!,
      scan: (options, visit) => real!.scan(options, (row) => (hideBad && row.sessionId === "bad" ? undefined : visit(row))),
      remove: (keys, batch, bounds) => (allowRemove ? real!.remove(keys, batch, bounds) : Promise.resolve(false)),
    };
    const view = harness({ store: () => Promise.resolve(stubborn) });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    hideBad = false;
    allowRemove = false;
    await view.cache.prime(["/p/bad.jsonl"]);
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
    expect(view.cache.peek("/p/bad.jsonl")).toBeUndefined();
    expect(view.cache.counters()).toMatchObject({ records: 0, hotRecords: 0 });
    real!.close();
  });
});

describe("an over-bound cache never calls itself open", () => {
  it("closes when the eviction after a commit cannot be proved", async () => {
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    let allowRemove = true;
    const stubborn: TailStore = {
      ...real!,
      remove: (keys, batch, bounds) => (allowRemove ? real!.remove(keys, batch, bounds) : Promise.resolve(false)),
    };
    const view = harness({ store: () => Promise.resolve(stubborn) });
    // Room for one conversation only, so the second commit must evict the first.
    await view.cache.prepare(descriptor({ maxSessions: 1 }));
    view.cache.release(tail());
    await view.flush();
    expect(view.cache.counters().records).toBe(1);

    allowRemove = false;
    view.clock.now += 1_000;
    view.cache.release(tail({ path: "/p/b.jsonl", sessionId: "session-b", revision: REVISION }));
    await view.flush();

    // Over its bounds and unable to get back inside them: closed, holding
    // nothing, and never an open counter above the limit.
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
    expect(view.cache.peek("/p/b.jsonl")).toBeUndefined();
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    const counters = view.cache.counters();
    expect(counters).toMatchObject({ status: "refused", records: 0, hotRecords: 0, bytes: 0 });
    real!.close();
  });

  it("closes when making room before a retry cannot be proved", async () => {
    const real = await openTailStore(factory as unknown as IDBFactory, { now: () => clockNow.now });
    const refusing: TailStore = {
      ...real!,
      put: () => Promise.resolve(false),
      remove: () => Promise.resolve(false),
    };
    const view = harness({ store: () => Promise.resolve(refusing) });
    await view.cache.prepare(descriptor({ maxSessions: 1 }));
    view.cache.release(tail());
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters()).toMatchObject({ records: 0, hotRecords: 0 });
    real!.close();
  });
});
