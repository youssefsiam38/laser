import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDeviceStore, type DeviceStore } from "../../src/runtime/device-storage.js";
import {
  DEFAULT_SETTINGS_SCOPE,
  createSettingsScopeStore,
  normalizeSettingsScope,
  parseSettingsScope,
  sameSettingsScope,
  type SettingsScopeStore,
} from "../../src/runtime/settings-scope.js";
import { OTHER_ENVIRONMENT_KEY, testDescriptor } from "./environment-fixture.js";

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
  };
}

let device: DeviceStore;
let scope: SettingsScopeStore;

beforeEach(() => {
  const storage = fakeStorage();
  device = createDeviceStore(() => storage);
  scope = createSettingsScopeStore(device);
});

afterEach(() => {
  scope.dispose();
  device.deactivate();
});

describe("Settings scope persistence", () => {
  it("starts Global and refuses to invent state before an environment is active", () => {
    expect(scope.getSnapshot()).toEqual(DEFAULT_SETTINGS_SCOPE);
    expect(scope.set({ view: "project", projectCwd: "/one" })).toBe(false);
    expect(scope.getSnapshot()).toEqual({ view: "global" });
  });

  it("persists explicit and valid unselected Project/Effective views", () => {
    device.activate(testDescriptor());
    expect(scope.set({ view: "project" })).toBe(true);
    expect(scope.getSnapshot()).toEqual({ view: "project" });

    scope.dispose();
    scope = createSettingsScopeStore(device);
    expect(scope.getSnapshot()).toEqual({ view: "project" });

    expect(scope.set({ view: "effective" })).toBe(true);
    scope.dispose();
    scope = createSettingsScopeStore(device);
    expect(scope.getSnapshot()).toEqual({ view: "effective" });
  });

  it("rehydrates per environment and never carries the old target through a switch", () => {
    device.activate(testDescriptor());
    scope.set({ view: "project", projectCwd: "/source" });
    expect(scope.getSnapshot()).toEqual({ view: "project", projectCwd: "/source" });

    device.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY }));
    expect(scope.getSnapshot()).toEqual({ view: "global" });

    scope.set({ view: "effective", projectCwd: "/other" });
    device.deactivate();
    expect(scope.getSnapshot()).toEqual({ view: "global" });
  });
});

describe("Settings scope domain", () => {
  it("normalizes and compares domain values without a persistence version", () => {
    expect(normalizeSettingsScope({ view: "project", projectCwd: "/one" })).toEqual({ view: "project", projectCwd: "/one" });
    expect(normalizeSettingsScope({ view: "global", projectCwd: "/not-global" })).toBeUndefined();
    expect(sameSettingsScope({ view: "effective" }, { view: "effective" })).toBe(true);
    expect(sameSettingsScope({ view: "project", projectCwd: "/one" }, { view: "project", projectCwd: "/two" })).toBe(false);
  });
});

describe("parseSettingsScope", () => {
  it.each([
    [{ v: 1, view: "global" }, { view: "global" }],
    [{ v: 1, view: "project" }, { view: "project" }],
    [{ v: 1, view: "effective" }, { view: "effective" }],
    [{ v: 1, view: "project", projectCwd: "/still-explicit-after-removal" }, { view: "project", projectCwd: "/still-explicit-after-removal" }],
  ])("accepts %o", (stored, expected) => {
    expect(parseSettingsScope(stored)).toEqual(expected);
  });

  it.each([
    undefined,
    { v: 2, view: "global" },
    { v: 1, view: "elsewhere" },
    { v: 1, view: "global", projectCwd: "/not-allowed" },
    { v: 1, view: "project", projectCwd: "" },
    { v: 1, view: "effective", projectCwd: 42 },
    { v: 1, view: "project", extra: true },
  ])("fails closed for %o", (stored) => {
    expect(parseSettingsScope(stored)).toBeUndefined();
  });
});
