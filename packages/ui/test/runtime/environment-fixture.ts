/**
 * The environment a test connects to (RP-13, M18-T13 B).
 *
 * Device storage is disabled until a descriptor arrives, so a test that wants
 * the app to remember anything has to say which environment it is in — exactly
 * as the app does. `activateTestEnvironment()` is the fake handshake's half of
 * that; {@link deviceKeyName} is how a test seeds or inspects what lands on the
 * device, without rebuilding the namespace rule by hand.
 */
import {
  DEFAULT_CACHE_POLICY,
  ENVIRONMENT_CONTRACT_VERSION,
  METHOD_SCOPES,
  PRODUCT_VERSION,
  type CachePolicy,
  type EnvironmentCapabilities,
  type EnvironmentDescriptor,
} from "@lasercode/protocol";
import { DEVICE_KEYS, ENVIRONMENT_NAMESPACE, deviceStore, type DeviceKey } from "../../src/runtime/device-storage.js";

export const TEST_ENVIRONMENT_KEY = "e1.AAAAAAAAAAAAAAAAAAAAAA";
export const OTHER_ENVIRONMENT_KEY = "e1.BBBBBBBBBBBBBBBBBBBBBB";

export const FULL_CAPABILITIES: EnvironmentCapabilities = {
  revisions: true,
  deltas: true,
  snapshots: true,
  durableReads: true,
  search: true,
  diagnostics: true,
  logs: true,
  push: true,
};

export function testDescriptor(overrides: {
  environmentKey?: string;
  capabilities?: Partial<EnvironmentCapabilities>;
  cache?: Partial<CachePolicy>;
  deployment?: EnvironmentDescriptor["deployment"];
  contract?: string;
  version?: string;
} = {}): EnvironmentDescriptor {
  return {
    contract: (overrides.contract ?? ENVIRONMENT_CONTRACT_VERSION) as EnvironmentDescriptor["contract"],
    version: overrides.version ?? PRODUCT_VERSION,
    environmentKey: overrides.environmentKey ?? TEST_ENVIRONMENT_KEY,
    deployment: overrides.deployment ?? "local",
    actor: { class: "local_browser", id: "l1.browser" },
    capabilities: { ...FULL_CAPABILITIES, ...overrides.capabilities },
    cache: { ...DEFAULT_CACHE_POLICY, ...overrides.cache },
    scopes: [...METHOD_SCOPES],
    localOnly: [],
  };
}

/** The key one of this environment's values really lands under. */
export function deviceKeyName(key: DeviceKey, environmentKey = TEST_ENVIRONMENT_KEY): string {
  return `${ENVIRONMENT_NAMESPACE}:${environmentKey}:${key}`;
}

/** Open a namespace the way the handshake does, for a test that needs one. */
export function activateTestEnvironment(overrides?: Parameters<typeof testDescriptor>[0]): EnvironmentDescriptor {
  const descriptor = testDescriptor(overrides);
  deviceStore.activate(descriptor);
  return descriptor;
}

/**
 * Put a value where this environment keeps it, without needing the store to be
 * open: a test seeds before the (fake) handshake runs, exactly as a person's
 * previous visit would have left it there.
 */
export function seedDeviceValue(key: DeviceKey, value: string, environmentKey = TEST_ENVIRONMENT_KEY): void {
  globalThis.localStorage?.setItem(deviceKeyName(key, environmentKey), value);
}

export function readDeviceValue(key: DeviceKey, environmentKey = TEST_ENVIRONMENT_KEY): string | null {
  return globalThis.localStorage?.getItem(deviceKeyName(key, environmentKey)) ?? null;
}

export function clearDeviceValue(key: DeviceKey, environmentKey = TEST_ENVIRONMENT_KEY): void {
  globalThis.localStorage?.removeItem(deviceKeyName(key, environmentKey));
}

/** Seed the remembered destination the way the destination controller writes it. */
export function seedDestination(memory: { tab?: "chat" | "code"; chat?: string; code: unknown }): void {
  seedDeviceValue(DEVICE_KEYS.destination, JSON.stringify({ v: 2, tab: memory.tab ?? "code", ...(memory.chat ? { chat: memory.chat } : {}), code: memory.code }));
}

/** Seed "the last session opened in this project", as the controller records it. */
export function seedRememberedSessions(sessions: Record<string, string>): void {
  seedDeviceValue(DEVICE_KEYS.sessionsByProject, JSON.stringify(sessions));
}

/** Seed the remembered project, as the controller records it. */
export function seedProject(cwd: string | undefined): void {
  if (cwd === undefined) clearDeviceValue(DEVICE_KEYS.project);
  else seedDeviceValue(DEVICE_KEYS.project, cwd);
}

/**
 * A `Storage` a node-environment test can stand in front of the device store.
 *
 * The real one is a browser API; these tests are about what the app writes,
 * not about the browser, so a Map is the honest stand-in. `throws` makes every
 * access fail the way a private window does.
 */
export function installFakeStorage(options: { throws?: boolean } = {}): { entries: Map<string, string>; restore(): void } {
  const entries = new Map<string, string>();
  const fail = (): never => {
    throw new DOMException("denied");
  };
  const storage = {
    get length() {
      return options.throws ? fail() : entries.size;
    },
    key: (index: number) => (options.throws ? fail() : [...entries.keys()][index] ?? null),
    getItem: (key: string) => (options.throws ? fail() : entries.get(key) ?? null),
    setItem: (key: string, value: string) => void (options.throws ? fail() : entries.set(key, value)),
    removeItem: (key: string) => void (options.throws ? fail() : entries.delete(key)),
    clear: () => (options.throws ? fail() : entries.clear()),
  } as unknown as Storage;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return {
    entries,
    restore() {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis as object, "localStorage");
      deviceStore.deactivate();
    },
  };
}
