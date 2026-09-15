import { describe, expect, it } from "vitest";
import {
  RESOURCE_ASSOCIATIONS_MAX,
  RESOURCE_HISTORY_MAX_AGE_MS,
  RESOURCE_HISTORY_MAX_BYTES,
  RESOURCE_HISTORY_MAX_PROCESS_ROWS,
  RESOURCE_HISTORY_MAX_SNAPSHOTS,
  RESOURCE_LABEL_MAX,
  PRODUCT_NAME,
  RESOURCE_PROCESS_ROLES,
  RESOURCE_STORE_KEYS,
  boundedResourceIds,
  boundedResourceText,
  resourceMeasure,
  sanitizeResourceLabel,
} from "../src/index.js";

describe("resource measures", () => {
  it("never turns a missing counter into a zero", () => {
    expect(resourceMeasure(undefined, "permission_denied")).toEqual({ status: "unavailable", reason: "permission_denied" });
    expect(resourceMeasure(Number.NaN, "collector_failed")).toEqual({ status: "unavailable", reason: "collector_failed" });
    // Zero is a real answer when we read it.
    expect(resourceMeasure(0, "collector_failed")).toEqual({ status: "available", value: 0 });
  });

  it("bounds a failure detail and keeps it one readable line", () => {
    const detail = boundedResourceText(`${"x".repeat(500)}\n\nsecond line`);
    expect(detail.length).toBe(200);
    expect(detail).not.toContain("\n");
  });
});

describe("resource labels", () => {
  it("keeps a plain executable name and strips anything that could carry text", () => {
    const workerBinary = `${PRODUCT_NAME}-worker`;
    expect(sanitizeResourceLabel(workerBinary)).toBe(workerBinary);
    expect(sanitizeResourceLabel("node --token=s3cret")).toBe("node---token-s3cret".slice(0, RESOURCE_LABEL_MAX));
    expect(sanitizeResourceLabel("")).toBe("unknown");
    expect(sanitizeResourceLabel("a".repeat(200)).length).toBe(RESOURCE_LABEL_MAX);
  });

  it("bounds an association list and says when it cut one", () => {
    const ids = Array.from({ length: RESOURCE_ASSOCIATIONS_MAX + 5 }, (_, index) => `s${index}`);
    const bounded = boundedResourceIds(ids);
    expect(bounded.ids).toHaveLength(RESOURCE_ASSOCIATIONS_MAX);
    expect(bounded.truncated).toBe(true);
    expect(boundedResourceIds(["only"]).truncated).toBe(false);
  });
});

describe("retention bounds", () => {
  it("matches the shape RP-1 asks for, with four independent limits", () => {
    expect(RESOURCE_HISTORY_MAX_AGE_MS).toBe(60 * 60_000);
    expect(RESOURCE_HISTORY_MAX_SNAPSHOTS).toBe(3600);
    expect(RESOURCE_HISTORY_MAX_PROCESS_ROWS).toBe(20_000);
    expect(RESOURCE_HISTORY_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it("has no role for an agent run: a run is not a process", () => {
    expect(RESOURCE_PROCESS_ROLES).not.toContain("agent_run");
    expect(RESOURCE_PROCESS_ROLES).toContain("project_worker");
    expect(RESOURCE_PROCESS_ROLES).toContain("unknown_descendant");
  });
});

describe("retained-store keys", () => {
  it("names one producer per owning subsystem, including the two device-local ones", () => {
    // `rendererViews` is the transcripts a viewer holds in memory (RP-5);
    // `deviceCache` is the bounded tails it has written to its own device
    // (RP-10). Both are per device, so a phone reports its own and never the
    // desktop's; the host fills the rest.
    expect(RESOURCE_STORE_KEYS).toContain("rendererViews");
    expect(RESOURCE_STORE_KEYS).toContain("deviceCache");
    expect(new Set(RESOURCE_STORE_KEYS).size).toBe(RESOURCE_STORE_KEYS.length);
  });
});
