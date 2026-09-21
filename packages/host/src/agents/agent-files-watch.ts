import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  PROJECT_DIR_NAME,
  type AgentDefinition,
  type AgentLocation,
  type AgentWarning,
  type ModelIdentity,
} from "@lasercode/protocol";
import { parseAgentFile } from "./agent-file.js";

export type AgentFileLocation = AgentLocation;

export interface AgentFilesWatchOptions {
  globalDirectory(): string;
  projectDirectory(projectCwd: string): string;
  trustedProjects(): ReadonlySet<string>;
  globalReconciliationBlocked(): boolean;
  definitions(): Iterable<AgentDefinition>;
  definition(location: AgentFileLocation, name: string): AgentDefinition | undefined;
  replaceDefinition(location: AgentFileLocation, definition: AgentDefinition): void;
  removeDefinition(definition: AgentDefinition): void;
  digest(path: string): string | undefined;
  setDigest(path: string, digest: string | undefined): void;
  warning(path: string): AgentWarning | undefined;
  warningPaths(): Iterable<string>;
  setWarning(path: string, warning: AgentWarning | undefined): void;
  /** The model a file written before Model Profiles still names, for the migration. */
  setLegacyModel(path: string, model: ModelIdentity | undefined): void;
  commit(): void;
  now(): Date;
  log(line: string): void;
  debounceMs?: number;
  pollMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_MS = 5_000;

/** Watches and reconciles the host-owned definition-file locations. */
export class AgentFilesWatch {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watchedRoots = new Map<string, string>();
  private readonly pendingPaths = new Set<string>();
  private readonly pendingScans = new Set<string>();
  private readonly failedWatchDirectories = new Set<string>();
  /** Project locations whose configuration root was absent at the last trust tick. */
  private readonly inactiveProjectDirectories = new Set<string>();
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: AgentFilesWatchOptions) {}

  start(): void {
    this.rebuildWatchers();
  }

  locationsChanged(): void {
    this.inactiveProjectDirectories.clear();
    this.rebuildWatchers();
  }

  close(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.watchedRoots.clear();
    this.inactiveProjectDirectories.clear();
  }

  reconcile(location: AgentFileLocation, notify: boolean, reconcileMissing = true): boolean {
    if (location.scope === "global" && this.options.globalReconciliationBlocked()) return false;
    return this.scanDirectory(this.directoryOf(location), location, notify, reconcileMissing);
  }

  private scanDirectory(directory: string, location: AgentFileLocation, notify: boolean, reconcileMissing = true): boolean {
    let names: string[];
    try {
      names = readdirSync(directory).filter((name) => name.endsWith(".md")).sort();
    } catch (error) {
      if (errorCode(error) === "ENOENT") names = [];
      else {
        this.options.log(`agents: ${directory} could not be read; keeping the last known definitions: ${messageOf(error)}`);
        return false;
      }
    }
    const paths = new Set(names.map((name) => join(directory, name)));
    let changed = false;
    for (const path of paths) changed = this.readDefinitionPath(path, location, false) || changed;
    if (reconcileMissing) {
      for (const agent of [...this.options.definitions()]) {
        if (!sameLocation(locationOf(agent), location) || !agent.path || paths.has(agent.path)) continue;
        this.options.removeDefinition(agent);
        changed = true;
      }
    }
    for (const path of [...this.options.warningPaths()]) {
      if (dirname(path) !== directory || paths.has(path)) continue;
      this.options.setWarning(path, undefined);
      this.options.setDigest(path, undefined);
      this.options.setLegacyModel(path, undefined);
      changed = true;
    }
    if (changed && notify) this.options.commit();
    return changed;
  }

  private readDefinitionPath(path: string, location: AgentFileLocation, notify: boolean): boolean {
    let text: string;
    let fallbackTimestamp: string;
    try {
      text = readFileSync(path, "utf8");
      fallbackTimestamp = statSync(path).mtime.toISOString();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        this.options.log(`agents: ${path} could not be read; keeping the last valid definition: ${messageOf(error)}`);
        this.options.setDigest(path, undefined);
        return false;
      }
      const current = this.options.definition(location, basename(path, ".md"));
      let changed = false;
      if (current?.path === path) {
        this.options.removeDefinition(current);
        changed = true;
      }
      this.options.setLegacyModel(path, undefined);
      if (this.options.warning(path)) {
        this.options.setWarning(path, undefined);
        changed = true;
      }
      this.options.setDigest(path, undefined);
      if (changed && notify) this.options.commit();
      return changed;
    }
    const digest = agentFileDigest(text);
    if (this.options.digest(path) === digest) return false;
    this.options.setLegacyModel(path, undefined);
    this.options.setDigest(path, digest);
    const name = basename(path, ".md");
    const parsed = parseAgentFile(text, name, fallbackTimestamp);
    if (parsed.issues) {
      const previous = this.options.warning(path);
      this.options.setWarning(path, {
        agentName: name,
        field: "file",
        path,
        target: path,
        message: `${parsed.issues.join(" ")} Fix ${path} and save it again; the last valid definition is still in use.`,
        since: previous?.since ?? this.options.now().toISOString(),
      });
      if (notify) this.options.commit();
      return true;
    }
    const definition: AgentDefinition = {
      ...parsed.definition,
      scope: location.scope,
      ...(location.scope === "project" ? { projectCwd: location.projectCwd } : {}),
      path,
    };
    this.options.replaceDefinition(location, definition);
    if (parsed.legacyModel) this.options.setLegacyModel(path, parsed.legacyModel);
    // One warning slot per file, and the retired name comes first: the model
    // one is cleared automatically by the one-way migration at this same
    // start, while only a person can take a name out of `allowedAgents`.
    const previous = this.options.warning(path);
    const since = previous?.since ?? this.options.now().toISOString();
    const retired = parsed.retiredAllowedAgents ?? [];
    if (retired.length > 0) {
      // The definition already runs without them (`agent-file.ts` drops them).
      const listed = retired.map((agent) => `"${agent}"`).join(", ");
      this.options.setWarning(path, {
        agentName: name,
        field: "allowedAgents",
        path,
        target: retired[0]!,
        message: `${listed} ${retired.length > 1 ? "are no longer agents" : "is no longer an agent"}, so this agent runs without ${retired.length > 1 ? "them" : "it"}. Remove the name from its allowed agents.`,
        since,
      });
    } else if (parsed.legacyModel) {
      // A file that still names a model loads and runs on the profile new
      // conversations use; the warning says so on the field a person can act
      // on (`docs/model-profiles.md`, "Assignments"). The one-way migration
      // clears it by rewriting the file.
      this.options.setWarning(path, {
        agentName: name,
        field: "profile",
        path,
        target: `${parsed.legacyModel.provider}/${parsed.legacyModel.id}`,
        message: `This agent names the model ${parsed.legacyModel.provider}/${parsed.legacyModel.id} instead of a model profile, so it runs on the profile new conversations use. Choose a profile for it.`,
        since,
      });
    } else {
      this.options.setWarning(path, undefined);
    }
    if (notify) this.options.commit();
    return true;
  }

  private rebuildWatchers(): void {
    const wanted = this.wantedLocations();
    for (const [directory, watcher] of this.watchers) {
      if (wanted.has(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
      this.watchedRoots.delete(directory);
      this.failedWatchDirectories.delete(directory);
      this.inactiveProjectDirectories.delete(directory);
    }
    for (const [directory, location] of wanted) {
      if (location.scope === "project" && this.inactiveProjectDirectories.has(directory)) continue;
      const floor = location.scope === "project" ? join(location.projectCwd, PROJECT_DIR_NAME) : undefined;
      const root = closestExistingDirectory(directory, floor);
      if (!root) {
        if (location.scope === "project") this.inactiveProjectDirectories.add(directory);
        this.watchers.get(directory)?.close();
        this.watchers.delete(directory);
        this.watchedRoots.delete(directory);
        this.failedWatchDirectories.delete(directory);
        continue;
      }
      if (this.watchers.has(directory) && this.watchedRoots.get(directory) === root) continue;
      this.watchers.get(directory)?.close();
      try {
        const watcher = watch(root, (_event, filename) => {
          const text = filename?.toString();
          if (root === directory && text?.endsWith(".md")) this.pendingPaths.add(join(directory, text));
          else this.pendingScans.add(directory);
          this.scheduleWatchFlush();
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(directory);
          this.watchedRoots.delete(directory);
          this.failedWatchDirectories.add(directory);
          this.ensureWatchFallback();
        });
        this.watchers.set(directory, watcher);
        this.watchedRoots.set(directory, root);
        this.failedWatchDirectories.delete(directory);
      } catch {
        // inotify can be exhausted by unrelated processes. Poll only the
        // affected location until a real watcher can be established again.
        this.failedWatchDirectories.add(directory);
        this.ensureWatchFallback();
      }
    }
    if (this.failedWatchDirectories.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private ensureWatchFallback(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      try {
        for (const directory of [...this.failedWatchDirectories]) {
          const location = this.locationForDirectory(directory);
          if (!location) {
            this.failedWatchDirectories.delete(directory);
            continue;
          }
          this.scanDirectory(directory, location, true);
        }
        this.rebuildWatchers();
      } catch (error) {
        this.options.log(`agents: definition-file poll failed: ${messageOf(error)}`);
      }
    }, this.options.pollMs ?? DEFAULT_POLL_MS);
    this.pollTimer.unref?.();
  }

  private scheduleWatchFlush(): void {
    if (this.watchTimer) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      try {
        const scans = [...this.pendingScans];
        const paths = [...this.pendingPaths];
        this.pendingScans.clear();
        this.pendingPaths.clear();
        for (const directory of scans) {
          const location = this.locationForDirectory(directory);
          if (location) this.scanDirectory(directory, location, true);
        }
        for (const path of paths) {
          if (scans.includes(dirname(path))) continue;
          const location = this.locationForDirectory(dirname(path));
          if (location) this.readDefinitionPath(path, location, true);
        }
        this.rebuildWatchers();
      } catch (error) {
        this.options.log(`agents: definition-file watch failed: ${messageOf(error)}`);
      }
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.watchTimer.unref?.();
  }

  private wantedLocations(): Map<string, AgentFileLocation> {
    const wanted = new Map<string, AgentFileLocation>();
    if (!this.options.globalReconciliationBlocked()) wanted.set(this.options.globalDirectory(), { scope: "global" });
    for (const projectCwd of this.options.trustedProjects()) {
      wanted.set(this.options.projectDirectory(projectCwd), { scope: "project", projectCwd });
    }
    return wanted;
  }

  private locationForDirectory(directory: string): AgentFileLocation | undefined {
    return this.wantedLocations().get(directory);
  }

  private directoryOf(location: AgentFileLocation): string {
    return location.scope === "global" ? this.options.globalDirectory() : this.options.projectDirectory(location.projectCwd);
  }
}

export function agentFileDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function closestExistingDirectory(path: string, floor?: string): string | undefined {
  if (floor) {
    try {
      if (!statSync(floor).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  let cursor = path;
  while (true) {
    try {
      if (statSync(cursor).isDirectory()) return cursor;
    } catch { /* move to the parent */ }
    if (floor && cursor === floor) return undefined;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function locationOf(agent: AgentDefinition): AgentFileLocation {
  return agent.scope === "project" ? { scope: "project", projectCwd: agent.projectCwd ?? "" } : { scope: "global" };
}

function sameLocation(left: AgentFileLocation, right: AgentFileLocation): boolean {
  return left.scope === right.scope && (left.scope === "global" || (right.scope === "project" && left.projectCwd === right.projectCwd));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
