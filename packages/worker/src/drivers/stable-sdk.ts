/**
 * StableSdkDriver — real driver on the pinned stable Pi SDK.
 *
 * Status: skeleton (M0-T4). The shape is fixed; the bodies marked TODO map to
 * `createAgentSessionRuntime` per docs/architecture.md "The driver seam".
 *
 * Mapping notes (Pi 0.85):
 *   - runtime = createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })
 *   - session = runtime.session; session.subscribe(...) for AgentSessionEvent
 *   - dialogs: session.bindExtensions({ mode: "rpc", uiContext }) — see ui-bridge.ts
 *   - message_update in-process still carries partial; we emit deltas only.
 *   - entry_appended drives persistence-aligned transcript updates.
 */

import type {
  ContentBlock,
  ModelRef,
  SessionState,
  ThinkingLevel,
  UiDialogResponse,
} from "@piorbit/protocol";
import {
  DriverUnavailableError,
  type DriverEvent,
  type DriverListener,
  type DriverOpenOptions,
  type PromptOptions,
  type SessionDriver,
} from "../driver.js";
import { createUiBridge, type UiBridge } from "../ui-bridge.js";

export class StableSdkDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  private listeners = new Set<DriverListener>();
  private ui: UiBridge;
  private current: SessionState | undefined;
  // Pi runtime handle. Typed loosely on purpose so no Pi type leaks into public signatures.
  private runtime: unknown;

  constructor() {
    this.ui = createUiBridge({
      onRequest: (request) => this.emit({ type: "ui_request", request }),
      onEvent: (event) => this.emit({ type: "ui_event", event }),
    });
  }

  async open(options: DriverOpenOptions): Promise<SessionState> {
    // TODO(M0-T4): import { createAgentSessionRuntime, createAgentSessionServices,
    //   createAgentSessionFromServices, getAgentDir, SessionManager, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
    // Build a DefaultResourceLoader with extensionFactories: [createPiorbitExtension({ send })]
    // (from @piorbit/pi-extension), build the runtime for options.cwd, bind extensions with
    // this.ui.context and mode "rpc", subscribe to session events and map them to SessionUpdate.
    void options;
    throw new DriverUnavailableError(this.kind, "open() not implemented yet (M0-T4)");
  }

  state(): SessionState {
    if (!this.current) throw new DriverUnavailableError(this.kind, "no open session");
    return this.current;
  }

  subscribe(listener: DriverListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(content: ContentBlock[], options?: PromptOptions): Promise<{ accepted: boolean; queued: boolean }> {
    void content; void options;
    throw new DriverUnavailableError(this.kind, "prompt() not implemented yet (M0-T4)");
  }
  async steer(content: ContentBlock[]): Promise<void> { void content; throw this.todo("steer"); }
  async followUp(content: ContentBlock[]): Promise<void> { void content; throw this.todo("followUp"); }
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> { throw this.todo("clearQueue"); }
  async abort(): Promise<void> { throw this.todo("abort"); }
  async listModels(): Promise<ModelRef[]> { throw this.todo("listModels"); }
  async setModel(model: ModelRef): Promise<SessionState> { void model; throw this.todo("setModel"); }
  async setThinkingLevel(level: ThinkingLevel): Promise<SessionState> { void level; throw this.todo("setThinkingLevel"); }
  async rename(name: string): Promise<void> { void name; throw this.todo("rename"); }
  async compact(instructions?: string): Promise<void> { void instructions; throw this.todo("compact"); }
  async navigateTree(entryId: string, options?: { summarize?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }> {
    void entryId; void options; throw this.todo("navigateTree");
  }
  respondToUi(response: UiDialogResponse): void { this.ui.respond(response); }
  async entries(): Promise<unknown[]> { throw this.todo("entries"); }
  async dispose(): Promise<void> {
    this.ui.dispose();
    this.runtime = undefined;
    this.emit({ type: "closed", reason: "disposed" });
    this.listeners.clear();
  }

  private emit(event: DriverEvent): void {
    for (const l of this.listeners) l(event);
  }
  private todo(method: string): Error {
    return new DriverUnavailableError(this.kind, `${method}() not implemented yet (M0-T4)`);
  }
}
