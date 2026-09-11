import { FEATURE_MANIFESTS } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { FeatureService } from "../src/features.js";
import { PrefsStore } from "../src/prefs.js";

describe("FeatureService", () => {
  it("keeps engine package language out of product feature manifests", () => {
    expect(JSON.stringify(FEATURE_MANIFESTS)).not.toMatch(/\b(?:pi|package|extension)s?\b/i);
  });

  it("starts with the curated features enabled", () => {
    const service = new FeatureService(new PrefsStore());
    expect(service.list("/project").map(({ manifest, enabled, source }) => ({ id: manifest.id, enabled, source }))).toEqual([
      { id: "web-search", enabled: false, source: "default" },
      { id: "subagents", enabled: true, source: "default" },
      { id: "mcp", enabled: true, source: "default" },
      { id: "goals", enabled: true, source: "default" },
    ]);
  });

  it("lets a project override the global choice without changing another project", () => {
    const service = new FeatureService(new PrefsStore());
    service.set("subagents", false, "global");
    service.set("subagents", true, "project", "/one");

    expect(service.list("/one").find(({ manifest }) => manifest.id === "subagents")).toMatchObject({ enabled: true, source: "project" });
    expect(service.list("/two").find(({ manifest }) => manifest.id === "subagents")).toMatchObject({ enabled: false, source: "global" });
    service.set("subagents", null, "project", "/one");
    expect(service.list("/one").find(({ manifest }) => manifest.id === "subagents")).toMatchObject({ enabled: false, source: "global" });
  });

  it("preserves unknown legacy feature data while ignoring it", () => {
    const prefs = new PrefsStore();
    prefs.set("features", { version: 1, global: { unknown: false }, projects: { "/one": { unknown: true } } });
    const service = new FeatureService(prefs);
    service.set("goals", false, "global");

    expect(prefs.get("features")[0]?.value).toMatchObject({
      global: { unknown: false, goals: false },
      projects: { "/one": { unknown: true } },
    });
  });
});
