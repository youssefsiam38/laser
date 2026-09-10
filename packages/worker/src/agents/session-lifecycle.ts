/** Per-session prompt ownership and serialization for the agent harness. */
export type SessionPhase<End> =
  | { kind: "idle" }
  | { kind: "invoking"; runId: string; settled: boolean }
  | { kind: "terminal-pending"; runId: string; settled: boolean; end: End };

export type PromptAdmission = "invoke" | "engine-queue" | "local-queue" | "bare-concurrent";

export class SessionLifecycle<End, Message> {
  private phaseValue: SessionPhase<End> = { kind: "idle" };
  private successorRunId: string | undefined;
  private readonly inboxes = new Map<string, Message[]>();
  private operation: Promise<void> = Promise.resolve();
  private readonly terminal = new Map<string, Promise<void>>();
  private readonly resolveTerminal = new Map<string, () => void>();

  phase(): SessionPhase<End> {
    return this.phaseValue;
  }

  owner(): string | undefined {
    return this.phaseValue.kind === "idle" ? undefined : this.phaseValue.runId;
  }

  /**
   * Cohesive prompt admission: settled unwind and asynchronous preflight stay
   * local; only an explicitly queued prompt while demonstrably streaming may
   * enter the engine queue. A bare concurrent prompt remains the driver's
   * refusal to make.
   */
  admitPrompt(runId: string, message: { local: Message; engine: Message }, input: { streaming: boolean; explicitQueue: boolean }): PromptAdmission {
    if (this.phaseValue.kind === "idle") {
      this.phaseValue = { kind: "invoking", runId, settled: false };
      return "invoke";
    }
    if (this.phaseValue.runId !== runId || this.phaseValue.kind === "terminal-pending" || this.phaseValue.settled || !input.streaming) {
      this.enqueue(runId, message.local);
      return "local-queue";
    }
    if (input.explicitQueue) {
      this.enqueue(runId, message.engine);
      return "engine-queue";
    }
    return "bare-concurrent";
  }

  begin(runId: string): boolean {
    if (this.phaseValue.kind !== "idle") return false;
    this.phaseValue = { kind: "invoking", runId, settled: false };
    return true;
  }

  markSettled(runId: string): void {
    if (this.phaseValue.kind === "invoking" && this.phaseValue.runId === runId) {
      this.phaseValue = { ...this.phaseValue, settled: true };
    } else if (this.phaseValue.kind === "terminal-pending" && this.phaseValue.runId === runId) {
      this.phaseValue = { ...this.phaseValue, settled: true };
    }
  }

  declareEnd(runId: string, end: End): boolean {
    if (this.phaseValue.kind === "terminal-pending" && this.phaseValue.runId === runId) return false;
    if (this.phaseValue.kind !== "invoking" || this.phaseValue.runId !== runId) return false;
    this.phaseValue = { kind: "terminal-pending", runId, settled: this.phaseValue.settled, end };
    return true;
  }

  end(runId: string): End | undefined {
    return this.phaseValue.kind === "terminal-pending" && this.phaseValue.runId === runId ? this.phaseValue.end : undefined;
  }

  finish(runId: string): { settled: boolean; end: End | undefined } | undefined {
    if (this.phaseValue.kind === "idle" || this.phaseValue.runId !== runId) return undefined;
    const result = {
      settled: this.phaseValue.settled,
      ...(this.phaseValue.kind === "terminal-pending" ? { end: this.phaseValue.end } : { end: undefined }),
    };
    this.phaseValue = { kind: "idle" };
    return result;
  }

  successor(): string | undefined {
    return this.successorRunId;
  }

  /** Preserve first-creator identity and append every later message in order. */
  reserveSuccessor(message: Message, create: () => string): { runId: string; created: boolean } {
    if (this.successorRunId) {
      this.enqueue(this.successorRunId, message);
      return { runId: this.successorRunId, created: false };
    }
    const runId = create();
    this.successorRunId = runId;
    this.enqueue(runId, message);
    return { runId, created: true };
  }

  takeSuccessor(): { runId: string; first: Message | undefined } | undefined {
    const runId = this.successorRunId;
    if (!runId) return undefined;
    this.successorRunId = undefined;
    return { runId, first: this.shift(runId) };
  }

  cancelSuccessor(runId: string): boolean {
    if (this.successorRunId !== runId) return false;
    this.successorRunId = undefined;
    this.inboxes.delete(runId);
    return true;
  }

  enqueue(runId: string, message: Message): void {
    const inbox = this.inboxes.get(runId);
    if (inbox) inbox.push(message);
    else this.inboxes.set(runId, [message]);
  }

  inbox(runId: string): readonly Message[] {
    return this.inboxes.get(runId) ?? [];
  }

  replaceInbox(runId: string, messages: Message[]): void {
    if (messages.length === 0) this.inboxes.delete(runId);
    else this.inboxes.set(runId, messages);
  }

  remove(runId: string, message: Message): void {
    this.replaceInbox(runId, this.inbox(runId).filter((candidate) => candidate !== message));
  }

  nextLocalAfterFence(runId: string, isEngineOwned: (message: Message) => boolean): Message | undefined {
    this.replaceInbox(runId, this.inbox(runId).filter((message) => !isEngineOwned(message)));
    return this.shift(runId);
  }

  shift(runId: string): Message | undefined {
    const inbox = this.inboxes.get(runId);
    const message = inbox?.shift();
    if (inbox?.length === 0) this.inboxes.delete(runId);
    return message;
  }

  clearInbox(runId: string): Message[] {
    const messages = this.inboxes.get(runId) ?? [];
    this.inboxes.delete(runId);
    return messages;
  }

  waitForTerminal(runId: string): Promise<void> {
    let promise = this.terminal.get(runId);
    if (!promise) {
      promise = new Promise<void>((resolve) => this.resolveTerminal.set(runId, resolve));
      this.terminal.set(runId, promise);
    }
    return promise;
  }

  didTerminate(runId: string): void {
    this.resolveTerminal.get(runId)?.();
    this.resolveTerminal.delete(runId);
    this.terminal.delete(runId);
    this.inboxes.delete(runId);
    if (this.successorRunId === runId) this.successorRunId = undefined;
  }

  async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const before = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
