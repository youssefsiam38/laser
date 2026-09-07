/**
 * WorkerServer (M0-T6) — JSON-RPC dispatch for one worker process (one cwd).
 *
 * Transport-agnostic: the caller feeds raw inbound values into `handle()` and
 * receives outbound messages through `send`. `main.ts` wires this to a pipe.
 *
 * Sessions are keyed by session file path. Each carries a monotonically
 * increasing `seq` and a bounded replay buffer so a client can `session/load`
 * with `fromSeq` after a reconnect and miss nothing that is still buffered.
 * Pending extension dialogs are re-emitted on load for the same reason.
 */

import { ErrorCodes, PRODUCT_NAME, ProtocolError, parseClientRequest, type ClientRequests, type CommandInfo, type ContentBlock, type FeatureId, type HostNotifications, type JsonRpcMessage, type JsonRpcResponse, type PiExtensionModuleName, type SessionState, type SessionUpdateParams, type TypedClientRequest } from "@lasercode/protocol";
import { resolve } from "node:path";
import type { DriverEvent, SessionDriver } from "./driver.js";
import { ProjectFilesService } from "./files.js";
import { GitService } from "./git.js";
import { KeybindingsAdapter } from "./keybindings.js";
import { ModelsAdapter, PackagesAdapter } from "./packages.js";
import { SettingsAdapter } from "./settings.js";
import { WebSearchService } from "./web-search.js";
import { TranscribeService } from "./transcribe.js";

export interface WorkerServerOptions {
  cwd: string;
  createDriver: () => SessionDriver;
  send: (message: JsonRpcMessage) => void;
  agentDir?: string;
  sessionDir?: string;
  subagentsTempRoot?: string;
  /** Host-resolved Pi project trust for `cwd`; see `DriverOpenOptions.projectTrusted`. */
  projectTrusted?: boolean;
  features?: FeatureId[];
  /** Updates kept per session for `fromSeq` replay. */
  replayBuffer?: number;
  /** The package manager to run when settings name none (M10-T5): the one the host bundles. */
  npmCommand?: string[];
}

interface Live {
  driver: SessionDriver;
  seq: number;
  buffer: SessionUpdateParams[];
  unsubscribe: () => void;
  path: string;
}

type Result<M extends keyof ClientRequests> = ClientRequests[M]["result"];

export class WorkerServer {
  private readonly sessions = new Map<string, Live>();
  /**
   * Opens in flight, keyed by session path. `handle()` dispatches concurrently,
   * so two `session/load`s for one path used to miss the `sessions` map, build
   * two drivers on one Pi session file (AGENTS.md invariant 8) and orphan the
   * first — its subscription still emitting, its runtime leaked. Nothing above
   * can dedupe this: a desktop and a phone are two clients, and the pool's
   * crash recovery can race a client's own reconnect.
   */
  private readonly opening = new Map<string, Promise<SessionState>>();
  private readonly replayBuffer: number;
  /**
   * M4 adapters. Built on first use: constructing a `SettingsManager` reads two
   * files and `ModelRuntime.create` touches the network-free catalogue, and a
   * worker that never opens the settings screen should pay for neither.
   */
  private settingsAdapter: SettingsAdapter | undefined;
  private packagesAdapter: PackagesAdapter | undefined;
  private modelsAdapter: ModelsAdapter | undefined;
  /** M2-T6 git line. Built on first use like the adapters above. */
  private gitService: GitService | undefined;
  /** M4-T7 keybindings, and the `@` popover's file list. Both built on first use. */
  private keybindingsAdapter: KeybindingsAdapter | undefined;
  private filesService: ProjectFilesService | undefined;
  /** M8-T2 dictation. Built on first use; `register()` publishes drain() in-process. */
  private transcribeService: TranscribeService | undefined;
  /** The companion extension's last capability report; features gate on it (M8-T1). */
  private activeModules = new Set<PiExtensionModuleName>();
  /** Coalesce simultaneous new-chat command requests into one read-only runtime. */
  private commandCatalogInFlight: Promise<CommandInfo[]> | undefined;

  constructor(private readonly options: WorkerServerOptions) {
    this.replayBuffer = options.replayBuffer ?? 5000;
  }

  /** Paths of sessions currently open in this worker. */
  openSessions(): string[] {
    return [...this.sessions.keys()];
  }

  notify<M extends keyof HostNotifications>(method: M, params: HostNotifications[M]): void {
    this.options.send({ jsonrpc: "2.0", method, params });
  }

  /** Handle one inbound raw JSON-RPC value. Never throws; errors become responses. */
  async handle(raw: unknown): Promise<void> {
    let req: TypedClientRequest;
    try {
      req = parseClientRequest(raw);
    } catch (error) {
      const id = (raw as { id?: string | number } | null)?.id ?? null;
      this.respondError(id, error);
      return;
    }
    try {
      const result = await this.dispatch(req);
      this.options.send({ jsonrpc: "2.0", id: req.id, result });
    } catch (error) {
      this.respondError(req.id, error);
    }
  }

  async dispose(): Promise<void> {
    this.transcribeService?.dispose();
    this.transcribeService = undefined;
    for (const live of this.sessions.values()) {
      live.unsubscribe();
      await live.driver.dispose().catch(() => {});
    }
    this.sessions.clear();
  }

  // ------------------------------------------------------------- dispatch

  private async dispatch(req: TypedClientRequest): Promise<unknown> {
    switch (req.method) {
      case "session/new":
        return this.sessionNew(req.params);
      case "session/load":
        return this.sessionLoad(req.params);
      case "session/prompt": {
        const { driver } = this.live(req.params.path);
        const r = await driver.prompt(req.params.content, {
          ...(req.params.streamingBehavior ? { streamingBehavior: req.params.streamingBehavior } : {}),
        });
        return r satisfies Result<"session/prompt">;
      }
      case "session/cancel":
        await this.live(req.params.path).driver.abort();
        return {};
      case "session/set_mode":
        throw new ProtocolError(ErrorCodes.Unsupported, "session/set_mode is not supported by this worker yet");

      case "pi/session/list":
        throw new ProtocolError(ErrorCodes.Unsupported, "pi/session/list is answered by the host catalog, not a worker");
      case "pi/session/detach":
        throw new ProtocolError(
          ErrorCodes.Unsupported,
          "pi/session/detach is host bookkeeping; a worker has nothing to detach from",
        );
      case "pi/session/steer":
        // steer/follow_up call the runtime directly and so bypass Pi's `input`
        // hook, where the companion extension folds in a phrase still being
        // transcribed. Doing it here keeps the three send paths identical.
        await this.live(req.params.path).driver.steer(await this.withDictation(req.params.path, req.params.content));
        return {};
      case "pi/session/follow_up":
        await this.live(req.params.path).driver.followUp(await this.withDictation(req.params.path, req.params.content));
        return {};
      case "pi/session/clear_queue":
        return this.live(req.params.path).driver.clearQueue();
      case "pi/session/fork": {
        const live = this.live(req.params.path);
        const forked = await live.driver.fork(req.params.entryId);
        const { state } = forked;
        if (state.path !== live.path) {
          // The driver now serves the forked session file; re-key it so later
          // requests by the new path find it. Clients learn the new path from
          // the result and from the state update that follows.
          this.sessions.delete(live.path);
          live.path = state.path;
          this.sessions.set(state.path, live);
        }
        this.onDriverEvent(live, { type: "update", update: { kind: "state", state } });
        return forked satisfies Result<"pi/session/fork">;
      }
      case "pi/session/navigate": {
        const { driver } = this.live(req.params.path);
        return driver.navigateTree(req.params.entryId, {
          ...(req.params.summarize !== undefined ? { summarize: req.params.summarize } : {}),
          ...(req.params.label !== undefined ? { label: req.params.label } : {}),
        });
      }
      case "pi/session/rename":
        await this.live(req.params.path).driver.rename(req.params.name);
        return {};
      case "pi/session/entries":
        return { entries: await this.live(req.params.path).driver.entries() } satisfies Result<"pi/session/entries">;
      case "pi/session/compact":
        await this.live(req.params.path).driver.compact(req.params.instructions);
        return {};
      case "pi/model/list":
        return { models: await this.live(req.params.path).driver.listModels() } satisfies Result<"pi/model/list">;
      case "pi/model/set":
        return { state: await this.live(req.params.path).driver.setModel(req.params.model) } satisfies Result<"pi/model/set">;
      case "pi/thinking/set":
        return {
          state: await this.live(req.params.path).driver.setThinkingLevel(req.params.level),
        } satisfies Result<"pi/thinking/set">;
      case "pi/account-usage/refresh": {
        const delivered = this.live(req.params.path).driver.deliverExtensionCommand?.({
          type: "lasercode/account-usage/refresh",
        }) ?? false;
        return { delivered } satisfies Result<"pi/account-usage/refresh">;
      }
      case "session/goal/get": {
        const goal = await this.live(req.params.path).driver.goalState?.();
        return { goal: goal ?? null } satisfies Result<"session/goal/get">;
      }
      case "session/goal/action": {
        const driver = this.live(req.params.path).driver;
        if (!driver.goalAction) throw new ProtocolError(ErrorCodes.Unsupported, "Goals are not available in this session.");
        return { goal: await driver.goalAction(req.params.action) } satisfies Result<"session/goal/action">;
      }
      case "pi/ui/response": {
        // Answer only the session that raised the dialog: ids are minted per
        // UI bridge, so broadcasting could settle another session's dialog with
        // an answer the user never gave it.
        const owner = this.ownerOfDialog(req.params.id);
        if (!owner) return { delivered: false } satisfies Result<"pi/ui/response">;
        owner.driver.respondToUi(req.params);
        return { delivered: true } satisfies Result<"pi/ui/response">;
      }

      // -------------------------------------------------------- panels ---
      case "pi/panel/action": {
        // The extension that declared the panel answers on Pi's bus; `false`
        // means nobody holds that id any more (it closed, or the session
        // restarted), which the client turns into a sentence.
        const { driver } = this.live(req.params.path);
        const delivered =
          driver.deliverExtensionCommand?.({
            type: "lasercode/panel/action",
            id: req.params.id,
            actionId: req.params.actionId,
            ...(req.params.value !== undefined ? { value: req.params.value } : {}),
          }) ?? false;
        return { delivered } satisfies Result<"pi/panel/action">;
      }
      case "pi/panel/list":
      case "pi/panel/read":
        throw new ProtocolError(
          ErrorCodes.Unsupported,
          `${req.method} is answered by the host's panel hub, not a worker`,
        );

      // ---------------------------------------------------- M8 dictation ---
      case "pi/transcribe/status":
        this.assertCwd(req.params.cwd);
        return (await this.transcribe().status()) satisfies Result<"pi/transcribe/status">;
      case "pi/transcribe/begin":
        this.assertCwd(req.params.cwd);
        return this.transcribe().begin({
          mimeType: req.params.mimeType,
          ...(req.params.language !== undefined ? { language: req.params.language } : {}),
          ...(req.params.path !== undefined ? { sessionPath: req.params.path } : {}),
        }) satisfies Result<"pi/transcribe/begin">;
      case "pi/transcribe/chunk":
        this.transcribe().chunk(req.params.id, req.params.data);
        return {};
      case "pi/transcribe/end":
        return (await this.transcribe().end(req.params.id)) satisfies Result<"pi/transcribe/end">;
      case "pi/transcribe/cancel":
        this.transcribe().cancel(req.params.id);
        return {};

      // ------------------------------------------------------ host-only ---
      case "pi/push/config":
      case "pi/push/subscribe":
      case "pi/push/unsubscribe":
      case "pi/push/test":
        throw new ProtocolError(ErrorCodes.Unsupported, `${req.method} is answered by the host, not a worker`);

      // -------------------------------------------------------- M2-T6 ---
      case "pi/project/git": {
        this.assertCwd(req.params.cwd);
        const git = this.git();
        // A session loaded before this worker knew about git lines (or a
        // caller naming a session this worker never opened) still gets a
        // baseline from now on, so the numbers start counting at first ask.
        if (req.params.path !== undefined && this.sessions.has(req.params.path)) await git.baseline(req.params.path);
        return (await git.status(req.params.path)) satisfies Result<"pi/project/git">;
      }

      // -------------------------------------------------- M4-T7 keys ---
      case "pi/keybindings/get":
        this.assertCwd(req.params.cwd);
        return { keybindings: await this.keybindings().snapshot() } satisfies Result<"pi/keybindings/get">;
      case "pi/keybindings/set":
        this.assertCwd(req.params.cwd);
        return {
          keybindings: await this.keybindings().apply(req.params.changes),
        } satisfies Result<"pi/keybindings/set">;

      // ------------------------------------------- composer sources ---
      case "pi/commands/list":
        if ("cwd" in req.params) {
          const { cwd } = req.params as { cwd: string };
          this.assertCwd(cwd);
          return { commands: await this.projectCommands() } satisfies Result<"pi/commands/list">;
        }
        return { commands: await this.live(req.params.path).driver.commands() } satisfies Result<"pi/commands/list">;
      case "pi/prompts/list":
        return { prompts: await this.live(req.params.path).driver.prompts() } satisfies Result<"pi/prompts/list">;
      case "pi/project/files": {
        this.assertCwd(req.params.cwd);
        return (await this.files().list({
          ...(req.params.query !== undefined ? { query: req.params.query } : {}),
          ...(req.params.limit !== undefined ? { limit: req.params.limit } : {}),
        })) satisfies Result<"pi/project/files">;
      }

      // ----------------------------------------------------------- M4 ---
      case "pi/settings/list":
        this.assertCwd(req.params.cwd);
        return { catalog: this.settings().catalog() } satisfies Result<"pi/settings/list">;
      case "pi/settings/get": {
        this.assertCwd(req.params.cwd);
        const settings = this.settings();
        await settings.refresh();
        return { snapshot: settings.snapshot() } satisfies Result<"pi/settings/get">;
      }
      case "pi/settings/set": {
        this.assertCwd(req.params.cwd);
        return {
          snapshot: await this.settings().apply(req.params.scope, req.params.changes),
        } satisfies Result<"pi/settings/set">;
      }

      case "pi/packages/list":
        this.assertCwd(req.params.cwd);
        return { packages: this.packages().list() } satisfies Result<"pi/packages/list">;
      case "pi/packages/install":
        this.assertCwd(req.params.cwd);
        return {
          packages: await this.packages().install(req.params.source, req.params.scope),
        } satisfies Result<"pi/packages/install">;
      case "pi/packages/remove":
        this.assertCwd(req.params.cwd);
        return (await this.packages().remove(req.params.source, req.params.scope)) satisfies Result<"pi/packages/remove">;
      case "pi/packages/update":
        this.assertCwd(req.params.cwd);
        return { packages: await this.packages().update(req.params.source) } satisfies Result<"pi/packages/update">;
      case "pi/packages/check_updates":
        this.assertCwd(req.params.cwd);
        return { updates: await this.packages().checkUpdates() } satisfies Result<"pi/packages/check_updates">;

      case "pi/providers/list":
        this.assertCwd(req.params.cwd);
        return (await this.modelCatalog().providers()) satisfies Result<"pi/providers/list">;
      case "web-search/status":
        this.assertCwd(req.params.cwd);
        return new WebSearchService(this.options.agentDir).status();
      case "web-search/configure":
        this.assertCwd(req.params.cwd);
        return new WebSearchService(this.options.agentDir).configure(req.params.change);
      case "pi/providers/login/start": {
        this.assertCwd(req.params.cwd);
        const provider = req.params.provider;
        const id = await this.modelCatalog().loginStart(provider, req.params.method, (loginId, event) =>
          this.notify("pi/providers/login/event", { cwd: this.options.cwd, id: loginId, provider, event }),
        );
        return { id } satisfies Result<"pi/providers/login/start">;
      }
      case "pi/providers/login/answer":
        this.assertCwd(req.params.cwd);
        this.modelCatalog().loginAnswer(req.params.id, req.params.promptId, req.params.value);
        return {} satisfies Result<"pi/providers/login/answer">;
      case "pi/providers/login/cancel":
        this.assertCwd(req.params.cwd);
        this.modelCatalog().loginCancel(req.params.id);
        return {} satisfies Result<"pi/providers/login/cancel">;
      case "pi/providers/logout":
        this.assertCwd(req.params.cwd);
        return { providers: await this.modelCatalog().logout(req.params.provider) } satisfies Result<"pi/providers/logout">;
      case "pi/models/catalog":
        this.assertCwd(req.params.cwd);
        return (await this.modelCatalog().catalog(req.params.refresh ?? false)) satisfies Result<"pi/models/catalog">;

      case "pi/logs/query":
      case "pi/logs/content":
      case "pi/logs/stats":
      case "pi/logs/clear":
        throw new ProtocolError(
          ErrorCodes.Unsupported,
          `${req.method} is answered by the host's log store, not a worker`,
        );

      case "pi/prefs/get":
      case "pi/prefs/set":
        throw new ProtocolError(
          ErrorCodes.Unsupported,
          `${req.method} is answered by the host: ${PRODUCT_NAME}'s own preferences are not per project and must outlive a sleeping worker`,
        );
    }
  }

  // ------------------------------------------------------------- M4 adapters

  private assertCwd(cwd: string): void {
    if (resolve(cwd) !== resolve(this.options.cwd)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `this worker serves ${this.options.cwd}, not ${cwd}`);
    }
  }

  private settings(): SettingsAdapter {
    this.settingsAdapter ??= new SettingsAdapter({
      cwd: this.options.cwd,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.projectTrusted !== undefined ? { hostTrusted: this.options.projectTrusted } : {}),
    });
    return this.settingsAdapter;
  }

  private packages(): PackagesAdapter {
    this.packagesAdapter ??= new PackagesAdapter({
      cwd: this.options.cwd,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      settings: this.settings(),
      onProgress: (event) => this.notify("pi/packages/progress", { cwd: this.options.cwd, ...event }),
      ...(this.options.npmCommand ? { npmCommand: this.options.npmCommand } : {}),
    });
    return this.packagesAdapter;
  }

  private git(): GitService {
    this.gitService ??= new GitService({ cwd: this.options.cwd });
    return this.gitService;
  }

  private keybindings(): KeybindingsAdapter {
    this.keybindingsAdapter ??= new KeybindingsAdapter({
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
    });
    return this.keybindingsAdapter;
  }

  private files(): ProjectFilesService {
    this.filesService ??= new ProjectFilesService({ cwd: this.options.cwd });
    return this.filesService;
  }

  private transcribe(): TranscribeService {
    if (!this.transcribeService) {
      const service = new TranscribeService({
        keys: {
          providerKey: (provider) => this.modelCatalog().apiKeyForProvider(provider),
          providers: async () => (await this.modelCatalog().providers()).providers,
        },
      });
      // Publishes drain() to the companion extension in this process, so Pi's
      // own `input` hook can pick up a phrase still in flight.
      service.register();
      this.transcribeService = service;
    }
    return this.transcribeService;
  }

  /**
   * Append a phrase the microphone was still transcribing to the text being
   * sent, so pressing Enter mid-sentence does not lose the tail.
   */
  private async withDictation(path: string, content: ContentBlock[]): Promise<ContentBlock[]> {
    if (!this.transcribeService?.isActive(path)) return content;
    const tail = await this.transcribeService.drain(path);
    if (tail === "") return content;
    const last = content.at(-1);
    if (last?.type !== "text") return [...content, { type: "text", text: tail }];
    const joined = last.text === "" || /\s$/.test(last.text) ? `${last.text}${tail}` : `${last.text} ${tail}`;
    return [...content.slice(0, -1), { type: "text", text: joined }];
  }

  private modelCatalog(): ModelsAdapter {
    this.modelsAdapter ??= new ModelsAdapter({
      cwd: this.options.cwd,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      settings: this.settings(),
    });
    return this.modelsAdapter;
  }

  private async sessionNew(params: ClientRequests["session/new"]["params"]): Promise<Result<"session/new">> {
    if (params.cwd !== this.options.cwd) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `this worker serves ${this.options.cwd}, not ${params.cwd}`);
    }
    const state = await this.openAndAttach({
      cwd: this.options.cwd,
      ...(params.parentPath ? { parentSessionPath: params.parentPath } : {}),
      ...this.commonOpen(),
    });
    return { state: this.withCapabilities(state) };
  }

  private async sessionLoad(params: ClientRequests["session/load"]["params"]): Promise<Result<"session/load">> {
    const existing = this.sessions.get(params.path);
    if (existing) {
      const state = existing.driver.state();
      this.replay(existing, params.fromSeq);
      return { state: this.withCapabilities(state), replayFrom: this.replayFloor(existing, params.fromSeq) };
    }
    const inFlight = this.opening.get(params.path);
    if (inFlight) {
      const state = await inFlight;
      const live = this.sessions.get(state.path);
      if (!live) return { state: this.withCapabilities(state), replayFrom: 0 };
      this.replay(live, params.fromSeq);
      return { state: this.withCapabilities(state), replayFrom: this.replayFloor(live, params.fromSeq) };
    }
    // Registered synchronously, before `open()` gets a chance to yield.
    const promise = this.openAndAttach({ cwd: this.options.cwd, sessionPath: params.path, ...this.commonOpen() });
    this.opening.set(params.path, promise);
    try {
      const state = await promise;
      return { state: this.withCapabilities(state), replayFrom: 0 };
    } finally {
      this.opening.delete(params.path);
    }
  }

  private withCapabilities(state: SessionState): SessionState {
    return { ...state, capabilities: [...this.activeModules] };
  }

  /**
   * The earliest seq this reply actually covers.
   *
   * Answering with the `fromSeq` the client asked for is a lie once the replay
   * buffer no longer reaches that far — every token delta consumes a seq, so a
   * few thousand tokens is one buffer. The client would believe it missed
   * nothing and render a transcript with a hole in it. Reporting the real floor
   * lets it notice the mismatch and re-hydrate.
   */
  private replayFloor(live: Live, fromSeq: number | undefined): number {
    const asked = fromSeq ?? 0;
    // A restarted worker numbers from 1 again, so a client holding seq 40 is
    // asking about an epoch this process never had. Answering `asked` would
    // tell it "you missed nothing" and every update we then send would be
    // deduped away as a replay: alive-looking, rendering nothing. Checked
    // before the buffer, because the buffer is usually non-empty already —
    // `WorkerPool.reopen` re-loads the session right after the crash and the
    // first driver event lands in it.
    if (asked > live.seq) return live.seq;
    const oldest = live.buffer[0]?.seq;
    // Nothing buffered: nothing after `live.seq` can be replayed either.
    if (oldest === undefined) return live.seq;
    return asked >= oldest - 1 ? asked : oldest - 1;
  }

  /**
   * Subscribe before opening: extensions emit (e.g. the companion's capability
   * report at `session_start`) while `open()` is still running. Those events
   * are queued and flushed once the session path is known.
   */
  private async openAndAttach(openOptions: Parameters<SessionDriver["open"]>[0]): Promise<SessionState> {
    const driver = this.options.createDriver();
    const live: Live = { driver, seq: 0, buffer: [], unsubscribe: () => {}, path: "" };
    const queued: DriverEvent[] = [];
    let ready = false;
    live.unsubscribe = driver.subscribe((event) => (ready ? this.onDriverEvent(live, event) : queued.push(event)));
    try {
      const state = await driver.open(openOptions);
      const already = this.sessions.get(state.path);
      if (already && already !== live) {
        // Someone else got there first (a `session/new` that landed on an
        // existing path, say). One writer per session file, always.
        live.unsubscribe();
        await driver.dispose().catch(() => {});
        return already.driver.state();
      }
      live.path = state.path;
      this.sessions.set(state.path, live);
      ready = true;
      for (const event of queued) this.onDriverEvent(live, event);
      // Capture "since the session started" for the git line. Fire and forget:
      // a failure here means the line shows nothing, never that the open fails.
      void this.git().baseline(state.path);
      return state;
    } catch (error) {
      live.unsubscribe();
      await driver.dispose().catch(() => {});
      throw error;
    }
  }

  private commonOpen() {
    return {
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
      ...(this.options.subagentsTempRoot ? { subagentsTempRoot: this.options.subagentsTempRoot } : {}),
      ...(this.options.projectTrusted !== undefined ? { projectTrusted: this.options.projectTrusted } : {}),
      ...(this.options.features ? { features: this.options.features } : {}),
    };
  }

  /**
   * Load the same Pi resources a first session will use, without attaching the
   * ephemeral session or writing a transcript. This makes skills available in
   * the composer before the first message creates the real session.
   */
  private projectCommands(): Promise<CommandInfo[]> {
    if (this.commandCatalogInFlight) return this.commandCatalogInFlight;
    const pending = (async () => {
      const driver = this.options.createDriver();
      try {
        await driver.open({ cwd: this.options.cwd, ...this.commonOpen() });
        return await driver.commands();
      } finally {
        await driver.dispose().catch(() => {});
      }
    })();
    this.commandCatalogInFlight = pending;
    void pending.finally(() => {
      if (this.commandCatalogInFlight === pending) this.commandCatalogInFlight = undefined;
    }).catch(() => {});
    return pending;
  }

  // ------------------------------------------------------------- sessions

  private live(path: string): Live {
    const live = this.sessions.get(path);
    if (!live) throw new ProtocolError(ErrorCodes.SessionNotFound, `session ${path} is not open in this worker`);
    return live;
  }

  /**
   * The session whose UI bridge is holding `id`. Drivers that cannot report
   * their pending dialogs (the stub) fall back to the only open session, so a
   * single-session worker keeps working.
   */
  private ownerOfDialog(id: string): Live | undefined {
    let blind: Live | undefined;
    let blindCount = 0;
    for (const live of this.sessions.values()) {
      const pendingUi = (live.driver as { pendingUi?: () => Array<{ id: string }> }).pendingUi;
      if (typeof pendingUi === "function") {
        if (pendingUi.call(live.driver).some((request) => request.id === id)) return live;
        continue;
      }
      // A driver that cannot report its pending dialogs (the stub).
      blind = live;
      blindCount += 1;
    }
    // Guessing is only safe when exactly one session could not be asked. A
    // driver that *can* be asked and does not claim the id genuinely does not
    // have it, and the caller is told so rather than answering into the void.
    return blindCount === 1 ? blind : undefined;
  }

  private onDriverEvent(live: Live, event: DriverEvent): void {
    switch (event.type) {
      case "update": {
        const params: SessionUpdateParams = {
          sessionPath: live.path,
          seq: ++live.seq,
          update: event.update,
          at: new Date().toISOString(),
        };
        live.buffer.push(params);
        if (live.buffer.length > this.replayBuffer) live.buffer.splice(0, live.buffer.length - this.replayBuffer);
        this.notify("session/update", params);
        return;
      }
      case "ui_request":
        this.notify("pi/ui/request", { path: live.path, ...event.request });
        return;
      case "ui_event":
        this.notify("pi/ui/event", { path: live.path, ...event.event });
        return;
      case "extension":
        // The capability report is what gates the microphone and everything
        // else that is only offered where its package is (M8-T1).
        if (event.message.type === "lasercode/capabilities") this.activeModules = new Set(event.message.active);
        this.notify("pi/extension/message", { path: live.path, message: event.message });
        return;
      case "closed":
        live.unsubscribe();
        this.sessions.delete(live.path);
        this.gitService?.forget(live.path);
        return;
    }
  }

  /** Re-send buffered updates after `fromSeq`, then any dialogs still waiting. */
  private replay(live: Live, fromSeq: number | undefined): void {
    if (fromSeq !== undefined) {
      for (const params of live.buffer) if (params.seq > fromSeq) this.notify("session/update", params);
    }
    // Pending dialogs are owned by the driver's UI bridge; the driver re-emits
    // them through `ui_request` events when asked. Drivers that expose
    // `pendingUi()` get replayed here (StableSdkDriver does).
    const pendingUi = (live.driver as { pendingUi?: () => Array<HostNotifications["pi/ui/request"]> }).pendingUi;
    if (typeof pendingUi === "function") {
      for (const request of pendingUi.call(live.driver)) this.notify("pi/ui/request", { ...request, path: live.path });
    }
  }

  private respondError(id: string | number | null, error: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: id ?? 0,
      error:
        error instanceof ProtocolError
          ? { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) }
          : { code: ErrorCodes.Internal, message: error instanceof Error ? error.message : String(error) },
    };
    this.options.send(response);
  }
}
