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

import { PRODUCT_NAME } from "@lasercode/protocol";
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
  ProviderLoginEvent,
  ProviderLoginMethod,
  ThinkingLevel,
} from "@lasercode/protocol";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SettingsAdapter } from "./settings.js";

export class PackagesError extends Error {
  override readonly name = "PackagesError";
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Lifecycle scripts reviewed as part of a specific curated release.
 *
 * npm 11's `--strict-allow-scripts` is intentionally kept on: an extension
 * may otherwise add a new transitive setup script without Laser noticing.
 * Keys here are therefore pinned twice — by the extension release and by the
 * dependency release whose script was inspected. A future extension version
 * gets no inherited approval and fails closed until it is reviewed.
 */
const REVIEWED_INSTALL_SCRIPTS: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  "npm:pi-subagents@0.65.1": {
    "esbuild@0.28.1": true,
    "@google/genai@1.52.0": true,
    "protobufjs@7.6.6": true,
  },
};

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
  /**
   * The package manager to run when the person has not configured one
   * (`npmCommand` in settings): `[command, ...args]`. The packaged app ships no
   * `npm` on PATH, so the host hands down the one it bundles (M10-T5). A value
   * the person wrote in settings always wins.
   */
  npmCommand?: string[];
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
      settingsManager: withNpmFallback(options.settings.settingsManager, options.npmCommand),
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
    applyReviewedInstallScripts(this.cwd, this.agentDir, scope, source);
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
        `${PRODUCT_NAME} cannot ${what}: ${projectTrust.reason} Trust the project first, or install it for your user instead.`,
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

/**
 * Merge Laser's exact reviewed approvals into Pi's npm project without
 * overwriting a person's explicit policy. Pi still owns package installation;
 * this only supplies the npm policy its package manager reads.
 */
export function applyReviewedInstallScripts(
  cwd: string,
  agentDir: string,
  scope: PackageScope,
  source: string,
): boolean {
  const reviewed = REVIEWED_INSTALL_SCRIPTS[source];
  if (!reviewed) return false;

  const installRoot = scope === "project" ? join(resolve(cwd), ".pi", "npm") : join(resolve(agentDir), "npm");
  mkdirSync(installRoot, { recursive: true });
  const packageJsonPath = join(installRoot, "package.json");
  let manifest: Record<string, unknown> = { name: "pi-extensions", private: true };
  if (existsSync(packageJsonPath)) {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new PackagesError("The extension store has an invalid package manifest. Repair it before installing extensions.");
    }
    manifest = parsed as Record<string, unknown>;
  }

  const current =
    typeof manifest["allowScripts"] === "object" && manifest["allowScripts"] !== null && !Array.isArray(manifest["allowScripts"])
      ? { ...(manifest["allowScripts"] as Record<string, unknown>) }
      : {};
  let changed = false;
  for (const [dependency, allowed] of Object.entries(reviewed)) {
    const name = dependency.startsWith("@") ? dependency.slice(0, dependency.lastIndexOf("@")) : dependency.split("@")[0]!;
    if (current[name] === false || current[dependency] !== undefined) continue;
    current[dependency] = allowed;
    changed = true;
  }
  if (!changed) return false;

  manifest["allowScripts"] = current;
  const temporary = `${packageJsonPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, packageJsonPath);
  return true;
}

/**
 * Pi asks its `SettingsManager` which package manager to run and falls back to
 * a bare `npm` on PATH. On a machine that has only laser there is none, so
 * the host's bundled command stands in — but only when settings name nothing,
 * so a person's own `npmCommand` (bun, pnpm, a wrapper) is never overridden.
 * A proxy rather than a subclass: the manager is Pi's, constructed by Pi.
 */
function withNpmFallback<T extends { getNpmCommand(): string[] | undefined }>(settingsManager: T, fallback: string[] | undefined): T {
  if (!fallback || fallback.length === 0) return settingsManager;
  return new Proxy(settingsManager, {
    get(target, property, receiver) {
      if (property === "getNpmCommand") {
        return () => target.getNpmCommand() ?? [...fallback];
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
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

/** One sign-in in flight: how to cancel it, and the questions it is waiting on. */
interface LoginFlow {
  abort: AbortController;
  pending: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
}

type LoginInteraction = Parameters<ModelRuntime["login"]>[2];
type LoginPrompt = Parameters<LoginInteraction["prompt"]>[0];
type LoginNotice = Parameters<LoginInteraction["notify"]>[0];

export class ModelsAdapter {
  readonly agentDir: string;
  private readonly settings: SettingsAdapter;
  private runtime: Promise<ModelRuntime> | undefined;
  private refreshedAt = new Date().toISOString();
  private readonly logins = new Map<string, LoginFlow>();

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

  /** The shared runtime, for services that complete or check auth outside a session (Namer, the harness). */
  modelRuntime(): Promise<ModelRuntime> {
    return this.models;
  }

  async providers(): Promise<{ providers: ProviderAuthInfo[]; error?: string }> {
    const runtime = await this.models;
    const providers = runtime.getProviders().map((provider): ProviderAuthInfo => {
      const status = runtime.getProviderAuthStatus(provider.id);
      // Which ways in this provider offers from a UI (M10-T6): an account
      // flow when it declares one, a key flow when its key auth is interactive.
      // A provider that reads only from the environment has neither.
      const methods: ProviderLoginMethod[] = [];
      if (provider.auth.oauth) methods.push("oauth");
      if (provider.auth.apiKey?.login) methods.push("api_key");
      const oauthLabel = provider.auth.oauth?.loginLabel;
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
        methods,
        ...(oauthLabel !== undefined ? { oauthLabel } : {}),
      };
    });
    const error = runtime.getError();
    return { providers, ...(error !== undefined ? { error } : {}) };
  }

  /**
   * Pi's own resolved API key for one provider, or undefined when it has none.
   *
   * Dictation needs the *platform* key, so the caller checks `oauth` on the
   * provider first: `getAuth` happily hands back an OAuth bearer, which the
   * audio endpoint rejects with a 401 halfway through a sentence.
   */
  async apiKeyForProvider(providerId: string): Promise<string | undefined> {
    const runtime = await this.models;
    try {
      const auth = await runtime.getAuth(providerId);
      return auth?.auth.apiKey;
    } catch {
      // No credential, or a provider Pi does not know: the caller says so.
      return undefined;
    }
  }

  /**
   * Begin a sign-in (M10-T6). Pi's login flow is written for a terminal — it
   * calls back with a URL to open, a code to type, a question to answer — and
   * every callback becomes a `ProviderLoginEvent` for the UI, with prompts
   * answered through `loginAnswer`. Resolves with the flow id as soon as the
   * flow has started; the outcome arrives as a `done`, `error` or `cancelled`
   * event. The credential itself is written by Pi to its own store and never
   * passes through here.
   */
  async loginStart(providerId: string, method: ProviderLoginMethod, emit: (id: string, event: ProviderLoginEvent) => void): Promise<string> {
    const runtime = await this.models;
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new PackagesError(`No provider is called "${providerId}".`);
    const supported = method === "oauth" ? provider.auth.oauth !== undefined : provider.auth.apiKey?.login !== undefined;
    if (!supported) {
      throw new PackagesError(
        method === "oauth"
          ? `${provider.name} has no account sign-in; use an API key instead.`
          : `${provider.name} does not take an API key here; it reads its credential from your environment.`,
      );
    }
    const id = randomUUID();
    const flow: LoginFlow = { abort: new AbortController(), pending: new Map() };
    this.logins.set(id, flow);
    let promptSeq = 0;
    const interaction: LoginInteraction = {
      signal: flow.abort.signal,
      prompt: (prompt: LoginPrompt) =>
        new Promise<string>((resolve, reject) => {
          const promptId = `p${++promptSeq}`;
          const settle = { resolve, reject };
          flow.pending.set(promptId, settle);
          const onAbort = () => {
            if (flow.pending.get(promptId) === settle) {
              flow.pending.delete(promptId);
              reject(new Error("Login cancelled"));
            }
          };
          prompt.signal?.addEventListener("abort", onAbort, { once: true });
          flow.abort.signal.addEventListener("abort", onAbort, { once: true });
          emit(id, { type: "prompt", prompt: toLoginPrompt(promptId, prompt) });
        }),
      notify: (event: LoginNotice) => emit(id, toLoginEvent(event)),
    };
    void runtime
      .login(providerId, method, interaction)
      .then(
        () => emit(id, { type: "done", method }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          emit(id, flow.abort.signal.aborted || message === "Login cancelled" ? { type: "cancelled" } : { type: "error", message });
        },
      )
      .finally(() => {
        this.logins.delete(id);
        for (const waiting of flow.pending.values()) waiting.reject(new Error("Login finished"));
        flow.pending.clear();
      });
    return id;
  }

  loginAnswer(id: string, promptId: string, value: string): void {
    const flow = this.logins.get(id);
    if (!flow) throw new PackagesError("That sign-in is no longer running. Start it again.");
    const waiting = flow.pending.get(promptId);
    if (!waiting) throw new PackagesError("That question has already been answered.");
    flow.pending.delete(promptId);
    waiting.resolve(value);
  }

  loginCancel(id: string): void {
    this.logins.get(id)?.abort.abort();
  }

  /** Forget the stored credential for a provider; environment-provided ones are untouched. */
  async logout(providerId: string): Promise<ProviderAuthInfo[]> {
    const runtime = await this.models;
    await runtime.logout(providerId);
    return (await this.providers()).providers;
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

/** Pi's prompt shape → the protocol's. Readonly option lists are copied; nothing else changes. */
function toLoginPrompt(id: string, prompt: LoginPrompt): Extract<ProviderLoginEvent, { type: "prompt" }>["prompt"] {
  const base = { id, kind: prompt.type, message: prompt.message };
  if (prompt.type === "select") {
    return {
      ...base,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description !== undefined ? { description: option.description } : {}),
      })),
    };
  }
  return { ...base, ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}) };
}

function toLoginEvent(event: LoginNotice): ProviderLoginEvent {
  switch (event.type) {
    case "info":
      return {
        type: "info",
        message: event.message,
        ...(event.links ? { links: event.links.map((link) => ({ url: link.url, ...(link.label !== undefined ? { label: link.label } : {}) })) } : {}),
      };
    case "auth_url":
      return { type: "auth_url", url: event.url, ...(event.instructions !== undefined ? { instructions: event.instructions } : {}) };
    case "device_code":
      return {
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
        ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
      };
    case "progress":
      return { type: "progress", message: event.message };
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
