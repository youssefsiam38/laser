/**
 * SessionDriver — the migration seam (AGENTS.md invariant 3, decisions D-6/D-8).
 *
 * Everything above the worker sees only @piorbit/protocol types. A driver
 * turns protocol-level intents into calls on some Pi runtime and turns that
 * runtime's events into protocol `SessionUpdate`s.
 *
 * Two implementations:
 *   - StableSdkDriver: real, on the pinned stable Pi SDK (createAgentSessionRuntime).
 *   - ChordDriver: stub that compiles against this interface and throws
 *     DriverUnavailable, proving the seam. Becomes real when Pi's
 *     pi-server/Chord stack is usable and the community migrates.
 *
 * Rules for changing this file:
 *   - Both drivers must keep compiling.
 *   - No `@earendil-works/*` type may appear in a public signature here.
 *   - Add a protocol message first (packages/protocol), then a driver method.
 */

import type {
  ContentBlock,
  ModelRef,
  SessionState,
  SessionUpdate,
  ThinkingLevel,
  UiDialogRequest,
  UiDialogResponse,
  UiFireAndForget,
} from "@piorbit/protocol";

export interface DriverOpenOptions {
  cwd: string;
  /** Existing session file to resume; omit for a new session. */
  sessionPath?: string;
  /** Fork parent when creating a new session. */
  parentSessionPath?: string;
  /** Override of Pi's agent dir (default ~/.pi/agent). */
  agentDir?: string;
  /** Where pi-subagents should keep its file layer for this worker. */
  subagentsTempRoot?: string;
}

export type DriverEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "ui_request"; request: UiDialogRequest }
  | { type: "ui_event"; event: UiFireAndForget }
  | { type: "closed"; reason: string };

export type DriverListener = (event: DriverEvent) => void;

export interface PromptOptions {
  streamingBehavior?: "steer" | "followUp";
}

/** One driver instance = one live Pi session inside one worker process. */
export interface SessionDriver {
  readonly kind: "stable-sdk" | "chord";

  open(options: DriverOpenOptions): Promise<SessionState>;
  state(): SessionState;
  subscribe(listener: DriverListener): () => void;

  prompt(content: ContentBlock[], options?: PromptOptions): Promise<{ accepted: boolean; queued: boolean }>;
  steer(content: ContentBlock[]): Promise<void>;
  followUp(content: ContentBlock[]): Promise<void>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  abort(): Promise<void>;

  listModels(): Promise<ModelRef[]>;
  setModel(model: ModelRef): Promise<SessionState>;
  setThinkingLevel(level: ThinkingLevel): Promise<SessionState>;
  rename(name: string): Promise<void>;
  compact(instructions?: string): Promise<void>;
  navigateTree(entryId: string, options?: { summarize?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;

  /** Answer a pending extension dialog raised via a `ui_request` event. */
  respondToUi(response: UiDialogResponse): void;

  /** Replay persisted entries (for reattach). Returns entries and the seq they were last emitted at. */
  entries(): Promise<unknown[]>;

  dispose(): Promise<void>;
}

export class DriverUnavailableError extends Error {
  override readonly name = "DriverUnavailableError";
  constructor(public readonly driver: SessionDriver["kind"], detail: string) {
    super(`${driver} driver unavailable: ${detail}`);
  }
}
