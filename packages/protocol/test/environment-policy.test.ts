/**
 * The authorization table and the environment descriptor (RP-13).
 *
 * The table's completeness is a compiler guarantee (`satisfies Record<
 * ClientMethod, MethodPolicy>`); these tests guard the parts a compiler cannot
 * see: that reach is only ever tightened for the three methods that describe
 * or reconfigure this machine, that narrowing is one-directional, and that a
 * descriptor never carries an identity a person did not agree to publish.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_POLICY,
  ENVIRONMENT_CONTRACT_VERSION,
  ENVIRONMENT_DESCRIBE_METHOD,
  EnvironmentPolicyError,
  METHOD_POLICY,
  METHOD_SCOPES,
  NOTIFICATION_SCOPE,
  POLICED_METHODS,
  clampCachePolicy,
  clientMethods,
  deviceGrantsSchema,
  environmentDescriptorSchema,
  intersectScopes,
  isMethodScope,
  methodPolicy,
  notificationScope,
  parseClientRequest,
  reachAllows,
  resolveEnvironmentPolicy,
  type ActorClass,
  type EnvironmentDescriptor,
  type MethodScope,
} from "../src/index.js";

describe("the method table", () => {
  it("covers every client method exactly once, with a known scope", () => {
    expect([...POLICED_METHODS].sort()).toEqual([...clientMethods].sort());
    for (const method of clientMethods) {
      const policy = methodPolicy(method);
      expect(policy, method).toBeDefined();
      expect(isMethodScope(policy!.scope), `${method} scope`).toBe(true);
    }
  });

  it("knows nothing about a method it was never given", () => {
    for (const unknown of ["", "pi/host/environment ", "session/steal", "__proto__", "toString", "constructor"]) {
      expect(methodPolicy(unknown), unknown).toBeUndefined();
    }
  });

  it("restricts reach to the methods that reconfigure or measure this machine, or address its own workers", () => {
    const restricted = Object.entries(METHOD_POLICY)
      .filter(([, policy]) => policy.reach !== "any")
      .map(([method]) => method)
      .sort();
    // `pi/worker/retained-stores` joins `agents/sync`: the app asking its own
    // already-live workers what they are holding, never a client's call. RP-4's
    // `pi/session/unload` and `pi/worker/safety` are the same shape: the app
    // managing and inspecting its own session runtimes on this machine.
    // RP-8's `pi/worker/pressure` is the newest of that family: asking a worker
    // to give memory back releases runtime state, so it is the app's own call.
    expect(restricted).toEqual([
      "agents/sync",
      "pi/host/environment",
      "pi/session/unload",
      "pi/worker/pressure",
      "pi/worker/retained-stores",
      "pi/worker/retire",
      "pi/worker/safety",
      "resource/report",
    ]);
    expect(METHOD_POLICY["pi/worker/pressure"]).toMatchObject({ scope: "work_control", reach: "native" });
    // The phone's redacted inventory summary stays reachable (RP-3); only the
    // desktop's measurement *input* is local.
    for (const method of ["resource/snapshot", "resource/history", "resource/export"] as const) {
      expect(METHOD_POLICY[method].reach).toBe("any");
    }
  });

  it("keeps the exact refusal sentences the two existing local guards used", () => {
    expect(METHOD_POLICY["pi/host/environment"].refusal).toBe(
      "Environment updates are only accepted from a local app or terminal.",
    );
    expect(METHOD_POLICY["resource/report"].refusal).toBe(
      "Process metrics are only accepted from the app running on this machine.",
    );
    for (const [method, policy] of Object.entries(METHOD_POLICY)) {
      if (policy.reach !== "any") expect(policy.refusal, method).toBeTruthy();
    }
  });

  it("lets a handshake through from every proven caller", () => {
    for (const method of ["pi/host/version", ENVIRONMENT_DESCRIBE_METHOD] as const) {
      expect(METHOD_POLICY[method as "pi/host/version"].scope).toBe("handshake");
      expect(METHOD_POLICY[method as "pi/host/version"].reach).toBe("any");
    }
  });

  it("maps reach onto the three proven actor classes", () => {
    const classes: ActorClass[] = ["local_app", "local_browser", "paired_device"];
    expect(classes.map((actor) => reachAllows("any", actor))).toEqual([true, true, true]);
    expect(classes.map((actor) => reachAllows("native", actor))).toEqual([true, false, false]);
    // Two values, and no unused third: every row is one or the other.
    expect(new Set(Object.values(METHOD_POLICY).map((policy) => policy.reach))).toEqual(new Set(["any", "native"]));
  });

  it("separates running something from configuring it", () => {
    for (const method of ["mcp/call", "pi/project/env/set", "pi/project/env/test", "pi/project/env/refresh"] as const) {
      expect(METHOD_POLICY[method].scope, method).toBe("execution");
    }
    // Describing what is configured is not execution.
    expect(METHOD_POLICY["mcp/list"].scope).toBe("read");
    expect(METHOD_POLICY["pi/project/env/status"].scope).toBe("read");
    expect(METHOD_POLICY["mcp/save"].scope).toBe("settings");
    // A policy that narrows to settings alone cannot reach an executable.
    const settingsOnly = resolveEnvironmentPolicy({ remote: { scopes: ["handshake", "read", "settings"] } }, "the host's configured policy");
    expect(settingsOnly.remote.scopes).not.toContain("execution");
    // And the default policy keeps today's behaviour exactly.
    expect(resolveEnvironmentPolicy({}, "the host's configured policy").remote.scopes).toContain("execution");
  });

  it("summarises the one high-frequency stream, and nothing else", () => {
    const summarised = Object.entries(METHOD_POLICY)
      .filter(([, policy]) => policy.audit === "summary")
      .map(([method]) => method);
    expect(summarised).toEqual(["pi/transcribe/chunk"]);
  });

  it("gives every host notification an owning scope", () => {
    for (const [method, scope] of Object.entries(NOTIFICATION_SCOPE)) {
      expect(isMethodScope(scope), method).toBe(true);
      expect(notificationScope(method)).toBe(scope);
    }
    expect(notificationScope("session/made-up")).toBeUndefined();
    // The two that a narrowed connection must stop hearing.
    expect(NOTIFICATION_SCOPE["pi/logs/append"]).toBe("diagnostics");
    expect(NOTIFICATION_SCOPE["resource/refresh_request"]).toBe("diagnostics");
  });
});

describe("narrowing", () => {
  it("intersects scopes and never adds one", () => {
    expect(intersectScopes(METHOD_SCOPES, ["read"])).toEqual(["read"]);
    expect(intersectScopes(["read"], ["read", "settings", "approval"])).toEqual(["read"]);
    expect(intersectScopes(["read", "approval"])).toEqual(["read", "approval"]);
    // Order is the table's, not the caller's, so two equal sets compare equal.
    expect(intersectScopes(METHOD_SCOPES, ["settings", "read"])).toEqual(["read", "settings"]);
  });

  it("clamps a cache policy in every dimension and never loosens one", () => {
    const wide = clampCachePolicy(DEFAULT_CACHE_POLICY, {
      maxBytes: DEFAULT_CACHE_POLICY.maxBytes * 100,
      maxSessions: 9_999,
      maxAgeHours: 10_000,
      maxEntriesPerSession: 10_000,
      transcripts: "allowed",
      attachments: "reference",
      requireDeviceEncryption: false,
    });
    expect(wide).toEqual(DEFAULT_CACHE_POLICY);

    const narrow = clampCachePolicy(DEFAULT_CACHE_POLICY, {
      maxBytes: 1024,
      maxSessions: 2,
      maxAgeHours: 1,
      maxEntriesPerSession: 10,
      attachments: "none",
      requireDeviceEncryption: true,
    });
    expect(narrow).toEqual({
      transcripts: "allowed",
      maxSessions: 2,
      maxBytes: 1024,
      maxEntriesPerSession: 10,
      maxAgeHours: 1,
      attachments: "none",
      requireDeviceEncryption: true,
    });

    // Disabled is sticky even when the next patch asks for it back.
    const disabled = clampCachePolicy({ ...DEFAULT_CACHE_POLICY, transcripts: "disabled" }, { transcripts: "allowed" });
    expect(disabled.transcripts).toBe("disabled");
    expect(clampCachePolicy({ ...DEFAULT_CACHE_POLICY, attachments: "none" }, { attachments: "reference" }).attachments).toBe("none");
    expect(clampCachePolicy({ ...DEFAULT_CACHE_POLICY, requireDeviceEncryption: true }, { requireDeviceEncryption: false }).requireDeviceEncryption).toBe(true);
  });

  it("validates a device grant and refuses one that invents a scope", () => {
    expect(deviceGrantsSchema.safeParse({ scopes: ["read", "approval"] }).success).toBe(true);
    expect(deviceGrantsSchema.safeParse({ scopes: ["everything"] }).success).toBe(false);
    expect(deviceGrantsSchema.safeParse({ reach: "native" }).success).toBe(false);
    expect(deviceGrantsSchema.safeParse({ cache: { transcripts: "disabled" } }).success).toBe(true);
  });
});

describe("a configured policy", () => {
  it("fills in defaults for an absent policy", () => {
    const policy = resolveEnvironmentPolicy(undefined, "the host's configured policy");
    expect(policy.deployment).toBe("local");
    expect(policy.local.scopes).toEqual([...METHOD_SCOPES]);
    expect(policy.remote.scopes).toEqual([...METHOD_SCOPES]);
    expect(policy.cache).toEqual(DEFAULT_CACHE_POLICY);
    expect(policy.audit.reads).toBe("summary");
  });

  it("narrows what it names and leaves the rest alone", () => {
    const policy = resolveEnvironmentPolicy(
      { deployment: "enterprise", remote: { scopes: ["read", "handshake"] }, cache: { transcripts: "disabled" }, audit: { reads: "each" } },
      "the host's configured policy",
    );
    expect(policy.deployment).toBe("enterprise");
    expect(policy.remote.scopes).toEqual(["handshake", "read"]);
    expect(policy.local.scopes).toEqual([...METHOD_SCOPES]);
    expect(policy.cache.transcripts).toBe("disabled");
    expect(policy.audit.reads).toBe("each");
  });

  it("refuses an unusable policy with problems a person can act on, and never echoes a value", () => {
    let thrown: unknown;
    try {
      resolveEnvironmentPolicy({ deployment: "s3cret-deployment", remote: { scopes: ["root"] }, extra: "s3cret-value" }, "the host's configured policy");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvironmentPolicyError);
    const error = thrown as EnvironmentPolicyError;
    expect(error.problems.length).toBeGreaterThan(0);
    expect(error.message).toContain("the host's configured policy");
    expect(error.message).not.toContain("s3cret");
    for (const problem of error.problems) expect(problem).not.toContain("s3cret");
  });
});

describe("the descriptor", () => {
  const descriptor: EnvironmentDescriptor = {
    contract: ENVIRONMENT_CONTRACT_VERSION,
    version: "9.9.9",
    environmentKey: "e1.AAAAAAAAAAAAAAAAAAAAAA",
    deployment: "cloud",
    actor: { class: "paired_device", id: "d1.AAAAAAAAAAAAAAAAAAAAAA" },
    capabilities: {
      revisions: true,
      deltas: true,
      snapshots: true,
      durableReads: true,
      search: true,
      diagnostics: true,
      logs: true,
      push: true,
    },
    cache: DEFAULT_CACHE_POLICY,
    scopes: ["handshake", "read"] as MethodScope[],
    localOnly: ["pi/host/environment"],
  };

  it("round-trips its request and validates its shape", () => {
    const request = { jsonrpc: "2.0", id: 4, method: ENVIRONMENT_DESCRIBE_METHOD, params: {} };
    expect(parseClientRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(environmentDescriptorSchema.parse(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor);
  });

  it("refuses a descriptor that names something opaque identities replaced", () => {
    expect(environmentDescriptorSchema.safeParse({ ...descriptor, environmentKey: "8f14e45f-ea3b-4b1f-9b0e-000000000000" }).success).toBe(false);
    expect(environmentDescriptorSchema.safeParse({ ...descriptor, actor: { class: "paired_device", id: "d1.x", publicKey: "AAAA" } }).success).toBe(false);
    expect(environmentDescriptorSchema.safeParse({ ...descriptor, stateDir: "/home/me/state" }).success).toBe(false);
    expect(environmentDescriptorSchema.safeParse({ ...descriptor, contract: "ep0" }).success).toBe(false);
  });
});
