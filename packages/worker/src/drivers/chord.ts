/**
 * ChordDriver — stub for Pi's experimental pi-server/Chord stack (D-8, MX-T1).
 *
 * Exists to prove the seam: it compiles against SessionDriver with zero Pi
 * imports and every method throws DriverUnavailableError. When the experimental
 * stack becomes usable (extensions, cwd in create, stable contract) and the
 * community migrates, this file becomes the real driver and StableSdkDriver
 * becomes the fallback.
 *
 * Intended mapping (Pi 0.85 experimental services):
 *   pi.session-management  → open / dispose (create, attach, detach)
 *   pi.agent-controller    → prompt, requestAbort, steer, followUp, compact, navigate
 *   pi.transcript          → replicated state → SessionUpdate stream
 *   pi.models              → listModels, setModel, setThinkingLevel
 *   keyed dialog services  → ui_request / respondToUi
 */

import type {
  CommandInfo,
  ContentBlock,
  ModelRef,
  PromptInfo,
  SessionState,
  ThinkingLevel,
  UiDialogResponse,
} from "@piorbit/protocol";
import {
  DriverUnavailableError,
  type DriverListener,
  type DriverOpenOptions,
  type PromptOptions,
  type SessionDriver,
} from "../driver.js";

const NOT_YET = "Pi experimental server is not a supported runtime yet (see STATUS_DETAILED.md MX-T1)";

export class ChordDriver implements SessionDriver {
  readonly kind = "chord" as const;
  private listeners = new Set<DriverListener>();

  async open(options: DriverOpenOptions): Promise<SessionState> { void options; throw new DriverUnavailableError(this.kind, NOT_YET); }
  state(): SessionState { throw new DriverUnavailableError(this.kind, NOT_YET); }
  subscribe(listener: DriverListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async prompt(content: ContentBlock[], options?: PromptOptions): Promise<{ accepted: boolean; queued: boolean }> { void content; void options; throw new DriverUnavailableError(this.kind, NOT_YET); }
  async steer(content: ContentBlock[]): Promise<void> { void content; throw new DriverUnavailableError(this.kind, NOT_YET); }
  async followUp(content: ContentBlock[]): Promise<void> { void content; throw new DriverUnavailableError(this.kind, NOT_YET); }
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> { throw new DriverUnavailableError(this.kind, NOT_YET); }
  async abort(): Promise<void> { throw new DriverUnavailableError(this.kind, NOT_YET); }
  async listModels(): Promise<ModelRef[]> { throw new DriverUnavailableError(this.kind, NOT_YET); }
  async setModel(model: ModelRef): Promise<SessionState> { void model; throw new DriverUnavailableError(this.kind, NOT_YET); }
  async setThinkingLevel(level: ThinkingLevel): Promise<SessionState> { void level; throw new DriverUnavailableError(this.kind, NOT_YET); }
  async rename(name: string): Promise<void> { void name; throw new DriverUnavailableError(this.kind, NOT_YET); }
  async compact(instructions?: string): Promise<void> { void instructions; throw new DriverUnavailableError(this.kind, NOT_YET); }
  async navigateTree(entryId: string, options?: { summarize?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }> { void entryId; void options; throw new DriverUnavailableError(this.kind, NOT_YET); }
  async fork(entryId: string): Promise<{ state: SessionState; editorText?: string }> { void entryId; throw new DriverUnavailableError(this.kind, NOT_YET); }
  respondToUi(response: UiDialogResponse): void { void response; }
  async commands(): Promise<CommandInfo[]> { throw new DriverUnavailableError(this.kind, NOT_YET); }
  async prompts(): Promise<PromptInfo[]> { throw new DriverUnavailableError(this.kind, NOT_YET); }
  async entries(): Promise<unknown[]> { throw new DriverUnavailableError(this.kind, NOT_YET); }
  async dispose(): Promise<void> { this.listeners.clear(); }
}
