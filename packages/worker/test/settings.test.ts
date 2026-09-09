/**
 * Laser's curated settings map safely onto the pinned engine without loading
 * or writing the engine's project configuration directory.
 *
 * Everything runs against temp directories; the user's ~/.pi/agent is never
 * read or written.
 */
import { PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingDescriptor, SettingsScope } from "@lasercode/protocol";
import {
  LASER_SETTINGS_KEYS,
  PI_SETTINGS_TOP_LEVEL_KEYS,
  SETTINGS_CLASSIFICATIONS,
  SETTINGS_FIELDS,
  SETTINGS_SECTIONS,
  SettingsAdapter,
  SettingsError,
  getAtPath,
  mergeSettings,
  setAtPath,
  unsetAtPath,
  validateSettingValue,
  settingsCatalog,
} from "../src/settings.js";

let base: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-settings-`));
  cwd = join(base, "project");
  agentDir = join(base, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const adapter = (hostTrusted?: boolean): SettingsAdapter =>
  new SettingsAdapter({ cwd, agentDir, ...(hostTrusted === undefined ? {} : { hostTrusted }) });

/** A value the field will accept, derived from its own control descriptor. */
function sampleFor(field: SettingDescriptor): unknown {
  const type = field.type;
  switch (type.control) {
    case "boolean":
      return field.default === true ? false : true;
    case "text":
      return `${PRODUCT_NAME}-${field.path}`;
    case "number": {
      const min = type.min ?? 1;
      const max = type.max ?? min + 1000;
      return Math.min(max, min + 1);
    }
    case "enum": {
      const options = type.options;
      const other = options.find((o) => o.value !== field.default) ?? options[0];
      return other!.value;
    }
    case "string-list":
      return ["alpha", "beta"];
    case "enum-map":
      return { "anthropic/claude-sonnet-4-20250514": type.options[0]!.value };
    case "json":
      return [{ source: "pi-skills", skills: ["brave-search"] }];
  }
}

describe("settings catalogue", () => {
  it("covers every top-level key of the pinned Pi's Settings interface", () => {
    expect(new Set(PI_SETTINGS_TOP_LEVEL_KEYS).size).toBe(PI_SETTINGS_TOP_LEVEL_KEYS.length);
    // Pi 0.85.0. A pin bump that changes this count is a real task (MX-T2):
    // read core/settings-manager.d.ts and update both the list and the fields.
    expect(PI_SETTINGS_TOP_LEVEL_KEYS.length).toBe(51);

    const covered = new Set(SETTINGS_FIELDS.map((f) => f.key));
    const missing = PI_SETTINGS_TOP_LEVEL_KEYS.filter((key) => !covered.has(key));
    expect(missing).toEqual([]);

    // The product's own keys are the only ones allowed beside the engine's.
    const known = new Set([...PI_SETTINGS_TOP_LEVEL_KEYS, ...LASER_SETTINGS_KEYS]);
    const stray = [...covered].filter((key) => !known.has(key));
    expect(stray).toEqual([]);
    expect(LASER_SETTINGS_KEYS.every((key) => covered.has(key) && !PI_SETTINGS_TOP_LEVEL_KEYS.includes(key))).toBe(true);
  });

  it("exposes only product settings and classifies every engine key", () => {
    const catalog = settingsCatalog();
    expect(SETTINGS_CLASSIFICATIONS.map(({ key }) => key)).toEqual(PI_SETTINGS_TOP_LEVEL_KEYS);
    expect(new Set(SETTINGS_CLASSIFICATIONS.map(({ key }) => key)).size).toBe(PI_SETTINGS_TOP_LEVEL_KEYS.length);
    expect(catalog.fields.every(({ audience }) => audience === "general" || audience === "advanced")).toBe(true);
    const exposed = new Set(catalog.fields.map(({ key }) => key));
    for (const classification of SETTINGS_CLASSIFICATIONS) {
      expect(exposed.has(classification.key)).toBe(classification.disposition === "general" || classification.disposition === "advanced");
    }
    for (const key of LASER_SETTINGS_KEYS) expect(exposed.has(key), key).toBe(true);
    expect(catalog.sections.map(({ id }) => id)).toEqual(["model", "delivery", "context", "images", "retry", "network", "shell", "warnings"]);
  });

  it("gives every field a real section, a unique path, and a description", () => {
    const sections = new Set(SETTINGS_SECTIONS.map((s) => s.id));
    const paths = new Set<string>();
    for (const field of SETTINGS_FIELDS) {
      expect(sections, `${field.path} section`).toContain(field.section);
      expect(paths.has(field.path), `duplicate path ${field.path}`).toBe(false);
      paths.add(field.path);
      expect(field.description.length, `${field.path} description`).toBeGreaterThan(10);
      expect(field.scopes.length).toBeGreaterThan(0);
      // A nested path must be persisted under its own top-level key.
      expect(field.path.split(".")[0]).toBe(field.key);
    }
  });
});

describe("path helpers", () => {
  it("sets, reads and prunes nested paths", () => {
    const doc: Record<string, unknown> = {};
    setAtPath(doc, "retry.provider.maxRetries", 2);
    expect(doc).toEqual({ retry: { provider: { maxRetries: 2 } } });
    expect(getAtPath(doc, "retry.provider.maxRetries")).toBe(2);
    expect(getAtPath(doc, "retry.missing.deep")).toBeUndefined();

    unsetAtPath(doc, "retry.provider.maxRetries");
    // Emptied parents go too, so the file never accumulates `"retry": {}`.
    expect(doc).toEqual({});
  });

  it("keeps siblings when pruning", () => {
    const doc: Record<string, unknown> = { retry: { enabled: true, provider: { maxRetries: 1 } } };
    unsetAtPath(doc, "retry.provider.maxRetries");
    expect(doc).toEqual({ retry: { enabled: true } });
  });

  it("merges like Pi: nested objects merge, arrays replace", () => {
    const merged = mergeSettings(
      { theme: "dark", compaction: { enabled: true, reserveTokens: 16384 }, enabledModels: ["a", "b"] },
      { compaction: { reserveTokens: 8192 }, enabledModels: ["c"] },
    );
    expect(merged).toEqual({
      theme: "dark",
      compaction: { enabled: true, reserveTokens: 8192 },
      enabledModels: ["c"],
    });
  });
});

describe("value validation", () => {
  const field = (path: string): SettingDescriptor => SETTINGS_FIELDS.find((f) => f.path === path)!;

  it("names the setting and the rule it broke", () => {
    expect(validateSettingValue(field("compaction.enabled"), "yes")).toMatch(/compaction\.enabled must be true or false/);
    expect(validateSettingValue(field("autocompleteMaxVisible"), 2)).toMatch(/at least 3/);
    expect(validateSettingValue(field("autocompleteMaxVisible"), 25)).toMatch(/at most 20/);
    expect(validateSettingValue(field("editorPaddingX"), 1.5)).toMatch(/whole number/);
    expect(validateSettingValue(field("transport"), "carrier-pigeon")).toMatch(/must be one of/);
    expect(validateSettingValue(field("extensions"), "not-a-list")).toMatch(/list of strings/);
    expect(validateSettingValue(field("modelThinkingLevels"), { "a/b": "very" })).toMatch(/must be one of/);
  });

  it("accepts every sample the catalogue implies", () => {
    for (const f of SETTINGS_FIELDS) {
      expect(validateSettingValue(f, sampleFor(f)), f.path).toBeUndefined();
    }
  });
});

describe("SettingsAdapter round-trip", () => {
  for (const scope of ["global", "project"] as SettingsScope[]) {
    it(`writes and reads back every writable field at ${scope} scope`, async () => {
      const settings = adapter();
      const fields = settingsCatalog().fields.filter((f) => f.scopes.includes(scope));
      // One batch per top-level key keeps each assertion attributable.
      for (const field of fields) {
        const value = sampleFor(field);
        const snapshot = await settings.apply(scope, [{ path: field.path, op: "set", value }]);
        expect(getAtPath(snapshot[scope].values, field.path), `${scope} ${field.path}`).toEqual(value);
        expect(getAtPath(snapshot.effective, field.path), `effective ${field.path}`).toEqual(value);
      }

      // Every top-level key writable at this scope is now present on disk.
      const file = scope === "global" ? join(agentDir, "settings.json") : join(cwd, PROJECT_DIR_NAME, "settings.json");
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const expectedKeys = new Set(fields.map((f) => f.key));
      for (const key of expectedKeys) expect(Object.keys(onDisk), `${scope} ${key}`).toContain(key);

      // A fresh adapter sees the same values: nothing lived only in memory.
      const reread = adapter();
      await reread.refresh();
      for (const field of fields) {
        expect(getAtPath(reread.snapshot()[scope].values, field.path), `reread ${field.path}`).toEqual(
          sampleFor(field),
        );
      }
    }, 60_000);
  }

  it("unsets a field and prunes the emptied parent", async () => {
    const settings = adapter();
    await settings.apply("global", [{ path: "compaction.reserveTokens", op: "set", value: 4096 }]);
    const after = await settings.apply("global", [{ path: "compaction.reserveTokens", op: "unset" }]);
    expect(after.global.values["compaction"]).toBeUndefined();
  });

  it("project settings override global, per key", async () => {
    const settings = adapter();
    await settings.apply("global", [
      { path: "steeringMode", op: "set", value: "one-at-a-time" },
      { path: "compaction.reserveTokens", op: "set", value: 16384 },
      { path: "compaction.enabled", op: "set", value: true },
    ]);
    const snapshot = await settings.apply("project", [{ path: "compaction.reserveTokens", op: "set", value: 8192 }]);
    expect(snapshot.effective["steeringMode"]).toBe("one-at-a-time");
    expect(snapshot.effective["compaction"]).toEqual({ enabled: true, reserveTokens: 8192 });
  });
});

describe("SettingsAdapter refusals", () => {
  it("rejects an unknown key and names the catalogue", async () => {
    await expect(adapter().apply("global", [{ path: "notASetting", op: "set", value: 1 }])).rejects.toThrow(
      /Unknown or unsupported setting "notASetting".*Settings screen/s,
    );
  });

  it("rejects a global-only key at project scope", async () => {
    await expect(
      adapter().apply("project", [{ path: "httpProxy", op: "set", value: "http://127.0.0.1:7890" }]),
    ).rejects.toThrow(/only be set at global scope/);
  });

  it("refuses engine-private keys even through a direct protocol call", async () => {
    await expect(adapter().apply("global", [{ path: "trackingId", op: "set", value: "x" }])).rejects.toThrow(
      /unsupported setting/,
    );
  });

  it("writes nothing when any change in the batch is invalid", async () => {
    const settings = adapter();
    await expect(
      settings.apply("global", [
        { path: "steeringMode", op: "set", value: "one-at-a-time" },
        { path: "compaction.reserveTokens", op: "set", value: -1 },
      ]),
    ).rejects.toThrow(SettingsError);
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
  });

  it("refuses to overwrite a settings file it cannot parse, and leaves it alone", async () => {
    const file = join(agentDir, "settings.json");
    writeFileSync(file, '{ "steeringMode": "all",,, }', "utf8");
    await expect(adapter().apply("global", [{ path: "steeringMode", op: "set", value: "one-at-a-time" }])).rejects.toThrow(
      /is not valid JSON.*Nothing was written/s,
    );
    expect(readFileSync(file, "utf8")).toBe('{ "steeringMode": "all",,, }');
  });

  it("preserves keys it was not asked to change", async () => {
    const file = join(agentDir, "settings.json");
    writeFileSync(file, JSON.stringify({ steeringMode: "all", somethingPiAddedLater: 42 }, null, 2), "utf8");
    const settings = adapter();
    await settings.apply("global", [{ path: "followUpMode", op: "set", value: "one-at-a-time" }]);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(onDisk["somethingPiAddedLater"]).toBe(42);
    expect(onDisk["steeringMode"]).toBe("all");
    expect(onDisk["followUpMode"]).toBe("one-at-a-time");
  });
});

describe("project trust", () => {
  it("ignores the engine's project settings directory", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ steeringMode: "all" }), "utf8");

    const snapshot = adapter().snapshot();
    expect(snapshot.projectTrust.trusted).toBe(true);
    expect(snapshot.projectTrust.writable).toBe(true);
    expect(snapshot.effective["steeringMode"]).toBeUndefined();
  });

  it("refuses to edit a project the user declined to trust", async () => {
    const settings = adapter(false);
    expect(settings.snapshot().projectTrust.writable).toBe(false);
    await expect(settings.apply("project", [{ path: "steeringMode", op: "set", value: "all" }])).rejects.toThrow(
      new RegExp(`will not write .*${PROJECT_DIR_NAME.replace(".", "\\.")}.*settings\\.json`, "s"),
    );
  });

  it(`uses ${PROJECT_DIR_NAME} for a new project's settings`, async () => {
    const trust = adapter().snapshot().projectTrust;
    expect(trust.trusted).toBe(true);
    expect(trust.writable).toBe(true);
    expect(trust.reason).toMatch(/no .* settings yet/i);
    await adapter().apply("project", [{ path: "steeringMode", op: "set", value: "all" }]);
    expect(existsSync(join(cwd, PROJECT_DIR_NAME, "settings.json"))).toBe(true);
    expect(existsSync(join(cwd, ".pi", "settings.json"))).toBe(false);
  });

  it(`loads trusted ${PROJECT_DIR_NAME} settings and filters engine-private keys`, () => {
    mkdirSync(join(cwd, PROJECT_DIR_NAME), { recursive: true });
    writeFileSync(
      join(cwd, PROJECT_DIR_NAME, "settings.json"),
      JSON.stringify({ steeringMode: "all", packages: ["bad"] }),
      "utf8",
    );

    const snapshot = adapter(true).snapshot();
    expect(snapshot.projectTrust.trusted).toBe(true);
    expect(snapshot.effective["steeringMode"]).toBe("all");
    expect(snapshot.project.values["packages"]).toBeUndefined();
  });
});
