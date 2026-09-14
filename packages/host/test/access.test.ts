/**
 * The host boundary's authorization, its descriptor and its audit (RP-13).
 *
 * The questions these tests answer are the ones a compiler cannot:
 *
 * - does a refusal happen *before* the request is parsed, before a session is
 *   looked up and before a worker could be started;
 * - can a device grant or a policy file ever end up wider than the table;
 * - does a descriptor carry an identity we promised not to publish;
 * - is the audit bounded per actor **and** for the host as a whole, and does
 *   reconnecting get around either.
 */
import { ErrorCodes, DEFAULT_CACHE_POLICY, METHOD_SCOPES, PRODUCT_NAME, PRODUCT_VERSION, resolveEnvironmentPolicy, type EnvironmentDescriptor, type JsonRpcResponse } from "@lasercode/protocol";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessAudit, type AccessAuditRecord } from "../src/access-audit.js";
import { AccessControl, localActor, pairedActor, type ActorIdentity } from "../src/access.js";
import { loadEnvironmentPolicy } from "../src/environment-policy.js";
import { AttentionTracker } from "../src/attention.js";
import type { SessionCatalog } from "../src/catalog.js";
import { Router } from "../src/router.js";
import { ViewCache } from "../src/views.js";
import type { LogInput } from "../src/logstore.js";
import type { WorkerPool } from "../src/worker-pool.js";
import { BROWSER_ACCESS, LOCAL_APP, LOCAL_BROWSER, deviceActor } from "./actors.js";

const ENVIRONMENT_ID = "8f14e45f-ea3b-4b1f-9b0e-000000000000";
const ENVIRONMENT_KEY = "e1.AAAAAAAAAAAAAAAAAAAAAA";

function control(options: { policy?: unknown; logs?: boolean } = {}): AccessControl {
  return new AccessControl({
    policy: resolveEnvironmentPolicy(options.policy ?? {}, "the host's configured policy"),
    environmentKey: ENVIRONMENT_KEY,
    capabilities: {
      revisions: true,
      deltas: true,
      snapshots: true,
      durableReads: true,
      search: true,
      logs: options.logs ?? true,
      diagnostics: true,
      push: true,
    },
  });
}

/** A Router whose worker pool records every attempt to reach a worker. */
function harness(options: { policy?: unknown; audit?: AccessAudit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-access-`));
  const spawned: string[] = [];
  const pool = {
    prepare: vi.fn(async (cwd: string) => void spawned.push(`prepare:${cwd}`)),
    get: vi.fn(async (cwd: string) => {
      spawned.push(`get:${cwd}`);
      return { request: async () => ({}) };
    }),
    openSessions: () => [],
    cwdOfSession: () => undefined,
    ownerOfSession: () => undefined,
    liveClients: () => [],
    workers: () => [],
    cwds: () => [],
  } as unknown as WorkerPool;
  const catalog = {
    list: () => [],
    get: () => undefined,
    getListed: () => undefined,
    cwdOf: () => undefined,
    cwdOfListed: () => undefined,
    cwdCounts: () => new Map<string, number>(),
    invalidate: () => {},
  } as unknown as SessionCatalog;
  const access = control(options.policy !== undefined ? { policy: options.policy } : {});
  const router = new Router(pool, catalog, {
    attention: new AttentionTracker({ storePath: join(dir, "attention.json") }),
    projects: { isExcluded: () => false, list: () => [], assertProject: () => {}, trustOf: () => ({ trust: "trusted" }) } as never,
    projectEnv: {} as never,
    views: new ViewCache(1),
    access,
    ...(options.audit ? { audit: options.audit } : {}),
  });
  return { router, access, spawned, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const call = (router: Router, method: string, actor: ActorIdentity, params: unknown = {}): Promise<JsonRpcResponse> =>
  router.handle({ jsonrpc: "2.0", id: 1, method, params }, { actor });

const errorOf = (response: JsonRpcResponse): { code: number; message: string } =>
  (response as { error: { code: number; message: string } }).error;

describe("reach", () => {
  it("keeps the shell's own two methods on this machine and refuses them elsewhere, in words", async () => {
    const h = harness();
    try {
      for (const actor of [LOCAL_BROWSER, deviceActor()]) {
        const environment = await call(h.router, "pi/host/environment", actor, { variables: {} });
        expect(errorOf(environment).code).toBe(ErrorCodes.Unsupported);
        expect(errorOf(environment).message).toContain("local app or terminal");
        const report = await call(h.router, "resource/report", actor, {});
        expect(errorOf(report).code).toBe(ErrorCodes.Unsupported);
        expect(errorOf(report).message).toContain("running on this machine");
      }
    } finally {
      h.cleanup();
    }
  });

  it("leaves the phone's own redacted summaries reachable", async () => {
    const h = harness();
    try {
      // No `resources` service is wired here, so reaching dispatch is the
      // proof: authorization let it through and the host answered for itself.
      for (const method of ["resource/snapshot", "resource/history", "resource/export"]) {
        const response = await call(h.router, method, deviceActor());
        expect(errorOf(response).message, method).toContain("resource diagnostics");
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("refusal ordering", () => {
  it("refuses before the params are parsed, before any lookup and before any worker", async () => {
    const h = harness();
    try {
      // Garbage params: a parse-first boundary would answer InvalidParams.
      const report = await call(h.router, "resource/report", deviceActor(), { nonsense: true });
      expect(errorOf(report).code).toBe(ErrorCodes.Unsupported);
      expect(errorOf(report).message).toContain("running on this machine");

      // A narrowed device sending a perfectly valid prompt.
      const narrowed = harness({ policy: { remote: { scopes: ["handshake", "read"] } } });
      try {
        const prompt = await call(narrowed.router, "session/prompt", deviceActor(), {
          path: "/sessions/a.jsonl",
          content: [{ type: "text", text: "hello" }],
        });
        expect(errorOf(prompt).code).toBe(ErrorCodes.Unsupported);
        expect(errorOf(prompt).message).toContain("change conversations");
        expect(narrowed.spawned).toEqual([]);
        const prepare = await call(narrowed.router, "pi/worker/prepare", deviceActor(), { cwd: "/projects/a" });
        expect(errorOf(prepare).code).toBe(ErrorCodes.Unsupported);
        expect(narrowed.spawned).toEqual([]);
      } finally {
        narrowed.cleanup();
      }
      expect(h.spawned).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a method it was never given, without believing anything in the body", async () => {
    const h = harness();
    try {
      const response = await call(h.router, "session/steal", deviceActor(), { path: "/sessions/a.jsonl" });
      expect(errorOf(response).code).toBe(ErrorCodes.MethodNotFound);
      // A body that tries to award itself authority changes nothing: the
      // decision was made from the method name and the proven actor.
      const widened = await h.router.handle(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "pi/host/environment",
          params: { variables: {} },
          actor: { class: "local_app", id: "l1.app" },
          scopes: [...METHOD_SCOPES],
          grants: { scopes: [...METHOD_SCOPES] },
        },
        { actor: deviceActor() },
      );
      expect(errorOf(widened).code).toBe(ErrorCodes.Unsupported);
      expect(h.spawned).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe("narrowing", () => {
  it("intersects a device grant with the environment and never widens", () => {
    const narrow = control({ policy: { remote: { scopes: ["handshake", "read"] } } });
    const device = deviceActor({ scopes: [...METHOD_SCOPES] }, ENVIRONMENT_ID);
    expect(narrow.scopesFor(device)).toEqual(["handshake", "read"]);

    const wide = control();
    expect(wide.scopesFor(deviceActor({ scopes: ["read"] }, ENVIRONMENT_ID))).toEqual(["read"]);
    // A grant cannot reach past reach either.
    expect(wide.authorize("resource/report", deviceActor({ scopes: [...METHOD_SCOPES] }, ENVIRONMENT_ID)).ok).toBe(false);
    // A local connection is unaffected by a remote narrowing.
    expect(narrow.scopesFor(LOCAL_APP)).toEqual([...METHOD_SCOPES]);
  });

  it("clamps the cache policy through both the environment and the grant", () => {
    const access = control({ policy: { cache: { maxBytes: 1024 } } });
    expect(access.cacheFor(LOCAL_APP)).toMatchObject({ maxBytes: 1024, transcripts: "allowed" });
    const device = deviceActor({ cache: { transcripts: "disabled", maxBytes: 8 * 1024 * 1024 } }, ENVIRONMENT_ID);
    expect(access.cacheFor(device)).toMatchObject({ transcripts: "disabled", maxBytes: 1024 });
  });
});

describe("the descriptor", () => {
  it("describes the actor that asked, and nothing it should not publish", async () => {
    const h = harness();
    try {
      const response = await call(h.router, "environment/describe", LOCAL_BROWSER);
      const descriptor = (response as { result: { environment: EnvironmentDescriptor } }).result.environment;
      expect(descriptor.contract).toBe("ep1");
      expect(descriptor.version).toBe(PRODUCT_VERSION);
      expect(descriptor.environmentKey).toBe(ENVIRONMENT_KEY);
      expect(descriptor.deployment).toBe("local");
      expect(descriptor.actor).toEqual({ class: "local_browser", id: "l1.browser" });
      expect(descriptor.scopes).toEqual([...METHOD_SCOPES]);
      expect(descriptor.cache).toEqual(DEFAULT_CACHE_POLICY);
      // A page on this machine still cannot hand down an environment.
      expect(descriptor.localOnly).toEqual(["agents/sync", "pi/host/environment", "resource/report"]);

      const device = deviceActor(undefined, ENVIRONMENT_ID);
      const remote = (await call(h.router, "environment/describe", device)) as { result: { environment: EnvironmentDescriptor } };
      const remoteDescriptor = remote.result.environment;
      expect(remoteDescriptor.actor.class).toBe("paired_device");
      expect(remoteDescriptor.actor.id).toMatch(/^d1\.[A-Za-z0-9_-]{22}$/);
      expect(remoteDescriptor.capabilities.diagnostics).toBe(true);

      // Everything but the method names in `localOnly` is opaque: no path, no
      // environment identity, no device key.
      const { localOnly, ...rest } = remoteDescriptor;
      const serialized = JSON.stringify(rest);
      expect(serialized).not.toContain(ENVIRONMENT_ID);
      expect(serialized).not.toContain("/");
      expect(serialized).not.toContain("BwcH"); // the device key, in any base64url form
      expect(localOnly.every((method) => /^[a-z][a-z/_-]*$/.test(method))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("repeats a downgraded policy to the client it applies to", async () => {
    const h = harness({
      policy: { deployment: "enterprise", remote: { scopes: ["handshake", "read"] }, cache: { transcripts: "disabled" } },
    });
    try {
      const remote = (await call(h.router, "environment/describe", deviceActor())) as { result: { environment: EnvironmentDescriptor } };
      const descriptor = remote.result.environment;
      expect(descriptor.deployment).toBe("enterprise");
      expect(descriptor.scopes).toEqual(["handshake", "read"]);
      expect(descriptor.cache.transcripts).toBe("disabled");
      expect(descriptor.capabilities.diagnostics).toBe(false);
      expect(descriptor.capabilities.logs).toBe(false);
      expect(descriptor.capabilities.push).toBe(false);
      expect(descriptor.capabilities.snapshots).toBe(true);

      const logs = await call(h.router, "pi/logs/query", deviceActor(), {});
      expect(errorOf(logs).code).toBe(ErrorCodes.Unsupported);
      expect(errorOf(logs).message).toContain("diagnostics");

      // The same host, from this machine, is unchanged.
      const local = (await call(h.router, "environment/describe", LOCAL_APP)) as { result: { environment: EnvironmentDescriptor } };
      expect(local.result.environment.scopes).toEqual([...METHOD_SCOPES]);
      expect(local.result.environment.capabilities.diagnostics).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("says logs are unavailable when this host has no store, whatever the policy allows", () => {
    const descriptor = control({ logs: false }).describe(LOCAL_APP);
    expect(descriptor.capabilities.logs).toBe(false);
    expect(descriptor.capabilities.diagnostics).toBe(true);
  });
});

describe("notifications", () => {
  it("sends a connection only what its scopes cover", () => {
    const access = control({ policy: { remote: { scopes: ["handshake", "read"] } } });
    const device = deviceActor();
    expect(access.allowsNotification("session/update", device)).toBe(true);
    expect(access.allowsNotification("pi/ui/request", device)).toBe(true);
    expect(access.allowsNotification("pi/logs/append", device)).toBe(false);
    expect(access.allowsNotification("resource/refresh_request", device)).toBe(false);
    expect(access.allowsNotification("pi/providers/login/event", device)).toBe(false);
    // Unknown notifications are not sent to anybody.
    expect(access.allowsNotification("session/invented", LOCAL_APP)).toBe(false);
    expect(access.allowsNotification("pi/logs/append", LOCAL_APP)).toBe(true);
  });
});

describe("the audit", () => {
  function sink() {
    const rows: LogInput[] = [];
    return { rows, record: (input: LogInput) => void rows.push(input) };
  }

  const record = (over: Partial<AccessAuditRecord> = {}): AccessAuditRecord => ({
    actorId: "d1.AAAAAAAAAAAAAAAAAAAAAA",
    actorClass: "paired_device",
    method: "session/prompt",
    scope: "session_write",
    outcome: "ok",
    ...over,
  });

  it("writes who and what, and has no field that could carry a conversation", () => {
    const store = sink();
    const audit = new AccessAudit({ sink: store, autoFlush: false });
    audit.record(record({ outcome: "refused", reason: "scope", code: ErrorCodes.Unsupported }));
    audit.close();
    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.section).toBe("host");
    expect(row.kind).toBe("access_refused");
    expect(row.level).toBe("warn");
    expect(row.quiet).toBe(true);
    expect(row.cwd).toBeUndefined();
    expect(row.sessionPath).toBeUndefined();
    expect(row.detail).toEqual({
      actor: "d1.AAAAAAAAAAAAAAAAAAAAAA",
      actorClass: "paired_device",
      method: "session/prompt",
      scope: "session_write",
      outcome: "refused",
      reason: "scope",
      code: ErrorCodes.Unsupported,
    });
    expect(JSON.stringify(row)).not.toMatch(/\.jsonl|cwd|argv|token/);
  });

  it("records an unknown method as a placeholder and a digest, never verbatim", async () => {
    const store = sink();
    const audit = new AccessAudit({ sink: store, autoFlush: false });
    const h = harness({ audit });
    try {
      await call(h.router, "session/steal?token=s3cret", deviceActor());
      audit.close();
      const row = store.rows.find((entry) => entry.kind === "access_refused")!;
      expect(JSON.stringify(row)).not.toContain("s3cret");
      expect((row.detail as { method: string }).method).toBe("(unknown method)");
      expect((row.detail as { methodDigest: string }).methodDigest).toMatch(/^[A-Za-z0-9_-]{8}$/);
    } finally {
      h.cleanup();
    }
  });

  it("summarises reads and writes one row per decision that matters", async () => {
    const store = sink();
    const audit = new AccessAudit({ sink: store, autoFlush: false });
    const h = harness({ audit });
    try {
      await call(h.router, "environment/describe", LOCAL_APP);
      await call(h.router, "pi/host/version", LOCAL_APP);
      await call(h.router, "pi/session/list", LOCAL_APP);
      expect(store.rows).toHaveLength(0);
      audit.flush();
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]!.kind).toBe("access_reads");
      expect((store.rows[0]!.detail as { reads: number }).reads).toBe(3);
      audit.close();
    } finally {
      h.cleanup();
    }
  });

  it("records each read when the policy asks for it", () => {
    const store = sink();
    const audit = new AccessAudit({ sink: store, reads: "each", autoFlush: false });
    audit.record(record({ scope: "read", method: "pi/session/list" }));
    audit.close();
    expect(store.rows.map((row) => row.kind)).toEqual(["access_allowed"]);
  });

  it("bounds one actor, bounds the host, and is not reset by reconnecting", () => {
    const store = sink();
    let now = 1_000;
    const audit = new AccessAudit({
      sink: store,
      autoFlush: false,
      now: () => now,
      bounds: { perActor: 3, global: 5, maxActors: 8, windowMs: 60_000 },
    });
    for (let index = 0; index < 10; index++) audit.record(record());
    expect(store.rows.filter((row) => row.kind === "access_allowed")).toHaveLength(3);

    // A second actor — a reconnect mints a new connection, not a new actor,
    // and the host's own ceiling is shared by everybody.
    for (let index = 0; index < 10; index++) audit.record(record({ actorId: "d1.BBBBBBBBBBBBBBBBBBBBBB" }));
    expect(store.rows.filter((row) => row.kind === "access_allowed")).toHaveLength(5);

    audit.flush();
    const dropped = store.rows.filter((row) => row.kind === "access_dropped");
    expect(dropped.length).toBeGreaterThanOrEqual(2);
    expect(dropped.some((row) => row.summary.startsWith("the host exceeded"))).toBe(true);

    // The next window lets the same actor write again.
    now += 60_000;
    const before = store.rows.length;
    audit.record(record());
    expect(store.rows.length).toBe(before + 1);
    audit.close();
  });

  it("evicts the least recently seen actor and flushes its counters on the way out", () => {
    const store = sink();
    const audit = new AccessAudit({ sink: store, autoFlush: false, bounds: { perActor: 100, global: 1000, maxActors: 2, windowMs: 60_000 } });
    audit.record(record({ actorId: "a1", scope: "read", method: "pi/session/list" }));
    audit.record(record({ actorId: "a2", scope: "read", method: "pi/session/list" }));
    audit.record(record({ actorId: "a3", scope: "read", method: "pi/session/list" }));
    // `a1` was evicted, and its counted read was written rather than lost.
    expect(store.rows.filter((row) => row.kind === "access_reads").map((row) => row.summary)).toEqual(["a1 read 1 time"]);
    audit.close();
    expect(store.rows.filter((row) => row.kind === "access_reads")).toHaveLength(3);
  });

  it("still records a decision when this host has no log store", () => {
    const lines: string[] = [];
    const audit = new AccessAudit({ log: (line) => lines.push(line), autoFlush: false });
    expect(() => audit.record(record({ outcome: "refused", reason: "reach" }))).not.toThrow();
    audit.close();
    expect(lines).toEqual(["access: d1.AAAAAAAAAAAAAAAAAAAAAA session/prompt refused (reach)"]);
  });

  it("keeps a decision when the store refuses the row", () => {
    const lines: string[] = [];
    const audit = new AccessAudit({
      sink: { record: () => { throw new Error("store is closed"); } },
      log: (line) => lines.push(line),
      autoFlush: false,
    });
    audit.record(record({ outcome: "refused", reason: "scope" }));
    audit.close();
    expect(lines).toHaveLength(1);
  });
});

describe("actor identity", () => {
  it("is opaque, stable, and different in another environment", () => {
    const key = new Uint8Array(32).fill(3);
    const first = pairedActor(ENVIRONMENT_ID, key);
    const again = pairedActor(ENVIRONMENT_ID, key);
    const elsewhere = pairedActor("2f14e45f-ea3b-4b1f-9b0e-000000000000", key);
    expect(first.id).toBe(again.id);
    expect(first.id).not.toBe(elsewhere.id);
    expect(first.id).toMatch(/^d1\.[A-Za-z0-9_-]{22}$/);
    expect(pairedActor(ENVIRONMENT_ID, new Uint8Array(32).fill(4)).id).not.toBe(first.id);
    // The two local actors are one each per machine, and say which they are.
    expect(localActor(false)).toEqual({ class: "local_app", id: "l1.app" });
    expect(localActor(true)).toEqual({ class: "local_browser", id: "l1.browser" });
    // A socket the host cannot prove is local gets the least privileged class.
    expect(localActor(false, false).class).toBe("paired_device");
    expect(localActor(false, false).id).toBe("r1.socket");
  });
});

describe("where the policy comes from", () => {
  function stateDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-policy-`));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("uses defaults when nothing is configured and no file exists", () => {
    const { dir, cleanup } = stateDir();
    try {
      const loaded = loadEnvironmentPolicy({ stateDir: dir });
      expect(loaded.sources).toEqual([]);
      expect(loaded.policy.remote.scopes).toEqual([...METHOD_SCOPES]);
      expect(loaded.policy.deployment).toBe("local");
    } finally {
      cleanup();
    }
  });

  it("lets a local file narrow further, and never widen or rename the environment", () => {
    const { dir, cleanup } = stateDir();
    try {
      writeFileSync(join(dir, "policy.json"), JSON.stringify({ remote: { scopes: ["handshake", "read"] }, cache: { maxBytes: 64 } }));
      const loaded = loadEnvironmentPolicy({
        stateDir: dir,
        configured: { deployment: "enterprise", remote: { scopes: ["handshake", "read", "approval"] } },
      });
      expect(loaded.sources).toEqual(["the host's configured policy", "this environment's policy file"]);
      expect(loaded.policy.deployment).toBe("enterprise");
      expect(loaded.policy.remote.scopes).toEqual(["handshake", "read"]);
      expect(loaded.policy.cache.maxBytes).toBe(64);

      // The file cannot hand authority back.
      writeFileSync(join(dir, "policy.json"), JSON.stringify({ remote: { scopes: [...METHOD_SCOPES] } }));
      const widened = loadEnvironmentPolicy({ stateDir: dir, configured: { remote: { scopes: ["handshake", "read"] } } });
      expect(widened.policy.remote.scopes).toEqual(["handshake", "read"]);
    } finally {
      cleanup();
    }
  });

  it("refuses a policy that was configured and cannot be honoured", () => {
    const { dir, cleanup } = stateDir();
    try {
      expect(() => loadEnvironmentPolicy({ stateDir: dir, configured: { remote: { scopes: ["root"] } } as never }))
        .toThrow(/cannot be used/);

      writeFileSync(join(dir, "policy.json"), "{ not json");
      expect(() => loadEnvironmentPolicy({ stateDir: dir })).toThrow(/not valid JSON/);

      writeFileSync(join(dir, "policy.json"), JSON.stringify({ deployment: "enterprise" }));
      expect(() => loadEnvironmentPolicy({ stateDir: dir })).toThrow(/cannot set the deployment/);
    } finally {
      cleanup();
    }
  });
});

describe("a host with no boundary wired", () => {
  it("still enforces reach, and refuses to describe an environment it cannot name", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-access-bare-`));
    try {
      const router = new Router({ openSessions: () => [], cwdOfSession: () => undefined } as unknown as WorkerPool, {
        list: () => [],
        get: () => undefined,
        cwdOf: () => undefined,
        cwdCounts: () => new Map<string, number>(),
        invalidate: () => {},
      } as unknown as SessionCatalog, {
        attention: new AttentionTracker({ storePath: join(dir, "attention.json") }),
        projects: { isExcluded: () => false, list: () => [] } as never,
        projectEnv: {} as never,
        views: new ViewCache(1),
      });
      const refused = await router.handle({ jsonrpc: "2.0", id: 1, method: "resource/report", params: {} }, { actor: deviceActor() });
      expect(errorOf(refused).message).toContain("running on this machine");
      const described = await router.handle({ jsonrpc: "2.0", id: 2, method: "environment/describe", params: {} }, BROWSER_ACCESS);
      expect(errorOf(described).code).toBe(ErrorCodes.Unsupported);
      expect(errorOf(described).message).toContain("cannot describe its environment");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
