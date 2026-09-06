/**
 * M4-T2: the JSON escape hatch's diff, and where a setting's value comes from.
 * Both are places where being quietly wrong would lose someone's edit, so they
 * are tested rather than eyeballed.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import type { SettingDescriptor, SettingsCatalog, SettingsSnapshot } from "@lasercode/protocol";

import { changesFromJson, effectiveDiff, rowFor, searchFields } from "../../src/components/settings/model.js";

const field = (path: string, over: Partial<SettingDescriptor> = {}): SettingDescriptor => ({
  path,
  key: path.split(".")[0]!,
  label: path,
  description: `the ${path} setting`,
  section: "model",
  type: { control: "text" },
  scopes: ["global", "project"],
  ...over,
});

const catalog: SettingsCatalog = {
  engineVersion: "0.85.0",
  sections: [
    { id: "model", title: "Model", description: "m" },
    { id: "privacy", title: "Privacy", description: "p" },
  ],
  fields: [
    field("theme", { default: "dark" }),
    field("compaction.enabled", { type: { control: "boolean" }, default: true }),
    field("compaction.reserveTokens", { type: { control: "number" }, default: 16384 }),
    field("enabledModels", { type: { control: "string-list" } }),
    field("trackingId", { section: "privacy", scopes: ["global"], managed: true }),
    field("httpProxy", { section: "privacy", scopes: ["global"] }),
  ],
  topLevelKeys: ["theme", "compaction", "enabledModels", "trackingId", "httpProxy"],
};

const snapshot = (global: Record<string, unknown>, project: Record<string, unknown> = {}): SettingsSnapshot => ({
  cwd: "/p",
  agentDir: "/a",
  global: { path: "/a/settings.json", exists: true, values: global },
  project: { path: "/p/.pi/settings.json", exists: true, values: project },
  effective: mergeDeep(global, project),
  projectTrust: { trusted: true, writable: true, reason: "trusted" },
});

function mergeDeep(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const current = out[key];
    out[key] =
      isObj(current) && isObj(value) ? mergeDeep(current, value) : value;
  }
  return out;
}
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

describe("rowFor", () => {
  it("says which file decided the value", () => {
    const snap = snapshot({ theme: "dark", compaction: { enabled: false } }, { theme: "light" });
    expect(rowFor(catalog.fields[0]!, snap)).toMatchObject({
      global: "dark",
      project: "light",
      effective: "light",
      origin: "project",
    });
    expect(rowFor(catalog.fields[1]!, snap)).toMatchObject({ effective: false, origin: "global" });
    expect(rowFor(catalog.fields[2]!, snap)).toMatchObject({ effective: undefined, origin: "default" });
    expect(rowFor(catalog.fields[3]!, snap)).toMatchObject({ effective: undefined, origin: "unset" });
  });
});

describe("effectiveDiff", () => {
  it("lists only what a file actually sets, path-sorted", () => {
    const rows = effectiveDiff(catalog, snapshot({ theme: "dark", compaction: { reserveTokens: 8192 } }));
    expect(rows.map((row) => row.field.path)).toEqual(["compaction.reserveTokens", "theme"]);
  });
});

describe("searchFields", () => {
  it("puts the exact path first, then prefixes, then labels and descriptions", () => {
    expect(searchFields(catalog.fields, "theme")[0]!.path).toBe("theme");
    expect(searchFields(catalog.fields, "compaction.")[0]!.path).toBe("compaction.enabled");
    expect(searchFields(catalog.fields, "  ")).toHaveLength(catalog.fields.length);
    expect(searchFields(catalog.fields, "nothing-matches-this")).toEqual([]);
  });
});

describe("changesFromJson", () => {
  it("emits one change per edited setting and nothing for the rest", () => {
    const current = { theme: "dark", compaction: { enabled: true, reserveTokens: 16384 } };
    const edited = { theme: "light", compaction: { enabled: true, reserveTokens: 8192 } };
    const { changes, unrepresentable } = changesFromJson(catalog, current, edited, "global");
    expect(unrepresentable).toEqual([]);
    expect(changes).toEqual([
      { path: "theme", op: "set", value: "light" },
      { path: "compaction.reserveTokens", op: "set", value: 8192 },
    ]);
  });

  it("unsets a key the editor deleted", () => {
    const { changes } = changesFromJson(catalog, { theme: "dark" }, {}, "global");
    expect(changes).toEqual([{ path: "theme", op: "unset" }]);
  });

  it(`leaves keys ${PRODUCT_NAME} does not know about exactly as they were`, () => {
    const current = { theme: "dark", futurePiSetting: { deep: 1 } };
    const edited = { theme: "light", futurePiSetting: { deep: 1 } };
    const { changes, unrepresentable } = changesFromJson(catalog, current, edited, "global");
    expect(changes).toEqual([{ path: "theme", op: "set", value: "light" }]);
    expect(unrepresentable).toEqual([]);
  });

  it("refuses, by name, an edit to a key it cannot write", () => {
    const current = { theme: "dark", futurePiSetting: { deep: 1 } };
    const edited = { theme: "dark", futurePiSetting: { deep: 2 } };
    const { changes, unrepresentable } = changesFromJson(catalog, current, edited, "global");
    expect(changes).toEqual([]);
    expect(unrepresentable).toEqual(["futurePiSetting.deep"]);
  });

  it("refuses an edit to a key Pi manages itself", () => {
    const { changes, unrepresentable } = changesFromJson(catalog, { trackingId: "a" }, { trackingId: "b" }, "global");
    expect(changes).toEqual([]);
    expect(unrepresentable).toEqual(["trackingId"]);
  });

  it("refuses a global-only key edited in the project document", () => {
    const { changes, unrepresentable } = changesFromJson(catalog, {}, { httpProxy: "http://x" }, "project");
    expect(changes).toEqual([]);
    expect(unrepresentable).toEqual(["httpProxy"]);
  });

  it("treats an array as a whole value, the way Pi merges settings", () => {
    const { changes } = changesFromJson(catalog, { enabledModels: ["a", "b"] }, { enabledModels: ["a"] }, "global");
    expect(changes).toEqual([{ path: "enabledModels", op: "set", value: ["a"] }]);
  });
});
