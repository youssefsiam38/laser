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
 *    exactly the leak this task closes. So is a `laser-env:` key whose
 *    environment segment is missing or malformed. They are removed.
 * 4. **A purge that could not finish keeps the store shut.** The scan is
 *    bounded and verified, and if it hits its ceiling or a removal fails,
 *    activation *fails* — the app shows a connection failure rather than
 *    reading half a purged namespace.
 * 5. **`cache` is the single admission point for content.** Drafts are the
 *    only content B stores, and they live or die by the environment's cache
 *    policy. Attachments are never stored.
 * 6. **A downgrade invalidates what it took away** before the namespace opens,
 *    and so does a fingerprint this build cannot read beside data it did not
 *    write.
 *
 * Local browser storage is **not encrypted**. Everything here is readable by
 * anything with access to the profile, which is why paths live behind an
 * environment namespace, why content obeys the policy, and why nothing in this
 * module is ever logged or exported.
 */
import {
  ENVIRONMENT_CONTRACT_VERSION,
  ENVIRONMENT_KEY_PATTERN,
  STORAGE_PREFIX,
  cachePolicySchema,
  environmentCapabilitiesSchema,
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
  /** Content: `{ "<id>": {text, at} }`. Reached only through the draft API. */
  drafts: "drafts",
  /** The descriptor fingerprint this namespace was written under. */
  descriptor: "descriptor",
} as const;

export type DeviceKey = (typeof DEVICE_KEYS)[keyof typeof DEVICE_KEYS];

/**
 * The keys a caller may read and write directly.
 *
 * Drafts are content and the descriptor is this module's own bookkeeping, so
 * neither is reachable through the generic accessors — not by convention, but
 * because the type of {@link DeviceStore.read} and friends does not admit
 * them. Drafts have their own bounded, admission-gated API.
 */
export type DeviceValueKey = Exclude<DeviceKey, typeof DEVICE_KEYS.drafts | typeof DEVICE_KEYS.descriptor>;

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

/**
 * Why content is not being kept.
 *
 * `unavailable` is the browser's answer, not the environment's: storage exists
 * in name only (a private window, blocked site data, a quota that will not
 * take even a fingerprint), so this environment is open and remembers nothing.
 */
export type ContentRefusal = "inactive" | "unavailable" | "policy" | "bounds" | "encryption";

export interface DeviceStorageStatus {
  active: boolean;
  /** The opaque environment key in force, never anything derived from a path. */
  environmentKey: string | undefined;
  /** Does this device actually keep what it is given? */
  persistent: boolean;
  /** May content (today: drafts) be read and written? */
  content: boolean;
  /** Why not, when it may not. */
  refusal: ContentRefusal | undefined;
}

/**
 * What activating an environment turned out to be.
 *
 * A discriminated answer rather than a pair of booleans, so the caller reads
 * the decision instead of re-deriving it: `switched` and `narrowed` are the
 * two that throw live state away, `first` and `same` never do, and `failure`
 * is the one the person is shown.
 */
export type ActivationResult =
  | { kind: "failure"; reason: string }
  | {
      kind: EnvironmentTransition;
      environmentKey: string;
      /** What the descriptor comparison threw away before the namespace opened. */
      invalidated: "none" | "namespace" | "content";
      /** False when the browser will not actually keep anything. */
      persistent: boolean;
    };

/** How this environment relates to the one this view was in a moment ago. */
export type EnvironmentTransition = "first" | "same" | "switched" | "narrowed";

/** What a store hears when the environment comes or goes. */
export type DeviceStoreEvent =
  | { kind: "activated"; environmentKey: string; transition: EnvironmentTransition }
  | { kind: "deactivated" };

/**
 * The fingerprint beside a namespace: what the environment could do and what
 * it allowed to be kept, the last time anything was written here.
 *
 * Deliberately **not** the whole descriptor. The actor, the scopes and the
 * deployment label describe *this connection*, not what is on this device: a
 * phone and a desktop in the same environment hold the same cache under
 * different actors and different scopes, and treating either as part of the
 * fingerprint would throw a person's pins away every time they changed device
 * or an operator narrowed a grant. Capabilities and the cache policy are the
 * two things everything stored here is derived from.
 */
interface Fingerprint {
  contract: string;
  capabilities: EnvironmentCapabilities;
  cache: CachePolicy;
}

/**
 * Validate a stored fingerprint with the protocol's **own** schemas, field for
 * field. Nothing here is cast: a capability set or a cache policy that gains a
 * field upstream is rejected by the same parser the descriptor uses, so a
 * record this build cannot fully read is treated as corrupt rather than
 * half-believed.
 */
function parseFingerprint(value: unknown): Fingerprint | undefined {
  if (!isRecord(value)) return undefined;
  const contract = value["contract"];
  if (typeof contract !== "string" || contract === "") return undefined;
  const capabilities = environmentCapabilitiesSchema.safeParse(value["capabilities"]);
  const cache = cachePolicySchema.safeParse(value["cache"]);
  if (!capabilities.success || !cache.success) return undefined;
  if (Object.keys(value).length !== 3) return undefined;
  return { contract, capabilities: capabilities.data, cache: cache.data };
}

export interface DraftRecord {
  text: string;
  at: string;
}

export interface DeviceStore {
  status(): DeviceStorageStatus;
  /** Internal: close the store with the stable "cannot clear" failure. */
  refuse(): ActivationResult;
  /**
   * Remove the pre-environment keys, whatever happens next.
   *
   * They are unsafe in every environment, so a view that could not establish
   * one still takes them off this device rather than leaving them for whoever
   * connects next. Best effort by design: a browser that refuses storage has
   * nothing to remove.
   */
  purgeLegacy(): void;
  /**
   * Hear every activation and deactivation.
   *
   * This is how a module-level store keeps up without each one remembering to:
   * it subscribes once, and re-reads whatever namespace is in force. The event
   * is delivered on the **first** activation too, which is the one a store
   * that only listened for switches would miss — and it would then overwrite
   * what a person left behind with whatever it started empty with.
   */
  subscribe(listener: (event: DeviceStoreEvent) => void): () => void;
  activate(descriptor: EnvironmentDescriptor): ActivationResult;
  /** Close the namespace. Reads and writes stop; nothing stored is deleted. */
  deactivate(): void;
  read(key: DeviceValueKey): string | undefined;
  write(key: DeviceValueKey, value: string | undefined): void;
  readJson<T>(key: DeviceValueKey, parse: (value: unknown) => T | undefined): T | undefined;
  writeJson(key: DeviceValueKey, value: unknown): void;
  /** One draft, by session path or landing key. `undefined` when inadmissible or expired. */
  readDraft(id: string): DraftRecord | undefined;
  /** Store or forget one draft, within the environment's cache bounds. */
  writeDraft(id: string, text: string | undefined): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Serialized size in bytes, which is what a storage quota actually counts. */
const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;

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

/**
 * The environment a namespaced key belongs to, or `undefined` if it is not one.
 *
 * A key that *looks* namespaced but carries no valid environment key is not
 * "not a namespace": it is a malformed one, and {@link isUnsafeNamespaceKey}
 * treats it as something to remove rather than something to leave lying there.
 */
export function namespaceOf(key: string): string | undefined {
  const prefix = `${ENVIRONMENT_NAMESPACE}:`;
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return undefined;
  const candidate = rest.slice(0, separator);
  return ENVIRONMENT_KEY_PATTERN.test(candidate) ? candidate : undefined;
}

/** Does this key belong to an environment that is not `keep` — or to none at all? */
export function isUnsafeNamespaceKey(key: string, keep: string): boolean {
  if (!key.startsWith(`${ENVIRONMENT_NAMESPACE}:`)) return false;
  const namespace = namespaceOf(key);
  return namespace === undefined || namespace !== keep;
}

export function createDeviceStore(getStorage: () => Storage | null): DeviceStore {
  let storage: Storage | null = null;
  let environmentKey: string | undefined;
  let cache: CachePolicy | undefined;
  let content = false;
  let refusal: ContentRefusal | undefined = "inactive";
  let snapshot: DeviceStorageStatus = {
    active: false,
    environmentKey: undefined,
    persistent: false,
    content: false,
    refusal: "inactive",
  };
  const listeners = new Set<(event: DeviceStoreEvent) => void>();

  const publish = (event: DeviceStoreEvent): void => {
    snapshot = { active: environmentKey !== undefined, environmentKey, persistent: storage !== null, content, refusal };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One store's rehydrate is not allowed to cost the others theirs, nor
        // to turn a safe activation into half a handshake. A store that throws
        // keeps whatever it had; the ones after it still hear the event.
      }
    }
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

  /** The stored fingerprint, or `undefined` for missing, partial or corrupt. */
  const readFingerprint = (): Fingerprint | undefined => {
    const raw = rawRead(DEVICE_KEYS.descriptor);
    if (!raw) return undefined;
    try {
      return parseFingerprint(JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  };

  /**
   * Every key this environment actually holds, discovered by prefix.
   *
   * By prefix rather than by {@link DEVICE_KEYS}, because the thing that must
   * not survive an invalidation is *whatever is there* — including a suffix an
   * older or newer build of this app wrote and this one has never heard of.
   * `undefined` means the scan could not be taken, which is never treated as
   * "nothing is there".
   */
  const namespaceKeys = (store: Storage, key: string): string[] | undefined => {
    const prefix = `${ENVIRONMENT_NAMESPACE}:${key}:`;
    return snapshotKeys(store)?.filter((name) => name.startsWith(prefix));
  };

  const isDescriptorKey = (name: string, key: string): boolean =>
    name === `${ENVIRONMENT_NAMESPACE}:${key}:${DEVICE_KEYS.descriptor}`;

  const isContentKey = (name: string, key: string): boolean =>
    name === `${ENVIRONMENT_NAMESPACE}:${key}:${DEVICE_KEYS.drafts}`;

  /**
   * Remove exactly these keys and prove they are gone.
   *
   * `false` means the device still holds something that was supposed to be
   * invalidated — a selectively failing `removeItem`, a scan that could not be
   * retaken — and the caller must refuse to open the namespace rather than
   * write a new fingerprint over bytes a later, looser policy would happily
   * read back.
   */
  const purgeExact = (store: Storage, names: readonly string[]): boolean => {
    let complete = true;
    for (const name of names) {
      try {
        store.removeItem(name);
      } catch {
        complete = false;
      }
      // A browser that refuses to remove a key may still let it be written.
      // Emptying it is not as good as removing it — the key is still there —
      // but it means the bytes are gone, so a later, looser policy cannot read
      // back what this one forbade. The activation still fails.
      try {
        if (store.getItem(name) !== null) {
          store.setItem(name, "");
          complete = false;
        }
      } catch {
        complete = false;
      }
    }
    const after = snapshotKeys(store);
    if (after === undefined) return false;
    return complete && !names.some((name) => after.includes(name));
  };

  /**
   * Which way each cache field can only get tighter.
   *
   * `Record<keyof CachePolicy, …>` on purpose: a field added to the policy
   * without a rule here is a compile error, not a dimension that quietly stops
   * invalidating anything.
   */
  const CACHE_TIGHTENED: Record<keyof CachePolicy, (before: CachePolicy, after: CachePolicy) => boolean> = {
    transcripts: (before, after) => before.transcripts === "allowed" && after.transcripts === "disabled",
    attachments: (before, after) => before.attachments === "reference" && after.attachments === "none",
    requireDeviceEncryption: (before, after) => !before.requireDeviceEncryption && after.requireDeviceEncryption,
    maxBytes: (before, after) => after.maxBytes < before.maxBytes,
    maxSessions: (before, after) => after.maxSessions < before.maxSessions,
    maxEntriesPerSession: (before, after) => after.maxEntriesPerSession < before.maxEntriesPerSession,
    maxAgeHours: (before, after) => after.maxAgeHours < before.maxAgeHours,
  };

  /** What a new descriptor takes away from the one this namespace was written under. */
  const invalidationFor = (next: Fingerprint, transition: EnvironmentTransition, hasData: boolean): "none" | "namespace" | "content" => {
    const previous = readFingerprint();
    if (!previous) {
      // No fingerprint, or one this build cannot read, beside data somebody
      // wrote: there is no way to know what that data was derived from, so it
      // goes. Two exceptions that are not guesses: an empty namespace has
      // nothing to invalidate, and a namespace this store is *already* open on
      // holds this session's own writes, made under the descriptor now being
      // re-confirmed (the record itself can go missing under the app — another
      // tab clearing site data — without making this session's state foreign).
      return hasData && transition !== "same" ? "namespace" : "none";
    }
    if (previous.contract !== next.contract) return "namespace";
    const after = next.capabilities as unknown as Record<string, boolean>;
    for (const [name, was] of Object.entries(previous.capabilities as unknown as Record<string, boolean>)) {
      if (was === true && after[name] !== true) return "namespace";
    }
    const tightened = Object.values(CACHE_TIGHTENED).some((rule) => rule(previous.cache, next.cache));
    return tightened ? "content" : "none";
  };

  /**
   * Remove every legacy key and every namespace that is not this one, then
   * prove it worked. False means the store must stay shut.
   */
  const purgeUnsafe = (store: Storage, keep: string): boolean => {
    const unsafe = (key: string): boolean => isLegacyDeviceKey(key) || isUnsafeNamespaceKey(key, keep);
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

  /** Open the environment without any storage behind it. */
  const openWithoutStorage = (key: string, transition: EnvironmentTransition): ActivationResult => {
    storage = null;
    environmentKey = key;
    cache = undefined;
    content = false;
    refusal = "unavailable";
    publish({ kind: "activated", environmentKey: key, transition });
    return { kind: transition, environmentKey: key, invalidated: "none", persistent: false };
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

  /**
   * Every admissible draft, oldest first.
   *
   * A timestamp that cannot be read, or one from the future, is corrupt rather
   * than immortal: it is dropped, because the alternative is an entry that can
   * never expire and can never be evicted by age.
   */
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
        if (!Number.isFinite(at)) continue;
        if (at > now + 60_000) continue;
        if (now - at > bounds.ageMs) continue;
        entries.push([id, draft]);
      }
      return entries;
    } catch {
      return [];
    }
  };

  /**
   * Write the drafts back inside the environment's bounds.
   *
   * Sizes are measured once per entry and the oldest are dropped against a
   * running total, so trimming a full store costs one pass rather than one
   * serialization per eviction.
   */
  const writeDrafts = (entries: Array<[string, DraftRecord]>): void => {
    const bounds = draftBounds();
    if (!bounds) return;
    let kept = entries.slice(-bounds.entries);
    // `{}` plus, per entry, the JSON of its key, a colon, the JSON of its
    // value and the comma before it: the exact bytes `JSON.stringify` writes.
    const sizes = kept.map(([id, draft]) => byteLength(JSON.stringify(id)) + 1 + byteLength(JSON.stringify(draft)) + 1);
    let total = 2 + sizes.reduce((sum, size) => sum + size, 0);
    let first = 0;
    while (first < kept.length && total > bounds.bytes) {
      total -= sizes[first] ?? 0;
      first += 1;
    }
    kept = kept.slice(first);
    rawWrite(DEVICE_KEYS.drafts, kept.length === 0 ? undefined : JSON.stringify(Object.fromEntries(kept)));
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
        return { kind: "failure", reason: "This environment did not identify itself in a way this view understands." };
      }
      const store = open();
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
      const transition: EnvironmentTransition = previous === undefined ? "first" : previous === key ? "same" : "switched";
      if (!store || !reachable(store)) return openWithoutStorage(key, transition);

      if (!purgeUnsafe(store, key)) {
        this.deactivate();
        return {
          kind: "failure",
          reason: "This browser's stored data could not be cleared of other environments, so nothing is being kept on this device.",
        };
      }
      // The namespace is only readable from here on: purge first, open second.
      storage = store;
      environmentKey = key;
      cache = { ...descriptor.cache };
      const admission = admitContent(descriptor.cache);
      content = admission.content;
      refusal = admission.refusal;

      // What this environment really holds, discovered rather than assumed.
      const held = namespaceKeys(store, key);
      if (!held) return this.refuse();
      const next = fingerprintOf(descriptor);
      const invalidated = invalidationFor(next, transition, held.some((name) => !isDescriptorKey(name, key)));

      // Everything that must not survive this descriptor, by exact key: the
      // whole namespace when its provenance is gone or a capability was
      // withdrawn, the content alone when the cache tightened, and the content
      // again when this policy forbids keeping any. A removal that cannot be
      // proved to have happened closes the store instead of opening it — the
      // alternative is forbidden bytes sitting under a fingerprint that says
      // they are fine, waiting for a looser policy to read them back.
      const doomed = invalidated === "namespace"
        ? held
        : invalidated === "content" || !content
          ? held.filter((name) => isContentKey(name, key))
          : [];
      if (doomed.length > 0 && !purgeExact(store, doomed)) return this.refuse();

      // The fingerprint is written and read back. If it does not survive — a
      // quota that will not take even this — the namespace cannot be trusted
      // to record what it was written under, so this device keeps nothing at
      // all rather than reading state whose provenance it cannot check.
      const encoded = JSON.stringify(next);
      rawWrite(DEVICE_KEYS.descriptor, encoded);
      if (rawRead(DEVICE_KEYS.descriptor) !== encoded) return openWithoutStorage(key, transition);

      const kind = transition === "same" && invalidated !== "none" ? "narrowed" : transition;
      publish({ kind: "activated", environmentKey: key, transition: kind });
      return { kind, environmentKey: key, invalidated, persistent: true };
    },

    /**
     * Close the store and say why, in a sentence a person can act on: the
     * notice's recovery is to clear this browser's data for this app, which is
     * exactly what an un-removable key needs.
     */
    refuse(): ActivationResult {
      this.deactivate();
      return {
        kind: "failure",
        reason: "This browser will not let go of data from an earlier session, so nothing is being kept on this device. Clearing this browser's data for this app fixes it.",
      };
    },

    deactivate() {
      const wasActive = environmentKey !== undefined;
      storage = null;
      environmentKey = undefined;
      cache = undefined;
      content = false;
      refusal = "inactive";
      if (wasActive) publish({ kind: "deactivated" });
      else snapshot = { active: false, environmentKey: undefined, persistent: false, content: false, refusal: "inactive" };
    },

    read: (key) => rawRead(key),

    write(key, value) {
      rawWrite(key, value);
    },

    readJson(key, parse) {
      const raw = rawRead(key);
      if (raw === undefined) return undefined;
      try {
        return parse(JSON.parse(raw) as unknown);
      } catch {
        return undefined;
      }
    },

    writeJson(key, value) {
      rawWrite(key, value === undefined ? undefined : JSON.stringify(value));
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

/**
 * Forget everything this app has stored in this browser.
 *
 * The way out of an environment that cannot be established: the failure is
 * about what is on this device, so the recovery is to take it off. Neutral
 * preferences go too — a person who reaches for this is asking for a clean
 * start, and half a clean start is the confusing answer. Never touches the
 * host, and never throws.
 */
export function clearBrowserStorage(storage: Storage | null = safeLocalStorage()): boolean {
  deviceStore.deactivate();
  if (!storage) return true;
  try {
    // `clear()`, not a scan: this is the person asking, on this app's own
    // origin, and the failure it recovers from is precisely the one where
    // there is more here than a bounded scan will look at. Everything in this
    // origin's `localStorage` is this app's.
    storage.clear();
  } catch {
    return false;
  }
  try {
    // Only meaningful when the store still answers; a store that will not say
    // is not evidence that anything survived.
    return storage.length === 0;
  } catch {
    return true;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
