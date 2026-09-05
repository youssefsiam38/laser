/**
 * Package, provider and model adapters (M4-T3, M4-T4).
 *
 * Packages go through Pi's own `DefaultPackageManager` — never `pi install` in
 * a shell. The manager owns npm/git installation, the `.pi/npm` vs
 * `~/.pi/agent/npm` scope split, git dependency repair, and the settings
 * bookkeeping that makes an installed package actually load. Its progress
 * callback is forwarded verbatim as a `pi/packages/progress` notification so a
 * long `npm install` is visible while it runs.
 *
 * Providers and models come from Pi's `ModelRuntime`, the same object a session
 * uses, so the model list here is exactly the list the composer offers. Only
 * *status* crosses the protocol boundary: `configured`, the credential source
 * label Pi computed, and whether it is OAuth or a subscription. Credentials
 * themselves never leave the worker.
 */

import {
  DefaultPackageManager,
  ModelRuntime,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelCatalogEntry,
  PackageEntry,
  PackageProgress,
  PackageScope,
  PackageUpdateInfo,
  ProviderAuthInfo,
  ThinkingLevel,
} from "@piorbit/protocol";
import { join, resolve } from "node:path";
import type { SettingsAdapter } from "./settings.js";

export class PackagesError extends Error {
  override readonly name = "PackagesError";
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Best-effort classification of a package source string, matching Pi's own parsing. */
function sourceType(source: string): "npm" | "git" {
  return /^(https?:\/\/|git\+|git@|github:|gitlab:|bitbucket:)/.test(source) || source.endsWith(".git")
    ? "git"
    : "npm";
}

// ------------------------------------------------------------------ packages

export interface PackagesAdapterOptions {
  cwd: string;
  agentDir?: string;
  settings: SettingsAdapter;
  /** Called for every `ProgressEvent` Pi emits during install/remove/update. */
  onProgress: (event: Omit<PackageProgress, "cwd">) => void;
}

export class PackagesAdapter {
  readonly cwd: string;
  readonly agentDir: string;
  private readonly settings: SettingsAdapter;
  private readonly manager: DefaultPackageManager;
  private readonly onProgress: PackagesAdapterOptions["onProgress"];
  /** Update availability from the last `checkUpdates()`, keyed by source. */
  private updates = new Map<string, PackageUpdateInfo>();
  /**
   * One package operation at a time. Requests are dispatched concurrently, and
   * two npm installs against one `.pi/npm` tree corrupt each other; the shared
   * progress callback would also interleave their events under one stream.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private busy: string | undefined;

  constructor(options: PackagesAdapterOptions) {
    this.cwd = resolve(options.cwd);
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.settings = options.settings;
    this.manager = new DefaultPackageManager({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: options.settings.settingsManager,
    });
    this.onProgress = options.onProgress;
    this.manager.setProgressCallback((event) =>
      this.onProgress({
        type: event.type,
        action: event.action,
        source: event.source,
        ...(event.message !== undefined ? { message: event.message } : {}),
      }),
    );
  }

  list(): PackageEntry[] {
    return this.manager.listConfiguredPackages().map((pkg) => {
      const update = this.updates.get(pkg.source);
      return {
        source: pkg.source,
        scope: pkg.scope,
        filtered: pkg.filtered,
        ...(pkg.installedPath !== undefined ? { installedPath: pkg.installedPath } : {}),
        type: update?.type ?? sourceType(pkg.source),
        ...(update ? { updateAvailable: true } : {}),
      };
    });
  }

  async install(source: string, scope: PackageScope): Promise<PackageEntry[]> {
    this.assertProjectWritable(scope, `install ${source} into this project`);
    await this.run(`install ${source}`, () => this.manager.installAndPersist(source, { local: scope === "project" }), source);
    this.updates.delete(source);
    await this.settings.refresh();
    return this.list();
  }

  async remove(source: string, scope: PackageScope): Promise<{ packages: PackageEntry[]; removed: boolean }> {
    this.assertProjectWritable(scope, `remove ${source} from this project`);
    const removed = await this.run(
      `remove ${source}`,
      () => this.manager.removeAndPersist(source, { local: scope === "project" }),
      source,
    );
    this.updates.delete(source);
    await this.settings.refresh();
    return { packages: this.list(), removed };
  }

  async update(source?: string): Promise<PackageEntry[]> {
    await this.run(source ? `update ${source}` : "update packages", () => this.manager.update(source), source ?? "");
    if (source) this.updates.delete(source);
    else this.updates.clear();
    await this.settings.refresh();
    return this.list();
  }

  async checkUpdates(): Promise<PackageUpdateInfo[]> {
    const found = await this.run("check for package updates", () => this.manager.checkForAvailableUpdates());
    this.updates = new Map(found.map((update) => [update.source, { ...update }]));
    return [...this.updates.values()];
  }

  private assertProjectWritable(scope: PackageScope, what: string): void {
    if (scope !== "project") return;
    // `projectTrust` rather than `snapshot()`: a snapshot drains the settings
    // manager's error queue, and a pre-flight check must not consume errors the
    // settings screen has not shown yet.
    const projectTrust = this.settings.projectTrust;
    if (!projectTrust.writable) {
      throw new PackagesError(
        `piorbit cannot ${what}: ${projectTrust.reason} Trust the project first, or install it for your user instead.`,
      );
    }
  }

  /**
   * Pi's package errors are already user-facing; keep them and say what failed.
   * Operations are serialized, and a failure emits a terminal progress event —
   * Pi's own stream just stops on an error, which leaves any UI keyed on it
   * spinning forever.
   */
  private async run<T>(what: string, work: () => Promise<T>, source = ""): Promise<T> {
    const mine = this.queue.then(
      () => undefined,
      () => undefined,
    );
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => (release = resolve));
    await mine;
    this.busy = what;
    try {
      return await work();
    } catch (error) {
      const message = `Could not ${what}: ${error instanceof Error ? error.message : String(error)}`;
      this.onProgress({ type: "error", action: actionOf(what), source, message });
      throw new PackagesError(message);
    } finally {
      this.busy = undefined;
      release();
    }
  }

  /** What is running right now, for a caller that wants to say so. */
  get running(): string | undefined {
    return this.busy;
  }
}

/** The progress `action` a failed operation should close, from its description. */
function actionOf(what: string): "install" | "remove" | "update" | "clone" | "pull" {
  if (what.startsWith("install")) return "install";
  if (what.startsWith("remove")) return "remove";
  return "update";
}

// ----------------------------------------------------------- providers/models

export interface ModelsAdapterOptions {
  cwd: string;
  agentDir?: string;
  settings: SettingsAdapter;
}

export interface ModelCatalogResult {
  models: ModelCatalogEntry[];
  enabledPatterns: string[] | null;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  refreshedAt: string;
  errors: string[];
}

export class ModelsAdapter {
  readonly agentDir: string;
  private readonly settings: SettingsAdapter;
  private runtime: Promise<ModelRuntime> | undefined;
  private refreshedAt = new Date().toISOString();

  constructor(options: ModelsAdapterOptions) {
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.settings = options.settings;
  }

  /**
   * One runtime for the worker's lifetime, built exactly the way
   * `createAgentSessionServices` builds a session's own.
   */
  private get models(): Promise<ModelRuntime> {
    this.runtime ??= ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
    });
    return this.runtime;
  }

  async providers(): Promise<{ providers: ProviderAuthInfo[]; error?: string }> {
    const runtime = await this.models;
    const providers = runtime.getProviders().map((provider): ProviderAuthInfo => {
      const status = runtime.getProviderAuthStatus(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
        configured: status.configured,
        ...(status.source !== undefined ? { source: status.source } : {}),
        ...(status.label !== undefined ? { label: status.label } : {}),
        oauth: runtime.isUsingOAuth(provider.id),
        subscription: runtime.isUsingSubscription(provider.id),
        modelCount: runtime.getModels(provider.id).length,
      };
    });
    const error = runtime.getError();
    return { providers, ...(error !== undefined ? { error } : {}) };
  }

  async catalog(refresh = false): Promise<ModelCatalogResult> {
    const runtime = await this.models;
    const errors: string[] = [];
    if (refresh) {
      const result = await runtime.refresh({ allowNetwork: true, force: true });
      for (const [provider, error] of result.errors) errors.push(`${provider}: ${error.message}`);
      if (result.aborted) errors.push("The catalogue refresh was cancelled before it finished.");
      this.refreshedAt = new Date().toISOString();
    }

    await this.settings.refresh();
    const effective = this.settings.snapshot().effective;
    const patterns = Array.isArray(effective["enabledModels"])
      ? (effective["enabledModels"] as unknown[]).filter((p): p is string => typeof p === "string")
      : null;
    const perModelThinking = (effective["modelThinkingLevels"] ?? {}) as Record<string, unknown>;

    // `enabled` uses Pi's own scope resolver, so the set here is the set Pi
    // would cycle through — including its "no model matched" warnings.
    let enabled: Set<string> | undefined;
    if (patterns && patterns.length > 0) {
      const scope = await resolveModelScopeWithDiagnostics(patterns, runtime);
      enabled = new Set(scope.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`));
      for (const diagnostic of scope.diagnostics) errors.push(diagnostic.message);
    }

    const models = runtime.getModels().map((model): ModelCatalogEntry => {
      const ref = `${model.provider}/${model.id}`;
      const saved = perModelThinking[ref];
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        vision: model.input.includes("image"),
        maxTokens: model.maxTokens,
        thinkingLevels: supportedThinkingLevels(model.reasoning, model.thinkingLevelMap),
        ...(isThinkingLevel(saved) ? { thinkingLevel: saved } : {}),
        enabled: enabled ? enabled.has(ref) : true,
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
        },
      };
    });
    models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

    const defaultThinking = effective["defaultThinkingLevel"];
    return {
      models,
      enabledPatterns: patterns,
      ...(typeof effective["defaultProvider"] === "string" ? { defaultProvider: effective["defaultProvider"] } : {}),
      ...(typeof effective["defaultModel"] === "string" ? { defaultModel: effective["defaultModel"] } : {}),
      ...(isThinkingLevel(defaultThinking) ? { defaultThinkingLevel: defaultThinking } : {}),
      refreshedAt: this.refreshedAt,
      errors,
    };
  }
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as string[]).includes(value);
}

/**
 * Levels a model accepts. Pi's rule (`Model.thinkingLevelMap`): a missing key
 * means "use the provider default", an explicit null means unsupported. A model
 * without reasoning supports only "off".
 */
export function supportedThinkingLevels(
  reasoning: boolean,
  map: Partial<Record<string, string | null>> | undefined,
): ThinkingLevel[] {
  if (!reasoning) return ["off"];
  if (!map) return [...THINKING_LEVELS];
  return THINKING_LEVELS.filter((level) => !(level in map) || map[level] !== null);
}
