/**
 * KeybindingsAdapter (M4-T7) — the agent's own `keybindings.json`, read and
 * written through the agent's own `KeybindingsManager`.
 *
 * Two things make this less obvious than the settings adapter:
 *
 * 1. **Pi 0.85 exports `KeybindingsManager` as a type, not as a value.** Its
 *    package `exports` map has no subpath for it either, so a bare import
 *    cannot reach it. What *is* reachable is the resolved location of the
 *    package's own entry point, and the manager sits next to it. So the module
 *    is loaded once by file URL — the same guarded reach-in that
 *    `settings.ts` makes for `SettingsManager`'s storage, and with the same
 *    rule: if a future Pi moves it, say so in a sentence a person can act on
 *    and change nothing, rather than guessing.
 *
 *    Loading the real module matters beyond convenience: Pi's defaults are
 *    platform-dependent (Windows gets `ctrl+z` for undo where everything else
 *    gets `ctrl+-`), so a table copied into this repo would be wrong on some
 *    machines and silently drift on every Pi bump.
 *
 * 2. **Nothing must ever be a second writer on one file.** Pi never writes
 *    `keybindings.json` (it loads it at startup and on reload), and
 *    `SettingsManager`'s lock covers `settings.json`, a different file. What is
 *    left is laser racing itself: keybindings are global while workers are
 *    per project, so two workers share this file. Hence the same discipline
 *    `SettingsManager` uses — an exclusive lock around read-modify-write, and
 *    an atomic rename so a reader sees the old file or the new one and never a
 *    half-written one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, closeSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { ErrorCodes, PRODUCT_NAME, ProtocolError, type KeybindingChange, type KeybindingDescriptor, type KeybindingsSnapshot } from "@lasercode/protocol";

/** The half of Pi's `KeybindingsManager` this adapter uses. */
interface PiKeybindingsManager {
  getKeys(id: string): string[];
  getDefinition(id: string): { defaultKeys: string | string[]; description?: string } | undefined;
  getConflicts(): Array<{ key: string; keybindings: string[] }>;
  getUserBindings(): Record<string, string | string[] | undefined>;
  getResolvedBindings(): Record<string, string | string[] | undefined>;
  reload(): void;
}

interface PiKeybindingsModule {
  KeybindingsManager: { create(agentDir?: string): PiKeybindingsManager };
}

export class KeybindingsError extends ProtocolError {
  constructor(message: string) {
    super(ErrorCodes.InvalidParams, message);
  }
}

/** How long a lock file is trusted before it is treated as the debris of a crash. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

const keysOf = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? [...value] : [value];

/** One adapter per worker. Cheap until something asks for a snapshot. */
export class KeybindingsAdapter {
  private readonly agentDir: string;
  private readonly file: string;
  private manager: PiKeybindingsManager | undefined;
  private loading: Promise<PiKeybindingsManager> | undefined;
  /** Serialises this process's own writes; the lock file covers other processes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { agentDir?: string } = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.file = join(this.agentDir, "keybindings.json");
  }

  async snapshot(): Promise<KeybindingsSnapshot> {
    const manager = await this.load();
    manager.reload();
    return this.describe(manager);
  }

  /**
   * Apply `changes` and answer with the file as it now stands. Validated in
   * full first: one unknown id refuses the whole batch, so a rebinding screen
   * never half-applies.
   */
  async apply(changes: KeybindingChange[]): Promise<KeybindingsSnapshot> {
    if (changes.length === 0) throw new KeybindingsError("No changes were given.");
    const manager = await this.load();
    const known = manager.getResolvedBindings();
    for (const change of changes) {
      if (!Object.prototype.hasOwnProperty.call(known, change.id)) {
        throw new KeybindingsError(
          `The agent (${VERSION}) has no action called "${change.id}", so it cannot be bound to anything. ` +
            `Nothing was changed.`,
        );
      }
    }
    // Two ids claiming one key inside a single batch is the person's own doing
    // and the agent resolves it, but a batch that would make an action
    // unreachable by binding it to nothing is a mistake worth refusing here.
    for (const change of changes) {
      if (change.op === "set" && change.keys.length === 0) {
        throw new KeybindingsError(`"${change.id}" needs at least one key. Nothing was changed.`);
      }
    }

    const run = this.queue.then(() => this.write(changes));
    // Keep the chain alive even when this write fails, or one bad change would
    // wedge every later one behind a rejected promise.
    this.queue = run.catch(() => undefined);
    await run;
    manager.reload();
    return this.describe(manager);
  }

  // ------------------------------------------------------------- internals

  private describe(manager: PiKeybindingsManager): KeybindingsSnapshot {
    const user = manager.getUserBindings();
    const bindings: KeybindingDescriptor[] = [];
    for (const id of Object.keys(manager.getResolvedBindings())) {
      const definition = manager.getDefinition(id);
      bindings.push({
        id,
        description: definition?.description ?? id,
        defaultKeys: keysOf(definition?.defaultKeys),
        keys: manager.getKeys(id),
        overridden: Object.prototype.hasOwnProperty.call(user, id),
        section: id.split(".")[0] ?? "other",
      });
    }
    bindings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const unreadable = this.unreadable();
    return {
      path: this.file,
      piVersion: VERSION,
      bindings,
      conflicts: manager.getConflicts().map((conflict) => ({ key: conflict.key, ids: [...conflict.keybindings] })),
      writable: unreadable === undefined,
      ...(unreadable !== undefined
        ? {
            reason:
              `${PRODUCT_NAME} will not write ${this.file} because it cannot read it: ${unreadable} ` +
              `Fix the file (or delete it to go back to the defaults) and reopen this screen.`,
            error: unreadable,
          }
        : {}),
    };
  }

  /** Why the existing file cannot be read, or undefined when it is fine (or absent). */
  private unreadable(): string | undefined {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      // Absent is the normal case: the agent's defaults are in force.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return error instanceof Error ? error.message : String(error);
    }
    if (text.trim() === "") return undefined;
    try {
      const parsed: unknown = JSON.parse(text.replace(/^﻿/, ""));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "the file does not contain a JSON object.";
      }
    } catch (error) {
      return `it is not valid JSON (${error instanceof Error ? error.message : String(error)}).`;
    }
    return undefined;
  }

  private async write(changes: KeybindingChange[]): Promise<void> {
    const unreadable = this.unreadable();
    if (unreadable !== undefined) {
      throw new KeybindingsError(
        `${PRODUCT_NAME} will not overwrite ${this.file} because it cannot read it: ${unreadable} ` +
          `Nothing was changed. Fix the file, or delete it to go back to the agent's defaults.`,
      );
    }
    const release = this.lock();
    try {
      let doc: Record<string, unknown> = {};
      try {
        const text = readFileSync(this.file, "utf8");
        if (text.trim() !== "") doc = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const before = JSON.stringify(doc);
      for (const change of changes) {
        // The ids are validated against the agent's own table above, so nothing
        // here can be `__proto__`; assigning through a null-prototype copy makes
        // that true by construction rather than by argument.
        if (change.op === "reset") delete doc[change.id];
        else doc[change.id] = change.keys.length === 1 ? change.keys[0] : [...change.keys];
      }
      // A change that changes nothing must not touch the file: rewriting it
      // would bump its mtime and, on a machine that never had one, create it.
      if (JSON.stringify(doc) === before) return;
      mkdirSync(this.agentDir, { recursive: true });
      const tmp = join(this.agentDir, `.keybindings.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      renameSync(tmp, this.file);
    } finally {
      release();
    }
  }

  /**
   * An exclusive lock beside the file, so two laser workers (keybindings are
   * global; workers are per project) cannot interleave a read-modify-write.
   * A lock left behind by a crash goes stale and is taken over rather than
   * blocking rebinding forever.
   */
  private lock(): () => void {
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    mkdirSync(this.agentDir, { recursive: true });
    for (;;) {
      try {
        closeSync(openSync(lockFile, "wx"));
        return () => {
          try {
            rmSync(lockFile, { force: true });
          } catch {
            /* the lock is advisory; a failure to clear it goes stale on its own */
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let age = 0;
        try {
          age = Date.now() - statSync(lockFile).mtimeMs;
        } catch {
          continue; // it vanished between the two calls; try to take it again
        }
        if (age > LOCK_STALE_MS) {
          rmSync(lockFile, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new KeybindingsError(
            `Another copy of ${PRODUCT_NAME} is saving keyboard shortcuts right now, so this change was not applied. ` +
              `Try again in a moment.`,
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  private async load(): Promise<PiKeybindingsManager> {
    if (this.manager) return this.manager;
    this.loading ??= this.import().then((manager) => {
      this.manager = manager;
      return manager;
    });
    try {
      return await this.loading;
    } catch (error) {
      this.loading = undefined;
      throw error;
    }
  }

  private async import(): Promise<PiKeybindingsManager> {
    let module: PiKeybindingsModule;
    try {
      module = (await import(pathToFileURL(piKeybindingsModulePath()).href)) as PiKeybindingsModule;
    } catch (error) {
      throw new KeybindingsError(
        `This build of the agent (${VERSION}) does not put its keyboard shortcuts where ${PRODUCT_NAME} can read them ` +
          `(${error instanceof Error ? error.message : String(error)}), so shortcuts cannot be shown or changed here. ` +
          `Nothing was changed. Edit ${this.file} by hand, or update ${PRODUCT_NAME} for this agent version.`,
      );
    }
    if (typeof module?.KeybindingsManager?.create !== "function") {
      throw new KeybindingsError(
        `This build of the agent (${VERSION}) exposes its keyboard shortcuts in a shape ${PRODUCT_NAME} does not recognise, ` +
          `so shortcuts cannot be shown or changed here. Nothing was changed. Edit ${this.file} by hand, or update ` +
          `${PRODUCT_NAME} for this agent version.`,
      );
    }
    return module.KeybindingsManager.create(this.agentDir);
  }
}

/**
 * Where the pinned agent keeps `keybindings.js`.
 *
 * Two ways, because the two places this runs disagree: `import.meta.resolve`
 * is the correct one and is what the built worker uses, but the test runner
 * transforms modules and does not provide it. The fallback is the layout every
 * install has anyway — the package inside a `node_modules` above this file.
 * Both are checked for existence, so a wrong answer fails here with a path in
 * it rather than as an opaque import error.
 */
export function piKeybindingsModulePath(): string {
  const relative = join("core", "keybindings.js");
  const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve === "function") {
    try {
      const candidate = join(dirname(fileURLToPath(resolve("@earendil-works/pi-coding-agent"))), relative);
      if (existsSync(candidate)) return candidate;
    } catch {
      /* fall through to the directory walk */
    }
  }
  const suffix = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", relative);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, suffix);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) break;
    dir = parent;
  }
  throw new Error(`no @earendil-works/pi-coding-agent ${relative} found above ${dirname(fileURLToPath(import.meta.url))}`);
}
