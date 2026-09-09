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

// ---- M13-T49: why a catalogue row is absent from the pickers ---------------

import {
  connectedProviderIds,
  enabledModelsScope,
  hiddenByListCount,
  modelOfferState,
  matchesModelView,
  offerStateCounts,
  patternForModel,
  settingsListScope,
  withModelOffered,
  withModelsSwitchedOff,
  withModelsSwitchedOn,
} from "../../src/components/settings/model.js";

const connected = new Set(["openai"]);

describe("modelOfferState", () => {
  it("blames the sign-in, not the list, when the provider has no credential", () => {
    // With a list set the engine marks every model of an unconnected provider
    // `enabled: false` too; the row must still say "no key", never "your list".
    expect(modelOfferState({ provider: "anthropic", enabled: false }, connected)).toBe("provider-not-connected");
    expect(modelOfferState({ provider: "anthropic", enabled: true }, connected)).toBe("provider-not-connected");
  });

  it("blames the list only for a connected provider's model", () => {
    expect(modelOfferState({ provider: "openai", enabled: false }, connected)).toBe("hidden-by-list");
    expect(modelOfferState({ provider: "openai", enabled: true }, connected)).toBe("offered");
  });

  it("cannot blame a provider it could not read", () => {
    expect(modelOfferState({ provider: "anthropic", enabled: true }, undefined)).toBe("offered");
    expect(modelOfferState({ provider: "anthropic", enabled: false }, undefined)).toBe("hidden-by-list");
    expect(connectedProviderIds(undefined)).toBeUndefined();
    expect(connectedProviderIds([])).toBeUndefined();
  });
});

describe("hiddenByListCount", () => {
  it("counts only rows a sign-in would not fix", () => {
    const models = [
      { provider: "openai", enabled: false },
      { provider: "openai", enabled: false },
      { provider: "openai", enabled: true },
      { provider: "anthropic", enabled: false },
    ];
    expect(hiddenByListCount(models, connected)).toBe(2);
    expect(hiddenByListCount(models, undefined)).toBe(3);
    expect(hiddenByListCount([], connected)).toBe(0);
  });
});

describe("withModelOffered", () => {
  it("appends the canonical reference and keeps the narrow list", () => {
    expect(patternForModel({ provider: "openai", id: "gpt-6-astra" })).toBe("openai/gpt-6-astra");
    expect(withModelOffered(["gpt-5*"], { provider: "openai", id: "gpt-6-astra" })).toEqual(["gpt-5*", "openai/gpt-6-astra"]);
    expect(withModelOffered(null, { provider: "openai", id: "gpt-6-astra" })).toEqual(["openai/gpt-6-astra"]);
  });

  it("does not add a pattern already present, whatever its case or spacing", () => {
    expect(withModelOffered([" OpenAI/GPT-6-Astra "], { provider: "openai", id: "gpt-6-astra" })).toEqual([" OpenAI/GPT-6-Astra "]);
  });
});

describe("the switches (M13-T49 addendum)", () => {
  it("puts the person's own switch before every other reason", () => {
    expect(modelOfferState({ provider: "openai", enabled: false, switchedOff: true, hiddenByList: true }, connected)).toBe("switched-off");
    expect(modelOfferState({ provider: "anthropic", enabled: false, switchedOff: true }, connected)).toBe("switched-off");
    expect(modelOfferState({ provider: "openai", enabled: false, switchedOff: false, hiddenByList: true }, connected)).toBe("hidden-by-list");
    // A host that reports the list's verdict separately is believed over `enabled`.
    expect(modelOfferState({ provider: "openai", enabled: true, hiddenByList: false }, connected)).toBe("offered");
  });

  it("sorts rows into the three views, hidden being every reason at once", () => {
    expect(matchesModelView("offered", "all")).toBe(true);
    expect(matchesModelView("offered", "enabled")).toBe(true);
    expect(matchesModelView("offered", "hidden")).toBe(false);
    for (const state of ["switched-off", "hidden-by-list", "provider-not-connected"] as const) {
      expect(matchesModelView(state, "hidden"), state).toBe(true);
      expect(matchesModelView(state, "enabled"), state).toBe(false);
    }
    expect(offerStateCounts([
      { provider: "openai", enabled: true },
      { provider: "openai", enabled: false, switchedOff: true },
      { provider: "openai", enabled: false },
      { provider: "anthropic", enabled: false },
    ], connected)).toEqual({ offered: 1, "switched-off": 1, "hidden-by-list": 1, "provider-not-connected": 1 });
  });

  it("switches off by exact reference, once, and leaves the rest of the list alone", () => {
    const astra = { provider: "openai", id: "gpt-6-astra" };
    expect(withModelsSwitchedOff([], [astra])).toEqual(["openai/gpt-6-astra"]);
    expect(withModelsSwitchedOff(["anthropic/claude-sonnet-4"], [astra, astra])).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-6-astra"]);
    expect(withModelsSwitchedOff([" OpenAI/GPT-6-Astra "], [astra])).toEqual([" OpenAI/GPT-6-Astra "]);
  });

  it("switches on by removing the reference, whatever its case, and nothing else", () => {
    const astra = { provider: "openai", id: "gpt-6-astra" };
    expect(withModelsSwitchedOn(["OpenAI/gpt-6-astra", "anthropic/claude-sonnet-4"], [astra])).toEqual(["anthropic/claude-sonnet-4"]);
    expect(withModelsSwitchedOn(["anthropic/claude-sonnet-4"], [astra])).toEqual(["anthropic/claude-sonnet-4"]);
  });

  it("never writes an enumerated allow-list to switch a model off", () => {
    // A disable list does not mention what stays on, so a model that arrives
    // after the switch is not on it — and therefore not hidden.
    const list = withModelsSwitchedOff([], [{ provider: "openai", id: "gpt-5" }]);
    expect(list).toEqual(["openai/gpt-5"]);
    expect(list.some((entry) => entry.toLowerCase() === "openai/gpt-7-nova")).toBe(false);
  });

  it("writes each list where it lives", () => {
    expect(settingsListScope(snapshot({}, { disabledModels: ["a"] }), "disabledModels")).toBe("project");
    expect(settingsListScope(snapshot({ disabledModels: ["a"] }), "disabledModels")).toBe("global");
    expect(settingsListScope(snapshot({}, { enabledModels: ["a"] }), "disabledModels")).toBe("global");
  });
});

describe("enabledModelsScope", () => {
  it("writes where the list lives", () => {
    expect(enabledModelsScope(undefined)).toBe("global");
    expect(enabledModelsScope(snapshot({ enabledModels: ["a"] }))).toBe("global");
    expect(enabledModelsScope(snapshot({ enabledModels: ["a"] }, { enabledModels: ["b"] }))).toBe("project");
    expect(enabledModelsScope(snapshot({}, { enabledModels: [] }))).toBe("project");
  });
});
