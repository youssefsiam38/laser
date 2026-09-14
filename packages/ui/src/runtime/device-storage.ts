/**
 * The one authority over what this device remembers (RP-13, M18-T13 B).
 *
 * Everything the browser keeps that could name a conversation — a session
 * path, a project directory, a fold, a pin, an archived thread, a remembered
 * destination, a draft somebody typed — belongs to **one environment**. A
 * laptop can talk to a local host today and a hosted workspace tomorrow, and
 * what it kept for the first must never appear in the second. So no module
 * builds a storage key of its own any more: they all ask here, and here starts
 * **disabled**.
 *
 * The rules, in the order they matter:
 *
 * 1. **Nothing before the descriptor.** Until {@link DeviceStore.activate} is
 *    given a valid `EnvironmentDescriptor`, every read answers `undefined` and
 *    every write does nothing. That is not a convention a call site can forget:
 *    there is no key to read.
 * 2. **One namespace per environment.** `laser-env:<environmentKey>:<suffix>`,
 *    where `environmentKey` is RP-9's opaque public key (`e1.…`). No path, no
 *    UUID, no device identity — not in the namespace and not in the
 *    fingerprint beside it.
 * 3. **Foreign namespaces and legacy keys are purged, never adopted.** The old
 *    unscoped keys (`laser-draft:<path>`, `laser-archived`, …) have no
 *    provenance: assigning them to whichever environment connects first is
 *    exactly the leak this task closes. They are removed.
 * 4. **A purge that could not finish keeps the store disabled.** The scan is
 *    bounded and cooperative, and if it hits its ceiling or the removal cannot
 *    be verified, activation *fails* — the app shows a connection failure
 *    rather than reading half a purged namespace.
 * 5. **`cache` is the single admission point for content.** Drafts are the
 *    only content B stores, and they live or die by the environment's cache
 *    policy: disabled transcripts, any zero bound, or a required encrypted
 *    store (which a browser cannot prove) means content cannot be read or
 *    written and what is already here is purged. Attachments are never stored.
 * 6. **A downgrade invalidates what it took away** before the namespace opens:
 *    a new contract or a capability that was true and is now false clears the
 *    whole namespace; a tightened cache clears the content in it.
 *
 * Local browser storage is **not encrypted**. Everything here is readable by
 * anything with access to the profile, which is why paths live behind an
 * environment namespace, why content obeys the policy, and why nothing in this
 * module is ever logged or exported.
 */
import {
  ENVIRONMENT_CONTRACT_VERSION,
  ENVIRONMENT_KEY_PATTERN,
  storageKey,
  type CachePolicy,
  type EnvironmentCapabilities,
  type EnvironmentDescriptor,
} from "@lasercode/protocol";

/** `laser-env` — the root every environment-scoped key hangs from. */
export const ENVIRONMENT_NAMESPACE = storageKey("env");

/**
 * Keys a namespace can hold. One flat vocabulary so the purge, the tests and
 * the reader all speak the same names, and so a family (drafts, per-session
 * detail levels) is one bounded key rather than a key per session path.
 */
export const DEVICE_KEYS = {
  /** `{v:2, tab, chat?, code}` — the remembered main destination. */
  destination: "destination",
  /** `{ "<cwd>": "<session path>" }` — the last session opened per project. */
  sessionsByProject: "sessions",
  /** The last project cwd. */
  project: "project",
  beamSession: "beam-session",
  archived: "archived",
  sessionGroups: "session-groups",
  sessionPins: "session-pins",
  sessionFolds: "session-folds",
  /** `{ "<session path>": "answers"|"reasoning"|"everything" }`. */
  activityDetail: "activity-detail",
  /** `[{path, id, open}]`, bounded. */
  activityDisclosure: "activity-disclosure",
  fleetCleared: "fleet-cleared",
  /** Content: `{ "<id>": {text, at} }`. Admission-gated, bounded. */
  drafts: "drafts",
  /** The descriptor fingerprint this namespace was written under. */
  descriptor: "descriptor",
} as const;

export type DeviceKey = (typeof DEVICE_KEYS)[keyof typeof DEVICE_KEYS];

/** Every key that is content, and therefore subject to the cache policy. */
const CONTENT_KEYS: readonly DeviceKey[] = [DEVICE_KEYS.drafts];

/**
 * The unscoped keys this product wrote before environments existed.
 *
 * They are purged, never migrated: not one of them records which environment
 * its paths came from. `laser-projects` (the pre-M2 local project list) is in
 * the list for the same reason — it is a list of directories with no
 * provenance, and the host has owned projects since M2.
 */
export const LEGACY_EXACT_KEYS: readonly string[] = [
  storageKey("session"),
  storageKey("project"),
  storageKey("session-tab-last"),
  storageKey("beam-session"),
  storageKey("archived"),
  storageKey("session-groups"),
  storageKey("session-pins"),
  storageKey("session-folds"),
  storageKey("activity-disclosure-overrides"),
  storageKey("fleet-cleared"),
  storageKey("projects"),
];

/** Legacy key families, one key per session path or per landing. */
export const LEGACY_KEY_PREFIXES: readonly string[] = [storageKey("draft:"), storageKey("activity-detail:")];

/**
 * Keys that belong to no environment and stay where they are: appearance,
 * window geometry, which tab was last shown, onboarding progress and the
 * "I dismissed that" timestamps. None of them names a conversation, a project
 * or a machine, which is the whole test.
 */
export const NEUTRAL_KEYS: readonly string[] = [
  storageKey("panels"),
  storageKey("sessions-tab"),
  storageKey("setup-step"),
  storageKey("mobile-install-dismissed"),
  storageKey("mobile-notify-hint-dismissed"),
];

/** Neutral key families (`laser-mobile-insecure-dismissed:<origin>`). */
export const NEUTRAL_KEY_PREFIXES: readonly string[] = [storageKey("mobile-insecure-dismissed:")];

/**
 * How many keys one purge may look at.
 *
 * A bound, because a scan of somebody else's enormous profile must not block
 * the first paint — and a *failure*, not a truncation, because a purge that
 * stopped early cannot promise the namespace it is about to open is clean.
 */
export const MAX_SCANNED_KEYS = 5_000;

/** Ceilings that apply however generous the environment's policy is. */
export const DRAFT_HARD_LIMITS = {
  /** `localStorage` is a few megabytes in total; drafts are a guest in it. */
  bytes: 512 * 1024,
  entries: 64,
} as const;

export type ContentRefusal = "inactive" | "policy" | "bounds" | "encryption";

export interface DeviceStorageStatus {
  active: boolean;
  /** The opaque environment key in force, never anything derived from a path. */
  environmentKey: string | undefined;
  /** May content (today: drafts) be read and written? */
  content: boolean;
  /** Why not, when it may not. */
  refusal: ContentRefusal | undefined;
}

export interface ActivationResult {
  ok: boolean;
  /** Person-readable, for the connection failure line. Present when `!ok`. */
  reason?: string;
  /**
   * The environment this store was scoped to a moment ago, if any.
   *
   * `undefined` means this is the first environment of this page's life, which
   * is the ordinary case and is *not* a switch: there is nothing from another
   * environment in memory to throw away, and throwing away what this
   * connection has already set up would be a bug rather than isolation.
   */
  previous: string | undefined;
  /** True when this is a different environment from the one last active. */
  changed: boolean;
  /** What the descriptor comparison threw away before opening the namespace. */
  invalidated: "none" | "namespace" | "content";
}

interface Fingerprint {
  contract: string;
  capabilities: EnvironmentCapabilities;
  cache: CachePolicy;
}

export interface DraftRecord {
  text: string;
  at: string;
}

export interface DeviceStore {
  status(): DeviceStorageStatus;
  /**
   * Remove the pre-environment keys, whatever happens next.
   *
   * They are unsafe in every environment, so a view that could not establish
   * one still takes them off this device rather than leaving them for whoever
   * connects next. Best effort by design: a browser that refuses storage has
   * nothing to remove.
   */
  purgeLegacy(): void;
  /** Notified after every activation, deactivation and policy change. */
  subscribe(listener: () => void): () => void;
  activate(descriptor: EnvironmentDescriptor): ActivationResult;
  /** Close the namespace. Reads and writes stop; nothing stored is deleted. */
  deactivate(): void;
  read(key: DeviceKey): string | undefined;
  write(key: DeviceKey, value: string | undefined): void;
  readJson<T>(key: DeviceKey, parse: (value: unknown) => T | undefined): T | undefined;
  writeJson(key: DeviceKey, value: unknown): void;
  /** One draft, by session path or landing key. `undefined` when inadmissible or expired. */
  readDraft(id: string): DraftRecord | undefined;
  /** Store or forget one draft, within the environment's cache bounds. */
  writeDraft(id: string, text: string | undefined): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A bounded, cooperative snapshot of the keys in a `Storage`.
 *
 * `undefined` means "could not be taken": the store threw (a private window, a
 * browser that blocks site data) or there are more keys than {@link
 * MAX_SCANNED_KEYS}. Both fail closed.
 */
export function snapshotKeys(storage: Storage, max = MAX_SCANNED_KEYS): string[] | undefined {
  try {
    if (storage.length > max) return undefined;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      if (keys.length >= max) return undefined;
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch {
    return undefined;
  }
}

/** Is this one of the unscoped keys that must not survive? */
export function isLegacyDeviceKey(key: string): boolean {
  if (NEUTRAL_KEYS.includes(key)) return false;
  if (NEUTRAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  if (LEGACY_EXACT_KEYS.includes(key)) return true;
  return LEGACY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The environment a namespaced key belongs to, or `undefined` if it is not one. */
export function namespaceOf(key: string): string | undefined {
  const prefix = `${ENVIRONMENT_NAMESPACE}:`;
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  const separator = rest.indexOf(":");
  return separator > 0 ? rest.slice(0, separator) : undefined;
}

export function createDeviceStore(getStorage: () => Storage | null): DeviceStore {
  let storage: Storage | null = null;
  let environmentKey: string | undefined;
  let cache: CachePolicy | undefined;
  let content = false;
  let refusal: ContentRefusal | undefined = "inactive";
  let snapshot: DeviceStorageStatus = { active: false, environmentKey: undefined, content: false, refusal: "inactive" };
  const listeners = new Set<() => void>();

  const publish = (): void => {
    snapshot = { active: environmentKey !== undefined, environmentKey, content, refusal };
    for (const listener of [...listeners]) listener();
  };

  const open = (): Storage | null => {
    try {
      return getStorage();
    } catch {
      return null;
    }
  };

  const keyFor = (key: DeviceKey): string | undefined =>
    environmentKey === undefined ? undefined : `${ENVIRONMENT_NAMESPACE}:${environmentKey}:${key}`;

  const rawRead = (key: DeviceKey): string | undefined => {
    const name = keyFor(key);
    if (!name || !storage) return undefined;
    try {
      return storage.getItem(name) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const rawWrite = (key: DeviceKey, value: string | undefined): void => {
    const name = keyFor(key);
    if (!name || !storage) return;
    try {
      if (value === undefined) storage.removeItem(name);
      else storage.setItem(name, value);
    } catch {
      // A private window, a full quota, a browser that refuses site data: the
      // live state in memory stays authoritative and nothing is lost that was
      // not already only a convenience.
    }
  };

  /** Content admission, from the environment's cache policy and nothing else. */
  const admitContent = (policy: CachePolicy): { content: boolean; refusal: ContentRefusal | undefined } => {
    if (policy.transcripts === "disabled") return { content: false, refusal: "policy" };
    // No browser storage can prove it is encrypted at rest, so a policy that
    // requires one is a policy that forbids content here. Saying that plainly
    // is the honest answer; pretending `localStorage` qualifies is not.
    if (policy.requireDeviceEncryption) return { content: false, refusal: "encryption" };
    if (policy.maxBytes <= 0 || policy.maxSessions <= 0 || policy.maxEntriesPerSession <= 0 || policy.maxAgeHours <= 0) {
      return { content: false, refusal: "bounds" };
    }
    return { content: true, refusal: undefined };
  };

  const fingerprintOf = (descriptor: EnvironmentDescriptor): Fingerprint => ({
    contract: descriptor.contract,
    capabilities: { ...descriptor.capabilities },
    cache: { ...descriptor.cache },
  });

  const readFingerprint = (): Fingerprint | undefined => {
    const raw = rawRead(DEVICE_KEYS.descriptor);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || typeof parsed["contract"] !== "string") return undefined;
      if (!isRecord(parsed["capabilities"]) || !isRecord(parsed["cache"])) return undefined;
      return parsed as unknown as Fingerprint;
    } catch {
      return undefined;
    }
  };

  /** What a new descriptor takes away from the one this namespace was written under. */
  const downgrade = (previous: Fingerprint | undefined, next: Fingerprint): "none" | "namespace" | "content" => {
    if (!previous) return "none";
    if (previous.contract !== next.contract) return "namespace";
    const after = next.capabilities as unknown as Record<string, boolean>;
    for (const [name, was] of Object.entries(previous.capabilities as unknown as Record<string, boolean>)) {
      if (was === true && after[name] !== true) return "namespace";
    }
    const before = previous.cache;
    const now = next.cache;
    const tighter =
      (before.transcripts === "allowed" && now.transcripts === "disabled") ||
      (before.attachments === "reference" && now.attachments === "none") ||
      (!before.requireDeviceEncryption && now.requireDeviceEncryption) ||
      now.maxBytes < before.maxBytes ||
      now.maxSessions < before.maxSessions ||
      now.maxEntriesPerSession < before.maxEntriesPerSession ||
      now.maxAgeHours < before.maxAgeHours;
    return tighter ? "content" : "none";
  };

  /**
   * Remove every legacy key and every foreign namespace, then prove it worked.
   *
   * Returns false when the scan could not be taken or something unsafe is
   * still there afterwards — in which case the store stays shut.
   */
  const purgeUnsafe = (store: Storage, keep: string): boolean => {
    const unsafe = (key: string): boolean => {
      if (isLegacyDeviceKey(key)) return true;
      const namespace = namespaceOf(key);
      return namespace !== undefined && namespace !== keep;
    };
    const keys = snapshotKeys(store);
    if (!keys) return false;
    for (const key of keys) {
      if (!unsafe(key)) continue;
      try {
        store.removeItem(key);
      } catch {
        return false;
      }
    }
    // Verified, not assumed: a half-purged device must never become readable.
    const after = snapshotKeys(store);
    return after !== undefined && !after.some(unsafe);
  };

  const purgeNamespace = (only: readonly DeviceKey[] | "all"): void => {
    const keys = only === "all" ? Object.values(DEVICE_KEYS) : only;
    for (const key of keys) rawWrite(key, undefined);
  };

  // ------------------------------------------------------------------ drafts

  const draftBounds = (): { bytes: number; entries: number; ageMs: number } | undefined => {
    if (!content || !cache) return undefined;
    return {
      bytes: Math.min(cache.maxBytes, DRAFT_HARD_LIMITS.bytes),
      entries: Math.min(cache.maxSessions, DRAFT_HARD_LIMITS.entries),
      ageMs: cache.maxAgeHours * 60 * 60 * 1000,
    };
  };

  const validDraft = (value: unknown): DraftRecord | undefined => {
    if (!isRecord(value)) return undefined;
    const { text, at } = value as { text?: unknown; at?: unknown };
    if (typeof text !== "string" || text.trim() === "" || typeof at !== "string") return undefined;
    return { text, at };
  };

  /** Every admissible draft, oldest first, with expired ones already dropped. */
  const readDrafts = (): Array<[string, DraftRecord]> => {
    const bounds = draftBounds();
    if (!bounds) return [];
    const raw = rawRead(DEVICE_KEYS.drafts);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return [];
      const now = Date.now();
      const entries: Array<[string, DraftRecord]> = [];
      for (const [id, value] of Object.entries(parsed)) {
        const draft = validDraft(value);
        if (!draft) continue;
        const at = Date.parse(draft.at);
        if (Number.isFinite(at) && now - at > bounds.ageMs) continue;
        entries.push([id, draft]);
      }
      return entries;
    } catch {
      return [];
    }
  };

  const writeDrafts = (entries: Array<[string, DraftRecord]>): void => {
    const bounds = draftBounds();
    if (!bounds) return;
    let kept = entries.slice(-bounds.entries);
    let serialized = JSON.stringify(Object.fromEntries(kept));
    // Oldest first out, until the whole family fits the environment's bound.
    while (kept.length > 0 && serialized.length > bounds.bytes) {
      kept = kept.slice(1);
      serialized = JSON.stringify(Object.fromEntries(kept));
    }
    rawWrite(DEVICE_KEYS.drafts, kept.length === 0 ? undefined : serialized);
  };

  return {
    status: () => snapshot,

    purgeLegacy() {
      const store = open();
      if (!store) return;
      const keys = snapshotKeys(store);
      if (!keys) return;
      for (const key of keys) {
        if (!isLegacyDeviceKey(key)) continue;
        try {
          store.removeItem(key);
        } catch {
          // Nothing more this view can do; activation will refuse to open a
          // namespace while an unsafe key is still there.
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    activate(descriptor) {
      const key = descriptor.environmentKey;
      const previous = environmentKey;
      if (!ENVIRONMENT_KEY_PATTERN.test(key) || descriptor.contract !== ENVIRONMENT_CONTRACT_VERSION) {
        this.deactivate();
        return { ok: false, reason: "This environment did not identify itself in a way this view understands.", previous, changed: true, invalidated: "none" };
      }
      const store = open();
      const changed = environmentKey !== key;
      // A store that will not even say how much it holds is a browser that has
      // switched storage off (a private window, blocked site data). There is
      // then nothing to read and nothing to purge, so the environment is
      // usable and simply remembers nothing — which is not a failure to show
      // a person.
      const reachable = (candidate: Storage): boolean => {
        try {
          void candidate.length;
          return true;
        } catch {
          return false;
        }
      };
      if (!store || !reachable(store)) {
        // No storage at all (a private window, site data blocked). Nothing can
        // be kept and nothing unsafe can be left behind, so the environment is
        // usable — it simply remembers nothing.
        storage = null;
        environmentKey = key;
        cache = { ...descriptor.cache };
        content = false;
        refusal = "inactive";
        publish();
        return { ok: true, previous, changed, invalidated: "none" };
      }
      if (!purgeUnsafe(store, key)) {
        this.deactivate();
        return {
          ok: false,
          reason: "This browser's stored data could not be cleared of other environments, so nothing is being kept on this device.",
          previous,
          changed: true,
          invalidated: "none",
        };
      }
      // The namespace is only readable from here on: purge first, open second.
      storage = store;
      environmentKey = key;
      cache = { ...descriptor.cache };
      const admission = admitContent(descriptor.cache);
      content = admission.content;
      refusal = admission.refusal;

      const next = fingerprintOf(descriptor);
      const invalidated = downgrade(readFingerprint(), next);
      if (invalidated === "namespace") purgeNamespace("all");
      else if (invalidated === "content") purgeNamespace(CONTENT_KEYS);
      // A policy that forbids content also forbids the content already here.
      if (!content) for (const key of CONTENT_KEYS) rawWrite(key, undefined);
      rawWrite(DEVICE_KEYS.descriptor, JSON.stringify(next));
      publish();
      return { ok: true, previous, changed, invalidated };
    },

    deactivate() {
      storage = null;
      environmentKey = undefined;
      cache = undefined;
      content = false;
      refusal = "inactive";
      publish();
    },

    read: (key) => (key === DEVICE_KEYS.drafts ? undefined : rawRead(key)),

    write(key, value) {
      if (key === DEVICE_KEYS.drafts) return;
      rawWrite(key, value);
    },

    readJson(key, parse) {
      const raw = this.read(key);
      if (raw === undefined) return undefined;
      try {
        return parse(JSON.parse(raw) as unknown);
      } catch {
        return undefined;
      }
    },

    writeJson(key, value) {
      this.write(key, value === undefined ? undefined : JSON.stringify(value));
    },

    readDraft(id) {
      const entry = readDrafts().find(([name]) => name === id);
      return entry?.[1];
    },

    writeDraft(id, text) {
      if (!draftBounds()) return;
      const entries = readDrafts().filter(([name]) => name !== id);
      if (text !== undefined && text.trim() !== "") {
        entries.push([id, { text, at: new Date().toISOString() }]);
      }
      writeDrafts(entries);
    },
  };
}

/**
 * The store the app uses. Reads `globalThis.localStorage` on demand so a test
 * can stand a fake one in front of it without a seam that ships.
 */
export const deviceStore: DeviceStore = createDeviceStore(() => globalThis.localStorage ?? null);
