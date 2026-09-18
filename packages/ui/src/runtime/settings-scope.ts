import { DEVICE_KEYS, deviceStore, type DeviceStore } from "./device-storage.js";

export type SettingsScopeView = "global" | "project" | "effective";

/**
 * The Settings target chosen by the person.
 *
 * Project and Effective deliberately allow no project: that is a designed
 * state which asks for a choice instead of borrowing one from the app.
 */
export interface SettingsScopeState {
  view: SettingsScopeView;
  projectCwd?: string | undefined;
}

export const DEFAULT_SETTINGS_SCOPE: SettingsScopeState = Object.freeze({ view: "global" });

interface StoredSettingsScope {
  v: 1;
  view: SettingsScopeView;
  projectCwd?: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Canonicalize one domain value without involving its storage envelope. */
export function normalizeSettingsScope(value: SettingsScopeState): SettingsScopeState | undefined {
  if (!isRecord(value)) return undefined;
  const view: unknown = value.view;
  if (view !== "global" && view !== "project" && view !== "effective") return undefined;
  const projectCwd: unknown = value.projectCwd;
  if (projectCwd !== undefined && (typeof projectCwd !== "string" || projectCwd.trim() === "")) return undefined;
  if (view === "global" && projectCwd !== undefined) return undefined;
  return projectCwd === undefined ? { view } : { view, projectCwd };
}

export function sameSettingsScope(left: SettingsScopeState, right: SettingsScopeState): boolean {
  return left.view === right.view && left.projectCwd === right.projectCwd;
}

/** Parse only the versioned persistence envelope, then delegate the domain rules. */
export function parseSettingsScope(value: unknown): SettingsScopeState | undefined {
  if (!isRecord(value) || value["v"] !== 1) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "v" && key !== "view" && key !== "projectCwd")) return undefined;
  return normalizeSettingsScope({
    view: value["view"],
    ...(value["projectCwd"] === undefined ? {} : { projectCwd: value["projectCwd"] }),
  } as SettingsScopeState);
}

export interface SettingsScopeStore {
  getSnapshot(): SettingsScopeState;
  subscribe(listener: () => void): () => void;
  set(next: SettingsScopeState): boolean;
  /** Test/lifecycle seam; the app-owned singleton lives for the page. */
  dispose(): void;
}

function stored(next: SettingsScopeState): StoredSettingsScope {
  return next.projectCwd === undefined
    ? { v: 1, view: next.view }
    : { v: 1, view: next.view, projectCwd: next.projectCwd };
}

/** One environment-aware live store, backed only by the device-store authority. */
export function createSettingsScopeStore(storage: DeviceStore): SettingsScopeStore {
  let snapshot: SettingsScopeState = DEFAULT_SETTINGS_SCOPE;
  const listeners = new Set<() => void>();

  const publish = (next: SettingsScopeState): void => {
    if (sameSettingsScope(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const rehydrate = (): void => {
    publish(storage.readJson(DEVICE_KEYS.settingsScope, parseSettingsScope) ?? DEFAULT_SETTINGS_SCOPE);
  };

  const unsubscribeStorage = storage.subscribe(rehydrate);
  if (storage.status().active) rehydrate();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      const normalized = normalizeSettingsScope(next);
      if (!normalized || !storage.status().active) return false;
      storage.writeJson(DEVICE_KEYS.settingsScope, stored(normalized));
      publish(normalized);
      return true;
    },
    dispose() {
      unsubscribeStorage();
      listeners.clear();
    },
  };
}

export const settingsScopeStore = createSettingsScopeStore(deviceStore);
