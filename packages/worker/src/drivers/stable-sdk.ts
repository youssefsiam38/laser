/**
 * StableSdkDriver (M0-T4) — the real driver, on the pinned stable Pi SDK.
 *
 * Owns one `AgentSessionRuntime` for one project directory. Loads the piorbit
 * companion extension inline, binds the UI bridge in "rpc" mode, and maps Pi's
 * `AgentSessionEvent` stream onto protocol `SessionUpdate`s.
 *
 * Runtime replacement (new/switch/fork) swaps `runtime.session`, so every such
 * operation re-subscribes and re-binds extensions — see `applySession()`.
 *
 * Verified against Pi 0.85.0 (test/stable-sdk.prompt.test.ts):
 *   - the user message emits message_start/message_end before the assistant
 *     stream begins; anchor transcript logic on the first text_delta;
 *   - `entry_appended` fires only for extension custom entries, never for
 *     message persistence — build transcript state from the message and tool
 *     execution events and hydrate from `entries()`;
 *   - `isStreaming` flips after `prompt()` yields, so "busy" is detected by
 *     catching Pi's error, not only by the pre-check.
 */

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createPiorbitExtension } from "@piorbit/pi-extension";
import type {
  ContentBlock,
  ImageContent,
  ModelRef,
  SessionState,
  SessionUpdate,
  ThinkingLevel,
  UiDialogRequest,
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

type PiModel = ReturnType<ModelRuntime["getModels"]>[number];

export class StableSdkDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;

  private readonly listeners = new Set<DriverListener>();
  private readonly ui: UiBridge;
  private runtime: AgentSessionRuntime | undefined;
  private unsubscribe: (() => void) | undefined;
  private cwd = "";

  constructor() {
    this.ui = createUiBridge({
      onRequest: (request) => this.emit({ type: "ui_request", request }),
      onEvent: (event) => this.emit({ type: "ui_event", event }),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  async open(options: DriverOpenOptions): Promise<SessionState> {
    if (this.runtime) throw new DriverUnavailableError(this.kind, "session already open");
    this.cwd = options.cwd;
    if (options.subagentsTempRoot) process.env["PI_SUBAGENTS_TEMP_ROOT"] = options.subagentsTempRoot;

    const agentDir = options.agentDir ?? getAgentDir();
    const piorbit = createPiorbitExtension({
      send: (message) => this.emit({ type: "extension", message }),
    });

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      // The companion extension rides along with whatever the user already has
      // installed; it is added to discovery, it does not replace it.
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: { extensionFactories: [piorbit] },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          ...(sessionStartEvent ? { sessionStartEvent } : {}),
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir,
      sessionManager: SessionManager.create(options.cwd, options.sessionDir),
    });
    this.runtime = runtime;

    if (options.sessionPath) {
      const { cancelled } = await runtime.switchSession(options.sessionPath);
      if (cancelled) throw new DriverUnavailableError(this.kind, `switch to ${options.sessionPath} was cancelled`);
    } else if (options.parentSessionPath) {
      await runtime.newSession({ parentSession: options.parentSessionPath });
    }

    await this.applySession();
    return this.state();
  }

  /** Bind extensions and subscribe to the current `runtime.session`. */
  private async applySession(): Promise<void> {
    const session = this.session();
    this.unsubscribe?.();
    await session.bindExtensions({
      mode: "rpc",
      uiContext: this.ui.context,
      abortHandler: () => void session.abort(),
      onError: (error: ExtensionError) =>
        this.push({ kind: "extension_error", extension: error.extensionPath, message: error.error }),
    });
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ui.dispose();
    await this.runtime?.dispose();
    this.runtime = undefined;
    this.emit({ type: "closed", reason: "disposed" });
    this.listeners.clear();
  }

  subscribe(listener: DriverListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------- state

  state(): SessionState {
    const session = this.session();
    const usage = session.getContextUsage();
    return {
      path: session.sessionFile ?? "",
      id: session.sessionId,
      cwd: this.cwd,
      ...(session.sessionName !== undefined ? { name: session.sessionName } : {}),
      // With no configured auth Pi substitutes an "unknown/unknown" placeholder; report it as no model.
      model: session.model && session.model.provider !== "unknown" ? toModelRef(session.model) : null,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      autoCompactionEnabled: session.autoCompactionEnabled,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
      ...(usage
        ? {
            contextUsage: {
              tokens: usage.tokens,
              contextWindow: usage.contextWindow,
              percent: usage.percent,
            },
          }
        : {}),
    };
  }

  async entries(): Promise<unknown[]> {
    return this.session().sessionManager.getEntries();
  }

  // ----------------------------------------------------------------- prompting

  async prompt(content: ContentBlock[], options?: PromptOptions): Promise<{ accepted: boolean; queued: boolean }> {
    const session = this.session();
    const { text, images } = split(content);
    const streaming = session.isStreaming;
    if (streaming && !options?.streamingBehavior) {
      return { accepted: false, queued: false };
    }
    try {
      await session.prompt(text, {
        ...(images.length > 0 ? { images } : {}),
        ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      });
    } catch (error) {
      // `isStreaming` flips only after the agent loop starts, so a prompt sent in
      // the same tick as another can pass the pre-check and still be refused by
      // Pi. "Busy" is a normal outcome for the protocol, not an exception.
      if (isBusyError(error)) return { accepted: false, queued: false };
      throw error;
    }
    return { accepted: true, queued: streaming };
  }

  async steer(content: ContentBlock[]): Promise<void> {
    const { text, images } = split(content);
    await this.session().steer(text, images.length > 0 ? images : undefined);
  }

  async followUp(content: ContentBlock[]): Promise<void> {
    const { text, images } = split(content);
    await this.session().followUp(text, images.length > 0 ? images : undefined);
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.session().clearQueue();
  }

  async abort(): Promise<void> {
    await this.session().abort();
  }

  // -------------------------------------------------------------------- model

  async listModels(): Promise<ModelRef[]> {
    return this.session().modelRuntime.getModels().map(toModelRef);
  }

  async setModel(model: ModelRef): Promise<SessionState> {
    const session = this.session();
    const match = session.modelRuntime
      .getModels()
      .find((m) => m.provider === model.provider && m.id === model.id);
    if (!match) throw new DriverUnavailableError(this.kind, `unknown model ${model.provider}/${model.id}`);
    await session.setModel(match);
    return this.state();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<SessionState> {
    this.session().setThinkingLevel(level);
    return this.state();
  }

  // ------------------------------------------------------------------ session

  async rename(name: string): Promise<void> {
    this.session().setSessionName(name);
  }

  async compact(instructions?: string): Promise<void> {
    await this.session().compact(instructions);
  }

  async navigateTree(
    entryId: string,
    options?: { summarize?: boolean; label?: string },
  ): Promise<{ editorText?: string; cancelled: boolean }> {
    const result = await this.session().navigateTree(entryId, {
      ...(options?.summarize !== undefined ? { summarize: options.summarize } : {}),
      ...(options?.label !== undefined ? { label: options.label } : {}),
    });
    return {
      ...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
      cancelled: result.cancelled,
    };
  }

  respondToUi(response: UiDialogResponse): void {
    this.ui.respond(response);
  }

  /** Dialogs still waiting for an answer, for replay after a client reconnect. */
  pendingUi(): UiDialogRequest[] {
    return this.ui.pending();
  }

  // ------------------------------------------------------------------ internals

  private session(): AgentSession {
    if (!this.runtime) throw new DriverUnavailableError(this.kind, "no open session");
    return this.runtime.session;
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private push(update: SessionUpdate): void {
    this.emit({ type: "update", update });
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    const update = mapEvent(event);
    if (update) this.push(update);
    // These change visible session state, so follow them with a state snapshot.
    if (
      event.type === "agent_end" ||
      event.type === "agent_settled" ||
      event.type === "session_info_changed" ||
      event.type === "thinking_level_changed" ||
      event.type === "compaction_end"
    ) {
      this.push({ kind: "state", state: this.state() });
    }
  }
}

// ------------------------------------------------------------------- mapping

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already processing|streamingBehavior/i.test(message);
}

function toModelRef(model: PiModel): ModelRef {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    vision: model.input.includes("image"),
  };
}

function split(content: ContentBlock[]): { text: string; images: ImageContent[] } {
  const text = content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const images = content.filter((b): b is ImageContent => b.type === "image");
  return { text, images };
}

function roleOf(message: unknown): "user" | "assistant" | "tool" | "custom" {
  const role = (message as { role?: string } | null)?.role;
  if (role === "user" || role === "assistant") return role;
  if (role === "toolResult" || role === "tool") return "tool";
  return "custom";
}

/** Pi event → protocol update. Returns undefined for events with no wire form. Exported for tests. */
export function mapEvent(event: AgentSessionEvent): SessionUpdate | undefined {
  switch (event.type) {
    case "agent_start":
      return { kind: "agent_start" };
    case "agent_end":
      return { kind: "agent_end", willRetry: event.willRetry };
    case "agent_settled":
      return { kind: "agent_settled" };
    case "turn_start":
      return { kind: "turn_start" };
    case "turn_end":
      return { kind: "turn_end" };
    case "message_start":
      return { kind: "message_start", role: roleOf(event.message) };
    case "message_end":
      return { kind: "message_end", message: event.message };
    case "message_update": {
      // Serialized updates carry deltas only; clients assemble text themselves.
      const inner = event.assistantMessageEvent;
      switch (inner.type) {
        case "text_delta":
          return { kind: "text_delta", delta: inner.delta, contentIndex: inner.contentIndex };
        case "thinking_delta":
          return { kind: "thinking_delta", delta: inner.delta, contentIndex: inner.contentIndex };
        case "toolcall_delta":
          return { kind: "toolcall_delta", delta: inner.delta, contentIndex: inner.contentIndex };
        default:
          return undefined;
      }
    }
    case "tool_execution_start":
      return { kind: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_update":
      return { kind: "tool_execution_update", toolCallId: event.toolCallId, partial: event.partialResult };
    case "tool_execution_end":
      return {
        kind: "tool_execution_end",
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError,
      };
    case "bash_execution_update":
      return { kind: "bash_execution_update", ...(event.id !== undefined ? { id: event.id } : {}), delta: event.delta };
    case "queue_update":
      return { kind: "queue_update", steering: [...event.steering], followUp: [...event.followUp] };
    case "compaction_start":
      return { kind: "compaction_start" };
    case "compaction_end":
      return { kind: "compaction_end", ok: !event.aborted && event.result !== undefined };
    case "auto_retry_start":
      return { kind: "auto_retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts };
    case "auto_retry_end":
      return { kind: "auto_retry_end", ok: event.success };
    case "entry_appended":
      return { kind: "entry_appended", entry: event.entry };
    default:
      return undefined;
  }
}
