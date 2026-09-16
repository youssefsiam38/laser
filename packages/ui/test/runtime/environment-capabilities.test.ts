import { describe, expect, it } from "vitest";

import { capabilityFor } from "../../src/runtime/environment-capabilities.js";
import { testDescriptor } from "./environment-fixture.js";

describe("environment capability decisions", () => {
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
      testDescriptor({ actor: { class: "remote_web", id: "r1.browser" } }),
      "resource/report",
      { presentation: "explained" },
    )).toMatchObject({ state: "explained", explanation: expect.stringMatching(/host computer/i) });
  });

  it("requires descriptor capability bits for their matching surfaces", () => {
    const descriptor = testDescriptor({ capabilities: { diagnostics: false, logs: false, push: false } });
    expect(capabilityFor(descriptor, "resource/snapshot", { capabilities: ["diagnostics"] }).state).toBe("hidden");
    expect(capabilityFor(descriptor, "pi/logs/query", { capabilities: ["logs"] }).state).toBe("hidden");
    expect(capabilityFor(descriptor, "pi/push/subscribe", { capabilities: ["push"] }).state).toBe("hidden");
    expect(capabilityFor(descriptor, "pi/session/list").state).toBe("available");
  });
});
