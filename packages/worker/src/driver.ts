/**
 * SessionDriver — the migration seam (AGENTS.md invariant 3, decisions D-6/D-8).
 *
 * Everything above the worker sees only @lasercode/protocol types. A driver
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
  AgentDefinition,
  AgentPolicy,
  CommandInfo,
  ContentBlock,
  ModelRef,
  PromptInfo,
  PiExtensionCommand,
  PiExtensionMessage,
  SessionAgentRecord,
  SessionState,
  SessionUpdate,
  ThinkingLevel,
  FeatureId,
  GoalAction,
  SessionGoal,
  UiDialogRequest,
  UiDialogResponse,
  UiFireAndForget,
} from "@lasercode/protocol";
import type { AgentHarnessBridge, BackgroundWorkOptions, HarnessSessionRole } from "./agents/bridge.js";

/**
 * Which agent a session runs as (M13). Everything here is product vocabulary:
 * the definition names tools by their product names, the role is the
 * companion extension's, and the record is what the session file carries so a
 * catalog that only reads files can attribute it.
 */
export interface DriverAgentOptions {
  definition: AgentDefinition;
  role: HarnessSessionRole;
  /** Written as the session's first custom entry (`SESSION_AGENT_ENTRY_TYPE`) on a new session. */
  record: SessionAgentRecord;
  /** The harness, scoped to this session; passed to the companion extension. */
  bridge?: AgentHarnessBridge;
  backgroundWork?: BackgroundWorkOptions;
  policy: AgentPolicy;
}

export interface DriverOpenOptions {
  cwd: string;
  /** Existing session file to resume; omit for a new session. */
  sessionPath?: string;
  /** Fork parent when creating a new session. */
  parentSessionPath?: string;
  /** Override of Pi's agent dir (default ~/.pi/agent). */
  agentDir?: string;
  /** Override of the session storage dir (default <agentDir>/sessions). */
  sessionDir?: string;
  /** Host state used only by instruction fields that name Laser-owned data files. */
  stateDir?: string;
  /**
   * Host-resolved Pi project trust (M2-T4). The SDK never runs Pi's own trust
   * flow and `SettingsManager` defaults to trusted, so without this a project
   * the user declined would still load its `.pi/` resources. Omit to keep Pi's
   * default (used by tests and by hand-run workers).
   */
  projectTrusted?: boolean;
  /** Laser-owned capabilities enabled for this project. */
  features?: FeatureId[];
  /** The agent this session runs as. Absent for ephemeral, catalogue-only opens. */
  agent?: DriverAgentOptions;
}

export interface DriverInvocationRef {
  /** Unique only inside this driver generation. */
  id: string;
  /** Present when the agent harness owns the native invocation. */
  runId?: string;
}

/** Opaque server admission lease shared only across one causal invocation. */
export interface SessionAdmissionLease {
  readonly token: symbol;
  readonly active: boolean;
  release(): void;
}

export type ExtensionWorkDisposition = "started" | "queued" | "consumed";

export interface ExtensionModelExecution {
  /** Extension-visible acceptance: never the full model turn. */
  admission: Promise<void>;
  /** Worker-owned native lifetime. */
  completion: Promise<{ disposition: ExtensionWorkDisposition }>;
}

export interface ExtensionModelWorkRequest {
  kind: "user" | "custom";
  content: ContentBlock[];
  task: string;
  origin: "agent" | "user";
  parent?: DriverInvocationRef;
  /** Whether the causal parent had already entered a model run. */
  parentStarted?: boolean;
  /** The exact outer lease; only a still-active causal call may borrow it. */
  admissionLease?: SessionAdmissionLease;
  /** Start after ownership exists. Calling this twice is an error. */
  start(ownerRunId?: string): ExtensionModelExecution;
}

export interface ExtensionModelAdmission {
  admission: Promise<void>;
  completion: Promise<void>;
}

export type ExtensionModelWorkHandler = (request: ExtensionModelWorkRequest) => ExtensionModelAdmission;

export type DriverEvent =
  | { type: "update"; update: SessionUpdate; invocation?: DriverInvocationRef }
  | { type: "ui_request"; request: UiDialogRequest }
  | { type: "ui_event"; event: UiFireAndForget }
  /** Emitted by the laser companion extension running inside the session. */
  | { type: "extension"; message: PiExtensionMessage }
  | { type: "closed"; reason: string };

export type DriverListener = (event: DriverEvent) => void;

export interface FirstTurnOptions {
  agent: DriverAgentOptions;
  thinkingLevel?: ThinkingLevel;
}

export interface PromptOptions {
  streamingBehavior?: "steer" | "followUp";
  /** Internal owner propagated to extension work; never crosses protocol. */
  ownerRunId?: string;
  /** Server preflight lease, borrowed only by a causal nested extension send. */
  admissionLease?: SessionAdmissionLease;
  /** False sends the text verbatim: no slash-command dispatch, no template expansion. */
  expandPromptTemplates?: boolean;
  /**
   * Called once the engine has accepted this exact prompt, before its turn runs.
   * Not called for a preflight refusal. A later run failure does not revoke
   * acceptance: the user message already belongs to the engine and must not be
   * submitted again. The driver isolates observer failures so they cannot stop
   * the accepted engine run.
   */
  onAccepted?: () => void;
}

/** One driver instance = one live Pi session inside one worker process. */
export interface SessionDriver {
  readonly kind: "stable-sdk" | "chord";

  open(options: DriverOpenOptions): Promise<SessionState>;
  state(): SessionState;
  subscribe(listener: DriverListener): () => void;

  /** Replace only a pristine root runtime around its existing session manager. */
  prepareFirstTurn?(options: FirstTurnOptions): Promise<void>;
  /** Restore the prior runtime when prompt preflight did not accept ownership. */
  rollbackFirstTurn?(): Promise<void>;
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
  /** Move the leaf. `stopFirst` aborts a streaming turn first (recorded as `aborted`), because the engine refuses to move one mid-turn. */
  navigateTree(entryId: string, options?: { summarize?: boolean; label?: string; stopFirst?: boolean }): Promise<{ editorText?: string; cancelled: boolean }>;
  /** Fork before an entry into a new session file. The driver now serves the new session; `state().path` changes. `stopFirst` aborts a streaming turn before anything else. */
  fork(entryId: string, options?: { stopFirst?: boolean }): Promise<{ state: SessionState; editorText?: string }>;

  /** Answer a pending extension dialog raised via a `ui_request` event. */
  respondToUi(response: UiDialogResponse): void;

  /**
   * Hand a command to the companion extension — a panel action or account
   * refresh. Returns true when a module took it; false
   * means nobody still holds that panel id. Optional: the stub driver loads no
   * extension, so it has nothing to deliver to.
   */
  deliverExtensionCommand?(command: PiExtensionCommand): boolean;

  /**
   * Everything `/` can run in this session — the packages' registered commands,
   * the prompt library and the skills — and the prompt library on its own. Both
   * are per session because a session's resources are what its project and its
   * packages loaded, not a global list.
   */
  commands(): Promise<CommandInfo[]>;
  prompts(): Promise<PromptInfo[]>;

  /**
   * Replay persisted entries (for reattach). The session file is a tree, so
   * this is every branch; `leafId` says which one is live — the conversation
   * is the path from the root to that entry. `null` is a leaf reset to before
   * the first entry (`SessionManager.resetLeaf`).
   */
  entries(): Promise<{ entries: unknown[]; leafId: string | null }>;

  /** Durable goal control. Optional for engines that do not implement Goals. */
  goalState?(): Promise<SessionGoal | null>;
  goalAction?(action: GoalAction, options?: { admissionLease?: SessionAdmissionLease; onAccepted?: () => void }): Promise<SessionGoal | null>;

  /** Worker-owned admission for extension calls that can enter the model. */
  setExtensionModelWorkHandler?(handler: ExtensionModelWorkHandler | undefined): void;

  /**
   * Persist a custom entry in this session's file (the harness writes run
   * moments this way). Returns the entry id. Optional: the stub has no file.
   */
  appendEntry?(customType: string, data: unknown): Promise<string>;
  /** The text of the last assistant message, for a run that ended without its final tool. */
  lastAssistantText?(): string | undefined;

  /**
   * Re-read the settings files into this session's engine settings after a
   * Settings write (M13-T55), through the engine's own settings reload with
   * the project's `.laser` values kept durable across it. Never mid-turn: a
   * reload asked for while a turn or a compaction runs is deferred to its end
   * and answered `deferred: true`. Optional: the stub holds no settings.
   */
  reloadSettings?(): Promise<{ deferred: boolean }>;

  dispose(): Promise<void>;
}

export class DriverUnavailableError extends Error {
  override readonly name = "DriverUnavailableError";
  constructor(public readonly driver: SessionDriver["kind"], detail: string) {
    super(`${driver} driver unavailable: ${detail}`);
  }
}
