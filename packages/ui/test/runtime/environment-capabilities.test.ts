import { POLICED_METHODS, type ClientMethod } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";

import { capabilityFor, methodCapabilities, type EnvironmentCapability } from "../../src/runtime/environment-capabilities.js";
import { testDescriptor } from "./environment-fixture.js";

const EXPECTED_METHOD_CAPABILITIES = {
  "pi/host/version": [],
  "environment/describe": [],
  "session/load": [],
  "session/revision": ["revisions"],
  "session/search": ["search"],
  "session/entry_range": ["snapshots"],
  "session/entry_regions": ["snapshots"],
  "session/search/cancel": ["search"],
  "session/goal/get": [],
  "session/pending/list": [],
  "pi/session/list": [],
  "pi/session/inbox": [],
  "pi/session/entries": ["snapshots"],
  "pi/session/telemetry": ["snapshots"],
  "pi/session/seen": [],
  "pi/session/detach": [],
  "pi/model/list": [],
  "pi/account-usage/refresh": [],
  "pi/project/list": [],
  "pi/project/git": [],
  "pi/project/git/hosts": [],
  "pi/project/git/commit": [],
  "pi/project/git/push": [],
  "pi/project/git/branch": [],
  "pi/project/git/prose": [],
  "pi/project/pr/create": [],
  "pi/project/pr/read": [],
  "pi/project/pr/checkout": [],
  "pi/project/pr/merge": [],
  "pi/project/pr/viewed": [],
  "pi/project/changes": [],
  "pi/project/file_diff": [],
  "pi/project/file_source": [],
  "pi/project/file_blob": [],
  "pi/project/checkpoint/list": [],
  "pi/project/checkpoint/retention/set": [],
  "pi/project/restore": [],
  "pi/project/workspace": [],
  "pi/project/browse": [],
  "pi/project/files": [],
  "pi/project/read": [],
  "pi/project/env/status": [],
  "pi/settings/list": [],
  "pi/settings/get": [],
  "pi/keybindings/get": [],
  "pi/providers/list": [],
  "pi/models/catalog": [],
  "pi/commands/list": [],
  "pi/prompts/list": [],
  "pi/prefs/get": [],
  "pi/worker/list": [],
  "pi/setup/state": [],
  "pi/transcribe/status": [],
  "mcp/list": [],
  "mcp/import/detect": [],
  "tasks/list": [],
  "tasks/output": [],
  "agents/list": [],
  "agents/skills": [],
  "agents/engine-instructions": [],
  "agents/runs/list": [],
  "agents/worktree/status": [],
  "pi/packages/list": [],
  "pi/packages/install": [],
  "pi/packages/remove": [],
  "pi/packages/update": [],
  "pi/packages/check_updates": [],
  "pi/packages/catalog": [],
  "pi/packages/runtime": [],
  "pi/packages/records": [],
  "session/new": [],
  "session/prompt": [],
  "session/cancel": [],
  "session/set_mode": [],
  "session/goal/action": [],
  "session/pending/add": [],
  "session/pending/edit": [],
  "session/pending/remove": [],
  "session/pending/steer": [],
  "session/pending/clear": [],
  "pi/session/steer": [],
  "pi/session/follow_up": [],
  "pi/session/clear_queue": [],
  "pi/session/fork": [],
  "pi/session/navigate": [],
  "pi/session/rename": [],
  "pi/session/delete": [],
  "pi/session/move": [],
  "pi/session/close": [],
  "pi/session/compact": [],
  "pi/model/set": [],
  "pi/thinking/set": [],
  "pi/transcribe/begin": [],
  "pi/transcribe/chunk": [],
  "pi/transcribe/end": [],
  "pi/transcribe/cancel": [],
  "pi/ui/response": [],
  "pi/worker/prepare": [],
  "pi/worker/recover-agent-failures": [],
  "pi/worker/restart": [],
  "pi/worker/stop": [],
  "tasks/stop": [],
  "pi/task/stop": [],
  "agents/runs/stop": [],
  "agents/worktree/remove": [],
  "pi/settings/set": [],
  "pi/keybindings/set": [],
  "pi/prefs/set": [],
  "pi/project/add": [],
  "pi/project/remove": [],
  "pi/project/reorder": [],
  "pi/project/trust": [],
  "pi/project/isolation/set": [],
  "mcp/call": [],
  "pi/project/env/set": [],
  "pi/project/env/test": [],
  "pi/project/env/refresh": [],
  "pi/providers/login/start": [],
  "pi/providers/login/answer": [],
  "pi/providers/login/cancel": [],
  "pi/providers/logout": [],
  "pi/setup/complete": [],
  "mcp/save": [],
  "mcp/remove": [],
  "mcp/inspect": [],
  "mcp/ping": [],
  "mcp/disconnect": [],
  "mcp/auth/start": [],
  "mcp/auth/complete": [],
  "mcp/auth/logout": [],
  "mcp/import/apply": [],
  "agents/validate": [],
  "agents/save": [],
  "agents/delete": [],
  "agents/set-default": [],
  "agents/set-policy": [],
  "models/profiles/list": [],
  "models/profiles/save": [],
  "models/profiles/delete": [],
  "models/profiles/migrate": [],
  "session/profile/set": [],
  "session/model/pin": [],
  "pi/host/environment": [],
  "agents/sync": [],
  "feature/list": [],
  "feature/set": [],
  "web-search/status": [],
  "web-search/configure": [],
  "pi/logs/query": ["logs"],
  "pi/logs/content": ["logs"],
  "pi/logs/stats": ["logs"],
  "pi/logs/clear": ["logs"],
  "resource/snapshot": ["diagnostics"],
  "resource/history": ["diagnostics"],
  "resource/export": ["diagnostics"],
  "resource/report": ["diagnostics"],
  "pi/worker/retained-stores": [],
  "pi/session/unload": [],
  "pi/worker/safety": [],
  "pi/worker/retire": [],
  "pi/worker/pressure": [],
  "pi/runtime/activation/prepare": [],
  "pi/runtime/activation/status": [],
  "pi/runtime/activation/cancel": [],
  "pi/worker/activation/park": [],
  "pi/worker/activation/status": [],
  "pi/worker/activation/cancel": [],
  "pi/push/config": ["push"],
  "pi/push/subscribe": ["push"],
  "pi/push/unsubscribe": ["push"],
  "pi/push/test": ["push"],
} as const satisfies Record<ClientMethod, readonly EnvironmentCapability[]>;

describe("environment capability decisions", () => {
  it("pins a capability-family expectation for every policed method", () => {
    expect(Object.keys(EXPECTED_METHOD_CAPABILITIES).sort()).toEqual([...POLICED_METHODS].sort());
    for (const method of POLICED_METHODS) {
      expect(methodCapabilities(method as ClientMethod), method).toEqual(EXPECTED_METHOD_CAPABILITIES[method as ClientMethod]);
    }
  });

  it("stays hidden until the authenticated descriptor exists", () => {
    expect(capabilityFor(undefined, "pi/settings/set", { presentation: "explained" })).toEqual({ state: "hidden" });
  });

  it("uses protocol scopes without a UI policy copy", () => {
    const descriptor = testDescriptor({ scopes: ["handshake", "read"] });
    expect(capabilityFor(descriptor, "pi/session/list")).toEqual({ state: "available" });
    expect(capabilityFor(descriptor, "pi/settings/set")).toEqual({ state: "hidden" });
    expect(capabilityFor(descriptor, "pi/settings/set", { presentation: "explained" })).toMatchObject({
      state: "explained",
      explanation: expect.stringMatching(/read.*settings|settings.*connection/i),
    });
  });

  it("honours descriptor local-only methods and protocol reach", () => {
    expect(capabilityFor(
      testDescriptor({ localOnly: ["pi/settings/set"] }),
      "pi/settings/set",
      { presentation: "explained" },
    )).toMatchObject({ state: "explained", explanation: expect.stringMatching(/host computer/i) });

    expect(capabilityFor(
      testDescriptor({ actor: { class: "paired_device", id: "r1.browser" } }),
      "resource/report",
      { presentation: "explained" },
    )).toMatchObject({ state: "explained", explanation: expect.stringMatching(/host computer/i) });
  });

  it("requires descriptor capability bits for their matching surfaces", () => {
    const descriptor = testDescriptor({ capabilities: { diagnostics: false, logs: false, push: false } });
    expect(capabilityFor(descriptor, "resource/snapshot").state).toBe("hidden");
    expect(capabilityFor(descriptor, "pi/logs/query").state).toBe("hidden");
    expect(capabilityFor(descriptor, "pi/push/subscribe").state).toBe("hidden");
    expect(capabilityFor(descriptor, "pi/session/list").state).toBe("available");
  });
});
