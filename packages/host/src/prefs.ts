/**
 * PrefsStore (M11-T6) — piorbit's own preferences, kept by the host.
 *
 * Why this is not `pi/settings/set`: the agent's settings file belongs to the
 * agent. `SettingsAdapter` refuses any key the pinned agent does not define,
 * and it is right to — writing `theme` into `~/.pi/agent/settings.json` would
 * put a key there that the agent ignores today and could collide with
 * tomorrow. So piorbit's preferences live here instead, in
 * `<stateDir>/prefs.json`, next to `projects.json` and `attention.json`.
 *
 * Why the host and not the browser: a theme in `localStorage` is a theme on one
 * device. Keeping it here is what makes a phone that pairs with this desktop
 * open in the theme the desktop is wearing.
 *
 * The store is a plain namespace → JSON map. It never looks inside a value: a
 * namespace is a drawer whose owner is the only thing that understands what is
 * in it. One `revision` counts every accepted write across all namespaces, so a
 * client can recognise the echo of its own change and not fight itself.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorCodes, PREFS_MAX_BYTES, ProtocolError, type PrefsEntry } from "@piorbit/protocol";

interface Stored {
  value: unknown;
  revision: number;
  at: string;
}

export interface PrefsStoreOptions {
  /** File the preferences are persisted to. Absent = memory only (tests). */
  storePath?: string;
  /** Notified after every accepted write, so the host can broadcast it. */
  onChange?: (entry: PrefsEntry) => void;
  now?: () => Date;
}

export class PrefsStore {
  private readonly entries = new Map<string, Stored>();
  private readonly now: () => Date;
  private revision = 0;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: PrefsStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /** The highest revision written so far. */
  get currentRevision(): number {
    return this.revision;
  }

  /** Every namespace, or just one. A namespace never set is simply absent. */
  get(namespace?: string): PrefsEntry[] {
    if (namespace !== undefined) {
      const stored = this.entries.get(namespace);
      return stored ? [{ namespace, ...stored }] : [];
    }
    return [...this.entries].map(([name, stored]) => ({ namespace: name, ...stored }));
  }

  /**
   * Replace one namespace. `null` clears it — which is a real edit with its own
   * revision, not the same thing as never having been set.
   */
  set(namespace: string, value: unknown): PrefsEntry {
    let text: string;
    try {
      text = JSON.stringify(value ?? null) ?? "null";
    } catch {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        `That preference could not be saved because it is not JSON. Nothing was changed.`,
      );
    }
    if (Buffer.byteLength(text, "utf8") > PREFS_MAX_BYTES) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        `That preference is too large to save (${Math.round(Buffer.byteLength(text, "utf8") / 1024)} KB; the limit is ` +
          `${PREFS_MAX_BYTES / 1024} KB). Nothing was changed.`,
      );
    }
    const stored: Stored = {
      // Re-parse, so what is handed out and what is persisted are the same
      // value and nothing can hold a reference into the caller's object.
      value: JSON.parse(text) as unknown,
      revision: ++this.revision,
      at: this.now().toISOString(),
    };
    if (stored.value === null) this.entries.delete(namespace);
    else this.entries.set(namespace, stored);
    this.schedulePersist();
    const entry: PrefsEntry = { namespace, ...stored };
    this.options.onChange?.(entry);
    return entry;
  }

  /** Flush any pending write now. Called when the host shuts down. */
  close(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
      this.persist();
    }
  }

  private load(): void {
    const file = this.options.storePath;
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const revision = (parsed as { revision?: unknown })?.revision;
      if (typeof revision === "number" && Number.isFinite(revision)) this.revision = revision;
      const namespaces = (parsed as { namespaces?: unknown })?.namespaces;
      if (!namespaces || typeof namespaces !== "object") return;
      for (const [name, raw] of Object.entries(namespaces as Record<string, unknown>)) {
        // `__proto__` and friends cannot reach a Map's prototype, but a stale
        // file is still untrusted input: keep only what the writer could write.
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) continue;
        const at = (raw as { at?: unknown })?.at;
        const rev = (raw as { revision?: unknown })?.revision;
        if (typeof at !== "string") continue;
        this.entries.set(name, {
          value: (raw as { value?: unknown }).value ?? null,
          revision: typeof rev === "number" ? rev : this.revision,
          at,
        });
      }
    } catch {
      /* first run, or a truncated file: start empty rather than fail to boot */
    }
  }

  /** Coalesce writes: dragging a hue slider must not be one file write per pixel. */
  private schedulePersist(): void {
    if (!this.options.storePath || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.persist();
    }, 300);
    this.writeTimer.unref?.();
  }

  private persist(): void {
    const file = this.options.storePath;
    if (!file) return;
    const namespaces: Record<string, Stored> = {};
    for (const [name, stored] of this.entries) namespaces[name] = stored;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${Date.now()}.prefs.tmp`);
      writeFileSync(tmp, JSON.stringify({ version: 1, revision: this.revision, namespaces }, null, 2));
      renameSync(tmp, file);
    } catch {
      /* read-only home, full disk: the preference still applies for this run */
    }
  }
}
